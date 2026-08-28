/** Walking a music library. */
import fs from 'node:fs';
import path from 'node:path';
import { formatForPath, isUnsupportedAudio } from '../tags/io.ts';

export interface WalkResult {
  /** Files we can read and tag. */
  audio: string[];
  /** Audio we recognise but cannot tag — reported rather than silently skipped. */
  unsupported: string[];
}

/**
 * Collect every taggable file under `root`.
 *
 * Symlinks are deliberately not followed: a link pointing back up the tree loops forever,
 * and one pointing outside the library would quietly put files the user did not ask about
 * in scope for tagging.
 */
export function walkLibrary(root: string): WalkResult {
  const audio: string[] = [];
  const unsupported: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory: skip it, keep scanning the rest.
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (formatForPath(full)) audio.push(full);
        else if (isUnsupportedAudio(full)) unsupported.push(full);
      }
    }
  }

  audio.sort();
  unsupported.sort();
  return { audio, unsupported };
}
