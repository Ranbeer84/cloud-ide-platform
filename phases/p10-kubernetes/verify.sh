#!/usr/bin/env bash
# Phase 10 gate: Kubernetes migration (sandbox pods, IngressRoute routing, multi-node scheduling).
#
#   P10_CONTEXT=<kubectl context> bash phases/p10-kubernetes/verify.sh      an existing cluster
#   P10_CREATE_KIND=1 bash phases/p10-kubernetes/verify.sh                  a throwaway kind cluster
#
# Runs, in order:
#   1. regression: Phase 9 (which re-runs Phases 8 down to 0, on the Docker backend with the
#      Phase 10 code in place, so this proves the migration broke nothing)
#   2. install, build, type-check and lint
#   3. K8sManager against a fake Kubernetes API (object shapes, hardening, cleanup, failure paths)
#   4. manifest checks (and schema validation when `kubeconform` is installed)
#   5. on a REAL cluster with >= 2 schedulable nodes:
#        a. K8sManager directly: sandbox pods land on >= 2 nodes
#        b. the orchestrator inside the cluster: sandbox pods spread across >= 2 nodes
#        c. routes exist as Traefik IngressRoute objects (no Docker labels, no Docker socket),
#           appear with the sandbox, serve its preview, and disappear with it
#        d. sandbox hardening: gVisor, no API token, and NetworkPolicy isolation is ENFORCED
#        e. the Phase 5 and 7 behaviours on the cluster: auth, ownership, heartbeats, the idle
#           reaper, and orchestrator restart with the reconciler (stale record, orphan pod)
#
# About "Phases 0-9 on the cluster": the Phase 0-9 gates drive Docker and docker compose, so they
# cannot run on a cluster. Step 1 runs them against the Docker backend; step 5 re-checks, on the
# cluster, the behaviours of Phases 5 and 7 that the migration could break.
#
# Cluster requirements: kubectl, >= 2 Ready schedulable nodes, and a CNI that enforces
# NetworkPolicy. The orchestrator and sandbox images must be available to every node:
# with kind they are loaded automatically; on other clusters push them to a registry and pass
# P10_ORCHESTRATOR_IMAGE / P10_SANDBOX_IMAGE (with P10_SKIP_IMAGE_BUILD=1 for prebuilt images).
# For gVisor every node needs the runsc shim. Where it is missing, P10_ALLOW_NO_GVISOR=1 runs
# the sandboxes under the default runtime instead (development only: NOT isolated by gVisor).
#
# Everything is installed into namespaces live-system and live-sandboxes, so run it against a
# cluster you can use for that. P10_CONTEXT is mandatory so that it never runs against whatever
# kubectl happens to point at.
#
# Switches:
#   P10_CONTEXT              kubectl context to use (not needed with P10_CREATE_KIND=1)
#   P10_CREATE_KIND=1        create (or reuse) a 3-node kind cluster; P10_KIND_NAME (live-p10)
#   P10_KIND_CNI             calico (default; enforces NetworkPolicy) or default (kindnet; may not)
#   P10_ORCHESTRATOR_IMAGE   live/orchestrator:latest      P10_SANDBOX_IMAGE   live/sandbox-base:latest
#   P10_SKIP_IMAGE_BUILD=1   do not build the orchestrator image
#   P10_ALLOW_NO_GVISOR=1    sandboxes under the default runtime (development clusters only)
#   P10_ALLOW_NO_NETPOL=1    do not fail when NetworkPolicy is not enforced (reports it instead)
#   P10_API_PORT / P10_PROXY_PORT   local ports for the port-forwards (14100 / 18080)
#   P10_TEARDOWN=1           remove what the gate installed (and the kind cluster it created)
#   P10_SKIP_REGRESSION=1    skip step 1          P10_SKIP_CLUSTER=1   skip step 5
#                            (a run that skips anything says so and is NOT a full Phase 10 pass)
#   P10_PNPM_INSTALL_FLAGS   extra flags for `pnpm install`
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SKIP_REGRESSION="${P10_SKIP_REGRESSION:-0}"
SKIP_CLUSTER="${P10_SKIP_CLUSTER:-0}"
CREATE_KIND="${P10_CREATE_KIND:-0}"
KIND_NAME="${P10_KIND_NAME:-live-p10}"
KIND_CNI="${P10_KIND_CNI:-calico}"
CONTEXT="${P10_CONTEXT:-}"
ORCH_IMAGE="${P10_ORCHESTRATOR_IMAGE:-live/orchestrator:latest}"
SANDBOX_IMAGE="${P10_SANDBOX_IMAGE:-live/sandbox-base:latest}"
SKIP_IMAGE_BUILD="${P10_SKIP_IMAGE_BUILD:-0}"
ALLOW_NO_GVISOR="${P10_ALLOW_NO_GVISOR:-0}"
ALLOW_NO_NETPOL="${P10_ALLOW_NO_NETPOL:-0}"
API_PORT="${P10_API_PORT:-14100}"
PROXY_PORT="${P10_PROXY_PORT:-18080}"
TEARDOWN="${P10_TEARDOWN:-0}"
CALICO_URL="https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/calico.yaml"
TRAEFIK_CRD_URL="https://raw.githubusercontent.com/traefik/traefik/v3.1/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml"
SANDBOX_NS="live-sandboxes"
SYSTEM_NS="live-system"

LOG_DIR="$(mktemp -d /tmp/p10-verify.XXXXXX)"
SKIPPED=()
CLUSTER_STARTED=0
KIND_CREATED_BY_GATE=0
PF_PIDS=()
CREATED_SESSION_IDS=()
DIRECT_POD_NAMES=()

pass() { echo "  PASS: $1"; }
note() { echo "  NOTE: $1"; }

k() { kubectl --request-timeout=60s "$@"; }
# `kubectl wait` and `kubectl rollout status` hold a watch open for up to their own --timeout. A client-side
# --request-timeout would cut that watch short (after 60 s), so long waits go through this instead.
kw() { kubectl "$@"; }

diagnostics() {
  echo "  --- cluster diagnostics ---"
  k get nodes -o wide 2> /dev/null || true
  k -n kube-system get pods -o wide 2> /dev/null || true
  k -n "$SYSTEM_NS" get pods -o wide 2> /dev/null || true
  k -n "$SANDBOX_NS" get pods -o wide 2> /dev/null || true
  k -n "$SYSTEM_NS" logs -l app.kubernetes.io/name=live-orchestrator --tail=25 --prefix 2> /dev/null || true
  k get events -A --sort-by=.lastTimestamp 2> /dev/null | tail -n 15 || true
}

fail() {
  echo "  FAIL: $1"
  if [ "$CLUSTER_STARTED" = "1" ]; then
    diagnostics
  fi
  exit 1
}

# Reads JSON on stdin and prints the value of the expression, with the parsed JSON as `d`.
njs() {
  node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const result = (function (d) { return eval(process.argv[1]); })(d);
    if (result !== undefined) { console.log(typeof result === "object" ? JSON.stringify(result) : result); }
  ' "$1"
}

