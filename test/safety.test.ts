import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Journal } from '../src/lib/journal.ts';
import { Lock, LockHeldError } from '../src/lib/lock.ts';
import { walkLibrary } from '../src/lib/walk.ts';
import { statePaths } from '../src/lib/paths.ts';
import { readField, writeField } from '../src/tags/io.ts';
import { apply } from '../src/commands/apply.ts';
import { undo } from '../src/commands/undo.ts';
import type { PlanEntry, ScanPlan } from '../src/core/types.ts';
import { copyFixture, tempDir, FORMATS } from './helpers.ts';

function planFor(files: string[], overrides: Partial<PlanEntry> = {}): ScanPlan {
  return {
    version: 1,
    library: path.dirname(files[0]!),
    createdAt: new Date().toISOString(),
    entries: files.map((file) => ({
      path: file,
      format: (path.extname(file).slice(1) as PlanEntry['format']),
      artistKey: 'Someone',
      title: 'A Song',
      country: { value: 'JP', confidence: 'high', source: 'mbid' },
      language: { value: 'jpn', confidence: 'high', source: 'script' },
      existingCountry: null,
      existingLanguage: null,
      ...overrides,
    })),
    unsupported: [],
    errors: [],
  };
}

// --- journal ---------------------------------------------------------------

test('journal round-trips records and survives a torn final line', () => {
  const file = path.join(tempDir(), 'journal.jsonl');
  const journal = new Journal(file);

  journal.record({ filePath: '/music/a.flac', format: 'flac', kind: 'country', previous: null, written: 'JP' });
  journal.record({ filePath: '/music/a.flac', format: 'flac', kind: 'language', previous: 'eng', written: 'jpn' });
  fs.appendFileSync(file, '{"ts":"2026-01-01","path":"/music/b');

  const records = journal.read();
  assert.equal(records.length, 2, 'the torn line must be dropped, the good ones kept');
  assert.equal(records[0]?.previous, null);
  assert.equal(records[1]?.previous, 'eng');
});

test('a tag value containing a newline cannot corrupt the journal', () => {
  const file = path.join(tempDir(), 'journal.jsonl');
  const journal = new Journal(file);
  journal.record({
    filePath: '/music/a.flac',
    format: 'flac',
    kind: 'country',
    previous: 'line one\nline two\n{"fake":"record"}',
    written: 'JP',
  });
  const records = journal.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.previous, 'line one\nline two\n{"fake":"record"}');
});

// --- lock ------------------------------------------------------------------

test('a second run cannot tag a library already being tagged', () => {
  const file = path.join(tempDir(), 'lock.json');
  const first = new Lock(file);
  first.acquire();
  assert.throws(() => new Lock(file).acquire(), LockHeldError);
  first.release();
  assert.doesNotThrow(() => {
    const third = new Lock(file);
    third.acquire();
    third.release();
  });
});

test('a lock left by a dead process is taken over, not treated as fatal', () => {
  const file = path.join(tempDir(), 'lock.json');
  // PID 0x7FFFFFFF will not exist; simulate a crashed run.
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483646, started: new Date().toISOString() }));
  const lock = new Lock(file);
  assert.doesNotThrow(() => lock.acquire());
  lock.release();
});

test('the lock is released even when the work throws', async () => {
  const file = path.join(tempDir(), 'lock.json');
  await assert.rejects(Lock.around(file, () => { throw new Error('boom'); }));
  assert.equal(fs.existsSync(file), false, 'a crash must not leave the library locked');
});

// --- walk ------------------------------------------------------------------

test('walk finds taggable files, reports unsupported ones, and ignores the rest', () => {
  const dir = tempDir();
  for (const format of FORMATS) copyFixture(format, dir);
  fs.mkdirSync(path.join(dir, 'Album'), { recursive: true });
  copyFixture('flac', path.join(dir, 'Album'), 'nested.flac');
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'not audio');
  fs.writeFileSync(path.join(dir, 'legacy.wma'), 'unsupported audio');

  const result = walkLibrary(dir);
  assert.equal(result.audio.length, 5, 'four top-level plus one nested');
  assert.equal(result.unsupported.length, 1);
  assert.ok(result.unsupported[0]?.endsWith('.wma'));
  assert.ok(!result.audio.some((f) => f.endsWith('.jpg')));
});

test('walk skips dot-directories so it never scans its own state folder', () => {
  const dir = tempDir();
  copyFixture('flac', dir);
  fs.mkdirSync(path.join(dir, '.babeltag'), { recursive: true });
  copyFixture('flac', path.join(dir, '.babeltag'), 'stray.flac');

  assert.equal(walkLibrary(dir).audio.length, 1);
});

// --- apply / undo ----------------------------------------------------------

