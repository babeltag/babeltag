/**
 * Real MusicBrainz responses, captured live during design. Tests run against these so the
 * suite is deterministic, works offline, and never hammers a free community service.
 */

export const RADIOHEAD_MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

/** GET /artist/<mbid> — the direct, unambiguous path. */
export const ARTIST_RADIOHEAD = {
  id: RADIOHEAD_MBID,
  name: 'Radiohead',
  type: 'Group',
  country: 'GB',
  area: {
    name: 'United Kingdom',
    id: '8a754a16-0027-3a29-b6d7-2b40ea0481ed',
    'iso-3166-1-codes': ['GB'],
  },
  'begin-area': { name: 'Abingdon-on-Thames' },
  disambiguation: '',
};

/** An artist with no `country` but a usable `area` — the fallback path. */
export const ARTIST_AREA_ONLY = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Area Only',
  type: 'Group',
  country: null,
  area: { name: 'Israel', 'iso-3166-1-codes': ['IL'] },
};

/** An artist MusicBrainz simply has no country for. */
export const ARTIST_NO_COUNTRY = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Placeless',
  type: 'Group',
};

/**
 * GET /artist?query=Yorushika — the plain default-field query.
 * The artist is stored as ヨルシカ; "Yorushika" is an alias. The fielded form
 * `artist:Yorushika` returns zero results, which is why the client never uses it.
 */
export const SEARCH_YORUSHIKA = {
  count: 1,
  artists: [{ id: '33333333-3333-3333-3333-333333333333', name: 'ヨルシカ', score: 100, country: 'JP', type: 'Group' }],
};

/** An ambiguous name: two strong hits, so nothing should be trusted. */
export const SEARCH_AMBIGUOUS = {
  count: 2,
  artists: [
    { id: '44444444-4444-4444-4444-444444444444', name: 'Air', score: 100, country: 'FR', type: 'Group' },
    { id: '55555555-5555-5555-5555-555555555555', name: 'AIR', score: 99, country: 'JP', type: 'Group' },
  ],
};

/** A weak best hit. */
export const SEARCH_WEAK = {
  count: 1,
  artists: [{ id: '66666666-6666-6666-6666-666666666666', name: 'Something Else', score: 62, country: 'US', type: 'Group' }],
};

export const BOHEMIAN_MBID = 'b1a9c0e9-d987-4042-ae91-78d6a3267d69';

/** GET /recording/<mbid>?inc=work-rels+work-level-rels — language lives on the work. */
export const RECORDING_WITH_WORK = {
  id: BOHEMIAN_MBID,
  title: 'Bohemian Rhapsody',
  relations: [
    {
      'target-type': 'work',
      type: 'performance',
      attributes: [],
      work: { title: 'Bohemian Rhapsody', language: 'eng', languages: ['eng'] },
    },
  ],
};

/** An instrumental, flagged by the relation attribute rather than a `zxx` language. */
export const RECORDING_INSTRUMENTAL = {
  id: '77777777-7777-7777-7777-777777777777',
  title: 'Main Theme',
  relations: [
    {
      'target-type': 'work',
      type: 'performance',
      attributes: ['instrumental'],
      work: { title: 'Main Theme', languages: [] },
    },
  ],
};

/** An instrumental expressed the other way, as the `zxx` language code. */
export const RECORDING_ZXX = {
  id: '88888888-8888-8888-8888-888888888888',
  title: 'Overworld',
  relations: [
    {
      'target-type': 'work',
      type: 'performance',
      attributes: [],
      work: { title: 'Overworld', languages: ['zxx'] },
    },
  ],
};

/** A recording with no work linked at all — very common. */
export const RECORDING_NO_WORK = {
  id: '99999999-9999-9999-9999-999999999999',
  title: 'Untethered',
  relations: [],
};

/** Build a fetch stand-in that answers from a routing table and counts calls. */
export function stubFetch(routes: Array<[RegExp, unknown]>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    for (const [pattern, body] of routes) {
      if (pattern.test(url)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}
