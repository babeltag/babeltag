import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPlaylist,
  configSnippet,
  COUNTRY_FIELD,
  LANGUAGE_FIELD,
  playlistFileName,
} from '../src/navidrome.ts';
import { generatePlaylists } from '../src/commands/playlists.ts';
import type { PlanEntry, ScanPlan } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';

function entry(country: string | null, language: string | null, i: number): PlanEntry {
  return {
    path: `/music/${i}.flac`,
    format: 'flac',
    artistKey: 'Someone',
    title: 'A Song',
    country: country
      ? { value: country, confidence: 'high', source: 'mbid' }
      : { value: null, confidence: 'none', source: 'none' },
    language: language
      ? { value: language, confidence: 'high', source: 'script' }
      : { value: null, confidence: 'none', source: 'none' },
    existingCountry: null,
    existingLanguage: null,
  };
}

const PLAN: ScanPlan = {
  version: 1,
  library: '/music',
  createdAt: new Date().toISOString(),
  entries: [
    entry('JP', 'jpn', 1),
    entry('JP', 'jpn', 2),
    entry('IL', 'heb', 3),
    entry('DE', 'deu', 4),
    entry('JP', 'zxx', 5),
    entry(null, null, 6),
  ],
  unsupported: [],
  errors: [],
};

test('a playlist matches the documented Navidrome smart-playlist shape', () => {
  const playlist = buildPlaylist('language', 'jpn');
  assert.equal(playlist.name, 'Japanese');
  assert.deepEqual(playlist.all, [{ is: { language: 'jpn' } }]);
  assert.equal(playlist.sort, 'artist');
  assert.equal(playlist.order, 'asc');

  // It has to survive a JSON round-trip: Navidrome parses the file as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(playlist)), playlist);
});

test('the country playlist queries the custom field, not a built-in one', () => {
  const playlist = buildPlaylist('country', 'JP');
  assert.equal(playlist.name, 'Japan');
  assert.deepEqual(playlist.all, [{ is: { artistcountry: 'JP' } }]);
  assert.equal(COUNTRY_FIELD, 'artistcountry');
  assert.equal(LANGUAGE_FIELD, 'language');
});

test('instrumentals get a playlist named for what they are', () => {
  assert.equal(buildPlaylist('language', 'zxx').name, 'Instrumental');
});

test('playlist filenames are safe on any filesystem', () => {
  assert.equal(playlistFileName('country', 'JP'), 'country-Japan.nsp');
  assert.equal(playlistFileName('language', 'heb'), 'language-Hebrew.nsp');
  // A region whose English name contains punctuation must not produce a bad path.
  for (const code of ['KR', 'CD', 'VA', 'BQ', 'CI']) {
    const name = playlistFileName('country', code);
    assert.ok(!/[\\/:*?"<>|]/.test(name), `${name} contains a path-hostile character`);
    assert.ok(name.endsWith('.nsp'));
  }
});

test('the config snippet lists every per-format key Navidrome could see', () => {
  const snippet = configSnippet();
  assert.match(snippet, /Tags\.artistcountry\.Aliases/);
  assert.match(snippet, /"artistcountry"/);
  assert.match(snippet, /"txxx:artistcountry"/);
  assert.match(snippet, /"----:com\.apple\.itunes:artistcountry"/);
  // Language is built in, so the snippet must not tell people to configure it.
  assert.doesNotMatch(snippet, /Tags\.language\.Aliases/);
  // The single most common way to get nothing: forgetting the full rescan.
  assert.match(snippet, /FULL scan/);
});

test('generate writes one playlist per value actually present', () => {
  const dir = tempDir();
  const result = generatePlaylists({ plan: PLAN, outputDir: dir });

  const names = result.written.map((f) => path.basename(f)).sort();
  assert.deepEqual(names, [
    'country-Germany.nsp',
    'country-Israel.nsp',
    'country-Japan.nsp',
    'language-German.nsp',
    'language-Hebrew.nsp',
    'language-Instrumental.nsp',
    'language-Japanese.nsp',
  ]);
  assert.ok(fs.existsSync(result.snippetPath));

  // Every file must be valid JSON, or Navidrome silently ignores it.
  for (const file of result.written) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), file);
  }
});

test('minTracks filters out one-off values', () => {
  const dir = tempDir();
  const result = generatePlaylists({ plan: PLAN, outputDir: dir, minTracks: 3 });
  const names = result.written.map((f) => path.basename(f));
  assert.deepEqual(names, ['country-Japan.nsp'], 'only Japan has three or more tracks');
});

test('an empty plan still produces the config snippet', () => {
  const dir = tempDir();
  const empty: ScanPlan = { ...PLAN, entries: [] };
  const result = generatePlaylists({ plan: empty, outputDir: dir });
  assert.equal(result.written.length, 0);
  assert.ok(fs.existsSync(result.snippetPath));
});
