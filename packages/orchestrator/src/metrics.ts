import { createHash, timingSafeEqual } from "node:crypto";
import type { ManagedContainer, ManagedContainerStatus } from "./containers/containerTypes.js";
import type { SessionRecord } from "./sessionStore/sessionStore.js";
import type { ApiContext, Logger, OrchestratorSessionStore, SessionDocker } from "./sessionStore/sessionTypes.js";

/** Prometheus text exposition format 0.0.4. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Seconds. Session creation waits for a sandbox to boot, so the tail reaches a minute. */
export const REQUEST_DURATION_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

const COLLECT_TIMEOUT_MS = 4_000;

const CONTAINER_STATUSES: readonly ManagedContainerStatus[] = ["starting", "running", "stopped", "oom_killed", "exited", "error"];

export type Labels = Readonly<Record<string, string>>;

export interface Sample {
  readonly labels?: Labels;
  readonly value: number;
}

function assertName(name: string, pattern: RegExp, kind: string): void {
  if (!pattern.test(name) || name.startsWith("__")) {
    throw new Error(`Invalid ${kind} name "${name}"`);
  }
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Infinity) {
    return "+Inf";
  }
  if (value === -Infinity) {
    return "-Inf";
  }
  return String(value);
}

function renderLabels(labels: Labels | undefined, extra?: Labels): string {
  const entries = [...Object.entries(labels ?? {}), ...Object.entries(extra ?? {})];
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function sampleKey(labelNames: readonly string[], labels: Labels): string {
  return labelNames.map((name) => labels[name] ?? "").join("\u0000");
}

function assertLabelSet(metric: string, labelNames: readonly string[], labels: Labels): void {
  const given = Object.keys(labels);
  if (given.length !== labelNames.length || !labelNames.every((name) => name in labels)) {
    throw new Error(`Metric ${metric} expects labels [${labelNames.join(", ")}], got [${given.join(", ")}]`);
  }
}

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[],
  ) {
    assertName(name, METRIC_NAME, "metric");
    labelNames.forEach((label) => assertName(label, LABEL_NAME, "label"));
  }

  inc(labels: Labels = {}, by = 1): void {
    assertLabelSet(this.name, this.labelNames, labels);
    const key = sampleKey(this.labelNames, labels);
    const entry = this.values.get(key) ?? { labels: { ...labels }, value: 0 };
    entry.value += by;
    this.values.set(key, entry);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${formatNumber(value)}`);
    }
    return lines;
  }
}

interface HistogramSeries {
  readonly labels: Labels;
  readonly counts: number[];
  sum: number;
  count: number;
}

class Histogram {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[],
    private readonly buckets: readonly number[],
  ) {
    assertName(name, METRIC_NAME, "metric");
    labelNames.forEach((label) => {
      assertName(label, LABEL_NAME, "label");
      if (label === "le") {
        throw new Error('Histogram label "le" is reserved');
      }
    });
    if (buckets.length === 0 || buckets.some((bound, index) => index > 0 && bound <= (buckets[index - 1] ?? 0))) {
      throw new Error(`Histogram ${name} buckets must be non-empty and strictly increasing`);
    }
  }

  observe(labels: Labels, value: number): void {
    assertLabelSet(this.name, this.labelNames, labels);
    const key = sampleKey(this.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels: { ...labels }, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    const index = this.buckets.findIndex((bound) => value <= bound);
    if (index >= 0) {
      entry.counts[index] = (entry.counts[index] ?? 0) + 1;
    }
    entry.sum += value;
    entry.count += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.series.values()) {
      let cumulative = 0;
      this.buckets.forEach((bound, index) => {
        cumulative += entry.counts[index] ?? 0;
        lines.push(`${this.name}_bucket${renderLabels(entry.labels, { le: formatNumber(bound) })} ${cumulative}`);
      });
      lines.push(`${this.name}_bucket${renderLabels(entry.labels, { le: "+Inf" })} ${entry.count}`);
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${formatNumber(entry.sum)}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    return lines;
  }
}

interface GaugeCollector<C> {
  readonly name: string;
  readonly help: string;
  readonly collect: (scrape: C) => Promise<readonly Sample[]> | readonly Sample[];
}

/**
 * A small Prometheus registry with no dependencies (the production image installs
 * from a frozen lockfile, so a client library would mean regenerating it).
 * Counters and histograms hold state; gauges are read from their source at scrape time.
 * `C` is a per-scrape context, so several gauges can share one expensive lookup.
 */
export class MetricsRegistry<C> {
  private readonly names = new Set<string>();
  private readonly counters: Counter[] = [];
  private readonly histograms: Histogram[] = [];
  private readonly gauges: GaugeCollector<C>[] = [];

  constructor(
    private readonly createScrape: () => C,
    private readonly onCollectFailure: (metric: string, error: unknown) => void,
  ) {}

  private claim(name: string): void {
    if (this.names.has(name)) {
      throw new Error(`Metric ${name} is already registered`);
    }
    this.names.add(name);
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    this.claim(name);
    const counter = new Counter(name, help, labelNames);
    this.counters.push(counter);
    return counter;
  }

  histogram(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]): Histogram {
    this.claim(name);
    const histogram = new Histogram(name, help, labelNames, buckets);
    this.histograms.push(histogram);
    return histogram;
  }

  gauge(name: string, help: string, collect: GaugeCollector<C>["collect"]): void {
    assertName(name, METRIC_NAME, "metric");
    this.claim(name);
    this.gauges.push({ name, help, collect });
  }

  /**
   * A gauge whose source failed (or timed out) is left out of the output rather than
   * reported as zero: a made-up zero would hide an outage and could resolve an alert.
   */
  async render(): Promise<string> {
    const scrape = this.createScrape();
    const blocks: string[][] = [];

    const collected = await Promise.all(
      this.gauges.map(async (gauge) => {
        try {
          return { gauge, samples: await withTimeout(Promise.resolve(gauge.collect(scrape)), COLLECT_TIMEOUT_MS, gauge.name) };
        } catch (error) {
          this.onCollectFailure(gauge.name, error);
          return { gauge, samples: undefined };
        }
      }),
    );

    for (const { gauge, samples } of collected) {
      if (samples === undefined) {
        continue;
      }
      const lines = [`# HELP ${gauge.name} ${escapeHelp(gauge.help)}`, `# TYPE ${gauge.name} gauge`];
      for (const sample of samples) {
        lines.push(`${gauge.name}${renderLabels(sample.labels)} ${formatNumber(sample.value)}`);
      }
      blocks.push(lines);
    }
    for (const counter of this.counters) {
      blocks.push(counter.render());
    }
    for (const histogram of this.histograms) {
      blocks.push(histogram.render());
    }
    return `${blocks.map((lines) => lines.join("\n")).join("\n")}\n`;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Orchestrator metrics                                                */