wait_until() { # wait_until SECONDS CMD...
  local seconds="$1"
  shift
  local i
  for ((i = 0; i < seconds; i++)); do
    if "$@" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

url_ok() { curl -sf -m 2 "$1" > /dev/null 2>&1; }

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------
echo "== Phase 10 verify: preflight =="
for tool in node pnpm curl; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is required but was not found on PATH"
done
if [ "$SKIP_CLUSTER" != "1" ]; then
  command -v kubectl > /dev/null 2>&1 || fail "kubectl is required (or set P10_SKIP_CLUSTER=1)"
  if [ "$CREATE_KIND" = "1" ]; then
    command -v kind > /dev/null 2>&1 || fail "kind is required for P10_CREATE_KIND=1"
    CONTEXT="kind-${KIND_NAME}"
  fi
  [ -n "$CONTEXT" ] || fail "set P10_CONTEXT to the kubectl context to use (or P10_CREATE_KIND=1). Contexts: $(kubectl config get-contexts -o name 2> /dev/null | tr '\n' ' ')"
  if [ "$SKIP_IMAGE_BUILD" != "1" ] || [ "$CREATE_KIND" = "1" ]; then
    command -v docker > /dev/null 2>&1 || fail "docker is required to build and load images"
  fi
fi
if [ "$SKIP_REGRESSION" != "1" ]; then
  command -v docker > /dev/null 2>&1 || fail "docker is required for the regression suite (or set P10_SKIP_REGRESSION=1)"
fi
pass "required tools are present"
if [ "$SKIP_CLUSTER" != "1" ]; then
  # A 3-node kind cluster with Calico, Redis, Postgres, Traefik, 2 orchestrators and several sandboxes
  # shares ONE machine. When it is too small the API server's health checks start failing mid-run.
  HOST_CPUS="$(nproc 2> /dev/null || echo 0)"
  HOST_MEM_MB="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2> /dev/null || echo 0)"
  HOST_MEM_MB="${HOST_MEM_MB:-0}"
  SMALL_HOST=0
  if [ "$HOST_CPUS" -gt 0 ] && [ "$HOST_CPUS" -lt 4 ]; then SMALL_HOST=1; fi
  if [ "$HOST_MEM_MB" -gt 0 ] && [ "$HOST_MEM_MB" -lt 7500 ]; then SMALL_HOST=1; fi
  if [ "$SMALL_HOST" = "1" ]; then
    note "this machine has ${HOST_CPUS} CPU(s) and ${HOST_MEM_MB} MB of memory; the cluster steps want at least 4 CPUs and 8 GB, and may fail with API-server timeouts below that"
  fi
fi
echo

# --------------------------------------------------------------------------
# 1. Regression: Phase 9 (which includes Phases 0-8), Docker backend.
# --------------------------------------------------------------------------
echo "== Phase 10 verify: regression suite, Phases 0-9 (Docker backend) =="
if [ "$SKIP_REGRESSION" = "1" ]; then
  SKIPPED+=("regression P0-P9")
  note "SKIPPED (P10_SKIP_REGRESSION=1)"
else
  bash phases/p9-operability/verify.sh
  pass "Phase 9 regression suite (which includes Phases 0 through 8)"
fi
echo

# --------------------------------------------------------------------------
# 2. Install, build, type-check, lint.
# --------------------------------------------------------------------------
echo "== Phase 10 verify: pnpm install, build, typecheck, lint =="
# shellcheck disable=SC2086
pnpm install --frozen-lockfile ${P10_PNPM_INSTALL_FLAGS:-} > "$LOG_DIR/install.log" 2>&1 \
  && pass "pnpm install --frozen-lockfile (the lockfile includes @kubernetes/client-node)" \
  || { cat "$LOG_DIR/install.log"; fail "pnpm install --frozen-lockfile (did you commit the updated pnpm-lock.yaml?)"; }
pnpm run build > "$LOG_DIR/build.log" 2>&1 \
  && pass "pnpm build" \
  || { cat "$LOG_DIR/build.log"; fail "pnpm build"; }
[ -f packages/orchestrator/dist/containers/k8sManager.js ] || fail "k8sManager.js was not compiled"
pnpm run typecheck > "$LOG_DIR/typecheck.log" 2>&1 \
  && pass "pnpm typecheck (every package)" \
  || { cat "$LOG_DIR/typecheck.log"; fail "pnpm typecheck"; }
pnpm run lint:no-any > "$LOG_DIR/lint.log" 2>&1 \
  && pass "shared-types still has no 'any'" \
  || { cat "$LOG_DIR/lint.log"; fail "lint:no-any"; }
echo

# --------------------------------------------------------------------------
# 3. K8sManager against a fake Kubernetes API.
# --------------------------------------------------------------------------
echo "== Phase 10 verify: K8sManager (fake Kubernetes API) =="
UNIT_JS='
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const root = process.env.REPO_ROOT + "/packages/orchestrator/dist/";
const m = await import(pathToFileURL(root + "containers/k8sManager.js").href);
const { ConfigError, loadConfig } = await import(pathToFileURL(root + "config.js").href);
const { agentHostFor } = await import(pathToFileURL(root + "sessionStore/sessionTypes.js").href);

const logs = [];
const logger = { info: (a, b) => logs.push([a, b]), warn: (a, b) => logs.push([a, b]), error: (a, b) => logs.push([a, b]) };
const notFound = () => Object.assign(new Error("not found"), { statusCode: 404 });

function fakeApi(opts = {}) {
  const pods = new Map(), services = new Map(), routes = new Map();
  let clock = 0;
  const api = {
    pods, services, routes, reads: 0,
    async createPod(ns, pod) {
      if (opts.failCreatePod) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
      const stored = structuredClone(pod);
      stored.metadata.uid = "uid-" + pod.metadata.name;
      stored.metadata.creationTimestamp = new Date(clock);
      stored.status = { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/2 nodes available" }] };
      pods.set(pod.metadata.name, stored);
      api.reads = 0;
      return stored;
    },
    async readPod(ns, name) {
      const pod = pods.get(name);
      if (!pod) throw notFound();
      api.reads += 1;
      if (pod.metadata.deletionTimestamp) { pods.delete(name); return pod; }
      if (opts.pullFailure) pod.status = { phase: "Pending", containerStatuses: [{ name: "sandbox", state: { waiting: { reason: "ImagePullBackOff", message: "pull access denied" } } }] };
      else if (!opts.neverRuns && api.reads >= 2) { pod.spec.nodeName = "worker-1"; pod.status = { phase: "Running", containerStatuses: [{ name: "sandbox", state: { running: {} } }] }; }
      return pod;
    },
    async listPods() { return [...pods.values()]; },
    async deletePod(ns, name) { const p = pods.get(name); if (!p) throw notFound(); p.metadata.deletionTimestamp = new Date(clock); },
    async createService(ns, svc) { if (opts.failCreateService) throw Object.assign(new Error("boom"), { statusCode: 500 }); services.set(svc.metadata.name, structuredClone(svc)); return svc; },
    async listServices() { return [...services.values()]; },
    async deleteService(ns, name) { if (!services.delete(name)) throw notFound(); },
    async createIngressRoute(ns, r) { routes.set(r.metadata.name, structuredClone(r)); },
    async listIngressRoutes() { return [...routes.values()]; },
    async deleteIngressRoute(ns, name) { if (!routes.delete(name)) throw notFound(); },
    async readNamespace() {},
    async readRuntimeClassHandler(n) { return opts.handlers?.[n]; },
  };
  return { api, now: () => clock, advance: (ms) => { clock += ms; } };
}
function manager(env = {}, apiOpts = {}) {
  const fake = fakeApi(apiOpts);
  const options = m.loadK8sManagerOptions(env);
  return { mgr: new m.K8sManager({ options, api: fake.api, logger, now: fake.now, sleep: async (ms) => fake.advance(ms) }), fake, options };
}
const spawnOpts = (id = "sabc123") => ({ image: "live/sandbox-base:latest", sessionId: id, agentPort: 7777, resourceLimits: { memoryBytes: 536870912, nanoCpus: 1_000_000_000, pidsLimit: 256 }, env: { PORT: "7777" } });

// configuration
{
  const o = m.loadK8sManagerOptions({});
  assert.equal(o.namespace, "live-sandboxes"); assert.equal(o.runtimeClassName, "gvisor"); assert.equal(o.topologySpread, "strict");
  assert.equal(o.enableTls, false);
  assert.equal(m.loadK8sManagerOptions({ SESSION_HOST_SUFFIX: "sessions.example.dev" }).enableTls, true);
  for (const bad of [{ K8S_TOPOLOGY_SPREAD: "wild" }, { K8S_SANDBOX_UID: "0" }, { K8S_IMAGE_PULL_POLICY: "Sometimes" }, { K8S_SANDBOX_NODE_SELECTOR: "novalue" }, { K8S_ALLOW_DEFAULT_RUNTIME: "maybe" }, { K8S_SANDBOX_NAMESPACE: "Bad_NS" }]) {
    assert.throws(() => m.loadK8sManagerOptions(bad), ConfigError, JSON.stringify(bad));
  }
}
// the sandbox pod
const { options } = manager();
const pod = m.buildSandboxPod(options, spawnOpts());
assert.equal(pod.metadata.name, "sbx-sabc123");
assert.equal(pod.spec.runtimeClassName, "gvisor");
assert.equal(pod.spec.automountServiceAccountToken, false, "a sandbox never gets a Kubernetes API token");
assert.equal(pod.spec.enableServiceLinks, false);
assert.equal(pod.spec.restartPolicy, "Never");
assert.equal(pod.spec.hostNetwork, false);
assert.equal(pod.spec.securityContext.runAsNonRoot, true);
assert.equal(pod.spec.securityContext.runAsUser, 999);
assert.equal(pod.spec.securityContext.seccompProfile.type, "RuntimeDefault");
assert.deepEqual(pod.spec.containers[0].securityContext.capabilities.drop, ["ALL"]);
assert.equal(pod.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
assert.equal(pod.spec.containers[0].securityContext.privileged, false);
assert.equal(pod.spec.containers[0].resources.limits.memory, "536870912");
assert.equal(pod.spec.containers[0].resources.requests.memory, "536870912", "no memory over-commit");
assert.equal(pod.spec.containers[0].resources.limits.cpu, "1000m");
assert.equal(pod.spec.containers[0].resources.limits["ephemeral-storage"], "2048Mi");
assert.equal(pod.spec.topologySpreadConstraints[0].whenUnsatisfiable, "DoNotSchedule");
assert.equal(pod.spec.topologySpreadConstraints[0].nodeTaintsPolicy, "Honor");
assert.equal(pod.metadata.labels["live.session-id"], "sabc123");
assert.equal(pod.metadata.labels["app.kubernetes.io/name"], "live-sandbox", "the label the NetworkPolicies select on");
assert.ok(!Object.keys(pod.metadata.labels).some((key) => key.startsWith("traefik.")), "no Docker-style traefik labels");
assert.equal(m.buildSandboxPod(options, { ...spawnOpts(), labels: { "app.kubernetes.io/name": "evil" } }).metadata.labels["app.kubernetes.io/name"], "live-sandbox", "callers cannot overwrite policy labels");
assert.equal(m.buildSandboxPod(m.loadK8sManagerOptions({ K8S_TOPOLOGY_SPREAD: "soft" }), spawnOpts()).spec.topologySpreadConstraints[0].whenUnsatisfiable, "ScheduleAnyway");
assert.equal(m.buildSandboxPod(m.loadK8sManagerOptions({ K8S_TOPOLOGY_SPREAD: "off" }), spawnOpts()).spec.topologySpreadConstraints, undefined);
assert.equal(m.buildSandboxPod(m.loadK8sManagerOptions({ K8S_SANDBOX_RUNTIME_CLASS: "" }), spawnOpts()).spec.runtimeClassName, undefined);
assert.throws(() => m.sandboxObjectName("x".repeat(60)), /too long/);
// routes
const owner = { apiVersion: "v1", kind: "Pod", name: "sbx-sabc123", uid: "u1", blockOwnerDeletion: false };
const plain = m.buildIngressRoutes(options, "sabc123", owner);
assert.equal(plain.length, 1);
assert.equal(plain[0].apiVersion, "traefik.io/v1alpha1");
assert.equal(plain[0].spec.routes[0].match, "Host(`sabc123.localhost`)");
assert.equal(plain[0].spec.routes[0].services[0].port, 8080);
assert.equal(plain[0].metadata.ownerReferences[0].kind, "Pod", "the pod owns its routes, so deleting it removes them");
const tlsOptions = m.loadK8sManagerOptions({ SESSION_HOST_SUFFIX: ".sessions.example.dev" });
const tls = m.buildIngressRoutes(tlsOptions, "sabc123", owner);
assert.equal(tls.length, 2);
assert.deepEqual(tls[0].spec.routes[0].middlewares, [{ name: "sandbox-https-redirect" }]);
assert.deepEqual(tls[1].spec.entryPoints, ["websecure"]);
assert.deepEqual(tls[1].spec.tls.domains, [{ main: "sessions.example.dev", sans: ["*.sessions.example.dev"] }]);
// the agent address the orchestrator derives is the Service the manager creates
for (const id of ["s0123456789abcdef", "Sabc"]) {
  assert.equal(agentHostFor({ sandboxAgentHost: m.sandboxAgentHostTemplate("live-sandboxes") }, id), m.sandboxServiceHost(id, "live-sandboxes"));
}
assert.equal(agentHostFor({ sandboxAgentHost: "127.0.0.1" }, "s1"), "127.0.0.1", "the Docker default is unchanged");
assert.equal(loadConfig({ ORCHESTRATOR_AUTH_MODE: "disabled" }).sandboxAgentHost, "127.0.0.1");
// spawn and stop
{
  const { mgr, fake } = manager();
  const c = await mgr.spawnContainer(spawnOpts());
  assert.equal(c.containerId, "sbx-sabc123"); assert.equal(c.status, "running"); assert.equal(c.hostAgentPort, 7777);
  assert.equal(fake.api.services.get("sbx-sabc123").metadata.ownerReferences[0].uid, "uid-sbx-sabc123");
  assert.equal((await mgr.listManagedContainers()).length, 1);
  assert.equal((await mgr.inspectContainer("sbx-sabc123")).running, true);
  await mgr.stopContainer("sbx-sabc123");
  assert.equal(fake.api.pods.size + fake.api.services.size + fake.api.routes.size, 0, "stopping removes the pod, the service and the routes");
  await mgr.stopContainer("sbx-sabc123");
  await assert.rejects(() => mgr.inspectContainer("sbx-gone"), (e) => e.statusCode === 404);
}
// failures leave nothing behind
{
  const a = manager({}, { pullFailure: true });
  await assert.rejects(() => a.mgr.spawnContainer(spawnOpts()), /ImagePullBackOff.*no such image/);
  assert.equal(a.fake.api.pods.size + a.fake.api.services.size + a.fake.api.routes.size, 0);
  const b = manager({ K8S_POD_START_TIMEOUT_MS: "3000" }, { neverRuns: true });
  await assert.rejects(() => b.mgr.spawnContainer(spawnOpts()), /did not start within 3000 ms \(unschedulable: 0\/2 nodes available\)/);
  assert.equal(b.fake.api.pods.size, 0);
  const c = manager({}, { failCreateService: true });
  await assert.rejects(() => c.mgr.spawnContainer(spawnOpts()));
  assert.equal(c.fake.api.pods.size, 0, "a failure after the pod exists removes the pod");
  await assert.rejects(() => manager({}, { failCreatePod: true }).mgr.spawnContainer(spawnOpts()), (e) => e.statusCode === 403);
}
// status mapping, pruning, runtime checks
{
  const base = (status, extra = {}) => ({ metadata: { name: "sbx-x", ...extra }, status });
  assert.equal(m.podStatus(base({ phase: "Pending" })), "starting");
  assert.equal(m.podStatus(base({ phase: "Running", containerStatuses: [{ name: "sandbox", state: { running: {} } }] })), "running");
  assert.equal(m.podStatus(base({ phase: "Running", containerStatuses: [{ name: "sandbox", state: { terminated: { reason: "OOMKilled" } } }] })), "oom_killed");
  assert.equal(m.podStatus(base({ phase: "Failed" })), "error");
  assert.equal(m.podStatus(base({ phase: "Running" }, { deletionTimestamp: new Date() })), "stopped");

  const { mgr, fake } = manager();
  await mgr.spawnContainer(spawnOpts("skeep"));
  fake.api.services.set("sbx-sorphan", { metadata: { name: "sbx-sorphan", labels: { "live.session-id": "sorphan" }, creationTimestamp: new Date(0) } });
  fake.advance(120_000);
  assert.deepEqual([...(await mgr.pruneOrphanRoutes(new Set(["skeep"]), { graceMs: 60_000 }))], ["service/sbx-sorphan"]);
  assert.ok(fake.api.services.has("sbx-skeep"), "live session objects survive pruning");

  await assert.doesNotReject(() => manager({}, { handlers: { gvisor: "runsc" } }).mgr.assertRuntimeAvailable());
  await assert.rejects(() => manager({}, { handlers: {} }).mgr.assertRuntimeAvailable(), /does not exist/);
  await assert.rejects(() => manager({}, { handlers: { gvisor: "runc" } }).mgr.assertRuntimeAvailable(), /not gVisor/);
  await assert.rejects(() => manager({ K8S_SANDBOX_RUNTIME_CLASS: "" }).mgr.assertRuntimeAvailable(), /Refusing to run sandboxes without gVisor/);
  await assert.doesNotReject(() => manager({ K8S_SANDBOX_RUNTIME_CLASS: "", K8S_ALLOW_DEFAULT_RUNTIME: "true" }).mgr.assertRuntimeAvailable());
}
if (process.env.OUT_DIR) {
  const out = process.env.OUT_DIR;
  writeFileSync(out + "/gen-pod.json", JSON.stringify(pod));
  writeFileSync(out + "/gen-service.json", JSON.stringify(m.buildSandboxService(options, spawnOpts(), owner)));
  writeFileSync(out + "/gen-route-http.json", JSON.stringify(plain[0]));
  writeFileSync(out + "/gen-route-tls.json", JSON.stringify(tls[1]));
}
console.log("k8s manager checks ok");
'
REPO_ROOT="$REPO_ROOT" OUT_DIR="$LOG_DIR" node --input-type=module -e "$UNIT_JS" > "$LOG_DIR/unit.out" 2>&1 \
  && pass "pod hardening, routes, spawn/stop, failure cleanup, status mapping, pruning, runtime checks, agent address" \
  || { cat "$LOG_DIR/unit.out"; fail "K8sManager unit checks"; }
echo

# --------------------------------------------------------------------------
# 4. Manifests.
# --------------------------------------------------------------------------
echo "== Phase 10 verify: manifests =="
for file in packages/orchestrator/src/containers/k8sManager.ts packages/proxy/traefik/ingressroute-crd.yaml infra/k8s/orchestrator-deployment.yaml \
  infra/k8s/proxy-deployment.yaml infra/k8s/redis.yaml infra/k8s/postgres.yaml infra/k8s/network-policy.yaml packages/orchestrator/Dockerfile; do
  [ -f "$file" ] || fail "$file is missing"
done
grep -q -- "--providers.kubernetescrd=true" infra/k8s/proxy-deployment.yaml || fail "the proxy does not enable the Kubernetes CRD provider"
if grep -q -i -E "providers\.docker|docker\.sock" infra/k8s/proxy-deployment.yaml; then
  fail "the proxy manifest still refers to the Docker provider or the Docker socket"
fi
grep -q "kind: Middleware" packages/proxy/traefik/ingressroute-crd.yaml && grep -q "kind: IngressRoute" packages/proxy/traefik/ingressroute-crd.yaml \
  || fail "ingressroute-crd.yaml must define the redirect Middleware and the API IngressRoute"
grep -q "SANDBOX_BACKEND: \"kubernetes\"" infra/k8s/orchestrator-deployment.yaml || fail "the orchestrator is not configured for the Kubernetes backend"
grep -q "handler: runsc" infra/k8s/orchestrator-deployment.yaml || fail "the gVisor RuntimeClass is missing"
for file in infra/k8s/redis.yaml infra/k8s/postgres.yaml; do
  grep -q "kind: StatefulSet" "$file" && grep -q "kind: Service" "$file" || fail "$file must define a StatefulSet and a Service"
done
pass "proxy uses CRDs (no Docker provider or socket); RuntimeClass, StatefulSets, Services and API route are defined"
if command -v kubeconform > /dev/null 2>&1; then
  CRD_SCHEMAS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
  kubeconform -strict -summary -schema-location default -schema-location "$CRD_SCHEMAS" \
    infra/k8s/*.yaml packages/proxy/traefik/ingressroute-crd.yaml "$LOG_DIR"/gen-*.json > "$LOG_DIR/kubeconform.out" 2>&1 \
    && pass "kubeconform: every manifest and every object K8sManager generates matches the Kubernetes and Traefik schemas" \
    || { cat "$LOG_DIR/kubeconform.out"; fail "kubeconform found invalid objects"; }
else
  note "kubeconform is not installed: schemas are checked by the cluster's API server in step 5 instead"
fi
echo

# --------------------------------------------------------------------------
# 5. A real multi-node cluster.
# --------------------------------------------------------------------------
echo "== Phase 10 verify: cluster =="
if [ "$SKIP_CLUSTER" = "1" ]; then
  SKIPPED+=("cluster")
  note "SKIPPED (P10_SKIP_CLUSTER=1)"
  echo
else
  export DOCKER_BUILDKIT=1
  PROBE_JS='
const net = require("net"), dns = require("dns");
const probe = (spec) => new Promise((resolve) => {
  const [label, rest] = spec.split("=");
  if (label === "dns") { dns.lookup(rest, (e) => resolve("dns " + (e ? "FAIL:" + e.code : "OK"))); return; }
  const i = rest.lastIndexOf(":");
  const s = net.connect({ host: rest.slice(0, i), port: Number(rest.slice(i + 1)), timeout: 4000 });
  s.on("connect", () => { s.destroy(); resolve(label + " OPEN"); });
  s.on("timeout", () => { s.destroy(); resolve(label + " BLOCKED:timeout"); });
  s.on("error", (e) => resolve(label + " BLOCKED:" + e.code));
});
(async () => { for (const spec of process.argv.slice(1)) console.log(await probe(spec)); })();
'
  PREVIEW_JS='require("http").createServer((q, r) => r.end("p10-preview-ok")).listen(8080)'
  RENDER_JS='
const fs = require("fs");
let text = fs.readFileSync(process.argv[1], "utf8");
for (const [from, to] of JSON.parse(process.env.SWAPS || "[]")) { text = text.split(from).join(to); }
process.stdout.write(text);
'
  # Spawns, lists and removes sandboxes straight through K8sManager, as a cluster admin.
  MANAGER_JS='
import { pathToFileURL } from "node:url";
const m = await import(pathToFileURL(process.env.REPO_ROOT + "/packages/orchestrator/dist/index.js").href);
const options = m.loadK8sManagerOptions(process.env);
const quiet = { info() {}, warn() {}, error() {} };
const manager = new m.K8sManager({ options, api: m.createK8sApi(m.loadKubeConfig(process.env), { group: options.ingressRouteGroup, version: options.ingressRouteVersion }), logger: quiet });
const [command, ...args] = process.argv.slice(1);
const spawn = (sessionId) => manager.spawnContainer({ image: process.env.SANDBOX_IMAGE, sessionId, agentPort: 7777, resourceLimits: { memoryBytes: 536870912, nanoCpus: 1000000000, pidsLimit: 256 }, env: { PORT: "7777" } });
if (command === "assert-runtime") { await manager.assertRuntimeAvailable(); console.log("runtime ok"); }
else if (command === "spawn") {
  const created = [];
  for (const id of args) created.push((await spawn(id)).containerId);
  console.log(created.join(" "));
} else if (command === "stop") { for (const name of args) await manager.stopContainer(name); console.log("stopped"); }
else if (command === "list") { console.log((await manager.listManagedContainers()).map((c) => c.containerId + ":" + c.status).join(" ")); }
else { console.error("unknown command " + command); process.exit(1); }
'
  manager() { REPO_ROOT="$REPO_ROOT" SANDBOX_IMAGE="$SANDBOX_IMAGE" node --input-type=module -e "$MANAGER_JS" "$@"; }

  start_forwards() {
    stop_forwards
    k -n "$SYSTEM_NS" port-forward svc/live-orchestrator "${API_PORT}:4100" > "$LOG_DIR/pf-api.log" 2>&1 &
    PF_PIDS+=("$!")
    k -n "$SYSTEM_NS" port-forward svc/live-proxy "${PROXY_PORT}:80" > "$LOG_DIR/pf-proxy.log" 2>&1 &
    PF_PIDS+=("$!")
    wait_until 60 url_ok "http://127.0.0.1:${API_PORT}/healthz" || fail "the orchestrator did not answer /healthz through the port-forward"
  }
  stop_forwards() {
    local pid
    for pid in "${PF_PIDS[@]:-}"; do
      [ -n "$pid" ] && kill "$pid" > /dev/null 2>&1 || true
    done
    PF_PIDS=()
  }

  cleanup() {
    stop_forwards
    if [ "$CLUSTER_STARTED" = "1" ]; then
      k -n "$SANDBOX_NS" delete pods,services,ingressroutes.traefik.io -l live.managed=true --wait=false > /dev/null 2>&1 || true
      if [ "$TEARDOWN" = "1" ]; then
        k delete -f packages/proxy/traefik/ingressroute-crd.yaml --ignore-not-found > /dev/null 2>&1 || true
        for file in proxy-deployment orchestrator-deployment postgres redis; do
          k delete -f "infra/k8s/${file}.yaml" --ignore-not-found > /dev/null 2>&1 || true
        done
        k delete -f infra/k8s/network-policy.yaml --ignore-not-found > /dev/null 2>&1 || true
        k delete namespace "$SYSTEM_NS" "$SANDBOX_NS" --ignore-not-found > /dev/null 2>&1 || true
        if [ "$KIND_CREATED_BY_GATE" = "1" ]; then
          kind delete cluster --name "$KIND_NAME" > /dev/null 2>&1 || true
        fi
      fi
    fi
    rm -f "$LOG_DIR/kubeconfig" # last, because the commands above use it; it holds the cluster admin's client certificate
  }
  trap cleanup EXIT

  api() { # api METHOD PATH [TOKEN] [JSON_BODY] -> HTTP status; body in $LOG_DIR/body.json
    local method="$1" path="$2" token="${3:-}" body="${4:-}"
    local args=(-s -o "$LOG_DIR/body.json" -w '%{http_code}' -m 120 -X "$method")
    if [ -n "$token" ]; then
      args+=(-H "Authorization: Bearer ${token}")
    fi
    if [ -n "$body" ]; then
      args+=(-H 'Content-Type: application/json' -d "$body")
    fi
    curl "${args[@]}" "http://127.0.0.1:${API_PORT}${path}" || echo "000"
  }
  jget() {
    node -e '
      const body = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const value = process.argv[2].split(".").reduce((o, key) => (o == null ? undefined : o[key]), body);
      if (value === undefined) { process.exit(2); }
      console.log(typeof value === "object" ? JSON.stringify(value) : value);
    ' "$LOG_DIR/body.json" "$1"
  }
  expect_status() { # expect_status WANT DESCRIPTION METHOD PATH [TOKEN] [BODY]
    local want="$1" description="$2"
    shift 2
    local got
    got="$(api "$@")"
    if [ "$got" = "$want" ]; then
      pass "$description -> $want"
    else
      echo "  response body: $(cat "$LOG_DIR/body.json" 2> /dev/null || true)"
      fail "$description: expected HTTP $want, got $got"
    fi
  }
  create_session() { # create_session TOKEN -> prints the session id
    local got
    got="$(api POST /api/sessions "$1")"
    [ "$got" = "201" ] || { echo "  response body: $(cat "$LOG_DIR/body.json" 2> /dev/null || true)" >&2; fail "POST /api/sessions: expected 201, got $got"; }
    jget sessionId
  }
  pod_gone() { ! k -n "$SANDBOX_NS" get pod "$1" > /dev/null 2>&1; }
  node_names() { # node_names (pods labelled live.managed) -> "pod node" lines
    k -n "$SANDBOX_NS" get pods -l live.managed=true -o json | njs 'd.items.map((p) => p.metadata.name + " " + (p.spec.nodeName || "none")).join("\n")'
  }
  distinct_nodes() { k -n "$SANDBOX_NS" get pods -l live.managed=true -o json | njs 'new Set(d.items.map((p) => p.spec.nodeName)).size'; }

  set_config() { # set_config KEY=VALUE... : patch the ConfigMap and roll the orchestrator
    local patch
    patch="$(node -e 'const o = {}; for (const a of process.argv.slice(1)) { const i = a.indexOf("="); o[a.slice(0, i)] = a.slice(i + 1); } console.log(JSON.stringify({ data: o }));' "$@")"
    k -n "$SYSTEM_NS" patch configmap live-orchestrator-config --type merge -p "$patch" > /dev/null
    k -n "$SYSTEM_NS" rollout restart deploy/live-orchestrator > /dev/null
    kw -n "$SYSTEM_NS" rollout status deploy/live-orchestrator --timeout=300s > /dev/null || fail "the orchestrator did not come back after a configuration change"
    start_forwards
  }

  api_ready() { k get --raw=/readyz > /dev/null 2>&1; }
  wait_for_api() { # wait_for_api SECONDS WHEN : the control plane must be healthy before anything is applied to it
    wait_until "$1" api_ready && return 0
    echo "  API server /readyz: $(k get --raw='/readyz?verbose' 2>&1 | grep -v '^\[+\]' | head -n 8 | tr '\n' ' ')"
    fail "the Kubernetes API server is not ready ($2). The machine is probably short of CPU, memory or disk I/O: give it 4+ CPUs and 8+ GB, or run 'kind delete cluster --name ${KIND_NAME}' and start again"
  }

  # ---- 5.0 pick (or create) the cluster, and isolate this run's kubeconfig ----
  if [ "$CREATE_KIND" = "1" ]; then
    if kind get clusters 2> /dev/null | grep -qx "$KIND_NAME"; then
      note "reusing the existing kind cluster ${KIND_NAME}"
    else
      KIND_CONFIG="kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnodes:\n- role: control-plane\n- role: worker\n- role: worker\n"
      if [ "$KIND_CNI" = "calico" ]; then
        KIND_CONFIG="${KIND_CONFIG}networking:\n  disableDefaultCNI: true\n"
      fi
      printf "$KIND_CONFIG" | kind create cluster --name "$KIND_NAME" --config - > "$LOG_DIR/kind-create.log" 2>&1 \
        || { cat "$LOG_DIR/kind-create.log"; fail "kind create cluster"; }
      KIND_CREATED_BY_GATE=1
      pass "created kind cluster ${KIND_NAME} (1 control-plane + 2 workers, CNI: ${KIND_CNI})"
    fi
  fi
  kubectl config get-contexts -o name | grep -qx "$CONTEXT" || fail "kubectl context \"$CONTEXT\" does not exist"
  # A kubeconfig holding only this context: nothing below can touch another cluster.
  kubectl config view --minify --flatten --context="$CONTEXT" > "$LOG_DIR/kubeconfig" || fail "could not read context $CONTEXT"
  chmod 600 "$LOG_DIR/kubeconfig"
  export KUBECONFIG="$LOG_DIR/kubeconfig"
  CLUSTER_STARTED=1
  k version > /dev/null 2>&1 || fail "cannot reach the cluster of context $CONTEXT"
  wait_for_api 120 "right after connecting"
  # A kind cluster created without a CNI (calico mode) stays NotReady until Calico is installed. Install it
  # whenever it is missing, not only on the run that created the cluster: an earlier run may have stopped
  # before Calico was applied.
  if [ "$CREATE_KIND" = "1" ] && [ "$KIND_CNI" = "calico" ] \
    && ! k -n kube-system get ds calico-node > /dev/null 2>&1 && ! k -n kube-system get ds kindnet > /dev/null 2>&1; then
    k apply -f "$CALICO_URL" > "$LOG_DIR/calico.log" 2>&1 || { cat "$LOG_DIR/calico.log"; fail "installing Calico"; }
    # kind nodes are containers on a host whose reverse-path filtering may be "loose"; without this Calico's
    # felix refuses to start there (the documented kind setup).
    k -n kube-system set env ds/calico-node FELIX_IGNORELOOSERPF=true > /dev/null || fail "configuring Calico for kind"
    kw -n kube-system rollout status ds/calico-node --timeout=420s > /dev/null || fail "Calico did not become ready"
    kw -n kube-system rollout status deploy/calico-kube-controllers --timeout=300s > /dev/null || fail "calico-kube-controllers did not become ready"
    pass "installed Calico, so NetworkPolicy is enforced"
  fi
  kw wait --for=condition=Ready node --all --timeout=300s > /dev/null || fail "not every node became Ready"
  # Cluster DNS carries every Service lookup below (Redis, Postgres, the sandbox Services).
  kw -n kube-system rollout status deploy/coredns --timeout=300s > /dev/null || fail "CoreDNS did not become ready"
  wait_for_api 120 "after the nodes became Ready"

  SCHEDULABLE="$(k get nodes -o json | njs 'd.items.filter((n) => n.status.conditions.some((c) => c.type === "Ready" && c.status === "True") && !n.spec.unschedulable && !(n.spec.taints || []).some((t) => t.effect === "NoSchedule" || t.effect === "NoExecute")).map((n) => n.metadata.name).join(" ")')"
  NODE_COUNT="$(echo "$SCHEDULABLE" | wc -w | tr -d ' ')"
  [ "$NODE_COUNT" -ge 2 ] || fail "the cluster has $NODE_COUNT Ready schedulable node(s) (${SCHEDULABLE}); Phase 10 needs at least 2"
  pass "context ${CONTEXT} has ${NODE_COUNT} Ready schedulable nodes: ${SCHEDULABLE}"

  # ---- 5.1 images ----
  #
  # `kind load docker-image` can fail on a host whose Docker uses the containerd image store (the default
  # on new installs). Pulled images are then multi-platform indexes that also carry attestation manifests,
  # and kind imports them with `ctr import --all-platforms --digests`, which fails in one of two ways:
  #     ctr: content digest sha256:...: not found                   (a platform that was never downloaded)
  #     ctr: mismatched image rootfs and manifest layers            (an attestation manifest is not an image)
  # Both flags are only needed for images that must run on every platform. The nodes here run the host's
  # platform, so the fallbacks below import without them.
  #
  # Images go to the schedulable (worker) nodes only. The control-plane node cannot run workloads, and
  # unpacking several hundred MB into its containerd competes with etcd and the API server for disk and
  # CPU, which on a small machine is enough to make the API server's health checks fail.
  kind_nodes() { echo "$SCHEDULABLE"; } # kind names a node after its container, so these are docker container names

  image_on_node() { docker exec "$1" crictl inspecti "$2" > /dev/null 2>&1; } # image_on_node NODE IMAGE

  # Imports an image archive into one node's containerd the way kind does, minus --all-platforms/--digests.
  import_into_node() { # import_into_node NODE ARCHIVE
    docker exec --privileged -i "$1" ctr --namespace=k8s.io images import --snapshotter=overlayfs - < "$2" \
      >> "$LOG_DIR/kind-load-fallback.log" 2>&1
  }

  load_into_kind() { # load_into_kind IMAGE KIND_CLUSTER_NAME [public]
    local image="$1" name="$2" kind_of_image="${3:-local}" archive="$LOG_DIR/image-load.tar" platform node nodes missing=0
    nodes="$(kind_nodes)"
    : > "$LOG_DIR/kind-load.log"
    : > "$LOG_DIR/kind-load-fallback.log"

    # Registry images are identified by their tag, so a node that already has one needs nothing.
    # (A locally built image can change under the same tag, so it is always loaded again.)
    if [ "$kind_of_image" = "public" ]; then
      for node in $nodes; do image_on_node "$node" "$image" || missing=1; done
      if [ "$missing" = "0" ]; then
        return 0
      fi
    fi

    # 1. kind's own loader, the fast path where it works.
    if kind load docker-image "$image" --name "$name" --nodes "${nodes// /,}" > "$LOG_DIR/kind-load.log" 2>&1; then
      return 0
    fi

    # 2. Export only the host platform and import it ourselves.
    platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2> /dev/null || true)"
    note "kind load docker-image ${image} failed; importing an archive of ${platform:-the host platform} only"
    if { docker save --platform "$platform" -o "$archive" "$image" || docker save -o "$archive" "$image"; } >> "$LOG_DIR/kind-load-fallback.log" 2>&1; then
      missing=0
      for node in $nodes; do
        import_into_node "$node" "$archive" || missing=1
      done
      rm -f "$archive"
      if [ "$missing" = "0" ]; then
        return 0
      fi
    fi
    rm -f "$archive"

    # 3. A registry image can also be pulled by the nodes themselves.
    if [ "$kind_of_image" = "public" ]; then
      note "importing ${image} failed; the nodes will pull it from the registry"
      missing=0
      for node in $nodes; do
        for _ in 1 2 3; do
          if docker exec "$node" crictl pull "$image" >> "$LOG_DIR/kind-load-fallback.log" 2>&1; then
            continue 2
          fi
          sleep 3
        done
        missing=1
      done
      if [ "$missing" = "0" ]; then
        return 0
      fi
    fi

    cat "$LOG_DIR/kind-load.log" "$LOG_DIR/kind-load-fallback.log"
    return 1
  }

  # The sandbox image is built locally and is in no registry: a kind cluster cannot get it any other way.
  if [[ "$CONTEXT" == kind-* ]] && ! docker image inspect "$SANDBOX_IMAGE" > /dev/null 2>&1; then
    fail "the sandbox image ${SANDBOX_IMAGE} is not on this host, and no cluster can pull it. Build it first: bash scripts/seed-sandbox-image.sh"
  fi
  # The pods run as a fixed numeric user (K8S_SANDBOX_UID/GID): it must be the image's `sandbox` user, or the
  # agent cannot write to /workspace. Check it where the image is available.
  if docker image inspect "$SANDBOX_IMAGE" > /dev/null 2>&1; then
    MANIFEST_UID="$(sed -n 's/^ *K8S_SANDBOX_UID: "\([0-9]*\)".*/\1/p' infra/k8s/orchestrator-deployment.yaml | head -n 1)"
    MANIFEST_GID="$(sed -n 's/^ *K8S_SANDBOX_GID: "\([0-9]*\)".*/\1/p' infra/k8s/orchestrator-deployment.yaml | head -n 1)"
    IMAGE_UID="$(docker run --rm --entrypoint id "$SANDBOX_IMAGE" -u sandbox 2> /dev/null || true)"
    IMAGE_GID="$(docker run --rm --entrypoint id "$SANDBOX_IMAGE" -g sandbox 2> /dev/null || true)"
    if [ -n "$IMAGE_UID" ] && [ -n "$IMAGE_GID" ] && { [ "$IMAGE_UID" != "${MANIFEST_UID:-999}" ] || [ "$IMAGE_GID" != "${MANIFEST_GID:-999}" ]; }; then
      fail "the sandbox image's user is ${IMAGE_UID}:${IMAGE_GID}, but the pods run as ${MANIFEST_UID:-999}:${MANIFEST_GID:-999}. Set K8S_SANDBOX_UID/K8S_SANDBOX_GID in infra/k8s/orchestrator-deployment.yaml to match"
    fi
    pass "the sandbox image's user (${IMAGE_UID:-unknown}:${IMAGE_GID:-unknown}) matches the pods' numeric user"
  fi

  if [ "$SKIP_IMAGE_BUILD" != "1" ]; then
    docker build -f packages/orchestrator/Dockerfile -t "$ORCH_IMAGE" . > "$LOG_DIR/orch-build.log" 2>&1 \
      && pass "built the orchestrator image ${ORCH_IMAGE}" \
      || { tail -n 30 "$LOG_DIR/orch-build.log"; fail "docker build of the orchestrator image"; }
  fi
  if [[ "$CONTEXT" == kind-* ]]; then
    KIND_TARGET="${CONTEXT#kind-}"
    # The two images this repository builds must reach the nodes; the three registry images may also be pulled.
    for image in "$ORCH_IMAGE" "$SANDBOX_IMAGE"; do
      load_into_kind "$image" "$KIND_TARGET" local || fail "could not load $image into the kind nodes (see the output above)"
      wait_for_api 120 "after loading $image"
    done
    for image in redis:7-alpine postgres:16-alpine traefik:v3.1; do
      if docker image inspect "$image" > /dev/null 2>&1; then
        load_into_kind "$image" "$KIND_TARGET" public || fail "could not load $image into the kind nodes, and the nodes could not pull it (see the output above)"
        wait_for_api 120 "after loading $image"
      else
        note "image $image is not on this host, so the nodes will pull it"
      fi
    done
    pass "loaded the images into kind (worker nodes: $(kind_nodes))"
  else
    note "not a kind cluster: ${ORCH_IMAGE} and ${SANDBOX_IMAGE} must already be pullable by every node"
  fi

  # ---- 5.2 CRDs, namespaces, secrets, manifests ----
  k apply --server-side -f "$TRAEFIK_CRD_URL" > "$LOG_DIR/crds.log" 2>&1 || { tail -n 20 "$LOG_DIR/crds.log"; fail "installing the Traefik CRDs"; }
  kw wait --for=condition=established --timeout=90s crd/ingressroutes.traefik.io crd/middlewares.traefik.io > /dev/null || fail "the Traefik CRDs were not established"
  pass "Traefik CRDs installed (IngressRoute, Middleware)"

  SWAPS="$(node -e '
    const [orch, sandbox, noGvisor] = process.argv.slice(1);
    const swaps = [["image: live/orchestrator:latest", "image: " + orch], ["SANDBOX_IMAGE: \"live/sandbox-base:latest\"", "SANDBOX_IMAGE: \"" + sandbox + "\""]];
    if (noGvisor === "1") { swaps.push(["K8S_SANDBOX_RUNTIME_CLASS: \"gvisor\"", "K8S_SANDBOX_RUNTIME_CLASS: \"\"\n  K8S_ALLOW_DEFAULT_RUNTIME: \"true\""]); }
    console.log(JSON.stringify(swaps));
  ' "$ORCH_IMAGE" "$SANDBOX_IMAGE" "$ALLOW_NO_GVISOR")"
  export SWAPS
  render() { node -e "$RENDER_JS" "$1"; }
  render infra/k8s/orchestrator-deployment.yaml | grep -q "image: ${ORCH_IMAGE}" || fail "could not set the orchestrator image in the manifest"
  if [ "$ALLOW_NO_GVISOR" = "1" ]; then
    note "P10_ALLOW_NO_GVISOR=1: sandboxes run under the default runtime, NOT gVisor"
  fi

  k apply -f infra/k8s/network-policy.yaml > /dev/null || fail "applying network-policy.yaml"
  k get namespace "$SYSTEM_NS" > /dev/null 2>&1 || k create namespace "$SYSTEM_NS" > /dev/null
  ensure_secret() { # ensure_secret NAME KEY VALUE : create once, never rotate (Postgres reads its password only on first start)
    if ! k -n "$SYSTEM_NS" get secret "$1" > /dev/null 2>&1; then
      k -n "$SYSTEM_NS" create secret generic "$1" --from-literal="$2=$3" > /dev/null || fail "creating secret $1"
    fi
  }
  rand() { node -e 'console.log(require("crypto").randomBytes(+process.argv[1]).toString("hex"))' "$1"; }
  ensure_secret live-redis password "rd$(rand 12)"
  ensure_secret live-postgres password "pg$(rand 12)"
  ALICE_PASSWORD="alice-$(rand 6)"
  BOB_PASSWORD="bob-$(rand 6)"
  AUTH_USERS="$(ALICE_PASSWORD="$ALICE_PASSWORD" BOB_PASSWORD="$BOB_PASSWORD" node --input-type=module -e '
    const { hashPassword } = await import("./packages/orchestrator/dist/index.js");
    console.log(JSON.stringify([
      { id: "u_alice", username: "alice", passwordHash: await hashPassword(process.env.ALICE_PASSWORD) },
      { id: "u_bob", username: "bob", passwordHash: await hashPassword(process.env.BOB_PASSWORD) },
    ]));
  ')"
  k -n "$SYSTEM_NS" create secret generic live-orchestrator-auth --from-literal=auth-secret="$(rand 32)" --from-literal=auth-users="$AUTH_USERS" \
    --dry-run=client -o yaml | k apply -f - > /dev/null || fail "creating the orchestrator auth secret"
  pass "secrets exist (data-store passwords are kept between runs; sign-in accounts are regenerated)"

  render infra/k8s/redis.yaml | k apply --dry-run=server -f - > /dev/null || fail "the API server rejected redis.yaml"
  render infra/k8s/postgres.yaml | k apply --dry-run=server -f - > /dev/null || fail "the API server rejected postgres.yaml"
  render infra/k8s/proxy-deployment.yaml | k apply --dry-run=server -f - > /dev/null || fail "the API server rejected proxy-deployment.yaml"
  render infra/k8s/orchestrator-deployment.yaml | k apply --dry-run=server -f - > /dev/null || fail "the API server rejected orchestrator-deployment.yaml"
  render packages/proxy/traefik/ingressroute-crd.yaml | k apply --dry-run=server -f - > /dev/null || fail "the API server rejected ingressroute-crd.yaml"
  pass "the API server accepts every manifest (server-side dry run)"

  render infra/k8s/redis.yaml | k apply -f - > /dev/null || fail "applying redis.yaml"
  render infra/k8s/postgres.yaml | k apply -f - > /dev/null || fail "applying postgres.yaml"
  kw -n "$SYSTEM_NS" rollout status sts/live-redis --timeout=300s > /dev/null || fail "Redis did not become ready"
  kw -n "$SYSTEM_NS" rollout status sts/live-postgres --timeout=300s > /dev/null || fail "Postgres did not become ready"
  pass "Redis and Postgres are running"

  render infra/k8s/orchestrator-deployment.yaml | k apply -f - > /dev/null || fail "applying orchestrator-deployment.yaml"
  render infra/k8s/proxy-deployment.yaml | k apply -f - > /dev/null || fail "applying proxy-deployment.yaml"
  render packages/proxy/traefik/ingressroute-crd.yaml | k apply -f - > /dev/null || fail "applying ingressroute-crd.yaml"
  # A re-run must pick up new secrets and images.
  k -n "$SYSTEM_NS" rollout restart deploy/live-orchestrator > /dev/null
  kw -n "$SYSTEM_NS" rollout status deploy/live-proxy --timeout=300s > /dev/null || fail "the proxy did not become ready"
  kw -n "$SYSTEM_NS" rollout status deploy/live-orchestrator --timeout=300s > /dev/null || fail "the orchestrator did not become ready"
  READY="$(k -n "$SYSTEM_NS" get deploy live-orchestrator -o json | njs 'd.status.readyReplicas')"
  [ "$READY" = "2" ] || fail "expected 2 ready orchestrator replicas, found ${READY}"
  pass "the proxy and 2 orchestrator replicas are running"
  start_forwards
  pass "the orchestrator answers /healthz inside the cluster"

  # ---- 5.3 K8sManager directly: pods across nodes ----
  echo "-- K8sManager against the cluster"
  export K8S_SANDBOX_RUNTIME_CLASS="gvisor"
  if [ "$ALLOW_NO_GVISOR" = "1" ]; then
    export K8S_SANDBOX_RUNTIME_CLASS=""
    export K8S_ALLOW_DEFAULT_RUNTIME="true"
  fi
  manager assert-runtime > /dev/null 2>&1 || fail "K8sManager refuses this cluster: $(manager assert-runtime 2>&1 | tail -n 2)"
  pass "K8sManager accepts the cluster (namespace, Traefik CRDs and RuntimeClass are usable)"
  DIRECT_IDS=(p10direct0 p10direct1 p10direct2 p10direct3)
  DIRECT_POD_NAMES=()
  for id in "${DIRECT_IDS[@]}"; do DIRECT_POD_NAMES+=("sbx-${id}"); done
  manager spawn "${DIRECT_IDS[@]}" > "$LOG_DIR/direct-spawn.out" 2>&1 || { cat "$LOG_DIR/direct-spawn.out"; fail "K8sManager could not start 4 sandboxes"; }
  pass "K8sManager started 4 sandbox pods"
  DIRECT_NODES="$(distinct_nodes)"
  [ "$DIRECT_NODES" -ge 2 ] || fail "the 4 sandbox pods all landed on one node: $(node_names | tr '\n' ';')"
  pass "the sandbox pods are on ${DIRECT_NODES} different nodes: $(node_names | tr '\n' ';')"
  [ "$(k -n "$SANDBOX_NS" get ingressroutes.traefik.io -l live.managed=true -o name | wc -l | tr -d ' ')" = "4" ] \
    && pass "each sandbox has an IngressRoute" || fail "expected 4 IngressRoutes"
  manager stop "${DIRECT_POD_NAMES[@]}" > /dev/null 2>&1 || fail "K8sManager could not stop the sandboxes"
  [ "$(k -n "$SANDBOX_NS" get pods,services,ingressroutes.traefik.io -l live.managed=true -o name | wc -l | tr -d ' ')" = "0" ] \
    && pass "stopping removed every pod, service and IngressRoute" || fail "objects were left behind after stop"
  DIRECT_POD_NAMES=()

  # ---- 5.4 the orchestrator in the cluster ----
  echo "-- the orchestrator in the cluster"
  expect_status 200 "GET /healthz" GET /healthz
  expect_status 401 "an unauthenticated POST /api/sessions" POST /api/sessions
  expect_status 200 "alice signs in" POST /api/auth/login "" "{\"username\":\"alice\",\"password\":\"${ALICE_PASSWORD}\"}"
  ALICE_TOKEN="$(jget token)"
  expect_status 200 "bob signs in" POST /api/auth/login "" "{\"username\":\"bob\",\"password\":\"${BOB_PASSWORD}\"}"
  BOB_TOKEN="$(jget token)"

  SIDS=()
  for _ in 1 2 3 4; do
    SID="$(create_session "$ALICE_TOKEN")"
    SIDS+=("$SID")
    CREATED_SESSION_IDS+=("$SID")
    [ "$(jget containerId)" = "sbx-${SID}" ] || fail "the session's container id is not the pod name sbx-${SID}"
  done
  pass "alice created 4 sessions through the orchestrator (each is a sandbox pod)"
  ORCH_NODES="$(distinct_nodes)"
  [ "$ORCH_NODES" -ge 2 ] || fail "all 4 sandbox pods landed on one node: $(node_names | tr '\n' ';')"
  pass "the sandbox pods are on ${ORCH_NODES} different nodes: $(node_names | tr '\n' ';')"

  S1="${SIDS[0]}"
  P1="sbx-${S1}"
  k -n "$SANDBOX_NS" get pod "$P1" -o json | njs '
    const c = d.spec.containers[0];
    const problems = [];
    if (d.spec.automountServiceAccountToken !== false) problems.push("service-account token is mounted");
    if (d.spec.securityContext.runAsNonRoot !== true) problems.push("runAsNonRoot is not set");
    if (JSON.stringify(c.securityContext.capabilities.drop) !== "[\"ALL\"]") problems.push("capabilities are not dropped");
    if (c.securityContext.allowPrivilegeEscalation !== false) problems.push("privilege escalation allowed");
    if (c.resources.limits.memory !== "536870912") problems.push("memory limit is " + c.resources.limits.memory);
    if (!(d.spec.topologySpreadConstraints || []).length) problems.push("no topology spread constraint");
    if (Object.keys(d.metadata.labels).some((l) => l.startsWith("traefik."))) problems.push("pod carries traefik labels");
    problems.join("; ")' > "$LOG_DIR/podcheck.out" 2> "$LOG_DIR/podcheck.err" || { cat "$LOG_DIR/podcheck.err"; fail "could not inspect pod $P1"; }
  [ ! -s "$LOG_DIR/podcheck.out" ] && pass "pod ${P1}: no API token, non-root, no capabilities, memory limit, topology spread, no traefik labels" \
    || fail "pod $P1 is not hardened: $(cat "$LOG_DIR/podcheck.out")"
  if [ "$ALLOW_NO_GVISOR" != "1" ]; then
    [ "$(k -n "$SANDBOX_NS" get pod "$P1" -o json | njs 'd.spec.runtimeClassName')" = "gvisor" ] \
      && pass "pod ${P1} runs under the gvisor RuntimeClass" || fail "pod $P1 is not under the gvisor RuntimeClass"
    KERNEL="$(k -n "$SANDBOX_NS" exec "$P1" -- cat /proc/version 2> /dev/null || true)"
    echo "$KERNEL" | grep -qi gvisor && pass "the kernel the sandbox sees is gVisor's: ${KERNEL}" || fail "the sandbox sees a normal kernel, not gVisor: ${KERNEL}"
  fi

  # Routing is by IngressRoute objects, owned by the pod.
  [ "$(k -n "$SANDBOX_NS" get ingressroutes.traefik.io -l "live.session-id=${S1}" -o json | njs 'd.items.length')" -ge 1 ] \
    && pass "session ${S1} has an IngressRoute (a Traefik CRD object)" || fail "no IngressRoute for session ${S1}"
  [ "$(k -n "$SANDBOX_NS" get ingressroutes.traefik.io "$P1" -o json | njs 'd.metadata.ownerReferences[0].kind + "/" + d.metadata.ownerReferences[0].name')" = "Pod/${P1}" ] \
    && pass "the IngressRoute is owned by the pod, so it is removed with it" || fail "the IngressRoute has no pod owner"
  k -n "$SYSTEM_NS" get deploy live-proxy -o json | njs '
    const text = JSON.stringify(d.spec.template.spec);
    const problems = [];
    if (text.includes("providers.docker")) problems.push("Docker provider enabled");
    if (text.includes("docker.sock")) problems.push("Docker socket mounted");
    if ((d.spec.template.spec.volumes || []).some((v) => v.hostPath)) problems.push("hostPath volume");
    if (!text.includes("providers.kubernetescrd=true")) problems.push("CRD provider not enabled");
    problems.join("; ")' > "$LOG_DIR/proxycheck.out" || fail "could not inspect the proxy deployment"
  [ ! -s "$LOG_DIR/proxycheck.out" ] && pass "the running proxy uses the Kubernetes CRD provider: no Docker provider, no Docker socket, no hostPath" \
    || fail "the running proxy is misconfigured: $(cat "$LOG_DIR/proxycheck.out")"

  # A web server started in the sandbox is reachable through Traefik, and the route goes away with the pod.
  k -n "$SANDBOX_NS" exec "$P1" -- sh -c 'nohup node -e "$0" > /dev/null 2>&1 &' "$PREVIEW_JS" || fail "could not start a web server in the sandbox"
  preview_ok() { [ "$(curl -s -m 3 -H "Host: ${S1}.localhost" "http://127.0.0.1:${PROXY_PORT}/")" = "p10-preview-ok" ]; }
  wait_until 45 preview_ok || fail "http://${S1}.localhost/ did not reach the sandbox through Traefik"
  pass "http://${S1}.localhost/ reaches the sandbox's port 8080 through Traefik, discovered from the IngressRoute"

  # Isolation: the NetworkPolicies must actually be enforced.
  echo "-- sandbox isolation"
  S2="${SIDS[1]}"
  OTHER_IP="$(k -n "$SANDBOX_NS" get pod "sbx-${S2}" -o jsonpath='{.status.podIP}')"
  ORCH_IP="$(k -n "$SYSTEM_NS" get pods -l app.kubernetes.io/name=live-orchestrator -o jsonpath='{.items[0].status.podIP}')"
  HOST_IP="$(k -n "$SANDBOX_NS" get pod "$P1" -o jsonpath='{.status.hostIP}')"
  k -n "$SANDBOX_NS" exec "$P1" -- node -e "$PROBE_JS" "local=127.0.0.1:7777" "dns=live-orchestrator.${SYSTEM_NS}.svc" \
    "other-sandbox=${OTHER_IP}:7777" "orchestrator-pod=${ORCH_IP}:4100" "orchestrator-service=live-orchestrator.${SYSTEM_NS}.svc:4100" \
    "kubernetes-api=kubernetes.default.svc:443" "node-kubelet=${HOST_IP}:10250" "cloud-metadata=169.254.169.254:80" > "$LOG_DIR/probe.out" 2>&1 \
    || { cat "$LOG_DIR/probe.out"; fail "the probe could not run inside the sandbox"; }
  grep -q "^local OPEN$" "$LOG_DIR/probe.out" || { cat "$LOG_DIR/probe.out"; fail "control failed: the sandbox cannot reach its own agent, so the probe proves nothing"; }
  grep -q "^dns OK$" "$LOG_DIR/probe.out" || { cat "$LOG_DIR/probe.out"; fail "control failed: DNS does not work from the sandbox, so blocked connections would prove nothing"; }
  pass "controls: the sandbox reaches its own agent and can resolve DNS"
  LEAKS="$(grep -v -E "^(local OPEN|dns OK)$" "$LOG_DIR/probe.out" | grep -v -E " BLOCKED:(timeout|EHOSTUNREACH|ENETUNREACH)$" || true)"
  if [ -n "$LEAKS" ]; then
    echo "$LEAKS"
    if [ "$ALLOW_NO_NETPOL" = "1" ]; then
      note "P10_ALLOW_NO_NETPOL=1: this cluster does NOT enforce NetworkPolicy; sandboxes are not network-isolated"
    else
      fail "the sandbox can reach things it must not. Does the cluster's CNI enforce NetworkPolicy? (use Calico or Cilium, or P10_KIND_CNI=calico)"
    fi
  else
    pass "blocked from the sandbox: other sandboxes, the orchestrator (pod and service), the Kubernetes API, the node's kubelet, cloud metadata"
  fi

  # Ownership, heartbeats (Phases 5 and 7 on the cluster).
  echo "-- ownership and heartbeats"
  expect_status 404 "bob GET alice's session" GET "/api/sessions/${S1}" "$BOB_TOKEN"
  expect_status 404 "bob DELETE alice's session" DELETE "/api/sessions/${S1}" "$BOB_TOKEN"
  [ "$(k -n "$SANDBOX_NS" get pod "$P1" -o json | njs 'd.status.phase')" = "Running" ] && pass "alice's sandbox is untouched by bob's attempts" || fail "bob's DELETE affected alice's sandbox"
  expect_status 200 "bob lists his sessions" GET /api/sessions "$BOB_TOKEN"
  [ "$(jget sessions | njs 'd.length')" = "0" ] && pass "bob sees none of alice's sessions" || fail "bob can see alice's sessions"
  expect_status 200 "alice heartbeats" POST "/api/sessions/${S1}/heartbeat" "$ALICE_TOKEN"

  # Ending a session removes the pod, its service, its routes, and the preview.
  S4="${SIDS[3]}"
  expect_status 200 "alice ends a session" DELETE "/api/sessions/${S4}" "$ALICE_TOKEN"
  wait_until 30 pod_gone "sbx-${S4}" && pass "the sandbox pod is gone" || fail "the sandbox pod is still there after DELETE"
  [ "$(k -n "$SANDBOX_NS" get services,ingressroutes.traefik.io -l "live.session-id=${S4}" -o name | wc -l | tr -d ' ')" = "0" ] \
    && pass "its service and IngressRoute are gone too" || fail "service or IngressRoute left behind"
  expect_status 404 "a second DELETE" DELETE "/api/sessions/${S4}" "$ALICE_TOKEN"
  expect_status 200 "alice ends the session that served a preview" DELETE "/api/sessions/${S1}" "$ALICE_TOKEN"
  preview_gone() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Host: ${S1}.localhost" "http://127.0.0.1:${PROXY_PORT}/")" = "404" ]; }
  wait_until 45 preview_gone && pass "the preview route disappeared with the sandbox (404), with no proxy restart" || fail "the route for ${S1} is still served"
  expect_status 200 "alice ends another session" DELETE "/api/sessions/${SIDS[1]}" "$ALICE_TOKEN"
  expect_status 200 "alice ends the last session" DELETE "/api/sessions/${SIDS[2]}" "$ALICE_TOKEN"

  # The idle reaper, on the cluster.
  echo "-- idle reaper (12 s timeout)"
  set_config SESSION_IDLE_TIMEOUT_MS=12000 IDLE_REAPER_INTERVAL_MS=1000
  IDLE_SID="$(create_session "$ALICE_TOKEN")"; CREATED_SESSION_IDS+=("$IDLE_SID")
  LIVE_SID="$(create_session "$ALICE_TOKEN")"; CREATED_SESSION_IDS+=("$LIVE_SID")
  for ((i = 0; i < 9; i++)); do
    sleep 3
    api POST "/api/sessions/${LIVE_SID}/heartbeat" "$ALICE_TOKEN" > /dev/null
  done
  expect_status 200 "the session with heartbeats is still there after 27 s" GET "/api/sessions/${LIVE_SID}" "$ALICE_TOKEN"
  expect_status 404 "the idle session was reaped" GET "/api/sessions/${IDLE_SID}" "$ALICE_TOKEN"
  wait_until 30 pod_gone "sbx-${IDLE_SID}" && pass "the idle session's pod was removed" || fail "the idle session's pod is still there"
  gone_after_heartbeats_stop() { [ "$(api GET "/api/sessions/${LIVE_SID}" "$ALICE_TOKEN")" = "404" ]; }
  wait_until 40 gone_after_heartbeats_stop && pass "once heartbeats stopped, that session was reaped too" || fail "the session was never reaped"
  wait_until 30 pod_gone "sbx-${LIVE_SID}" || fail "its pod is still there"

  # Orchestrator restart and the reconciler.
  echo "-- orchestrator restart and reconciler"
  set_config SESSION_IDLE_TIMEOUT_MS=1800000 IDLE_REAPER_INTERVAL_MS=30000 RECONCILE_GRACE_MS=1000
  KEEP_SID="$(create_session "$ALICE_TOKEN")"; CREATED_SESSION_IDS+=("$KEEP_SID")
  STALE_SID="$(create_session "$ALICE_TOKEN")"; CREATED_SESSION_IDS+=("$STALE_SID")
  KEEP_UID="$(k -n "$SANDBOX_NS" get pod "sbx-${KEEP_SID}" -o jsonpath='{.metadata.uid}')"
  k -n "$SANDBOX_NS" delete pod "sbx-${STALE_SID}" --wait=true > /dev/null || fail "could not delete the stale session's pod"
  manager spawn p10orphan > /dev/null 2>&1 || fail "could not create the orphan sandbox"
  DIRECT_POD_NAMES=("sbx-p10orphan")
  sleep 3
  k -n "$SYSTEM_NS" rollout restart deploy/live-orchestrator > /dev/null
  kw -n "$SYSTEM_NS" rollout status deploy/live-orchestrator --timeout=300s > /dev/null || fail "the orchestrator did not come back after a restart"
  start_forwards
  k -n "$SYSTEM_NS" logs -l app.kubernetes.io/name=live-orchestrator --tail=300 2> /dev/null | grep -q "reconciler complete" \
    && pass "the reconciler ran when the orchestrator restarted" || fail "no reconciler run in the orchestrator logs"
  expect_status 200 "the healthy session survived the restart" GET "/api/sessions/${KEEP_SID}" "$ALICE_TOKEN"
  [ "$(k -n "$SANDBOX_NS" get pod "sbx-${KEEP_SID}" -o jsonpath='{.metadata.uid}')" = "$KEEP_UID" ] \
    && pass "and it is the same pod, still running (not recreated)" || fail "the healthy session's pod was replaced"
  expect_status 200 "its heartbeat is accepted" POST "/api/sessions/${KEEP_SID}/heartbeat" "$ALICE_TOKEN"
  expect_status 404 "the session whose pod vanished lost its stale record" GET "/api/sessions/${STALE_SID}" "$ALICE_TOKEN"
  wait_until 60 pod_gone sbx-p10orphan && pass "the orphan sandbox (a managed pod with no record) was removed" || fail "the orphan pod is still there"
  DIRECT_POD_NAMES=()
  expect_status 200 "alice ends the surviving session" DELETE "/api/sessions/${KEEP_SID}" "$ALICE_TOKEN"
  set_config RECONCILE_GRACE_MS=60000
  [ "$(k -n "$SANDBOX_NS" get pods,services,ingressroutes.traefik.io -l live.managed=true -o name | wc -l | tr -d ' ')" = "0" ] \
    && pass "no sandbox object is left in the cluster" || fail "sandbox objects were left behind"
  echo
fi

if [ "${#SKIPPED[@]}" -gt 0 ]; then
  note "Skipped: ${SKIPPED[*]}. This was NOT a full Phase 10 pass."
  echo "Phase 10 checks passed (with skips)."
else
  if [ "$ALLOW_NO_GVISOR" = "1" ]; then
    note "Sandboxes ran WITHOUT gVisor (P10_ALLOW_NO_GVISOR=1). Re-run on nodes with runsc before relying on isolation."
  fi
  note "The proxy ran with one replica and plain HTTP: issuing a real wildcard certificate needs a domain and DNS credentials (see infra/k8s/proxy-deployment.yaml)."
  echo "All Phase 10 checks passed."
fi