/**
 * Language from the writing system of a title.
 *
 * This is deliberately NOT statistical language detection. A three-word song title is far
 * below the length where that is reliable, and a confidently wrong `deu` across a whole
 * library is worse than an honest blank.
 *
 * What a script can tell you splits in two:
 *  - Some scripts belong to exactly one language in practice (kana, Hangul, Hebrew, Greek).
 *    Seeing them is as good as being told.
 *  - Others are shared (Arabic script is also Persian and Urdu; Cyrillic is also Ukrainian
 *    and Bulgarian). Those need the artist's country to narrow down, and stay unresolved
 *    without it rather than defaulting to the most popular guess.
 */

/** Scripts used by essentially one language, so seeing one settles it. */
const DEFINITE: Array<{ script: string; re: RegExp; language: string }> = [
  // Kana first: a Japanese title mixing kana and kanji must not fall through to the
  // shared Han branch. Mixed "Title / タイトル" headings are extremely common.
  { script: 'Hiragana', re: /\p{Script=Hiragana}/u, language: 'jpn' },
  { script: 'Katakana', re: /\p{Script=Katakana}/u, language: 'jpn' },
  { script: 'Hangul', re: /\p{Script=Hangul}/u, language: 'kor' },
  { script: 'Hebrew', re: /\p{Script=Hebrew}/u, language: 'heb' },
  { script: 'Greek', re: /\p{Script=Greek}/u, language: 'ell' },
  { script: 'Thai', re: /\p{Script=Thai}/u, language: 'tha' },
  { script: 'Georgian', re: /\p{Script=Georgian}/u, language: 'kat' },
  { script: 'Armenian', re: /\p{Script=Armenian}/u, language: 'hye' },
];

/** Scripts shared across languages: country decides, or we stay honest and say nothing. */
const SHARED: Array<{ script: string; re: RegExp; byCountry: Record<string, string> }> = [
  {
    script: 'Han',
    re: /\p{Script=Han}/u,
    byCountry: { JP: 'jpn', CN: 'zho', TW: 'zho', HK: 'zho', MO: 'zho', SG: 'zho', KR: 'kor' },
  },
  {
    script: 'Arabic',
    re: /\p{Script=Arabic}/u,
    byCountry: {
      IR: 'fas', AF: 'fas', TJ: 'fas',
      PK: 'urd', IN: 'urd',
      EG: 'ara', SA: 'ara', MA: 'ara', DZ: 'ara', TN: 'ara', LY: 'ara', LB: 'ara',
      SY: 'ara', IQ: 'ara', JO: 'ara', PS: 'ara', KW: 'ara', AE: 'ara', QA: 'ara',
      BH: 'ara', OM: 'ara', YE: 'ara', SD: 'ara',
    },
  },
  {
    script: 'Cyrillic',
    re: /\p{Script=Cyrillic}/u,
    byCountry: {
      RU: 'rus', UA: 'ukr', BY: 'bel', BG: 'bul', RS: 'srp', MK: 'mkd',
      ME: 'srp', KZ: 'kaz', KG: 'kir', MN: 'mon',
    },
  },
  {
    script: 'Devanagari',
    re: /\p{Script=Devanagari}/u,
    byCountry: { IN: 'hin', NP: 'nep' },
  },
];

export type ScriptVerdict =
  /** One language, no ambiguity. */
  | { kind: 'definite'; language: string; script: string }
  /** The script narrows it down but the artist's country is needed to finish the job. */
  | { kind: 'shared'; script: string; byCountry: Record<string, string> }
  /** Latin, or no letters at all — the writing system tells us nothing. */
  | { kind: 'none' };

/** Inspect a title and report what, if anything, its writing system proves. */
export function detectScript(title: string | null | undefined): ScriptVerdict {
  if (!title) return { kind: 'none' };

  for (const entry of DEFINITE) {
    if (entry.re.test(title)) {
      return { kind: 'definite', language: entry.language, script: entry.script };
    }
  }
  for (const entry of SHARED) {
    if (entry.re.test(title)) {
      return { kind: 'shared', script: entry.script, byCountry: entry.byCountry };
    }
  }
  return { kind: 'none' };
}

/** Resolve a shared-script verdict using the artist's country, or null if it does not help. */
export function resolveShared(verdict: ScriptVerdict, country: string | null): string | null {
  if (verdict.kind !== 'shared' || !country) return null;
  return verdict.byCountry[country] ?? null;
}
