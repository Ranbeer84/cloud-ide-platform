import type { ContainerLabels } from "./containerTypes.js";

/**
 * Reverse-proxy (Traefik) label computation for sandbox session containers.
 *
 * Every session container is routed at `<sanitized-session-id>.localhost` by
 * Traefik's Docker provider, which watches the Docker socket and
 * registers/deregisters routes automatically as containers start and stop
 * (see packages/proxy/traefik/traefik.yml). No manual Traefik configuration
 * edits or restarts are ever required — dockerManager.ts merges the labels
 * computed here onto every spawned container.
 */

/** Docker network shared by Traefik and every spawned sandbox container. */
export const PROXY_NETWORK_NAME = "live-network";

/** Port inside the sandbox container that the user's dev server listens on. */
export const DEFAULT_PROXY_TARGET_PORT = 8080;

const DEFAULT_ENTRYPOINT = "web";
const DEFAULT_HOST_SUFFIX = ".localhost";

export interface ProxyLabelOptions {
  /** Port inside the container Traefik should load-balance to. */
  readonly targetPort?: number;
  /** Docker network Traefik and the container both belong to. */
  readonly network?: string;
  /** Traefik entryPoint (defined in traefik.yml) to attach the router to. */
  readonly entryPoint?: string;
  /** Suffix appended to the sanitized session id to form the routed host. */
  readonly hostSuffix?: string;
}

/**
 * Turns an arbitrary session id into a valid DNS subdomain label: lowercase,
 * alphanumeric-or-hyphen only, no leading/trailing hyphen, capped at 63
 * chars (the DNS label limit). Throws if nothing usable remains.
 */
export function sanitizeSubdomain(sessionId: string): string {
  const sanitized = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

  if (sanitized.length === 0) {
    throw new Error(
      `Session id "${sessionId}" does not contain any characters usable in a subdomain`,
    );
  }

  return sanitized;
}

/**
 * Traefik router/service resource name for a session. Prefixed so it can't
 * collide with any other Traefik resource sharing the same Docker provider.
 */
function proxyResourceName(subdomain: string): string {
  return `session-${subdomain}`;
}

/**
 * Computes the full set of `traefik.*` container labels required for a
 * session container to be auto-discovered and routed by Traefik's Docker
 * provider.
 *
 * Pure and deterministic — given the same sessionId and options it always
 * returns the same labels, so it's trivially unit-testable without Docker.
 */
export function computeProxyLabels(
  sessionId: string,
  options: ProxyLabelOptions = {},
): ContainerLabels {
  const targetPort = options.targetPort ?? DEFAULT_PROXY_TARGET_PORT;
  const network = options.network ?? PROXY_NETWORK_NAME;
  const entryPoint = options.entryPoint ?? DEFAULT_ENTRYPOINT;
  const hostSuffix = options.hostSuffix ?? DEFAULT_HOST_SUFFIX;

  const subdomain = sanitizeSubdomain(sessionId);
  const resource = proxyResourceName(subdomain);
  const host = `${subdomain}${hostSuffix}`;

  return {
    "traefik.enable": "true",
    [`traefik.http.routers.${resource}.rule`]: `Host(\`${host}\`)`,
    [`traefik.http.routers.${resource}.entrypoints`]: entryPoint,
    [`traefik.http.services.${resource}.loadbalancer.server.port`]: String(targetPort),
    "traefik.docker.network": network,
  };
}