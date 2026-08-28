/**
 * MusicBrainz asks for at most one request per second, per client. That is not a
 * suggestion — exceeding it gets an IP blocked, and this tool points at a free service
 * run by a non-profit.
 *
 * So every request in the process funnels through one queue: strictly serial, with a
 * guaranteed gap between the end of one and the start of the next. The clock and sleep
 * are injectable so the behaviour can be tested without actually waiting.
 */
export interface LimiterOptions {
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Serialises callers: each waits for the previous one to finish. */
  #queue: Promise<unknown> = Promise.resolve();
  #lastStart = Number.NEGATIVE_INFINITY;

  constructor(options: LimiterOptions = {}) {
    this.#minIntervalMs = options.minIntervalMs ?? 1000;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Run `task` once the rate budget allows it. Rejections do not break the queue. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      const waitFor = this.#lastStart + this.#minIntervalMs - this.#now();
      if (waitFor > 0) await this.#sleep(waitFor);
      this.#lastStart = this.#now();
      return task();
    });
    // Keep the chain alive even when a task throws, so one failure cannot wedge the queue.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