/* ------------------------------------------------------------------ */

export interface OrchestratorMetricsDeps {
  readonly store: Pick<OrchestratorSessionStore, "list">;
  readonly docker: Pick<SessionDocker, "listManagedContainers">;
  /** The idle timeout the reaper enforces; exported so alerts can compare against it. */
  readonly idleTimeoutMs: number;
  readonly now: () => number;
  readonly logger: Logger;
  readonly replicaId: string;
  /** When set, GET /metrics needs `Authorization: Bearer <token>`. */
  readonly bearerToken?: string | undefined;
}

export interface OrchestratorMetrics {
  readonly contentType: string;
  /** Records one finished HTTP request. `route` must be low-cardinality (a route name, never a raw path). */
  observeRequest(route: string, method: string, status: number, durationSeconds: number): void;
  render(): Promise<string>;
  isAuthorized(authorizationHeader: string | undefined): boolean;
}

/** ApiContext plus the optional metrics sink. Phase scripts that build a plain ApiContext keep working. */
export interface ObservableApiContext extends ApiContext {
  readonly metrics?: OrchestratorMetrics;
}

interface ScrapeContext {
  readonly sessions: () => Promise<readonly SessionRecord[]>;
  readonly containers: () => Promise<readonly ManagedContainer[]>;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Exposed series (all gauges are read at scrape time):
 *
 *   active_sessions                  sessions in the shared store. Every replica reports the
 *                                    same number, so query it with max(), never sum().
 *   container_count{status}          managed sandbox containers on this Docker host, by status.
 *   session_max_idle_seconds         longest time since any session's last heartbeat (0 if none).
 *   session_idle_timeout_seconds     the reaper's idle timeout, so alerts can use a multiple of it.
 *   request_duration_seconds         histogram of API request time by route, method and status.
 *   metrics_collect_failures_total   scrapes where a gauge's source failed (that gauge is omitted).
 *   orchestrator_info{replica_id}    constant 1.
 *   process_start_time_seconds, process_resident_memory_bytes
 */
export function createOrchestratorMetrics(deps: OrchestratorMetricsDeps): OrchestratorMetrics {
  const { store, docker, now, logger } = deps;
  const startedAtSeconds = now() / 1000;
  const expectedToken = deps.bearerToken ? digest(deps.bearerToken) : undefined;

  let failures: Counter;
  const registry = new MetricsRegistry<ScrapeContext>(
    () => {
      let sessions: Promise<readonly SessionRecord[]> | undefined;
      let containers: Promise<readonly ManagedContainer[]> | undefined;
      return {
        sessions: () => (sessions ??= store.list()),
        containers: () => (containers ??= docker.listManagedContainers()),
      };
    },
    (metric, error) => {
      failures.inc({ collector: metric });
      logger.warn("metrics.collect_failed", { metric, message: error instanceof Error ? error.message : String(error) });
    },
  );

  failures = registry.counter("metrics_collect_failures_total", "Scrapes in which a gauge's data source failed; that gauge was omitted.", [
    "collector",
  ]);
  const requestDuration = registry.histogram(
    "request_duration_seconds",
    "Orchestrator API request duration in seconds.",
    ["route", "method", "status"],
    REQUEST_DURATION_BUCKETS,
  );

  registry.gauge("active_sessions", "Sessions currently tracked in the shared session store.", async (scrape) => [
    { value: (await scrape.sessions()).length },
  ]);
  registry.gauge("container_count", "Managed sandbox containers on this Docker host, by status.", async (scrape) => {
    const containers = await scrape.containers();
    return CONTAINER_STATUSES.map((status) => ({
      labels: { status },
      value: containers.filter((container) => container.status === status).length,
    }));
  });
  registry.gauge("session_max_idle_seconds", "Seconds since the least recently active session's last heartbeat; 0 when there are no sessions.", async (scrape) => {
    const sessions = await scrape.sessions();
    const current = now();
    const longest = sessions.reduce((max, record) => Math.max(max, current - record.updatedAt), 0);
    return [{ value: longest / 1000 }];
  });
  registry.gauge("session_idle_timeout_seconds", "Idle time after which the reaper ends a session.", () => [{ value: deps.idleTimeoutMs / 1000 }]);
  registry.gauge("orchestrator_info", "Constant 1, labelled with the replica id.", () => [{ labels: { replica_id: deps.replicaId }, value: 1 }]);
  registry.gauge("process_start_time_seconds", "Start time of the process, in unix seconds.", () => [{ value: startedAtSeconds }]);
  registry.gauge("process_resident_memory_bytes", "Resident memory size of the process in bytes.", () => [{ value: process.memoryUsage().rss }]);

  return {
    contentType: METRICS_CONTENT_TYPE,
    observeRequest(route, method, status, durationSeconds) {
      requestDuration.observe({ route, method, status: String(status) }, Math.max(0, durationSeconds));
    },
    render: () => registry.render(),
    isAuthorized(header) {
      if (!expectedToken) {
        return true;
      }
      const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
      return match?.[1] !== undefined && timingSafeEqual(digest(match[1].trim()), expectedToken);
    },
  };
}