/**
 * The resolution ladder: what country is this artist from, and what language is this sung in.
 *
 * Order matters. Country is always resolved first, because a shared writing system
 * (Arabic, Cyrillic, Han) can only be narrowed to a language once you know where the
 * artist is from.
 */
import type { Resolved, TrackTags } from './types.ts';
import { UNRESOLVED } from './types.ts';
import { artistCacheKey } from './iso.ts';
import { detectScript, resolveShared } from './script.ts';
import type { MusicBrainzClient } from '../mb/client.ts';
import { cacheKeys, LookupCache } from '../mb/cache.ts';
import { lookupArtist, lookupRecordingLanguage, searchArtist } from '../mb/lookup.ts';
import type { ArtistCountry, RecordingLanguage } from '../mb/lookup.ts';

/**
 * Where the language answer should come from.
 * - `script`      — writing system first, MusicBrainz only for Latin titles. Fast, and for a
 *                   non-Latin library it needs almost no network at all.
 * - `musicbrainz` — ask MusicBrainz first for every track that has a recording ID. More
 *                   accurate for a Latin-script library and for oddities like a Japanese
 *                   title sung in English, but it costs one request per track.
 */
export type LanguageSource = 'script' | 'musicbrainz';

/** Compilation placeholders that have no meaningful single country. */
const VARIOUS_ARTISTS = new Set([
  'various artists',
  'various',
  'va',
  'soundtrack',
  'original soundtrack',
  'unknown artist',
  'no artist',
]);

export function isVariousArtists(name: string | null): boolean {
  return name !== null && VARIOUS_ARTISTS.has(artistCacheKey(name));
}

export interface ResolverOptions {
  /** null means run offline: script detection still works, MusicBrainz is skipped. */
  client: MusicBrainzClient | null;
  cache?: LookupCache;
  languageSource?: LanguageSource;
}

export class Resolver {
  readonly #client: MusicBrainzClient | null;
  readonly #cache: LookupCache;
  readonly #languageSource: LanguageSource;
  /** Lookups that failed for transient reasons, so a scan can report them honestly. */
  #lookupFailures = 0;

  constructor(options: ResolverOptions) {
    this.#client = options.client;
    this.#cache = options.cache ?? LookupCache.ephemeral();
    this.#languageSource = options.languageSource ?? 'script';
  }

  get lookupFailures(): number {
    return this.#lookupFailures;
  }

  /**
   * Run a cached lookup, degrading to `undefined` if the network or the service fails.
   *
   * MusicBrainz genuinely returns 503 under load — observed repeatedly against the live
   * service. One busy moment must not abort a scan of twenty thousand files, and it must
   * not be cached either: a transient failure recorded as "no such artist" would poison
   * every future run.
   */
  async #tryLookup<T>(key: string, compute: () => Promise<T>): Promise<T | undefined> {
    try {
      return await this.#cache.fetch<T>(key, compute);
    } catch {
      this.#lookupFailures++;
      return undefined;
    }
  }

  /** Which artist a track's country should be judged by: the album artist. */
  static artistKeyFor(track: TrackTags): string | null {
    return track.albumArtist ?? track.artist;
  }

  async resolveCountry(track: TrackTags): Promise<Resolved> {
    const name = Resolver.artistKeyFor(track);
    if (isVariousArtists(name)) {
      return { ...UNRESOLVED, note: 'compilation — no single artist country' };
    }

    const mbid = track.albumArtistMbid ?? track.artistMbid;
    if (mbid && this.#client) {
      const artist = await this.#tryLookup<ArtistCountry | null>(
        cacheKeys.artistByMbid(mbid),
        () => lookupArtist(this.#client!, mbid),
      );
      if (artist === undefined) return { ...UNRESOLVED, note: 'MusicBrainz lookup failed — try again later' };
      if (artist?.country) return { value: artist.country, confidence: 'high', source: 'mbid' };
      if (artist) {
        return { ...UNRESOLVED, note: `MusicBrainz has no country for ${artist.name}` };
      }
    }

    if (name && this.#client) {
      const artist = await this.#tryLookup<ArtistCountry | null>(
        cacheKeys.artistByName(artistCacheKey(name)),
        () => searchArtist(this.#client!, name),
      );
      if (artist === undefined) return { ...UNRESOLVED, note: 'MusicBrainz search failed — try again later' };
      if (artist?.country) return { value: artist.country, confidence: 'medium', source: 'search' };
      if (!artist) return { ...UNRESOLVED, note: `no confident MusicBrainz match for "${name}"` };
      return { ...UNRESOLVED, note: `MusicBrainz has no country for ${artist.name}` };
    }

    if (!this.#client) return { ...UNRESOLVED, note: 'offline — MusicBrainz not consulted' };
    return { ...UNRESOLVED, note: 'no album artist to look up' };
  }

  async resolveLanguage(track: TrackTags, country: string | null): Promise<Resolved> {
    if (this.#languageSource === 'musicbrainz') {
      const fromWork = await this.#fromWork(track);
      if (fromWork) return fromWork;
      return this.#fromScript(track, country) ?? { ...UNRESOLVED, note: 'no language evidence' };
    }

    const fromScript = this.#fromScript(track, country);
    // A definite script settles it; anything less is worth a MusicBrainz check.
    if (fromScript?.confidence === 'high') return fromScript;

    const fromWork = await this.#fromWork(track);
    if (fromWork) return fromWork;
    if (fromScript) return fromScript;

    return { ...UNRESOLVED, note: this.#noEvidenceNote(track) };
  }

  #noEvidenceNote(track: TrackTags): string {
    if (!track.title) return 'no title to inspect';
    if (!track.recordingMbid) return 'Latin script and no MusicBrainz recording id';
    return 'MusicBrainz has no work language for this recording';
  }

  /** What the writing system proves, if anything. */
  #fromScript(track: TrackTags, country: string | null): Resolved | null {
    const verdict = detectScript(track.title);
    if (verdict.kind === 'definite') {
      return { value: verdict.language, confidence: 'high', source: 'script' };
    }
    if (verdict.kind === 'shared') {
      const narrowed = resolveShared(verdict, country);
      if (narrowed) {
        return { value: narrowed, confidence: 'medium', source: 'script+country' };
      }
      return {
        ...UNRESOLVED,
        note: `${verdict.script} script is shared between languages and the artist's country is unknown`,
      };
    }
    return null;
  }

  /** What MusicBrainz says the linked work is sung in. */
  async #fromWork(track: TrackTags): Promise<Resolved | null> {
    if (!track.recordingMbid || !this.#client) return null;
    const mbid = track.recordingMbid;
    const found = await this.#tryLookup<RecordingLanguage | null>(
      cacheKeys.recording(mbid),
      () => lookupRecordingLanguage(this.#client!, mbid),
    );
    if (!found?.language) return null;
    return {
      value: found.language,
      confidence: 'high',
      source: found.instrumental ? 'instrumental' : 'work',
    };
  }
}