test('apply writes, undo restores, and the audio never changes', async (t) => {
  let haveFfmpeg = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    haveFfmpeg = false;
  }
  const audioMd5 = (file: string): string =>
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();

  const dir = tempDir();
  const files = FORMATS.map((format) => copyFixture(format, dir));
  const before = haveFfmpeg ? files.map(audioMd5) : [];

  const result = await apply({ library: dir, plan: planFor(files) });
  assert.equal(result.filesChanged, 4);
  assert.equal(result.tagsWritten, 8);
  for (const file of files) {
    assert.equal(readField(file, 'country'), 'JP');
    assert.equal(readField(file, 'language'), 'jpn');
  }

  const undone = await undo({ library: dir });
  assert.equal(undone.removed, 8, 'both tags were new, so undo must remove both');
  assert.equal(undone.failed.length, 0);
  for (const file of files) {
    assert.equal(readField(file, 'country'), null, `${file} kept a country after undo`);
    assert.equal(readField(file, 'language'), null, `${file} kept a language after undo`);
  }

  if (!haveFfmpeg) {
    t.diagnostic('ffmpeg unavailable — audio-stream comparison skipped');
    return;
  }
  files.forEach((file, i) => {
    assert.equal(audioMd5(file), before[i], `${file} audio changed across apply+undo`);
  });
});

test('undo puts back a previous value rather than deleting it', async () => {
  const dir = tempDir();
  const file = copyFixture('flac', dir);
  writeField(file, 'country', 'US');

  await apply({ library: dir, plan: planFor([file]), overwrite: true });
  assert.equal(readField(file, 'country'), 'JP');

  await undo({ library: dir });
  assert.equal(readField(file, 'country'), 'US', 'the user\'s original value must come back');
});

test('an interrupted run is still fully undoable', async () => {
  const dir = tempDir();
  const files = FORMATS.map((format) => copyFixture(format, dir));

  // Tag only the first two files, as if the run died partway.
  await apply({ library: dir, plan: planFor(files.slice(0, 2)) });
  assert.equal(readField(files[0]!, 'country'), 'JP');
  assert.equal(readField(files[2]!, 'country'), null);

  const undone = await undo({ library: dir });
  assert.equal(undone.removed, 4);
  for (const file of files) assert.equal(readField(file, 'country'), null);
});

test('apply is idempotent — a second run writes nothing', async () => {
  const dir = tempDir();
  const files = [copyFixture('flac', dir)];
  const plan = planFor(files);

  await apply({ library: dir, plan });
  const second = await apply({ library: dir, plan });
  assert.equal(second.tagsWritten, 0);
  assert.equal(second.skippedFiles, 1);
});

test('apply refuses to overwrite an existing value by default', async () => {
  const dir = tempDir();
  const file = copyFixture('flac', dir);
  writeField(file, 'country', 'US');

  const result = await apply({ library: dir, plan: planFor([file]) });
  assert.equal(readField(file, 'country'), 'US', 'the existing value must be left alone');
  assert.equal(readField(file, 'language'), 'jpn', 'the empty field is still filled');
  assert.equal(result.tagsWritten, 1);
});

test('apply tolerates a file that vanished after the scan', async () => {
  const dir = tempDir();
  const present = copyFixture('flac', dir, 'here.flac');
  const missing = path.join(dir, 'gone.flac');

  const result = await apply({ library: dir, plan: planFor([present, missing]) });
  assert.equal(result.missingFiles, 1);
  assert.equal(result.filesChanged, 1);
  assert.equal(readField(present, 'country'), 'JP');
});

test('apply refuses plan entries pointing outside the library', async () => {
  // The plan is a file on disk, so a tampered one must not be able to aim `apply` at
  // arbitrary paths. Everything written has to sit inside the library we were given.
  const library = tempDir();
  const elsewhere = tempDir();
  const inside = copyFixture('flac', library, 'inside.flac');
  const outside = copyFixture('flac', elsewhere, 'outside.flac');
  const traversal = path.join(library, '..', path.basename(elsewhere), 'outside.flac');

  const result = await apply({ library, plan: planFor([inside, outside, traversal]) });

  assert.equal(result.outsideLibrary, 2, 'both the absolute and the ../ path must be refused');
  assert.equal(result.filesChanged, 1);
  assert.equal(readField(inside, 'country'), 'JP', 'the legitimate file is still tagged');
  assert.equal(readField(outside, 'country'), null, 'the outside file must be untouched');
});

test('undo with no journal is a clear error, not a crash', async () => {
  await assert.rejects(undo({ library: tempDir() }), /nothing to undo/);
});

test('state files all live in one folder beside the library', () => {
  const paths = statePaths('/music');
  assert.ok(paths.plan.includes('.babeltag'));
  assert.ok(paths.cache.includes('.babeltag'));
  assert.ok(paths.journal.includes('.babeltag'));
  assert.ok(paths.lock.includes('.babeltag'));
});
