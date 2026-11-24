import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  NodeV1Api,
  type V1Pod,
  type V1Service,
} from "@kubernetes/client-node";
import { ConfigError } from "../config.js";
import type { Logger } from "../sessionStore/sessionTypes.js";
import type {
  ContainerInspection,
  ContainerLabels,
  ManagedContainer,
  ManagedContainerStatus,
  SpawnContainerOptions,
  StopContainerOptions,
} from "./containerTypes.js";
import { DEFAULT_PROXY_TARGET_PORT, getHostSuffixFromEnv, sanitizeSubdomain } from "./proxyLabels.js";

/**
 * Kubernetes replacement for DockerManager / GvisorManager (Phase 10).
 *
 * One sandbox is three Kubernetes objects, all named `sbx-<session>`:
 *
 *   Pod          the sandbox itself, under the gVisor RuntimeClass, hardened like the
 *                Docker sandbox (no capabilities, non-root, no service-account token)
 *   Service      a stable in-cluster address for the pod: the orchestrator reaches the
 *                sandbox-agent through it, and the proxy reaches the preview port
 *   IngressRoute the Traefik CRD that routes `<session>.<suffix>` to the Service
 *                (plus a second, TLS one when the suffix is a real domain)
 *
 * The Service and IngressRoutes name the Pod as their owner, so Kubernetes deletes
 * them the moment the Pod goes. Removing the Pod IS the route cleanup, exactly as
 * removing the container was with Docker labels.
 *
 * Isolation between sandboxes is not done here. It is the job of the NetworkPolicies
 * in infra/k8s/network-policy.yaml, which select pods by the labels set below.
 *
 * Scheduling across nodes is left to the Kubernetes scheduler, steered by a topology
 * spread constraint (see K8S_TOPOLOGY_SPREAD).
 */

const MANAGED_LABEL_KEY = "live.managed";
const SESSION_LABEL_KEY = "live.session-id";
const NAME_LABEL_KEY = "app.kubernetes.io/name";
const SANDBOX_APP_NAME = "live-sandbox";
const AGENT_PORT_ANNOTATION = "live.io/agent-port";

/** Prefix of every object this manager creates. */
export const SANDBOX_OBJECT_PREFIX = "sbx-";

const CONTAINER_NAME = "sandbox";
const AGENT_PORT_NAME = "agent";
const PREVIEW_PORT_NAME = "preview";

