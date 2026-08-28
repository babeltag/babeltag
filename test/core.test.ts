import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artistCacheKey,
  countryName,
  INSTRUMENTAL,
  isValidMbid,
  languageName,
  normalizeCountry,
  normalizeLanguage,
} from '../src/core/iso.ts';
import { detectScript, resolveShared } from '../src/core/script.ts';
import { Resolver, isVariousArtists } from '../src/core/resolve.ts';
import { decideEntry, rankedCounts, summarize } from '../src/core/plan.ts';
import type { PlanEntry, Resolved, ScanPlan, TrackTags } from '../src/core/types.ts';
import { MusicBrainzClient } from '../src/mb/client.ts';
import { RateLimiter } from '../src/mb/limiter.ts';
import { LookupCache } from '../src/mb/cache.ts';
import {
  ARTIST_RADIOHEAD,
  RADIOHEAD_MBID,
  RECORDING_INSTRUMENTAL,
  RECORDING_WITH_WORK,
  SEARCH_YORUSHIKA,
  stubFetch,
} from './mb-fixtures.ts';

// --- iso -------------------------------------------------------------------

test('only a well-formed UUID counts as a MusicBrainz id', () => {
  assert.equal(isValidMbid(RADIOHEAD_MBID), true);
  assert.equal(isValidMbid(RADIOHEAD_MBID.toUpperCase()), true);
  for (const bad of ['', 'nope', '../../etc/passwd', `${RADIOHEAD_MBID}?inc=x`, null, 42, undefined]) {
    assert.equal(isValidMbid(bad), false, `${String(bad)} must be rejected`);
  }
});

test('country and language codes are normalised or rejected', () => {
  assert.equal(normalizeCountry('jp'), 'JP');
  assert.equal(normalizeCountry(' de '), 'DE');
  assert.equal(normalizeCountry('JPN'), null);
  assert.equal(normalizeCountry(''), null);

  assert.equal(normalizeLanguage('JPN'), 'jpn');
  assert.equal(normalizeLanguage('eng'), 'eng');
  assert.equal(normalizeLanguage('english'), null);
});

test('codes turn into readable names, including the instrumental marker', () => {
  assert.equal(countryName('JP'), 'Japan');
  assert.equal(countryName('IL'), 'Israel');
  assert.equal(languageName('heb'), 'Hebrew');
  assert.equal(languageName(INSTRUMENTAL), 'Instrumental');
  // An unknown code must degrade to itself, never throw.
  assert.equal(languageName('qqq'), 'qqq');
});

test('artist cache key folds case, accents and spacing but not identity', () => {
  assert.equal(artistCacheKey('Sigur Rós'), 'sigur ros');
  assert.equal(artistCacheKey('  BJÖRK  '), 'bjork');
  assert.notEqual(artistCacheKey('The Beatles'), artistCacheKey('Beatles'));
});

// --- script detection ------------------------------------------------------

test('a definite script settles the language on its own', () => {
  const cases: Array<[string, string]> = [
    ['夜に駆ける', 'jpn'],
    ['カタカナ', 'jpn'],
    ['다시 만난 세계', 'kor'],
    ['הכל עובר', 'heb'],
    ['Θάλασσα', 'ell'],
    ['ลอยกระทง', 'tha'],
  ];
  for (const [title, expected] of cases) {
    const verdict = detectScript(title);
    assert.equal(verdict.kind, 'definite', `${title} should be definite`);
    if (verdict.kind === 'definite') assert.equal(verdict.language, expected, title);
  }
});

test('a mixed Latin/Japanese title resolves as Japanese, not Latin', () => {
  // Extremely common in real libraries: "Title / タイトル".
  const verdict = detectScript('Say It Ain\'t So / だから僕は音楽を辞めた');
  assert.equal(verdict.kind, 'definite');
  if (verdict.kind === 'definite') assert.equal(verdict.language, 'jpn');
});

test('kana beats the shared Han branch, but bare ideographs stay ambiguous', () => {
  // Ideographs alone could be Japanese or Chinese, so they must not be guessed.
  const bare = detectScript('青花瓷');
  assert.equal(bare.kind, 'shared', 'ideographs alone are genuinely ambiguous');
  assert.equal(resolveShared(bare, 'TW'), 'zho');
  assert.equal(resolveShared(bare, 'JP'), 'jpn');

  // One kana character settles it, even surrounded by kanji.
  const withKana = detectScript('花に亡霊');
  assert.equal(withKana.kind, 'definite');
  if (withKana.kind === 'definite') assert.equal(withKana.language, 'jpn');
});

