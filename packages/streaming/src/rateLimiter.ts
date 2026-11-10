import { performance } from "node:perf_hooks";

/** Monotonic millisecond clock. Injectable so tests never depend on real time. */
export type Clock = () => number;

export const monotonicClock: Clock = () => performance.now();

/* ------------------------------------------------------------------ */
/* Broadcast rates                                                     */
/* ------------------------------------------------------------------ */

/** Hard ceiling for caret updates sent to viewers (Phase 6 acceptance: <= 10Hz). */
export const CURSOR_MAX_HZ = 10;
/** Buffer broadcasts are coalesced at the same ceiling. */
export const BUFFER_MAX_HZ = 10;
/** File-tree broadcasts are coalesced harder: the tree changes far less often. */
export const TREE_MAX_HZ = 4;

/**
 * Smallest spacing, in milliseconds, between two broadcasts such that no
 * closed 1-second window can ever contain more than `maxHz` of them.
 *
 * With a spacing of exactly 1000/maxHz ms, a closed window of 1000ms can hold
 * maxHz + 1 events (the first and the last sit on the window's two edges).
 * Adding one millisecond makes `maxHz` the true upper bound:
 * `maxHz` events need (maxHz - 1) gaps of at least `floor(1000/maxHz) + 1`
 * ms, while `maxHz + 1` events would need `maxHz` gaps, which is more than
 * 1000ms.
 */
export function minIntervalMsForHz(maxHz: number): number {
  if (!Number.isFinite(maxHz) || maxHz <= 0) {
    throw new RangeError(`maxHz must be a positive finite number (got ${maxHz})`);
  }
  return Math.floor(1000 / maxHz) + 1;
}

/* ------------------------------------------------------------------ */
/* Token bucket                                                        */
/* ------------------------------------------------------------------ */

export interface TokenBucketOptions {
  /** Maximum burst size; the bucket starts full. */
  readonly capacity: number;
  /** Sustained rate: tokens added per second. */
  readonly refillPerSecond: number;
  readonly now?: Clock;
}

/**
 * Classic token bucket. `tryConsume` answers "may this happen now?" without
 * ever blocking or queueing, which makes it the right tool for dropping
 * abusive traffic (as opposed to TrailingThrottle, which delays and
 * coalesces traffic that is legitimate but too frequent).
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: Clock;
  private tokens: number;
  private lastRefillAt: number;

  constructor(options: TokenBucketOptions) {
    if (!(options.capacity >= 1)) {
      throw new RangeError("TokenBucket capacity must be at least 1");
    }
    if (!(options.refillPerSecond > 0)) {
      throw new RangeError("TokenBucket refillPerSecond must be greater than 0");
    }
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerSecond / 1000;
    this.now = options.now ?? monotonicClock;
    this.tokens = options.capacity;
    this.lastRefillAt = this.now();
  }

  /** Takes `cost` tokens if available. Returns false (and takes nothing) otherwise. */
  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) {
      return false;
    }
    this.tokens -= cost;
    return true;
  }

  private refill(): void {
    const current = this.now();
    const elapsed = current - this.lastRefillAt;
    if (elapsed <= 0) {
      return;
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = current;
  }
}

/* ------------------------------------------------------------------ */
/* Trailing throttle                                                   */
/* ------------------------------------------------------------------ */

export interface TimerApi {
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

const realTimers: TimerApi = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TrailingThrottleOptions {
  readonly now?: Clock;
  readonly timers?: TimerApi;
}

/**
 * Rate-limits a stream of "something changed" signals to at most one emit
 * per `intervalMs`, while guaranteeing that the LAST signal is never lost.
 *
 * - If the throttle has been quiet for at least `intervalMs`, `trigger()`
 *   emits immediately (leading edge), so a single caret move is not delayed.
 * - Otherwise the signal is remembered and a single timer emits it as soon
 *   as the interval has elapsed (trailing edge). Any number of triggers in
 *   between collapse into that one emit.
 *
 * The throttle carries no payload on purpose: `emit` reads the current state
 * when it fires, so a delayed emit can never publish stale data.
 *
 * Invariant: two consecutive emits are always at least `intervalMs` apart
 * on the monotonic clock.
 */
export class TrailingThrottle {
  private readonly intervalMs: number;
  private readonly emit: () => void;
  private readonly now: Clock;
  private readonly timers: TimerApi;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private pending = false;
  private timer: unknown = undefined;
  private timerArmed = false;

  constructor(intervalMs: number, emit: () => void, options: TrailingThrottleOptions = {}) {
    if (!(intervalMs > 0)) {
      throw new RangeError("TrailingThrottle intervalMs must be greater than 0");
    }
    this.intervalMs = intervalMs;
    this.emit = emit;
    this.now = options.now ?? monotonicClock;
    this.timers = options.timers ?? realTimers;
  }

  /** Records that state changed and emits now or as soon as the rate allows. */
  trigger(): void {
    const current = this.now();
    if (!this.timerArmed && current - this.lastEmitAt >= this.intervalMs) {
      this.fire(current);
      return;
    }
    this.pending = true;
    if (!this.timerArmed) {
      this.arm(this.lastEmitAt + this.intervalMs - current);
    }
  }

  /** Drops the pending emit (if there is one) and its timer. Safe to call repeatedly. */
  cancel(): void {
    this.pending = false;
    if (this.timerArmed) {
      this.timers.clearTimer(this.timer);
      this.timerArmed = false;
      this.timer = undefined;
    }
  }

  private arm(delayMs: number): void {
    this.timerArmed = true;
    this.timer = this.timers.setTimer(() => this.onTimer(), Math.max(0, Math.ceil(delayMs)));
  }

  private onTimer(): void {
    this.timerArmed = false;
    this.timer = undefined;
    if (!this.pending) {
      return;
    }
    const current = this.now();
    const remaining = this.lastEmitAt + this.intervalMs - current;
    if (remaining > 0) {
      // The timer fired a hair early (timers have millisecond granularity).
      this.arm(remaining);
      return;
    }
    this.fire(current);
  }

  private fire(at: number): void {
    this.pending = false;
    this.lastEmitAt = at;
    this.emit();
  }
}