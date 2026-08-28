/**
 * ISO code handling, plus the one piece of input validation that actually matters:
 * MusicBrainz IDs are read out of untrusted tag data and then interpolated into a URL.
 *
 * Display names come from Node's built-in ICU rather than a hand-maintained table.
 */

/** MusicBrainz IDs are RFC-4122 UUIDs. Anything else never reaches a URL. */
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COUNTRY_RE = /^[A-Z]{2}$/;
const LANGUAGE_RE = /^[a-z]{2,3}$/;

/** ISO 639-3 for "no linguistic content" — MusicBrainz's own marker for an instrumental. */
export const INSTRUMENTAL = 'zxx';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * True only for a well-formed MusicBrainz ID. Call this before putting a value
 * that came from a music file into a request URL.
 */
export function isValidMbid(value: unknown): value is string {
  return typeof value === 'string' && MBID_RE.test(value);
}

/** Uppercase an ISO 3166-1 alpha-2 code, or null if it is not one. */
export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return COUNTRY_RE.test(code) ? code : null;
}

/** Lowercase an ISO 639 language code, or null if it is not one. */
export function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return LANGUAGE_RE.test(code) ? code : null;
}

/** "JP" -> "Japan". Falls back to the code itself for anything ICU does not know. */
export function countryName(code: string): string {
  const normalized = normalizeCountry(code);
  if (!normalized) return code;
  try {
    return regionNames.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}

/** "jpn" -> "Japanese", "zxx" -> "Instrumental". Falls back to the code itself. */
export function languageName(code: string): string {
  const normalized = normalizeLanguage(code);
  if (!normalized) return code;
  if (normalized === INSTRUMENTAL) return 'Instrumental';
  try {
    return languageNames.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}

/**
 * Fold an artist name into a stable cache key. Deliberately conservative: it lowercases,
 * collapses whitespace and strips accents, but does not try to be clever about
 * "The Beatles" vs "Beatles" — that would merge genuinely different artists.
 */
export function artistCacheKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