const DNS_LABEL_MAX = 63;
/** `sbx-` + subdomain + `-tls` must still be a valid object name. */
const MAX_SUBDOMAIN_LENGTH = DNS_LABEL_MAX - SANDBOX_OBJECT_PREFIX.length - "-tls".length;
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POD_NAME_PATTERN = /^sbx-[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const POLL_INTERVAL_MS = 500;
const API_TIMEOUT_MS = 15_000;
const STOP_EXTRA_WAIT_SECONDS = 5;
const DEFAULT_STOP_TIMEOUT_SECONDS = 5;
const PENDING_REASONS_TO_FAIL_FAST: ReadonlySet<string> = new Set([
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);

export type TopologySpreadMode = "strict" | "soft" | "off";

export interface K8sManagerOptions {
  /** Namespace the sandboxes live in. The NetworkPolicies and pod security level apply to it. */
  readonly namespace: string;
  /**
   * RuntimeClass the pods run under. It must map to gVisor (handler runsc). Empty means
   * the node's default runtime, which is only accepted with `allowDefaultRuntime`.
   */
  readonly runtimeClassName: string;
  /** Development clusters without gVisor only. The sandbox is then NOT isolated by gVisor. */
  readonly allowDefaultRuntime: boolean;
  /** Numeric ids of the image's `sandbox` user: Kubernetes cannot verify a user given by name. */
  readonly runAsUser: number;
  readonly runAsGroup: number;
  readonly topologySpread: TopologySpreadMode;
  readonly maxSkew: number;
  readonly nodeSelector: Readonly<Record<string, string>>;
  readonly cpuRequestMillis: number;
  readonly ephemeralStorageLimitMb: number;
  readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  readonly imagePullSecret: string | undefined;
  /** How long spawnContainer waits for the pod to be running (scheduling + image pull + start). */
  readonly podStartTimeoutMs: number;
  /** Port inside the sandbox where the user's dev server listens; the proxy routes here. */
  readonly previewPort: number;
  readonly hostSuffix: string;
  readonly enableTls: boolean;
  readonly wildcardDomain: string;
  readonly entryPoint: string;
  readonly httpsEntryPoint: string;
  readonly certResolver: string;
  /** Name of the Traefik Middleware (same namespace) that redirects HTTP to HTTPS. */
  readonly httpsRedirectMiddleware: string;
  readonly ingressRouteGroup: string;
  readonly ingressRouteVersion: string;
}

/** Everything K8sManager asks of the Kubernetes API. Small on purpose, so tests can fake it. */
export interface K8sApi {
  createPod(namespace: string, pod: V1Pod): Promise<V1Pod>;
  readPod(namespace: string, name: string): Promise<V1Pod>;
  listPods(namespace: string, labelSelector: string): Promise<readonly V1Pod[]>;
  deletePod(namespace: string, name: string, gracePeriodSeconds: number): Promise<void>;
  createService(namespace: string, service: V1Service): Promise<V1Service>;
  listServices(namespace: string, labelSelector: string): Promise<readonly V1Service[]>;
  deleteService(namespace: string, name: string): Promise<void>;
  createIngressRoute(namespace: string, route: IngressRouteObject): Promise<void>;
  listIngressRoutes(namespace: string, labelSelector: string): Promise<readonly IngressRouteObject[]>;
  deleteIngressRoute(namespace: string, name: string): Promise<void>;
  readNamespace(name: string): Promise<void>;
  /** The RuntimeClass's handler, or undefined when it does not exist. */
  readRuntimeClassHandler(name: string): Promise<string | undefined>;
}

export interface IngressRouteObject {
  readonly apiVersion: string;
  readonly kind: "IngressRoute";
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly creationTimestamp?: string;
    readonly ownerReferences?: readonly OwnerReference[];
  };
  readonly spec: Readonly<Record<string, unknown>>;
}

export interface OwnerReference {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  readonly blockOwnerDeletion: boolean;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function readInt(
  env: Readonly<Record<string, string | undefined>>,
  problems: string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || parsed < min || parsed > max) {
    problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return parsed;
}

function readBoolean(env: Readonly<Record<string, string | undefined>>, problems: string[], name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  problems.push(`${name} must be "true" or "false" (got "${raw}")`);
  return fallback;
}

function readName(env: Readonly<Record<string, string | undefined>>, problems: string[], name: string, fallback: string): string {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(raw) || raw.length > 253) {
    problems.push(`${name} must be a valid Kubernetes name (lowercase letters, digits, "-" and ".")`);
    return fallback;
  }
  return raw;
}

function parseNodeSelector(raw: string | undefined, problems: string[]): Record<string, string> {
  const selector: Record<string, string> = {};
  for (const part of (raw ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0)) {
    const index = part.indexOf("=");
    const key = index > 0 ? part.slice(0, index).trim() : "";
    const value = index > 0 ? part.slice(index + 1).trim() : "";
    if (!key || !value) {
      problems.push(`K8S_SANDBOX_NODE_SELECTOR entries must look like key=value (got "${part}")`);
      continue;
    }
    selector[key] = value;
  }
  return selector;
}

/**
 * Reads the Kubernetes sandbox settings from the environment.
 *
 * | variable                          | default                  |
 * | --------------------------------- | ------------------------ |
 * | K8S_SANDBOX_NAMESPACE             | live-sandboxes           |
 * | K8S_SANDBOX_RUNTIME_CLASS         | gvisor  ("" = node default, needs K8S_ALLOW_DEFAULT_RUNTIME) |
 * | K8S_ALLOW_DEFAULT_RUNTIME         | false                    |
 * | K8S_SANDBOX_UID / K8S_SANDBOX_GID | 999 / 999 (the image's `sandbox` user; check with `id sandbox`) |
 * | K8S_TOPOLOGY_SPREAD               | strict  (strict | soft | off) |
 * | K8S_TOPOLOGY_MAX_SKEW             | 1                        |
 * | K8S_SANDBOX_NODE_SELECTOR         | (none) e.g. pool=sandboxes |
 * | K8S_SANDBOX_CPU_REQUEST_MILLIS    | 250                      |
 * | K8S_SANDBOX_EPHEMERAL_STORAGE_MB  | 2048                     |
 * | K8S_IMAGE_PULL_POLICY             | IfNotPresent             |
 * | K8S_IMAGE_PULL_SECRET             | (none)                   |
 * | K8S_POD_START_TIMEOUT_MS          | 120000                   |
 * | K8S_ENTRYPOINT / K8S_HTTPS_ENTRYPOINT | web / websecure      |
 * | K8S_CERT_RESOLVER                 | letsencrypt              |
 * | K8S_HTTPS_REDIRECT_MIDDLEWARE     | sandbox-https-redirect   |
 * | K8S_INGRESSROUTE_GROUP / _VERSION | traefik.io / v1alpha1    |
 * | SESSION_HOST_SUFFIX               | .localhost               |
 *
 * TLS routes are created whenever SESSION_HOST_SUFFIX is a real domain, as with the
 * Docker labels (a `.localhost` name can never get a certificate).
 */
export function loadK8sManagerOptions(env: Readonly<Record<string, string | undefined>> = process.env): K8sManagerOptions {
  const problems: string[] = [];

  const namespace = readName(env, problems, "K8S_SANDBOX_NAMESPACE", "live-sandboxes");
  const runtimeRaw = env["K8S_SANDBOX_RUNTIME_CLASS"];
  const runtimeClassName = runtimeRaw === undefined ? "gvisor" : runtimeRaw.trim();
  if (runtimeClassName !== "" && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(runtimeClassName)) {
    problems.push(`K8S_SANDBOX_RUNTIME_CLASS must be a valid Kubernetes name or empty (got "${runtimeClassName}")`);
  }
  const allowDefaultRuntime = readBoolean(env, problems, "K8S_ALLOW_DEFAULT_RUNTIME", false);

  const spreadRaw = (env["K8S_TOPOLOGY_SPREAD"]?.trim().toLowerCase() || "strict") as string;
  let topologySpread: TopologySpreadMode = "strict";
  if (spreadRaw === "strict" || spreadRaw === "soft" || spreadRaw === "off") {
    topologySpread = spreadRaw;
  } else {
    problems.push(`K8S_TOPOLOGY_SPREAD must be "strict", "soft" or "off" (got "${spreadRaw}")`);
  }

  const pullRaw = env["K8S_IMAGE_PULL_POLICY"]?.trim() || "IfNotPresent";
  let imagePullPolicy: K8sManagerOptions["imagePullPolicy"] = "IfNotPresent";
  if (pullRaw === "Always" || pullRaw === "IfNotPresent" || pullRaw === "Never") {
    imagePullPolicy = pullRaw;
  } else {
    problems.push(`K8S_IMAGE_PULL_POLICY must be "Always", "IfNotPresent" or "Never" (got "${pullRaw}")`);
  }

  const hostSuffix = getHostSuffixFromEnv(env);
  const enableTls = hostSuffix !== ".localhost";

  const options: K8sManagerOptions = {
    namespace,
    runtimeClassName,
    allowDefaultRuntime,
    runAsUser: readInt(env, problems, "K8S_SANDBOX_UID", 999, 1, 2_147_483_647),
    runAsGroup: readInt(env, problems, "K8S_SANDBOX_GID", 999, 1, 2_147_483_647),
    topologySpread,
    maxSkew: readInt(env, problems, "K8S_TOPOLOGY_MAX_SKEW", 1, 1, 1000),
    nodeSelector: parseNodeSelector(env["K8S_SANDBOX_NODE_SELECTOR"], problems),
    cpuRequestMillis: readInt(env, problems, "K8S_SANDBOX_CPU_REQUEST_MILLIS", 250, 10, 64_000),
    ephemeralStorageLimitMb: readInt(env, problems, "K8S_SANDBOX_EPHEMERAL_STORAGE_MB", 2048, 64, 1_048_576),
    imagePullPolicy,
    imagePullSecret: env["K8S_IMAGE_PULL_SECRET"]?.trim() || undefined,
    podStartTimeoutMs: readInt(env, problems, "K8S_POD_START_TIMEOUT_MS", 120_000, 1_000, 1_800_000),
    previewPort: DEFAULT_PROXY_TARGET_PORT,
    hostSuffix,
    enableTls,
    wildcardDomain: hostSuffix.startsWith(".") ? hostSuffix.slice(1) : hostSuffix,
    entryPoint: readName(env, problems, "K8S_ENTRYPOINT", "web"),
    httpsEntryPoint: readName(env, problems, "K8S_HTTPS_ENTRYPOINT", "websecure"),
    certResolver: readName(env, problems, "K8S_CERT_RESOLVER", "letsencrypt"),
    httpsRedirectMiddleware: readName(env, problems, "K8S_HTTPS_REDIRECT_MIDDLEWARE", "sandbox-https-redirect"),
    ingressRouteGroup: readName(env, problems, "K8S_INGRESSROUTE_GROUP", "traefik.io"),
    ingressRouteVersion: readName(env, problems, "K8S_INGRESSROUTE_VERSION", "v1alpha1"),
  };

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return options;
}

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

/** Subdomain, pod name and label value for a session id, or an Error if Kubernetes cannot hold it. */
function namesFor(sessionId: string): { subdomain: string; objectName: string } {
  if (!LABEL_VALUE_PATTERN.test(sessionId)) {
    throw new Error(`Session id "${sessionId}" cannot be used as a Kubernetes label value`);
  }
  const subdomain = sanitizeSubdomain(sessionId);
  if (subdomain.length > MAX_SUBDOMAIN_LENGTH) {
    throw new Error(`Session id "${sessionId}" is too long for Kubernetes object names (max ${MAX_SUBDOMAIN_LENGTH} characters)`);
  }
  return { subdomain, objectName: `${SANDBOX_OBJECT_PREFIX}${subdomain}` };
}

/** The pod name (this manager's container id) for a session. */
export function sandboxObjectName(sessionId: string): string {
  return namesFor(sessionId).objectName;
}

/** In-cluster DNS name of a session's Service, e.g. `sbx-s1.live-sandboxes.svc`. */
export function sandboxServiceHost(sessionId: string, namespace: string): string {
  return `${namesFor(sessionId).objectName}.${namespace}.svc`;
}

/**
 * SANDBOX_AGENT_HOST value for Kubernetes: every session's Service name with the literal
 * "{subdomain}" where the session goes (agentHostFor fills it in). Always agrees with
 * sandboxServiceHost, because both use the same naming.
 */
export function sandboxAgentHostTemplate(namespace: string): string {
  return `${SANDBOX_OBJECT_PREFIX}{subdomain}.${namespace}.svc`;
}

/* ------------------------------------------------------------------ */
/* Object builders (pure: no cluster needed)                           */
/* ------------------------------------------------------------------ */

function sandboxLabels(sessionId: string, extra: ContainerLabels | undefined): Record<string, string> {
  return {
    // Caller labels first, so they can never overwrite the bookkeeping or policy labels below.
    ...(extra ?? {}),
    [NAME_LABEL_KEY]: SANDBOX_APP_NAME,
    "app.kubernetes.io/part-of": "live",
    "app.kubernetes.io/managed-by": "live-orchestrator",
    [MANAGED_LABEL_KEY]: "true",
    [SESSION_LABEL_KEY]: sessionId,
  };
}

/**
 * The sandbox pod. Hardening mirrors the Docker sandbox and satisfies the "restricted"
 * Pod Security level the namespace enforces:
 *
 *  - gVisor via the RuntimeClass
 *  - non-root numeric user, every capability dropped, no privilege escalation, seccomp RuntimeDefault
 *  - no service-account token (a sandbox must never be able to talk to the Kubernetes API)
 *  - no service-link environment variables, no host namespaces, no restarts (a crashed sandbox is
 *    reported to the reconciler instead of silently coming back empty)
 *  - memory request = limit (no memory over-commit), a CPU limit from the session limits, an
 *    ephemeral-storage limit so a full disk cannot take a node down
 *  - safe-to-evict=false so the cluster autoscaler does not scale down a node with live sessions
 */
export function buildSandboxPod(options: K8sManagerOptions, spawn: SpawnContainerOptions): V1Pod {
  const { objectName } = namesFor(spawn.sessionId);
  const limits = spawn.resourceLimits;

  const resourceLimits: Record<string, string> = {
    memory: String(limits.memoryBytes),
    "ephemeral-storage": `${options.ephemeralStorageLimitMb}Mi`,
  };
  const resourceRequests: Record<string, string> = {
    memory: String(limits.memoryBytes),
    "ephemeral-storage": `${Math.min(256, options.ephemeralStorageLimitMb)}Mi`,
  };
  if (limits.nanoCpus !== undefined) {
    const limitMillis = Math.max(1, Math.round(limits.nanoCpus / 1_000_000));
    resourceLimits["cpu"] = `${limitMillis}m`;
    resourceRequests["cpu"] = `${Math.min(limitMillis, options.cpuRequestMillis)}m`;
  } else {
    resourceRequests["cpu"] = `${options.cpuRequestMillis}m`;
  }

  const env = Object.entries(spawn.env ?? {}).map(([name, value]) => {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid environment variable name "${name}"`);
    }
    return { name, value };
  });

  const labels = sandboxLabels(spawn.sessionId, spawn.labels);
  const selector = { matchLabels: { [NAME_LABEL_KEY]: SANDBOX_APP_NAME } };

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: objectName,
      namespace: options.namespace,
      labels,
      annotations: {
        [AGENT_PORT_ANNOTATION]: String(spawn.agentPort),
        "cluster-autoscaler.kubernetes.io/safe-to-evict": "false",
      },
    },
    spec: {
      ...(options.runtimeClassName !== "" ? { runtimeClassName: options.runtimeClassName } : {}),
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      terminationGracePeriodSeconds: DEFAULT_STOP_TIMEOUT_SECONDS,
      ...(Object.keys(options.nodeSelector).length > 0 ? { nodeSelector: { ...options.nodeSelector } } : {}),
      ...(options.imagePullSecret !== undefined ? { imagePullSecrets: [{ name: options.imagePullSecret }] } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: options.runAsUser,
        runAsGroup: options.runAsGroup,
        seccompProfile: { type: "RuntimeDefault" },
      },
      ...(options.topologySpread !== "off"
        ? {
            topologySpreadConstraints: [
              {
                maxSkew: options.maxSkew,
                topologyKey: "kubernetes.io/hostname",
                whenUnsatisfiable: options.topologySpread === "strict" ? "DoNotSchedule" : "ScheduleAnyway",
                labelSelector: selector,
                // Do not count cordoned, tainted or non-matching nodes as empty domains: that
                // would make "strict" refuse to place more than maxSkew pods per usable node.
                nodeAffinityPolicy: "Honor",
                nodeTaintsPolicy: "Honor",
              },
            ],
          }
        : {}),
      containers: [
        {
          name: CONTAINER_NAME,
          image: spawn.image,
          imagePullPolicy: options.imagePullPolicy,
          ports: [
            { name: AGENT_PORT_NAME, containerPort: spawn.agentPort, protocol: "TCP" },
            { name: PREVIEW_PORT_NAME, containerPort: options.previewPort, protocol: "TCP" },
          ],
          env,
          resources: { limits: resourceLimits, requests: resourceRequests },
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}

/** ClusterIP Service in front of one sandbox pod: the agent port and the preview port. */
export function buildSandboxService(
  options: K8sManagerOptions,
  spawn: SpawnContainerOptions,
  owner: OwnerReference,
): V1Service {
  const { objectName } = namesFor(spawn.sessionId);
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: objectName,
      namespace: options.namespace,
      labels: sandboxLabels(spawn.sessionId, undefined),
      ownerReferences: [{ ...owner }],
    },
    spec: {
      type: "ClusterIP",
      selector: { [MANAGED_LABEL_KEY]: "true", [SESSION_LABEL_KEY]: spawn.sessionId },
      ports: [
        { name: AGENT_PORT_NAME, port: spawn.agentPort, targetPort: spawn.agentPort, protocol: "TCP" },
        { name: PREVIEW_PORT_NAME, port: options.previewPort, targetPort: options.previewPort, protocol: "TCP" },
      ],
    },
  };
}

/**
 * The Traefik IngressRoute CRDs that replace the Docker labels:
 *
 *   http  `sbx-<s>`      entryPoint web, Host(`<s><suffix>`) -> Service preview port
 *   https `sbx-<s>-tls`  entryPoint websecure, same rule, certResolver + wildcard SAN
 *
 * Without TLS only the first exists. With TLS the first one redirects to HTTPS (through the
 * shared Middleware in packages/proxy/traefik/ingressroute-crd.yaml), so no session is ever
 * served over plain HTTP, and every session asks for the same wildcard certificate.
 */
export function buildIngressRoutes(
  options: K8sManagerOptions,
  sessionId: string,
  owner: OwnerReference,
): readonly IngressRouteObject[] {
  const { subdomain, objectName } = namesFor(sessionId);
  const host = `${subdomain}${options.hostSuffix}`;
  const apiVersion = `${options.ingressRouteGroup}/${options.ingressRouteVersion}`;
  const labels = sandboxLabels(sessionId, undefined);
  const service = { name: objectName, port: options.previewPort };
  const match = `Host(\`${host}\`)`;

  const http: IngressRouteObject = {
    apiVersion,
    kind: "IngressRoute",
    metadata: { name: objectName, namespace: options.namespace, labels, ownerReferences: [{ ...owner }] },
    spec: {
      entryPoints: [options.entryPoint],
      routes: [
        {
          match,
          kind: "Rule",
          ...(options.enableTls ? { middlewares: [{ name: options.httpsRedirectMiddleware }] } : {}),
          services: [service],
        },
      ],
    },
  };
  if (!options.enableTls) {
    return [http];
  }

  const https: IngressRouteObject = {
    apiVersion,
    kind: "IngressRoute",
    metadata: { name: `${objectName}-tls`, namespace: options.namespace, labels, ownerReferences: [{ ...owner }] },
    spec: {
      entryPoints: [options.httpsEntryPoint],
      routes: [{ match, kind: "Rule", services: [service] }],
      tls: {
        certResolver: options.certResolver,
        domains: [{ main: options.wildcardDomain, sans: [`*.${options.wildcardDomain}`] }],
      },
    },
  };
  return [http, https];
}

/* ------------------------------------------------------------------ */
/* Pod status                                                          */
/* ------------------------------------------------------------------ */

function timestampMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** Maps a pod onto the status vocabulary the reconciler and reaper already use. */
export function podStatus(pod: V1Pod): ManagedContainerStatus {
  if (pod.metadata?.deletionTimestamp) {
    return "stopped";
  }
  const phase = pod.status?.phase;
  const container = pod.status?.containerStatuses?.find((status) => status.name === CONTAINER_NAME);
  const terminated = container?.state?.terminated;

  if (phase === "Pending") {
    return "starting";
  }
  if (phase === "Running") {
    if (terminated) {
      return terminated.reason === "OOMKilled" ? "oom_killed" : "exited";
    }
    return container?.state?.running ? "running" : "starting";
  }
  if (phase === "Succeeded") {
    return "exited";
  }
  if (phase === "Failed") {
    return terminated?.reason === "OOMKilled" ? "oom_killed" : "error";
  }
  return "error";
}

function agentPortOf(pod: V1Pod): number {
  const annotation = Number(pod.metadata?.annotations?.[AGENT_PORT_ANNOTATION]);
  if (Number.isInteger(annotation) && annotation > 0) {
    return annotation;
  }
  const declared = pod.spec?.containers?.[0]?.ports?.find((port) => port.name === AGENT_PORT_NAME)?.containerPort;
  return declared ?? 0;
}

function toManagedContainer(pod: V1Pod): ManagedContainer {
  const labels = pod.metadata?.labels ?? {};
  return {
    containerId: pod.metadata?.name ?? "",
    sessionId: labels[SESSION_LABEL_KEY] ?? "unknown",
    image: pod.spec?.containers?.[0]?.image ?? "",
    hostAgentPort: agentPortOf(pod),
    labels,
    createdAt: timestampMs(pod.metadata?.creationTimestamp),
    status: podStatus(pod),
  };
}

/* ------------------------------------------------------------------ */
/* Real API client                                                     */
/* ------------------------------------------------------------------ */

function bodyMessage(body: unknown): string | undefined {
  if (typeof body === "string") {
    try {
      return bodyMessage(JSON.parse(body) as unknown);
    } catch {
      return body.slice(0, 300);
    }
  }
  if (typeof body === "object" && body !== null) {
    const message = (body as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

/**
 * Turns an API failure into an Error that carries `statusCode`, like Docker's errors do,
 * so the existing helpers work unchanged: the reaper treats 404 as "gone", and the spawn
 * retry loop treats 409/429/5xx as transient. The message of a transient failure includes
 * "try again" for the same reason.
 */
function wrapApiError(action: string, error: unknown): Error {
  if (error instanceof ApiException) {
    const detail = bodyMessage(error.body) ?? error.message;
    const transient = error.code === 429 || error.code >= 500;
    const wrapped = new Error(`kubernetes: ${action} failed (HTTP ${error.code}): ${detail}${transient ? " - try again" : ""}`);
    Object.assign(wrapped, { statusCode: error.code, reason: detail });
    return wrapped;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const wrapped = new Error(`kubernetes: ${action} failed: ${error.message}`);
    if (typeof code === "string") {
      Object.assign(wrapped, { code });
    }
    return wrapped;
  }
  return new Error(`kubernetes: ${action} failed: ${String(error)}`);
}

/** Loads credentials: in-cluster service account when running in a pod, otherwise KUBECONFIG / ~/.kube/config. */
export function loadKubeConfig(env: Readonly<Record<string, string | undefined>> = process.env): KubeConfig {
  const config = new KubeConfig();
  if (env["KUBERNETES_SERVICE_HOST"] && !env["KUBECONFIG"]) {
    config.loadFromCluster();
  } else {
    config.loadFromDefault();
  }
  return config;
}

export interface IngressRouteKind {
  readonly group: string;
  readonly version: string;
}

/** The real Kubernetes API, built on the official client. Every call has a timeout. */
export function createK8sApi(
  config: KubeConfig = loadKubeConfig(),
  routeKind: IngressRouteKind = { group: "traefik.io", version: "v1alpha1" },
): K8sApi {
  const core = config.makeApiClient(CoreV1Api);
  const custom = config.makeApiClient(CustomObjectsApi);
  const node = config.makeApiClient(NodeV1Api);

  // The client has no per-call timeout, so a hung API server would hang spawnContainer. Race
  // each call against a timer; a timed-out request is abandoned (its result is ignored) and
  // reported as ETIMEDOUT, which the spawn retry loop treats as transient.
  const run = async <T>(action: string, call: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`no answer within ${API_TIMEOUT_MS} ms`), { code: "ETIMEDOUT" })),
        API_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([call(), timeout]);
    } catch (error) {
      throw wrapApiError(action, error);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  // The CRD's group and version are fixed per manager; the API wants them on each call.
  const ingressRoute = { group: routeKind.group, version: routeKind.version, plural: "ingressroutes" };

  return {
    createPod: (namespace, pod) => run("create pod", () => core.createNamespacedPod({ namespace, body: pod })),
    readPod: (namespace, name) => run(`read pod ${name}`, () => core.readNamespacedPod({ name, namespace })),
    listPods: async (namespace, labelSelector) =>
      (await run("list pods", () => core.listNamespacedPod({ namespace, labelSelector }))).items,
    deletePod: async (namespace, name, gracePeriodSeconds) => {
      await run(`delete pod ${name}`, () => core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds }));
    },
    createService: (namespace, service) =>
      run("create service", () => core.createNamespacedService({ namespace, body: service })),
    listServices: async (namespace, labelSelector) =>
      (await run("list services", () => core.listNamespacedService({ namespace, labelSelector }))).items,
    deleteService: async (namespace, name) => {
      await run(`delete service ${name}`, () => core.deleteNamespacedService({ name, namespace }));
    },
    createIngressRoute: async (namespace, route) => {
      await run("create ingressroute", () =>
        custom.createNamespacedCustomObject({ ...ingressRoute, namespace, body: route }),
      );
    },
    listIngressRoutes: async (namespace, labelSelector) => {
      const result = (await run("list ingressroutes", () =>
        custom.listNamespacedCustomObject({ ...ingressRoute, namespace, labelSelector }),
      )) as { items?: IngressRouteObject[] };
      return result.items ?? [];
    },
    deleteIngressRoute: async (namespace, name) => {
      await run(`delete ingressroute ${name}`, () =>
        custom.deleteNamespacedCustomObject({ ...ingressRoute, namespace, name }),
      );
    },
    readNamespace: async (name) => {
      await run(`read namespace ${name}`, () => core.readNamespace({ name }));
    },
    readRuntimeClassHandler: async (name) => {
      try {
        return (await node.readRuntimeClass({ name })).handler;
      } catch (error) {
        if (error instanceof ApiException && error.code === 404) {
          return undefined;
        }
        throw wrapApiError(`read runtimeclass ${name}`, error);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* The manager                                                         */
/* ------------------------------------------------------------------ */

export interface K8sManagerDeps {
  readonly options: K8sManagerOptions;
  readonly api: K8sApi;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PruneRoutesOptions {
  /** Objects younger than this are left alone: another replica may still be creating them. */
  readonly graceMs: number;
}

function isStatus(error: unknown, status: number): boolean {
  return (error as { statusCode?: number } | undefined)?.statusCode === status;
}

export class K8sManager {
  private readonly options: K8sManagerOptions;
  private readonly api: K8sApi;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: K8sManagerDeps) {
    this.options = deps.options;
    this.api = deps.api;
    this.logger = deps.logger;
    this.now = deps.now ?? ((): number => Date.now());
    this.sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get namespace(): string {
    return this.options.namespace;
  }

  /**
   * Refuses to run sandboxes unless the cluster can do it safely, the Kubernetes counterpart of
   * asserting that Docker has the runsc runtime:
   *  - the sandbox namespace exists and this orchestrator may use it
   *  - the Traefik CRDs are installed (otherwise no sandbox would ever be routable)
   *  - the RuntimeClass exists and maps to gVisor, or the insecure default runtime was explicitly allowed
   */
  async assertRuntimeAvailable(): Promise<void> {
    const { namespace, runtimeClassName, allowDefaultRuntime } = this.options;

    try {
      await this.api.readNamespace(namespace);
      await this.api.listPods(namespace, `${MANAGED_LABEL_KEY}=true`);
    } catch (error) {
      throw new Error(`Cannot use the sandbox namespace "${namespace}": ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await this.api.listIngressRoutes(namespace, `${MANAGED_LABEL_KEY}=true`);
    } catch (error) {
      throw new Error(
        `Cannot list Traefik IngressRoutes in "${namespace}" (are the Traefik CRDs installed, and does the orchestrator's Role allow it?): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (runtimeClassName === "") {
      if (!allowDefaultRuntime) {
        throw new Error(
          "Refusing to run sandboxes without gVisor: K8S_SANDBOX_RUNTIME_CLASS is empty. Set it to a RuntimeClass " +
            "that maps to runsc, or set K8S_ALLOW_DEFAULT_RUNTIME=true on a development cluster.",
        );
      }
      this.logger.warn("k8s.insecure_runtime", {
        message: "Sandboxes run under the node's default runtime, NOT gVisor. Development clusters only.",
      });
      return;
    }

    const handler = await this.api.readRuntimeClassHandler(runtimeClassName);
    if (handler === undefined) {
      throw new Error(`RuntimeClass "${runtimeClassName}" does not exist; create it (see infra/k8s/orchestrator-deployment.yaml)`);
    }
    if (!/runsc|gvisor/i.test(handler)) {
      throw new Error(`RuntimeClass "${runtimeClassName}" uses handler "${handler}", which is not gVisor (runsc)`);
    }
  }

  /**
   * Creates the sandbox pod, its Service and its IngressRoute(s), then waits until the pod is
   * running. It does not wait for the sandbox-agent to answer: createSession does that.
   * Anything created before a failure is removed again.
   */
  async spawnContainer(spawn: SpawnContainerOptions): Promise<ManagedContainer> {
    const { namespace } = this.options;
    const pod = buildSandboxPod(this.options, spawn);
    const objectName = pod.metadata?.name ?? "";

    const created = await this.api.createPod(namespace, pod);

    try {
      const uid = created.metadata?.uid;
      if (!uid) {
        throw new Error(`kubernetes: pod ${objectName} was created without a uid`);
      }
      const owner: OwnerReference = { apiVersion: "v1", kind: "Pod", name: objectName, uid, blockOwnerDeletion: false };

      await this.api.createService(namespace, buildSandboxService(this.options, spawn, owner));
      for (const route of buildIngressRoutes(this.options, spawn.sessionId, owner)) {
        await this.api.createIngressRoute(namespace, route);
      }

      const running = await this.waitUntilRunning(objectName, spawn.sessionId);
      this.logger.info("k8s.sandbox_started", {
        sessionId: spawn.sessionId,
        pod: objectName,
        node: running.spec?.nodeName ?? "unknown",
        runtimeClass: this.options.runtimeClassName || "default",
      });
      const container = toManagedContainer(running);
      return { ...container, hostAgentPort: spawn.agentPort, status: "running" };
    } catch (error) {
      await this.removeObjects(objectName, 0).catch((cleanupError: unknown) => {
        this.logger.warn("k8s.spawn_cleanup_failed", {
          pod: objectName,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
      throw error;
    }
  }

  private async waitUntilRunning(podName: string, sessionId: string): Promise<V1Pod> {
    const { namespace, podStartTimeoutMs } = this.options;
    const deadline = this.now() + podStartTimeoutMs;
    let lastProblem = "the pod has not been scheduled yet";

    while (this.now() < deadline) {
      const pod = await this.api.readPod(namespace, podName);
      const container = pod.status?.containerStatuses?.find((status) => status.name === CONTAINER_NAME);

      if (pod.status?.phase === "Running" && container?.state?.running) {
        return pod;
      }
      if (pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded") {
        const reason = container?.state?.terminated?.reason ?? pod.status.reason ?? pod.status.phase;
        throw new Error(`kubernetes: sandbox pod ${podName} ended before it was ready (${reason}): ${pod.status.message ?? "no message"}`);
      }

      const waiting = container?.state?.waiting;
      if (waiting?.reason !== undefined && PENDING_REASONS_TO_FAIL_FAST.has(waiting.reason)) {
        const hint = waiting.reason === "ImagePullBackOff" || waiting.reason === "InvalidImageName" ? " (no such image, or pull access denied)" : "";
        throw new Error(`kubernetes: sandbox ${sessionId} cannot start: ${waiting.reason}${hint}: ${waiting.message ?? "no message"}`);
      }

      const unscheduled = pod.status?.conditions?.find((condition) => condition.type === "PodScheduled" && condition.status === "False");
      lastProblem = unscheduled
        ? `unschedulable: ${unscheduled.message ?? unscheduled.reason ?? "no message"}`
        : waiting
          ? `${waiting.reason ?? "waiting"}: ${waiting.message ?? "no message"}`
          : `pod phase is ${pod.status?.phase ?? "unknown"}`;

      await this.sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`kubernetes: sandbox pod ${podName} did not start within ${podStartTimeoutMs} ms (${lastProblem})`);
  }

  async inspectContainer(containerId: string): Promise<ContainerInspection> {
    const pod = await this.api.readPod(this.options.namespace, this.podNameFor(containerId));
    const status = podStatus(pod);
    const container = pod.status?.containerStatuses?.find((item) => item.name === CONTAINER_NAME);
    return {
      containerId: pod.metadata?.name ?? containerId,
      running: status === "running",
      oomKilled: status === "oom_killed",
      exitCode: container?.state?.terminated?.exitCode ?? null,
      status: pod.status?.phase ?? "Unknown",
    };
  }

  /**
   * Removes a sandbox completely and waits (briefly) for its pod to disappear, so that when
   * this returns the sandbox is gone, as it is after removing a Docker container. Removing
   * something that is already gone is not an error. The Service and IngressRoutes are also
   * deleted explicitly: Kubernetes would garbage-collect them, but not necessarily at once.
   */
  async stopContainer(containerId: string, options: StopContainerOptions = {}): Promise<void> {
    await this.removeObjects(this.podNameFor(containerId), options.timeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS);
  }

  private podNameFor(containerId: string): string {
    if (!POD_NAME_PATTERN.test(containerId)) {
      throw Object.assign(new Error(`"${containerId}" is not a sandbox pod name`), { statusCode: 404 });
    }
    return containerId;
  }

  private async removeObjects(objectName: string, graceSeconds: number): Promise<void> {
    const { namespace } = this.options;
    const ignoreMissing = async (call: () => Promise<void>): Promise<void> => {
      try {
        await call();
      } catch (error) {
        if (!isStatus(error, 404)) {
          throw error;
        }
      }
    };

    await ignoreMissing(() => this.api.deletePod(namespace, objectName, graceSeconds));
    await ignoreMissing(() => this.api.deleteIngressRoute(namespace, objectName));
    await ignoreMissing(() => this.api.deleteIngressRoute(namespace, `${objectName}-tls`));
    await ignoreMissing(() => this.api.deleteService(namespace, objectName));

    const deadline = this.now() + (graceSeconds + STOP_EXTRA_WAIT_SECONDS) * 1000;
    while (this.now() < deadline) {
      try {
        await this.api.readPod(namespace, objectName);
      } catch (error) {
        if (isStatus(error, 404)) {
          return;
        }
        throw error;
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
    this.logger.warn("k8s.pod_still_terminating", { pod: objectName, waitedSeconds: graceSeconds + STOP_EXTRA_WAIT_SECONDS });
  }

  /** Every sandbox pod this orchestrator has created, in any state (including ones being deleted). */
  async listManagedContainers(): Promise<readonly ManagedContainer[]> {
    const pods = await this.api.listPods(this.options.namespace, `${MANAGED_LABEL_KEY}=true`);
    return pods.map(toManagedContainer);
  }

  /**
   * Deletes Services and IngressRoutes whose pod no longer exists and whose session is not
   * active. Garbage collection normally does this; this is the backstop for the case where
   * it has not (yet). Returns the names it removed. Objects younger than graceMs are kept.
   */
  async pruneOrphanRoutes(activeSessionIds: ReadonlySet<string>, options: PruneRoutesOptions): Promise<readonly string[]> {
    const { namespace } = this.options;
    const selector = `${MANAGED_LABEL_KEY}=true`;
    const livePods = new Set((await this.api.listPods(namespace, selector)).map((pod) => pod.metadata?.name ?? ""));
    const removed: string[] = [];

    const isOrphan = (name: string, labels: Readonly<Record<string, string>> | undefined, createdAt: number): boolean => {
      const sessionId = labels?.[SESSION_LABEL_KEY];
      const podName = name.endsWith("-tls") ? name.slice(0, -"-tls".length) : name;
      return (
        !livePods.has(podName) &&
        (sessionId === undefined || !activeSessionIds.has(sessionId)) &&
        this.now() - createdAt >= options.graceMs
      );
    };

    for (const service of await this.api.listServices(namespace, selector)) {
      const name = service.metadata?.name ?? "";
      if (name && isOrphan(name, service.metadata?.labels, timestampMs(service.metadata?.creationTimestamp))) {
        await this.api.deleteService(namespace, name).catch((error: unknown) => {
          if (!isStatus(error, 404)) {
            throw error;
          }
        });
        removed.push(`service/${name}`);
      }
    }
    for (const route of await this.api.listIngressRoutes(namespace, selector)) {
      const name = route.metadata.name;
      if (isOrphan(name, route.metadata.labels, timestampMs(route.metadata.creationTimestamp))) {
        await this.api.deleteIngressRoute(namespace, name).catch((error: unknown) => {
          if (!isStatus(error, 404)) {
            throw error;
          }
        });
        removed.push(`ingressroute/${name}`);
      }
    }
    return removed;
  }
}