test('a shared script needs the country and refuses to guess without it', () => {
  const arabic = detectScript('يا ليلي');
  assert.equal(arabic.kind, 'shared');
  assert.equal(resolveShared(arabic, 'EG'), 'ara');
  assert.equal(resolveShared(arabic, 'IR'), 'fas', 'Arabic script is also Persian');
  assert.equal(resolveShared(arabic, 'PK'), 'urd', 'Arabic script is also Urdu');
  assert.equal(resolveShared(arabic, null), null, 'no country means no guess');

  const cyrillic = detectScript('Земфира');
  assert.equal(resolveShared(cyrillic, 'RU'), 'rus');
  assert.equal(resolveShared(cyrillic, 'UA'), 'ukr', 'Cyrillic is also Ukrainian');
  assert.equal(resolveShared(cyrillic, 'ZZ'), null, 'an unmapped country must not guess');
});

test('Latin script and empty titles tell us nothing', () => {
  assert.equal(detectScript('Paranoid Android').kind, 'none');
  assert.equal(detectScript('!!! (2004)').kind, 'none');
  assert.equal(detectScript('').kind, 'none');
  assert.equal(detectScript(null).kind, 'none');
});

// --- resolver --------------------------------------------------------------

function track(overrides: Partial<TrackTags> = {}): TrackTags {
  return {
    path: '/music/a.flac',
    format: 'flac',
    title: null,
    artist: null,
    albumArtist: null,
    album: null,
    genres: [],
    artistMbid: null,
    albumArtistMbid: null,
    recordingMbid: null,
    existingCountry: null,
    existingLanguage: null,
    ...overrides,
  };
}

function resolverWith(routes: Array<[RegExp, unknown]>, languageSource: 'script' | 'musicbrainz' = 'script') {
  const { fetch: fetchImpl, calls } = stubFetch(routes);
  const client = new MusicBrainzClient({
    userAgent: 'test',
    fetchImpl,
    limiter: new RateLimiter({ minIntervalMs: 0 }),
    sleep: async () => {},
  });
  return { resolver: new Resolver({ client, languageSource }), calls };
}

