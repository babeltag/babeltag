import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const FORMATS = ['flac', 'mp3', 'm4a', 'ogg'] as const;

/** A throwaway directory that cleans itself up when the test process exits. */
export function tempDir(prefix = 'babeltag-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Copy a silent fixture into a temp dir so tests never mutate the committed originals. */
export function copyFixture(format: string, dir: string, name = `track.${format}`): string {
  const target = path.join(dir, name);
  fs.copyFileSync(path.join(FIXTURE_DIR, `silence.${format}`), target);
  return target;
}

