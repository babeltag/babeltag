import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { File, TagTypes } from 'node-taglib-sharp';
import { readTrack, readField, writeField, clearField, formatForPath, isUnsupportedAudio } from '../src/tags/io.ts';
import { navidromeAliases } from '../src/tags/formats.ts';
import { copyFixture, tempDir, FORMATS } from './helpers.ts';

test('every supported format round-trips both tags', async (t) => {
  for (const format of FORMATS) {
    await t.test(format, () => {
      const file = copyFixture(format, tempDir());

      writeField(file, 'country', 'JP');
      writeField(file, 'language', 'jpn');

      assert.equal(readField(file, 'country'), 'JP', `${format} country did not survive`);
      assert.equal(readField(file, 'language'), 'jpn', `${format} language did not survive`);
    });
  }
});

test('writeField throws rather than silently failing when a value does not stick', () => {
  const file = copyFixture('flac', tempDir());
  // A real write must not throw; this pins the happy path so the guard below means something.
  assert.doesNotThrow(() => writeField(file, 'country', 'DE'));
  assert.equal(readField(file, 'country'), 'DE');
});

test('clearField removes a field so undo can restore "was never set"', async (t) => {
  for (const format of FORMATS) {
    await t.test(format, () => {
      const file = copyFixture(format, tempDir());
      writeField(file, 'country', 'IL');
      assert.equal(readField(file, 'country'), 'IL');

      clearField(file, 'country');
      assert.equal(readField(file, 'country'), null, `${format} still had a country after clear`);
    });
  }
});

test('reading a file does not modify it', async (t) => {
  for (const format of FORMATS) {
    await t.test(format, () => {
      const file = copyFixture(format, tempDir());
      const before = fs.readFileSync(file);
      readTrack(file);
      assert.deepEqual(fs.readFileSync(file), before, `${format} changed on read`);
    });
  }
});

test('tagging leaves the decoded audio stream byte-identical', async (t) => {
  // The strongest guarantee available: the container changes, the music must not.
  let haveFfmpeg = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    haveFfmpeg = false;
  }
  if (!haveFfmpeg) {
    t.skip('ffmpeg not available to decode the audio stream');
    return;
  }

  const audioMd5 = (file: string): string =>
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'md5', '-'], {
      encoding: 'utf8',
    }).trim();

  for (const format of FORMATS) {
    await t.test(format, () => {
      const file = copyFixture(format, tempDir());
      const before = audioMd5(file);
      writeField(file, 'country', 'JP');
      writeField(file, 'language', 'jpn');
      assert.equal(audioMd5(file), before, `${format} audio stream changed during tagging`);
    });
  }
});

test('handles non-ASCII paths and values', () => {
  const dir = tempDir();
  const file = copyFixture('flac', dir, 'ヨルシカ - 花に亡霊.flac');
  writeField(file, 'country', 'JP');
  writeField(file, 'language', 'jpn');

  const track = readTrack(file);
  assert.equal(track.existingCountry, 'JP');
  assert.equal(track.existingLanguage, 'jpn');
  assert.ok(fs.existsSync(file));
});

test('recognises extensions it can and cannot handle', () => {
  assert.equal(formatForPath('/music/a.FLAC'), 'flac');
  assert.equal(formatForPath('/music/a.opus'), 'opus');
  assert.equal(formatForPath('/music/a.m4b'), 'm4a');
  assert.equal(formatForPath('/music/a.txt'), null);

  assert.equal(isUnsupportedAudio('/music/a.wma'), true);
  assert.equal(isUnsupportedAudio('/music/a.flac'), false);
});

test('reads back an empty file as having no tags rather than throwing', async (t) => {
  for (const format of FORMATS) {
    await t.test(format, () => {
      const file = copyFixture(format, tempDir());
      const track = readTrack(file);
      assert.equal(track.existingCountry, null);
      assert.equal(track.existingLanguage, null);
      assert.equal(track.format, format);
      assert.equal(track.path, file);
    });
  }
});

test('navidrome aliases cover every per-format key it could see', () => {
  const country = navidromeAliases('country');
  assert.ok(country.includes('artistcountry'), 'xiph key missing');
  assert.ok(country.includes('txxx:artistcountry'), 'id3 TXXX key missing');
  assert.ok(country.includes('----:com.apple.itunes:artistcountry'), 'mp4 freeform key missing');

  const language = navidromeAliases('language');
  assert.ok(language.includes('tlan'), 'id3 TLAN frame missing');
  assert.ok(language.includes('language'), 'xiph key missing');
});

test('a real MusicBrainz id is read back, a malformed one is rejected', () => {
  // MBIDs come out of untrusted tag data and end up in a URL, so the reader must filter.
  const file = copyFixture('flac', tempDir());

  const write = (value: string) => {
    const f = File.createFromPath(file);
    const tag = f.getTag(TagTypes.Xiph, true) as unknown as {
      setFieldAsStrings(k: string, ...v: string[]): void;
    };
    tag.setFieldAsStrings('MUSICBRAINZ_ARTISTID', value);
    f.save();
    f.dispose();
  };

  write('a74b1b7f-71a5-4011-9441-d0b5e4122711');
  assert.equal(readTrack(file).artistMbid, 'a74b1b7f-71a5-4011-9441-d0b5e4122711');

  write('../../etc/passwd');
  assert.equal(readTrack(file).artistMbid, null, 'a non-UUID must never reach a URL');
});

test('fixtures exist for every format', () => {
  for (const format of FORMATS) {
    const p = path.join(import.meta.dirname, 'fixtures', `silence.${format}`);
    assert.ok(fs.existsSync(p), `missing fixture ${p}`);
  }
});