test('country comes from the embedded MBID at high confidence', async () => {
  const { resolver } = resolverWith([[/artist\//, ARTIST_RADIOHEAD]]);
  const result = await resolver.resolveCountry(track({ albumArtistMbid: RADIOHEAD_MBID }));
  assert.deepEqual(result, { value: 'GB', confidence: 'high', source: 'mbid' });
});

test('with no MBID, the name search resolves an alias-only artist at medium confidence', async () => {
  const { resolver } = resolverWith([[/artist\?/, SEARCH_YORUSHIKA]]);
  const result = await resolver.resolveCountry(track({ albumArtist: 'Yorushika' }));
  assert.deepEqual(result, { value: 'JP', confidence: 'medium', source: 'search' });
});

test('compilations are skipped rather than given a nonsense country', async () => {
  const { resolver, calls } = resolverWith([[/artist/, ARTIST_RADIOHEAD]]);
  for (const name of ['Various Artists', 'various', 'VA', 'Original Soundtrack']) {
    const result = await resolver.resolveCountry(track({ albumArtist: name }));
    assert.equal(result.value, null, name);
  }
  assert.equal(calls.length, 0, 'a compilation should not cost a lookup');
  assert.equal(isVariousArtists('Various Artists'), true);
  assert.equal(isVariousArtists('Radiohead'), false);
});

test('offline still resolves language from script but never calls out', async () => {
  const resolver = new Resolver({ client: null });
  const t = track({ title: 'הכל עובר', albumArtist: 'Someone' });
  const country = await resolver.resolveCountry(t);
  assert.equal(country.value, null);
  assert.match(country.note ?? '', /offline/);

  const language = await resolver.resolveLanguage(t, country.value);
  assert.deepEqual(language, { value: 'heb', confidence: 'high', source: 'script' });
});

test('a definite script short-circuits MusicBrainz entirely', async () => {
  const { resolver, calls } = resolverWith([[/recording\//, RECORDING_WITH_WORK]]);
  const result = await resolver.resolveLanguage(
    track({ title: '夜に駆ける', recordingMbid: '11111111-1111-1111-1111-111111111111' }),
    'JP',
  );
  assert.deepEqual(result, { value: 'jpn', confidence: 'high', source: 'script' });
  assert.equal(calls.length, 0, 'kana is proof enough — this is what keeps a scan fast');
});

test('a Latin title falls through to the MusicBrainz work language', async () => {
  const { resolver, calls } = resolverWith([[/recording\//, RECORDING_WITH_WORK]]);
  const result = await resolver.resolveLanguage(
    track({ title: 'Bohemian Rhapsody', recordingMbid: '11111111-1111-1111-1111-111111111111' }),
    'GB',
  );
  assert.deepEqual(result, { value: 'eng', confidence: 'high', source: 'work' });
  assert.equal(calls.length, 1);
});

test('an instrumental resolves to zxx', async () => {
  const { resolver } = resolverWith([[/recording\//, RECORDING_INSTRUMENTAL]]);
  const result = await resolver.resolveLanguage(
    track({ title: 'Main Theme', recordingMbid: '11111111-1111-1111-1111-111111111111' }),
    'JP',
  );
  assert.deepEqual(result, { value: 'zxx', confidence: 'high', source: 'instrumental' });
});

test('a Latin title with no MusicBrainz data stays honestly unknown', async () => {
  const { resolver } = resolverWith([]);
  const result = await resolver.resolveLanguage(track({ title: 'Some Song' }), 'DE');
  assert.equal(result.value, null, 'guessing German from a German artist would be wrong');
  assert.match(result.note ?? '', /no MusicBrainz recording id/);
});

test('musicbrainz mode asks the work first, so a Japanese title sung in English is caught', async () => {
  const { resolver, calls } = resolverWith([[/recording\//, RECORDING_WITH_WORK]], 'musicbrainz');
  const result = await resolver.resolveLanguage(
    track({ title: 'タイトル (English Ver.)', recordingMbid: '11111111-1111-1111-1111-111111111111' }),
    'JP',
  );
  assert.deepEqual(result, { value: 'eng', confidence: 'high', source: 'work' });
  assert.equal(calls.length, 1);
});

test('a MusicBrainz outage degrades to unresolved instead of killing the scan', async () => {
  // Observed against the live service: search returns 503 under load. One busy moment
  // must not abort a scan of twenty thousand files.
  const failing = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
  const client = new MusicBrainzClient({
    userAgent: 'test',
    fetchImpl: failing,
    limiter: new RateLimiter({ minIntervalMs: 0 }),
    sleep: async () => {},
    maxAttempts: 2,
  });
  const resolver = new Resolver({ client });

  const result = await resolver.resolveCountry(track({ albumArtist: 'Radiohead' }));
  assert.equal(result.value, null);
  assert.match(result.note ?? '', /try again later/);
  assert.equal(resolver.lookupFailures, 1);

  // Script detection must still work while MusicBrainz is down.
  const language = await resolver.resolveLanguage(track({ title: 'הכל עובר' }), null);
  assert.equal(language.value, 'heb');
});

test('a transient failure is never cached as a negative answer', async () => {
  // Caching "no such artist" from a 503 would poison every future run.
  let attempt = 0;
  const flaky = (async () => {
    attempt++;
    if (attempt === 1) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify(SEARCH_YORUSHIKA), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new MusicBrainzClient({
    userAgent: 'test',
    fetchImpl: flaky,
    limiter: new RateLimiter({ minIntervalMs: 0 }),
    sleep: async () => {},
    maxAttempts: 1,
  });
  const cache = LookupCache.ephemeral();
  const resolver = new Resolver({ client, cache });
  const t = track({ albumArtist: 'Yorushika' });

  assert.equal((await resolver.resolveCountry(t)).value, null, 'first attempt fails');
  assert.equal((await resolver.resolveCountry(t)).value, 'JP', 'a retry must be allowed to succeed');
});

test('a shared script is narrowed by the country resolved first', async () => {
  const { resolver } = resolverWith([]);
  const t = track({ title: 'Земфира' });
  assert.equal((await resolver.resolveLanguage(t, 'UA')).value, 'ukr');
  assert.equal((await resolver.resolveLanguage(t, 'RU')).value, 'rus');
  const unknown = await resolver.resolveLanguage(t, null);
  assert.equal(unknown.value, null);
  assert.match(unknown.note ?? '', /shared between languages/);
});

// --- write policy ----------------------------------------------------------

function entry(overrides: Partial<PlanEntry> = {}): PlanEntry {
  const high = (value: string): Resolved => ({ value, confidence: 'high', source: 'mbid' });
  return {
    path: '/music/a.flac',
    format: 'flac',
    artistKey: 'Someone',
    title: 'A Song',
    country: high('JP'),
    language: high('jpn'),
    existingCountry: null,
    existingLanguage: null,
    ...overrides,
  };
}

test('a clean file gets both tags written', () => {
  const { writes } = decideEntry(entry(), { minConfidence: 'medium', overwrite: false });
  assert.deepEqual(
    writes.map((w) => [w.kind, w.value]),
    [['country', 'JP'], ['language', 'jpn']],
  );
});

test('an existing value is never clobbered without --overwrite', () => {
  const e = entry({ existingCountry: 'US' });
  const guarded = decideEntry(e, { minConfidence: 'medium', overwrite: false });
  assert.deepEqual(guarded.writes.map((w) => w.kind), ['language']);
  assert.deepEqual(
    guarded.skipped.find((s) => s.kind === 'country')?.reason,
    'would-overwrite',
  );

  const forced = decideEntry(e, { minConfidence: 'medium', overwrite: true });
  assert.equal(forced.writes.length, 2);
  assert.equal(forced.writes[0]?.previous, 'US', 'the old value must be journalled');
});

test('re-running over an already-correct library writes nothing', () => {
  const e = entry({ existingCountry: 'JP', existingLanguage: 'jpn' });
  const { writes, skipped } = decideEntry(e, { minConfidence: 'medium', overwrite: true });
  assert.equal(writes.length, 0, 'apply must be idempotent');
  assert.ok(skipped.every((s) => s.reason === 'already-correct'));
});

test('the confidence gate keeps weak guesses out of files', () => {
  const e = entry({ country: { value: 'JP', confidence: 'medium', source: 'search' } });
  assert.equal(decideEntry(e, { minConfidence: 'medium', overwrite: false }).writes.length, 2);

  const strict = decideEntry(e, { minConfidence: 'high', overwrite: false });
  assert.deepEqual(strict.writes.map((w) => w.kind), ['language']);
  assert.equal(strict.skipped.find((s) => s.kind === 'country')?.reason, 'below-confidence');
});

test('an unresolved value is never written at any confidence', () => {
  const e = entry({ country: { value: null, confidence: 'none', source: 'none' } });
  const { writes } = decideEntry(e, { minConfidence: 'medium', overwrite: true });
  assert.deepEqual(writes.map((w) => w.kind), ['language']);
});

test('the summary counts what a run would actually do', () => {
  const plan: ScanPlan = {
    version: 1,
    library: '/music',
    createdAt: new Date().toISOString(),
    entries: [
      entry({ path: '/music/1.flac' }),
      entry({ path: '/music/2.flac', country: { value: 'IL', confidence: 'high', source: 'mbid' }, language: { value: 'heb', confidence: 'high', source: 'script' } }),
      entry({ path: '/music/3.flac', country: { value: null, confidence: 'none', source: 'none' }, language: { value: null, confidence: 'none', source: 'none' } }),
    ],
    unsupported: [],
    errors: [],
  };
  const summary = summarize(plan, { minConfidence: 'medium', overwrite: false });

  assert.equal(summary.tracks, 3);
  assert.equal(summary.filesToChange, 2);
  assert.equal(summary.writes, 4);
  assert.equal(summary.unresolvedCountry, 1);
  assert.equal(summary.unresolvedLanguage, 1);

  // Counts descending, ties broken alphabetically so output is stable run to run.
  const countries = rankedCounts(summary.countries, 'country');
  assert.deepEqual(countries.map((c) => [c.code, c.name, c.count]), [['IL', 'Israel', 1], ['JP', 'Japan', 1]]);
});
