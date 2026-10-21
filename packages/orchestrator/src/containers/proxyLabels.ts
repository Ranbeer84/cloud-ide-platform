import type { ContainerLabels } from "./containerTypes.js";

/**
 * Reverse-proxy (Traefik) label computation for sandbox session containers.
 *
 * Every session container is routed at `<sanitized-session-id><hostSuffix>`
 * by Traefik's Docker provider, which watches the Docker socket and
 * registers/deregisters routes automatically as containers start and stop
 * (see packages/proxy/traefik/traefik.yml). No manual Traefik configuration
 * edits or restarts are ever required — dockerManager.ts merges the labels
 * computed here onto every spawned container.
 *
 * Phase 4 (DNS + HTTPS): when `hostSuffix` points at a real domain instead
 * of the Phase 3 default `.localhost`, this also emits an HTTPS router,
 * an HTTP->HTTPS redirect middleware, and a `tls.certresolver` pointing at
 * the Let's Encrypt resolver configured in packages/proxy/traefik/acme.yml.
 * `.localhost` cannot get a real certificate from any ACME CA (it isn't a
 * publicly resolvable domain), so TLS labels are only emitted once a real
 * `hostSuffix` is configured — see the `enableTls` derivation below. This
 * keeps local dev on plain HTTP by default while making TLS fully
 * automatic the moment a real domain is configured, with no separate
 * per-environment code path to maintain.
 *
 * Every session's secure router requests the *same* wildcard SAN
 * (`tls.domains[0]`) rather than a cert for its own single hostname, so
 * Let's Encrypt is asked for one wildcard certificate total — issued once,
 * on whichever session happens to start first, and reused from Traefik's
 * acme.json store by every session after that. See
 * packages/proxy/traefik/acme.yml and infra/dns/wildcard-record-notes.md
 * for the DNS-01 + wildcard-cert mechanics this relies on.
 */

/** Docker network shared by Traefik and every spawned sandbox container. */
export const PROXY_NETWORK_NAME = "live-network";

/** Port inside the sandbox container that the user's dev server listens on. */
export const DEFAULT_PROXY_TARGET_PORT = 8080;

const DEFAULT_ENTRYPOINT = "web";
const DEFAULT_HTTPS_ENTRYPOINT = "websecure";
const DEFAULT_HOST_SUFFIX = ".localhost";
const DEFAULT_CERT_RESOLVER = "letsencrypt";

