#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }
note() { echo "  NOTE: $1"; }

if ! command -v docker > /dev/null 2>&1; then
  fail "docker is required to run Phase 4 verification but was not found on PATH"
fi
if ! docker compose version > /dev/null 2>&1; then
  fail "docker compose (v2 plugin) is required to run Phase 4 verification"
fi

NETWORK_NAME="live-network"
TEST_TLS="p4-verify-session-tls"
FAKE_HOST="verify-tls.p4-local-test.invalid"

cleanup() {
  docker rm -f "$TEST_TLS" > /dev/null 2>&1 || true
  rm -f "$REPO_ROOT/phases/p4-dns-https/.label-check.tmp.mjs"
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# 1. Phase 3 regression: everything that worked before must still work,
#    completely unmodified, when TLS is not configured (default hostSuffix).
# --------------------------------------------------------------------------
echo "== Phase 4 verify: Phase 3 regression suite (includes Phases 0-2) =="
bash phases/p3-reverse-proxy/verify.sh
pass "Phase 3 regression suite (reverse proxy, and everything under it)"
echo

echo "== Phase 4 verify: pnpm install =="
pnpm install --frozen-lockfile=false > /tmp/p4-install.log 2>&1 \
  && pass "pnpm install" \
  || { cat /tmp/p4-install.log; fail "pnpm install"; }
echo

echo "== Phase 4 verify: build all packages (incl. updated proxyLabels) =="
pnpm run build > /tmp/p4-build.log 2>&1 \
  && pass "pnpm build" \
  || { cat /tmp/p4-build.log; fail "pnpm build"; }
echo

# --------------------------------------------------------------------------
# 2. Unit-level check of computeProxyLabels itself: TLS label shape is
#    correct, deterministic, and additive on top of the Phase 3 HTTP labels
#    -- independent of Docker/Traefik being up at all.
# --------------------------------------------------------------------------
echo "== Phase 4 verify: computeProxyLabels emits correct TLS labels =="
LABEL_CHECK="$REPO_ROOT/phases/p4-dns-https/.label-check.tmp.mjs"
cat > "$LABEL_CHECK" << 'NODEEOF'
import {
  computeProxyLabels,
  getHostSuffixFromEnv,
} from "../../packages/orchestrator/dist/containers/proxyLabels.js";

function expect(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Default (.localhost): must be unchanged from Phase 3 -- no TLS labels.
const localLabels = computeProxyLabels("Session A!!");
expect(localLabels["traefik.enable"] === "true", "local: traefik.enable");
expect(
  localLabels["traefik.http.routers.session-session-a.rule"] === "Host(`session-a.localhost`)",
  "local: http router rule",
);
expect(
  Object.keys(localLabels).every((k) => !k.includes("tls")),
  "local: no TLS labels should be present for the default .localhost hostSuffix",
);

// Real domain: TLS must turn on automatically, with the wildcard SAN, no
// extra flags required.
const tlsLabels = computeProxyLabels("Session A!!", {
  hostSuffix: ".sessions.yourdomain.dev",
});
expect(
  tlsLabels["traefik.http.routers.session-session-a-secure.rule"] ===
    "Host(`session-a.sessions.yourdomain.dev`)",
  "tls: secure router rule",
);
expect(
  tlsLabels["traefik.http.routers.session-session-a-secure.tls.certresolver"] === "letsencrypt",
  "tls: certresolver label present",
);
expect(
  tlsLabels["traefik.http.routers.session-session-a-secure.tls.domains[0].main"] ===
    "sessions.yourdomain.dev",
  "tls: wildcard main domain derived correctly",
);
expect(
  tlsLabels["traefik.http.routers.session-session-a-secure.tls.domains[0].sans"] ===
    "*.sessions.yourdomain.dev",
  "tls: wildcard SAN derived correctly",
);
expect(
  tlsLabels["traefik.http.routers.session-session-a.middlewares"] ===
    "session-session-a-https-redirect",
  "tls: plain-HTTP router redirects to HTTPS",
);

// A second, distinct session must reuse the SAME wildcard domain/SANs
// (this is what lets Traefik serve every session off one issued cert).
const tlsLabelsOther = computeProxyLabels("Session B!!", {
  hostSuffix: ".sessions.yourdomain.dev",
});
expect(
  tlsLabelsOther["traefik.http.routers.session-session-b-secure.tls.domains[0].sans"] ===
    tlsLabels["traefik.http.routers.session-session-a-secure.tls.domains[0].sans"],
  "tls: distinct sessions share the same wildcard SAN (one cert, not one per session)",
);

// getHostSuffixFromEnv: this is what dockerManager uses to switch a real
// spawn from .localhost/HTTP to a real domain/HTTPS.
expect(getHostSuffixFromEnv({}) === ".localhost", "env: unset -> .localhost");
expect(getHostSuffixFromEnv({ SESSION_HOST_SUFFIX: "  " }) === ".localhost", "env: blank -> .localhost");
expect(
  getHostSuffixFromEnv({ SESSION_HOST_SUFFIX: "sessions.yourdomain.dev" }) === ".sessions.yourdomain.dev",
  "env: leading dot is added",
);
expect(
  getHostSuffixFromEnv({ SESSION_HOST_SUFFIX: ".Sessions.YourDomain.dev" }) === ".sessions.yourdomain.dev",
  "env: value is lowercased and an existing dot is kept",
);
const fromEnv = computeProxyLabels("env-session", {
  hostSuffix: getHostSuffixFromEnv({ SESSION_HOST_SUFFIX: "sessions.yourdomain.dev" }),
});
expect(
  fromEnv["traefik.http.routers.session-env-session-secure.tls.certresolver"] === "letsencrypt",
  "env: SESSION_HOST_SUFFIX alone is enough to turn on TLS labels",
);

console.log("all label assertions passed");
NODEEOF
node "$LABEL_CHECK" > /tmp/p4-label-check.log 2>&1 \
  && pass "computeProxyLabels TLS + regression label assertions" \
  || { cat /tmp/p4-label-check.log; fail "computeProxyLabels label assertions"; }
echo

# --------------------------------------------------------------------------
# 3. Shared proxy network + merged Traefik static config (traefik.yml +
#    acme.yml) actually starts and exposes both entrypoints.
# --------------------------------------------------------------------------
echo "== Phase 4 verify: shared proxy network exists =="
if [ -f "./scripts/ensure-proxy-network.sh" ]; then
  PROXY_NETWORK_NAME="$NETWORK_NAME" bash ./scripts/ensure-proxy-network.sh > /tmp/p4-network.log 2>&1 \
    && pass "docker network ${NETWORK_NAME} exists" \
    || { cat /tmp/p4-network.log; fail "could not ensure docker network ${NETWORK_NAME} exists"; }
else
  docker network inspect "$NETWORK_NAME" > /dev/null 2>&1 || docker network create --driver bridge "$NETWORK_NAME" > /dev/null
  pass "docker network ${NETWORK_NAME} created/verified"
fi
echo

echo "== Phase 4 verify: bring up docker compose stack (traefik with acme.yml merged) =="
export ACME_EMAIL="${ACME_EMAIL:-p4-verify@example.invalid}"
docker compose up -d > /tmp/p4-compose-up.log 2>&1 \
  && pass "docker compose up" \
  || { cat /tmp/p4-compose-up.log; fail "docker compose up"; }
echo

echo "== Phase 4 verify: Traefik API reachable and both entrypoints registered =="
TRAEFIK_READY=false
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:8080/api/rawdata" > /dev/null 2>&1; then
    TRAEFIK_READY=true
    break
  fi
  sleep 1
done
[ "$TRAEFIK_READY" = true ] \
  && pass "Traefik API reachable on :8080" \
  || fail "Traefik API never became reachable on :8080"

ENTRYPOINTS_JSON="$(curl -sf http://127.0.0.1:8080/api/entrypoints || true)"
echo "$ENTRYPOINTS_JSON" | grep -q '"name":"web"' \
  && pass "entrypoint 'web' (:80, Phase 3) registered" \
  || fail "entrypoint 'web' missing from Traefik API"
echo "$ENTRYPOINTS_JSON" | grep -q '"name":"websecure"' \
  && pass "entrypoint 'websecure' (:443, Phase 4/acme.yml) registered" \
  || fail "entrypoint 'websecure' missing -- acme.yml was not merged into the running config"

echo "== Phase 4 verify: acme.yml was merged into Traefik's running config =="
MERGED="$(docker compose exec -T traefik cat /etc/traefik/merged.yml 2>/dev/null || true)"
echo "$MERGED" | grep -q "certificatesResolvers" \
  && pass "certificatesResolvers (letsencrypt) present in merged config" \
  || fail "merged.yml has no certificatesResolvers -- acme.yml was not appended"
echo "$MERGED" | grep -q "__ACME_" \
  && fail "unsubstituted __ACME_*__ placeholder left in merged.yml" \
  || pass "ACME_EMAIL / ACME_CA_SERVER placeholders substituted"
echo

# --------------------------------------------------------------------------
# 4. Functional TLS + redirect check against a real running container.
#
# IMPORTANT SCOPE NOTE: this environment has no publicly resolvable domain
# and no live DNS-01 credentials, so it CANNOT prove that Let's Encrypt
# will actually issue the production wildcard certificate -- that can only
# be verified once infra/dns/wildcard-record-notes.md's wildcard record is
# live and real DNS provider credentials are configured (see that file,
# section 5). What this DOES verify, without any of that: the HTTPS
# entrypoint is live, the HTTP->HTTPS redirect fires, TLS termination
# actually happens end-to-end through Traefik to the container, and the
# certresolver-labeled secure router matches the intended host -- i.e.
# everything on the Traefik/label side of the ACME boundary.
# --------------------------------------------------------------------------
echo "== Phase 4 verify: spawn a TLS-labeled sandbox container =="
docker rm -f "$TEST_TLS" > /dev/null 2>&1 || true

docker run -d --name "$TEST_TLS" \
  --network "$NETWORK_NAME" \
  --expose 8080 \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.session-verify-tls.rule=Host(\`${FAKE_HOST}\`)" \
  --label "traefik.http.routers.session-verify-tls.entrypoints=web" \
  --label "traefik.http.routers.session-verify-tls.middlewares=session-verify-tls-https-redirect" \
  --label "traefik.http.middlewares.session-verify-tls-https-redirect.redirectscheme.scheme=https" \
  --label "traefik.http.middlewares.session-verify-tls-https-redirect.redirectscheme.permanent=true" \
  --label "traefik.http.routers.session-verify-tls-secure.rule=Host(\`${FAKE_HOST}\`)" \
  --label "traefik.http.routers.session-verify-tls-secure.entrypoints=websecure" \
  --label "traefik.http.routers.session-verify-tls-secure.service=session-verify-tls" \
  --label "traefik.http.routers.session-verify-tls-secure.tls=true" \
  --label "traefik.http.services.session-verify-tls.loadbalancer.server.port=8080" \
  --label "traefik.docker.network=${NETWORK_NAME}" \
  node:20-bookworm-slim \
  node -e "require('http').createServer((_req,res)=>{res.end('hello-from-verify-tls');}).listen(8080, '0.0.0.0', () => console.log('TLS test container ready'));" \
  > /tmp/p4-run-tls.log 2>&1 \
  && pass "spawned ${TEST_TLS}" \
  || { cat /tmp/p4-run-tls.log; fail "failed to spawn ${TEST_TLS}"; }
echo

echo "== Phase 4 verify: HTTP request is redirected to HTTPS =="
REDIRECT_OK=false
for _ in $(seq 1 30); do
  REDIRECT_LOCATION="$(curl -s -o /dev/null -w '%{redirect_url}' -H "Host: ${FAKE_HOST}" http://127.0.0.1:80/ || true)"
  case "$REDIRECT_LOCATION" in
    https://*) REDIRECT_OK=true; break ;;
  esac
  sleep 1
done
[ "$REDIRECT_OK" = true ] \
  && pass "http://${FAKE_HOST}/ redirected to ${REDIRECT_LOCATION}" \
  || fail "http://${FAKE_HOST}/ was never redirected to https"
echo

echo "== Phase 4 verify: HTTPS request reaches the container through Traefik =="
# -k: no real DNS/ACME context locally, so this deliberately terminates on
# Traefik's fallback self-signed default certificate rather than a
# Let's Encrypt cert -- see the scope note above.
TLS_OK=false
for _ in $(seq 1 30); do
  BODY_TLS="$(curl -sk --resolve "${FAKE_HOST}:443:127.0.0.1" "https://${FAKE_HOST}/" || true)"
  [ "$BODY_TLS" = "hello-from-verify-tls" ] && TLS_OK=true && break
  sleep 1
done

if [ "$TLS_OK" != true ]; then
  echo "--- DIAGNOSTIC DUMP ---"
  echo "Container logs:"
  docker logs "$TEST_TLS" || true
  echo "Traefik Routers:"
  curl -s http://127.0.0.1:8080/api/http/routers || true
  echo
fi

[ "$TLS_OK" = true ] \
  && pass "https://${FAKE_HOST}/ -> ${TEST_TLS}:8080 over TLS, via the 'websecure' entrypoint" \
  || fail "TLS route to ${TEST_TLS} never came up"
echo

docker rm -f "$TEST_TLS" > /dev/null 2>&1 || true

note "Real wildcard cert issuance was NOT exercised by this run (no public"
note "domain / DNS-01 credentials available here). Before relying on this"
note "in production: complete infra/dns/wildcard-record-notes.md, set"
note "SESSION_HOST_SUFFIX + ACME_EMAIL + your DNS provider's credential env"
note "var, run 'docker compose up -d', start one real session, and confirm"
note "with 'curl -v https://<session>.sessions.yourdomain.dev/' that the"
note "certificate issuer is Let's Encrypt (not Traefik's self-signed default)."

echo "All Phase 4 checks passed."