/** Shared types. Kept dependency-free so every layer can import them. */

export type AudioFormat = 'flac' | 'ogg' | 'opus' | 'mp3' | 'm4a';

/**
 * How much we trust a resolved value.
 * - `high`   — MusicBrainz said so, or the writing system leaves no doubt (kana => Japanese).
 * - `medium` — a good inference that could still be wrong (a name search, or a script shared
 *              between languages narrowed down by the artist's country).
 * - `none`   — we do not know. Never written.
 */
export type Confidence = 'high' | 'medium' | 'none';

export const CONFIDENCE_RANK: Record<Confidence, number> = { none: 0, medium: 1, high: 2 };

/** Where a value came from, so the plan can explain itself. */
export type Source =
  | 'mbid'
  | 'search'
  | 'script'
  | 'script+country'
  | 'work'
  | 'instrumental'
  | 'none';

export interface Resolved {
  value: string | null;
  confidence: Confidence;
  source: Source;
  /** Human-readable note shown in the plan, e.g. why we gave up. */
  note?: string;
}

export const UNRESOLVED: Resolved = { value: null, confidence: 'none', source: 'none' };

/** Everything we read out of one audio file. */
export interface TrackTags {
  path: string;
  format: AudioFormat;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  genres: string[];
  artistMbid: string | null;
  albumArtistMbid: string | null;
  /** Picard writes the RECORDING mbid into `musicbrainz_trackid`. */
  recordingMbid: string | null;
  existingCountry: string | null;
  existingLanguage: string | null;
}

export interface PlanEntry {
  path: string;
  format: AudioFormat;
  /** The album-artist name we resolved country from; used for grouping and reporting. */
  artistKey: string | null;
  title: string | null;
  country: Resolved;
  language: Resolved;
  existingCountry: string | null;
  existingLanguage: string | null;
}

export interface ScanPlan {
  version: 1;
  library: string;
  createdAt: string;
  entries: PlanEntry[];
  /** Files we recognised as audio but cannot tag. */
  unsupported: string[];
  /** Files that blew up on read; the run continues without them. */
  errors: Array<{ path: string; error: string }>;
}

export type TagKind = 'country' | 'language';

export interface JournalRecord {
  ts: string;
  path: string;
  format: AudioFormat;
  kind: TagKind;
  /** null means the field did not exist before, so undo must remove it. */
  previous: string | null;
  written: string;
}