export interface ProxyLabelOptions {
  /** Port inside the container Traefik should load-balance to. */
  readonly targetPort?: number;
  /** Docker network Traefik and the container both belong to. */
  readonly network?: string;
  /** Traefik entryPoint (defined in traefik.yml) to attach the HTTP router to. */
  readonly entryPoint?: string;
  /** Traefik entryPoint (defined in acme.yml) to attach the HTTPS router to. */
  readonly httpsEntryPoint?: string;
  /**
   * Suffix appended to the sanitized session id to form the routed host.
   * Defaults to Phase 3's `.localhost`. Set to a real domain (e.g.
   * `.sessions.yourdomain.dev`, via the `SESSION_HOST_SUFFIX` env var read
   * in dockerManager.ts) to route real traffic and, per `enableTls` below,
   * turn on HTTPS automatically.
   */
  readonly hostSuffix?: string;
  /**
   * Whether to emit HTTPS router + redirect + certresolver labels.
   * Defaults to `true` whenever `hostSuffix` is anything other than the
   * `.localhost` default, since `.localhost` can never obtain a real
   * certificate and would otherwise just accumulate failed ACME attempts.
   * Pass explicitly to override (e.g. force it off for a custom local
   * domain, or on for a resolver that already trusts your CA).
   */
  readonly enableTls?: boolean;
  /** Name of the `certificatesResolvers.<name>` entry defined in acme.yml. */
  readonly certResolver?: string;
  /**
   * The public zone the wildcard certificate should cover, e.g.
   * `sessions.yourdomain.dev`. Required when `enableTls` is true (directly
   * or by default) unless the request supplies `hostSuffix` already in
   * `.sessions.yourdomain.dev` form, in which case it's derived from that.
   */
  readonly wildcardDomain?: string;
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
 * Derives the wildcard zone a hostSuffix like `.sessions.yourdomain.dev`
 * belongs to (`sessions.yourdomain.dev`), for use as the `tls.domains`
 * main/SAN values. Falls back to the hostSuffix with its leading dot
 * stripped if it doesn't otherwise start with a dot.
 */
function deriveWildcardDomain(hostSuffix: string): string {
  return hostSuffix.startsWith(".") ? hostSuffix.slice(1) : hostSuffix;
}

/**
 * Reads the session host suffix from the environment.
 *
 * `SESSION_HOST_SUFFIX` (e.g. `sessions.yourdomain.dev` or
 * `.sessions.yourdomain.dev`) switches routing from the Phase 3 default
 * `.localhost` to a real domain, which in turn makes computeProxyLabels emit
 * the HTTPS labels. A missing leading dot is added; empty/unset falls back
 * to `.localhost`.
 */
export function getHostSuffixFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env["SESSION_HOST_SUFFIX"]?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_HOST_SUFFIX;
  }
  return raw.startsWith(".") ? raw : `.${raw}`;
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
  const httpsEntryPoint = options.httpsEntryPoint ?? DEFAULT_HTTPS_ENTRYPOINT;
  const hostSuffix = options.hostSuffix ?? DEFAULT_HOST_SUFFIX;
  const certResolver = options.certResolver ?? DEFAULT_CERT_RESOLVER;
  const enableTls = options.enableTls ?? hostSuffix !== DEFAULT_HOST_SUFFIX;

  const subdomain = sanitizeSubdomain(sessionId);
  const resource = proxyResourceName(subdomain);
  const host = `${subdomain}${hostSuffix}`;

  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${resource}.rule`]: `Host(\`${host}\`)`,
    [`traefik.http.routers.${resource}.entrypoints`]: entryPoint,
    [`traefik.http.services.${resource}.loadbalancer.server.port`]: String(targetPort),
    "traefik.docker.network": network,
  };

  if (!enableTls) {
    return labels;
  }

  if (!options.wildcardDomain && hostSuffix === DEFAULT_HOST_SUFFIX) {
    throw new Error(
      "computeProxyLabels: enableTls is true but hostSuffix is still the " +
        "default '.localhost' and no wildcardDomain was supplied — " +
        "'.localhost' cannot receive a real ACME certificate. Set a real " +
        "hostSuffix (e.g. via SESSION_HOST_SUFFIX) or pass wildcardDomain " +
        "explicitly.",
    );
  }
  const wildcardDomain = options.wildcardDomain ?? deriveWildcardDomain(hostSuffix);

  // Plain-HTTP requests get redirected to HTTPS rather than served, so
  // "zero manual per-session intervention" also means no session is ever
  // reachable over unencrypted HTTP once TLS is enabled.
  const redirectMiddleware = `${resource}-https-redirect`;
  labels[`traefik.http.routers.${resource}.middlewares`] = redirectMiddleware;
  labels[`traefik.http.middlewares.${redirectMiddleware}.redirectscheme.scheme`] = "https";
  labels[`traefik.http.middlewares.${redirectMiddleware}.redirectscheme.permanent`] = "true";

  const secureResource = `${resource}-secure`;
  labels[`traefik.http.routers.${secureResource}.rule`] = `Host(\`${host}\`)`;
  labels[`traefik.http.routers.${secureResource}.entrypoints`] = httpsEntryPoint;
  // Explicit: the secure router's name differs from the service name
  // (`${resource}`), so Traefik won't infer it — without this line it would
  // look for a nonexistent `${secureResource}` service instead of reusing
  // the one already defined above.
  labels[`traefik.http.routers.${secureResource}.service`] = resource;
  labels[`traefik.http.routers.${secureResource}.tls`] = "true";
  labels[`traefik.http.routers.${secureResource}.tls.certresolver`] = certResolver;
  // Ask for the wildcard SAN, not this session's single hostname, so every
  // session shares one issued certificate instead of requesting its own.
  labels[`traefik.http.routers.${secureResource}.tls.domains[0].main`] = wildcardDomain;
  labels[`traefik.http.routers.${secureResource}.tls.domains[0].sans`] = `*.${wildcardDomain}`;

  return labels;
}