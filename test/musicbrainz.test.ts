import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RateLimiter } from '../src/mb/limiter.ts';
import { MusicBrainzClient, MusicBrainzError } from '../src/mb/client.ts';
import { lookupArtist, lookupRecordingLanguage, searchArtist } from '../src/mb/lookup.ts';
import { LookupCache, cacheKeys } from '../src/mb/cache.ts';
import { tempDir } from './helpers.ts';
import {
  ARTIST_AREA_ONLY,
  ARTIST_NO_COUNTRY,
  ARTIST_RADIOHEAD,
  BOHEMIAN_MBID,
  RADIOHEAD_MBID,
  RECORDING_INSTRUMENTAL,
  RECORDING_NO_WORK,
  RECORDING_WITH_WORK,
  RECORDING_ZXX,
  SEARCH_AMBIGUOUS,
  SEARCH_WEAK,
  SEARCH_YORUSHIKA,
  stubFetch,
} from './mb-fixtures.ts';

const UA = 'Babeltag/test ( https://example.invalid )';

function clientFor(routes: Array<[RegExp, unknown]>) {
  const { fetch: fetchImpl, calls } = stubFetch(routes);
  const client = new MusicBrainzClient({
    userAgent: UA,
    fetchImpl,
    limiter: new RateLimiter({ minIntervalMs: 0 }),
    sleep: async () => {},
  });
  return { client, calls };
}

// --- limiter ---------------------------------------------------------------

test('limiter keeps requests one second apart using a fake clock', async () => {
  let now = 0;
  const slept: number[] = [];
  const limiter = new RateLimiter({
    minIntervalMs: 1000,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  });

  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => limiter.run(async () => void order.push(n))));

  assert.deepEqual(order, [1, 2, 3], 'requests must run in order, never concurrently');
  // The first goes immediately; each subsequent one waits out the full interval.
  assert.deepEqual(slept, [1000, 1000]);
});

test('a failing task does not wedge the limiter queue', async () => {
  const limiter = new RateLimiter({ minIntervalMs: 0 });
  await assert.rejects(limiter.run(async () => { throw new Error('boom'); }));
  assert.equal(await limiter.run(async () => 'still works'), 'still works');
});

// --- client ----------------------------------------------------------------

test('client sends a real User-Agent and asks for JSON', async () => {
  let seenHeaders: Record<string, string> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seenHeaders = init.headers as Record<string, string>;
    return new Response(JSON.stringify(ARTIST_RADIOHEAD), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new MusicBrainzClient({
    userAgent: UA,
    fetchImpl,
    limiter: new RateLimiter({ minIntervalMs: 0 }),
  });
  await client.get(`artist/${RADIOHEAD_MBID}`);
  assert.equal(seenHeaders['User-Agent'], UA);
  assert.match(seenHeaders['Accept'] ?? '', /json/);
});

test('client retries a 503 and then succeeds', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    if (attempts < 3) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify(ARTIST_RADIOHEAD), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new MusicBrainzClient({
    userAgent: UA,
    fetchImpl,
    limiter: new RateLimiter({ minIntervalMs: 0 }),
    sleep: async () => {},
  });
  const artist = await client.get<{ name: string }>(`artist/${RADIOHEAD_MBID}`);
  assert.equal(artist.name, 'Radiohead');
  assert.equal(attempts, 3);
});

test('client honours Retry-After', async () => {
  const waits: number[] = [];
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    if (attempts === 1) {
      return new Response('slow down', { status: 429, headers: { 'retry-after': '7' } });
    }
    return new Response(JSON.stringify(ARTIST_RADIOHEAD), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new MusicBrainzClient({
    userAgent: UA,
    fetchImpl,
    limiter: new RateLimiter({ minIntervalMs: 0 }),
    sleep: async (ms) => void waits.push(ms),
  });
  await client.get(`artist/${RADIOHEAD_MBID}`);
  assert.deepEqual(waits, [7000], 'must wait exactly what the server asked for');
});

test('client gives up on a 404 immediately rather than retrying', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;

  const client = new MusicBrainzClient({
    userAgent: UA,
    fetchImpl,
    limiter: new RateLimiter({ minIntervalMs: 0 }),
    sleep: async () => {},
  });
  await assert.rejects(client.get('artist/x'), MusicBrainzError);
  assert.equal(attempts, 1, 'a 404 is a real answer, not a transient failure');
});

// --- artist lookup ---------------------------------------------------------

