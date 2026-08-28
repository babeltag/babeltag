/**
 * The two MusicBrainz questions this tool asks: where is this artist from, and what
 * language is this recording sung in.
 *
 * Everything is parsed defensively — no field is assumed present — because a shape change
 * upstream should degrade to "unknown", never crash a scan halfway through a library.
 */
import type { MusicBrainzClient } from './client.ts';
import { INSTRUMENTAL, isValidMbid, normalizeCountry, normalizeLanguage } from '../core/iso.ts';

interface MbArea {
  name?: string;
  'iso-3166-1-codes'?: string[];
}

interface MbArtist {
  id?: string;
  name?: string;
  type?: string;
  score?: number;
  country?: string;
  area?: MbArea;
  'begin-area'?: MbArea;
  disambiguation?: string;
}

interface MbRelation {
  'target-type'?: string;
  type?: string;
  attributes?: string[];
  work?: { title?: string; language?: string; languages?: string[] };
}

interface MbRecording {
  id?: string;
  title?: string;
  relations?: MbRelation[];
}

export interface ArtistCountry {
  country: string | null;
  name: string;
  /** Only set when the answer came from a name search. */
  score?: number;
}

/**
 * A MusicBrainz artist records its country in up to three places, in decreasing
 * directness. Take the first that yields a real ISO code.
 */
function countryOf(artist: MbArtist): string | null {
  return (
    normalizeCountry(artist.country) ??
    normalizeCountry(artist.area?.['iso-3166-1-codes']?.[0]) ??
    normalizeCountry(artist['begin-area']?.['iso-3166-1-codes']?.[0])
  );
}

/** Direct lookup by MBID — the unambiguous path, used whenever the file carries an ID. */
export async function lookupArtist(
  client: MusicBrainzClient,
  mbid: string,
): Promise<ArtistCountry | null> {
  if (!isValidMbid(mbid)) return null;
  const artist = await client.get<MbArtist>(`artist/${mbid}`);
  if (!artist?.name) return null;
  return { country: countryOf(artist), name: artist.name };
}

/** Only real musical acts; a Character or Other entity's "country" is meaningless here. */
const ACCEPTABLE_TYPES = new Set(['Person', 'Group', 'Orchestra', 'Choir']);

/** A hit must be this strong, and this far clear of the runner-up, to be trusted. */
export const MIN_SEARCH_SCORE = 95;
export const MIN_SEARCH_GAP = 5;

/**
 * Find an artist by name.
 *
 * Uses a plain default-field query on purpose. The fielded form `artist:"Yorushika"`
 * returns ZERO results because it only searches the primary name, while the artist is
 * stored as ヨルシカ with Yorushika as an alias — which is exactly the situation for the
 * non-Latin-script artists this tool exists to sort out. The plain query searches aliases
 * too and returns the right artist at score 100.
 */
export async function searchArtist(
  client: MusicBrainzClient,
  name: string,
): Promise<ArtistCountry | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const result = await client.get<{ artists?: MbArtist[] }>('artist', {
    query: trimmed,
    limit: '3',
  });
  const artists = Array.isArray(result?.artists) ? result.artists : [];
  const [best, runnerUp] = artists;
  if (!best?.name) return null;

  const score = typeof best.score === 'number' ? best.score : 0;
  if (score < MIN_SEARCH_SCORE) return null;
  if (best.type && !ACCEPTABLE_TYPES.has(best.type)) return null;

  // A near-tie means the name is genuinely ambiguous ("Air", "Bush", "Low").
  const runnerUpScore = typeof runnerUp?.score === 'number' ? runnerUp.score : 0;
  if (score - runnerUpScore < MIN_SEARCH_GAP) return null;

  return { country: countryOf(best), name: best.name, score };
}

export interface RecordingLanguage {
  language: string | null;
  instrumental: boolean;
}

/**
 * Ask what a recording is sung in.
 *
 * The answer lives on the linked *work*, not the release: a release's language describes
 * its track listing, which is why a J-Rock album pressed in the US reads as English.
 * `zxx` is ISO 639-3 for "no linguistic content" — MusicBrainz's own marker for an
 * instrumental — and the relation can also carry an explicit `instrumental` attribute.
 */
export async function lookupRecordingLanguage(
  client: MusicBrainzClient,
  mbid: string,
): Promise<RecordingLanguage | null> {
  if (!isValidMbid(mbid)) return null;

  const recording = await client.get<MbRecording>(`recording/${mbid}`, {
    inc: 'work-rels+work-level-rels',
  });
  const relations = Array.isArray(recording?.relations) ? recording.relations : [];
  const workRelations = relations.filter((r) => r?.['target-type'] === 'work');
  if (workRelations.length === 0) return null;

  for (const relation of workRelations) {
    const attributes = Array.isArray(relation.attributes) ? relation.attributes : [];
    if (attributes.some((a) => typeof a === 'string' && /instrumental/i.test(a))) {
      return { language: INSTRUMENTAL, instrumental: true };
    }
    const languages = Array.isArray(relation.work?.languages) ? relation.work.languages : [];
    const candidate = normalizeLanguage(languages[0]) ?? normalizeLanguage(relation.work?.language);
    if (candidate) {
      return { language: candidate, instrumental: candidate === INSTRUMENTAL };
    }
  }
  return null;
}
