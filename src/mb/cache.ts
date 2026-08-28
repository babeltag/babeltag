/**
 * An append-only JSONL cache.
 *
 * At one request per second, a large library is hours of lookups — so a re-scan after
 * adding a few albums must cost a few requests, not thousands. That makes the cache a
 * core feature, not an optimisation.
 *
 * Append-only JSONL over a database because it is crash-safe for free: a run killed
 * mid-write leaves one torn final line, which is discarded on load, and every complete
 * line before it survives. No transactions, no dependency, no experimental API.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Bump when the cached shape changes; older entries are then ignored, not misread. */
export const CACHE_VERSION = 1;

interface CacheLine {
  v: number;
  k: string;
  /** `null` is a real answer meaning "we asked and MusicBrainz had nothing". */
  d: unknown;
  ts: string;
}

export class LookupCache {
  readonly #entries = new Map<string, unknown>();
  readonly #filePath: string | null;
  #hits = 0;

  private constructor(filePath: string | null) {
    this.#filePath = filePath;
  }

  /** Load a cache from disk, tolerating a truncated or partly-corrupt file. */
  static open(filePath: string, refresh = false): LookupCache {
    const cache = new LookupCache(filePath);
    if (refresh) {
      fs.rmSync(filePath, { force: true });
      return cache;
    }
    if (!fs.existsSync(filePath)) return cache;

    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as CacheLine;
        // A torn last line, or an entry from an older schema, is simply a miss.
        if (parsed?.v === CACHE_VERSION && typeof parsed.k === 'string') {
          cache.#entries.set(parsed.k, parsed.d);
        }
      } catch {
        // Ignore the damaged line and keep everything else.
      }
    }
    return cache;
  }

  /** An in-memory cache, for tests and for runs with caching disabled. */
  static ephemeral(): LookupCache {
    return new LookupCache(null);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get<T>(key: string): T | undefined {
    if (this.#entries.has(key)) this.#hits++;
    return this.#entries.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.#entries.set(key, value);
    if (!this.#filePath) return;
    const line: CacheLine = { v: CACHE_VERSION, k: key, d: value, ts: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    fs.appendFileSync(this.#filePath, `${JSON.stringify(line)}\n`, 'utf8');
  }

  /** Read through the cache, only calling `compute` on a miss. */
  async fetch<T>(key: string, compute: () => Promise<T>): Promise<T> {
    if (this.has(key)) return this.get<T>(key) as T;
    const value = await compute();
    this.set(key, value);
    return value;
  }

  get size(): number {
    return this.#entries.size;
  }

  get hits(): number {
    return this.#hits;
  }
}

export const cacheKeys = {
  artistByMbid: (mbid: string) => `artist:mbid:${mbid}`,
  artistByName: (normalized: string) => `artist:name:${normalized}`,
  recording: (mbid: string) => `recording:${mbid}`,
};
