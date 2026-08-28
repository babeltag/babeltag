/**
 * Smoke suite — "is it on fire?", not "is every feature correct".
 * Runs the real CLI end to end against a real library of real audio files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { File, TagTypes } from 'node-taglib-sharp';
import { run } from '../src/cli.ts';
import { readField } from '../src/tags/io.ts';
import { statePaths } from '../src/lib/paths.ts';
import { copyFixture, tempDir, FORMATS } from './helpers.ts';
import { ARTIST_RADIOHEAD, RADIOHEAD_MBID, stubFetch } from './mb-fixtures.ts';

/** Give a fixture a title and an artist so the resolver has something to work with. */
function label(file: string, title: string, albumArtist: string, mbid?: string): void {
  const f = File.createFromPath(file);
  try {
    f.tag.title = title;
    f.tag.albumArtists = [albumArtist];
    f.tag.performers = [albumArtist];
    if (mbid) {
      const xiph = f.getTag(TagTypes.Xiph, true) as unknown as {
        setFieldAsStrings(k: string, ...v: string[]): void;
      };
      xiph.setFieldAsStrings('MUSICBRAINZ_ALBUMARTISTID', mbid);
    }
    f.save();
  } finally {
    f.dispose();
  }
}

function capture(): { log: (m: string) => void; text: () => string } {
  const lines: string[] = [];
  return { log: (m: string) => void lines.push(m), text: () => lines.join('\n') };
}

test('smoke: --help works and names every command', async () => {
  const out = capture();
  assert.equal(await run(['--help'], out.log), 0);
  for (const command of ['scan', 'apply', 'undo', 'playlists']) {
    assert.match(out.text(), new RegExp(`babeltag ${command}`), `help omits ${command}`);
  }
});

test('smoke: an unknown command exits non-zero', async () => {
  const out = capture();
  assert.equal(await run(['wibble'], out.log), 2);
});

test('smoke: config prints a snippet without needing a library', async () => {
  const out = capture();
  assert.equal(await run(['config'], out.log), 0);
  assert.match(out.text(), /Tags\.artistcountry\.Aliases/);
});

test('smoke: scan an offline library, apply, undo', async () => {
  const dir = tempDir();
  const files = FORMATS.map((format) => copyFixture(format, dir));
  // A Japanese title: resolvable from the writing system alone, no network needed.
  for (const file of files) label(file, '夜に駆ける', 'YOASOBI');

  const scanOut = capture();
  assert.equal(await run(['scan', dir, '--offline'], scanOut.log), 0);
  assert.match(scanOut.text(), /Japanese/);
  assert.ok(fs.existsSync(statePaths(dir).plan));

  // Scan must not have touched a single file.
  for (const file of files) assert.equal(readField(file, 'language'), null);

  // Without --yes, apply only reports.
  const dryOut = capture();
  assert.equal(await run(['apply', dir], dryOut.log), 0);
  assert.match(dryOut.text(), /--yes/);
  for (const file of files) assert.equal(readField(file, 'language'), null);

  const applyOut = capture();
  assert.equal(await run(['apply', dir, '--yes'], applyOut.log), 0);
  for (const file of files) assert.equal(readField(file, 'language'), 'jpn', file);

  const undoOut = capture();
  assert.equal(await run(['undo', dir], undoOut.log), 0);
  for (const file of files) assert.equal(readField(file, 'language'), null, file);
});

test('smoke: playlists come out valid and complete', async () => {
  const dir = tempDir();
  const file = copyFixture('flac', dir);
  label(file, 'הכל עובר', 'Someone');

  assert.equal(await run(['scan', dir, '--offline'], () => {}), 0);
  const out = capture();
  assert.equal(await run(['playlists', dir], out.log), 0);

  const playlistDir = path.join(dir, 'playlists');
  const written = fs.readdirSync(playlistDir);
  assert.ok(written.includes('language-Hebrew.nsp'), `got ${written.join(', ')}`);
  assert.ok(written.includes('navidrome-tags.toml'));

  const parsed = JSON.parse(fs.readFileSync(path.join(playlistDir, 'language-Hebrew.nsp'), 'utf8'));
  assert.deepEqual(parsed.all, [{ is: { language: 'heb' } }]);
  assert.match(out.text(), /FULL scan/);
});

test('smoke: a scan resolves country from MusicBrainz and caches it', async () => {
  const dir = tempDir();
  const files = [copyFixture('flac', dir, 'a.flac'), copyFixture('flac', dir, 'b.flac')];
  for (const file of files) label(file, 'Paranoid Android', 'Radiohead', RADIOHEAD_MBID);

  const { fetch: fetchImpl, calls } = stubFetch([[/artist\//, ARTIST_RADIOHEAD]]);
  const { scan } = await import('../src/commands/scan.ts');
  const plan = await scan({ library: dir, userAgent: 'test', fetchImpl });

  assert.equal(plan.entries.length, 2);
  for (const entry of plan.entries) {
    assert.equal(entry.country.value, 'GB');
    assert.equal(entry.country.confidence, 'high');
  }
  assert.equal(calls.length, 1, 'two tracks by one artist must cost one lookup');
});

test('smoke: a library with nothing in it is handled cleanly', async () => {
  const out = capture();
  assert.equal(await run(['scan', tempDir(), '--offline'], out.log), 0);
  assert.match(out.text(), /Found 0 taggable/);
});

test('smoke: a missing library is a clear error, not a stack trace', async () => {
  await assert.rejects(
    run(['scan', path.join(tempDir(), 'nope'), '--offline'], () => {}),
    /library not found/,
  );
});

test('smoke: bad flag values are rejected with a readable message', async () => {
  const dir = tempDir();
  await assert.rejects(run(['scan', dir, '--language-source', 'vibes'], () => {}), /must be "script"/);
  copyFixture('flac', dir);
  assert.equal(await run(['scan', dir, '--offline'], () => {}), 0);
  await assert.rejects(run(['apply', dir, '--min-confidence', 'sorta'], () => {}), /must be "high"/);
});
