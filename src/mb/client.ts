/**
 * A small, polite MusicBrainz client.
 *
 * Politeness is the feature: a real User-Agent, one request per second, `Retry-After`
 * honoured, and a bounded number of retries. During development the search endpoint
 * timed out repeatedly, so generous timeouts and backoff are not defensive padding —
 * they are what makes a long scan survive.
 */
import { RateLimiter } from './limiter.ts';

export const MB_BASE = 'https://musicbrainz.org/ws/2';

export interface ClientOptions {
  userAgent: string;
  baseUrl?: string;
  limiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Backoff base; the nth retry waits `retryBaseMs * n`. Injectable for tests. */
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRequest?: (url: string) => void;
}

export class MusicBrainzError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MusicBrainzError';
    this.status = status;
  }
}

/** HTTP statuses worth trying again — everything else is a real answer. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 503 || status >= 500;
}

export class MusicBrainzClient {
  readonly #options: Required<Omit<ClientOptions, 'onRequest'>> & Pick<ClientOptions, 'onRequest'>;
  /** How many HTTP calls actually left the process — asserted by the cache tests. */
  requestCount = 0;

  constructor(options: ClientOptions) {
    this.#options = {
      baseUrl: MB_BASE,
      limiter: options.limiter ?? new RateLimiter(),
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: 30_000,
      maxAttempts: 4,
      retryBaseMs: 1500,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options,
    };
  }

  /** GET a web-service path (e.g. `artist/<mbid>`) and parse the JSON. */
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.#options.baseUrl}/${path}`);
    url.searchParams.set('fmt', 'json');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const href = url.toString();

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt++) {
      try {
        const response = await this.#options.limiter.run(async () => {
          this.requestCount++;
          this.#options.onRequest?.(href);
          return this.#options.fetchImpl(href, {
            headers: { 'User-Agent': this.#options.userAgent, Accept: 'application/json' },
            signal: AbortSignal.timeout(this.#options.timeoutMs),
          });
        });

        if (response.ok) return (await response.json()) as T;

        if (isRetryable(response.status) && attempt < this.#options.maxAttempts) {
          await this.#options.sleep(this.#retryDelay(response, attempt));
          continue;
        }
        throw new MusicBrainzError(`MusicBrainz returned ${response.status}`, response.status);
      } catch (error) {
        // A non-retryable HTTP answer is final; anything else (timeout, socket) can retry.
        if (error instanceof MusicBrainzError) throw error;
        lastError = error as Error;
        if (attempt >= this.#options.maxAttempts) break;
        await this.#options.sleep(this.#options.retryBaseMs * attempt);
      }
    }
    throw new MusicBrainzError(`MusicBrainz request failed: ${lastError?.message ?? 'unknown'}`);
  }

  /** Respect an explicit `Retry-After` when the server sends one. */
  #retryDelay(response: Response, attempt: number): number {
    const header = response.headers?.get?.('retry-after');
    const seconds = header ? Number.parseInt(header, 10) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
    return this.#options.retryBaseMs * attempt;
  }
}

/** MusicBrainz requires a contactable User-Agent; make ours honest. */
export function defaultUserAgent(version: string): string {
  return `Babeltag/${version} ( https://github.com/babeltag/babeltag )`;
}