test('artist lookup reads the country', async () => {
  const { client } = clientFor([[/artist\//, ARTIST_RADIOHEAD]]);
  assert.deepEqual(await lookupArtist(client, RADIOHEAD_MBID), { country: 'GB', name: 'Radiohead' });
});

test('artist lookup falls back to the area when country is absent', async () => {
  const { client } = clientFor([[/artist\//, ARTIST_AREA_ONLY]]);
  const found = await lookupArtist(client, '11111111-1111-1111-1111-111111111111');
  assert.equal(found?.country, 'IL');
});

test('artist lookup reports a genuinely placeless artist as null, not a guess', async () => {
  const { client } = clientFor([[/artist\//, ARTIST_NO_COUNTRY]]);
  const found = await lookupArtist(client, '22222222-2222-2222-2222-222222222222');
  assert.equal(found?.country, null);
  assert.equal(found?.name, 'Placeless');
});

test('a malformed MBID never reaches the network', async () => {
  const { client, calls } = clientFor([[/artist\//, ARTIST_RADIOHEAD]]);
  assert.equal(await lookupArtist(client, '../../etc/passwd'), null);
  assert.equal(await lookupArtist(client, 'not-a-uuid'), null);
  assert.equal(calls.length, 0, 'an untrusted tag value must not be interpolated into a URL');
});

// --- artist search ---------------------------------------------------------

test('search uses a plain query, so it finds an artist by a Latin alias', async () => {
  // The whole point: ヨルシカ is stored under its Japanese name with Yorushika as an alias.
  const { client, calls } = clientFor([[/artist\?/, SEARCH_YORUSHIKA]]);
  const found = await searchArtist(client, 'Yorushika');

  assert.equal(found?.country, 'JP');
  assert.equal(found?.name, 'ヨルシカ');
  const query = new URL(calls[0]!).searchParams.get('query');
  assert.equal(query, 'Yorushika', 'must not use the fielded artist: form, which misses aliases');
});

test('search refuses an ambiguous name rather than picking one', async () => {
  const { client } = clientFor([[/artist\?/, SEARCH_AMBIGUOUS]]);
  assert.equal(await searchArtist(client, 'Air'), null);
});

test('search refuses a weak match', async () => {
  const { client } = clientFor([[/artist\?/, SEARCH_WEAK]]);
  assert.equal(await searchArtist(client, 'Whatever'), null);
});

test('search ignores an empty name without calling out', async () => {
  const { client, calls } = clientFor([[/artist\?/, SEARCH_YORUSHIKA]]);
  assert.equal(await searchArtist(client, '   '), null);
  assert.equal(calls.length, 0);
});

// --- recording language ----------------------------------------------------

test('recording language comes from the linked work', async () => {
  const { client, calls } = clientFor([[/recording\//, RECORDING_WITH_WORK]]);
  const found = await lookupRecordingLanguage(client, BOHEMIAN_MBID);

  assert.deepEqual(found, { language: 'eng', instrumental: false });
  assert.match(calls[0]!, /inc=work-rels%2Bwork-level-rels|inc=work-rels\+work-level-rels/);
});

test('an instrumental attribute becomes zxx', async () => {
  const { client } = clientFor([[/recording\//, RECORDING_INSTRUMENTAL]]);
  const found = await lookupRecordingLanguage(client, '77777777-7777-7777-7777-777777777777');
  assert.deepEqual(found, { language: 'zxx', instrumental: true });
});

test('a zxx work language is recognised as instrumental', async () => {
  const { client } = clientFor([[/recording\//, RECORDING_ZXX]]);
  const found = await lookupRecordingLanguage(client, '88888888-8888-8888-8888-888888888888');
  assert.deepEqual(found, { language: 'zxx', instrumental: true });
});

test('a recording with no work yields nothing rather than a guess', async () => {
  const { client } = clientFor([[/recording\//, RECORDING_NO_WORK]]);
  assert.equal(await lookupRecordingLanguage(client, '99999999-9999-9999-9999-999999999999'), null);
});

// --- cache -----------------------------------------------------------------

test('cache prevents repeat HTTP calls', async () => {
  const { client, calls } = clientFor([[/artist\//, ARTIST_RADIOHEAD]]);
  const cache = LookupCache.ephemeral();
  const key = cacheKeys.artistByMbid(RADIOHEAD_MBID);

  for (let i = 0; i < 5; i++) {
    await cache.fetch(key, () => lookupArtist(client, RADIOHEAD_MBID));
  }
  assert.equal(calls.length, 1, 'five lookups of the same artist must cost one request');
  assert.equal(cache.hits, 4);
});

test('cache remembers a negative answer so we stop re-asking', async () => {
  let computed = 0;
  const cache = LookupCache.ephemeral();
  const compute = async () => {
    computed++;
    return null;
  };
  await cache.fetch('artist:name:nobody', compute);
  await cache.fetch('artist:name:nobody', compute);
  assert.equal(computed, 1, '"MusicBrainz has nothing" is an answer worth caching');
});

test('cache survives a torn final line', () => {
  const file = path.join(tempDir(), 'cache.jsonl');
  const good = LookupCache.open(file);
  good.set('a', { country: 'JP' });
  good.set('b', { country: 'DE' });

  // Simulate a process killed mid-append.
  fs.appendFileSync(file, '{"v":1,"k":"c","d":{"coun');

  const reopened = LookupCache.open(file);
  assert.deepEqual(reopened.get('a'), { country: 'JP' });
  assert.deepEqual(reopened.get('b'), { country: 'DE' });
  assert.equal(reopened.has('c'), false, 'the torn line must be discarded, not misread');
});

test('cache ignores entries from an older schema', () => {
  const file = path.join(tempDir(), 'cache.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ v: 0, k: 'old', d: 'stale' })}\n`);
  assert.equal(LookupCache.open(file).has('old'), false);
});

test('refresh discards the cache file', () => {
  const file = path.join(tempDir(), 'cache.jsonl');
  LookupCache.open(file).set('a', 1);
  assert.equal(LookupCache.open(file).has('a'), true);
  assert.equal(LookupCache.open(file, true).has('a'), false);
});
