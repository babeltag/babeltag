/**
 * `babeltag playlists` — generate the Navidrome smart playlists and the config snippet.
 *
 * Tags alone do not make shows. This writes one `.nsp` per country and per language
 * actually present in the library, so the split the user wanted exists the moment
 * Navidrome rescans.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ScanPlan, TagKind } from '../core/types.ts';
import { buildPlaylist, configSnippet, playlistFileName } from '../navidrome.ts';

export interface PlaylistOptions {
  plan: ScanPlan;
  outputDir: string;
  /** Only emit a playlist for a value with at least this many tracks. */
  minTracks?: number;
  log?: (message: string) => void;
}

export interface PlaylistResult {
  written: string[];
  snippetPath: string;
}

function collect(plan: ScanPlan, kind: TagKind): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of plan.entries) {
    const value = kind === 'country' ? entry.country.value : entry.language.value;
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function generatePlaylists(options: PlaylistOptions): PlaylistResult {
  const log = options.log ?? (() => {});
  const minTracks = options.minTracks ?? 1;
  fs.mkdirSync(options.outputDir, { recursive: true });

  const written: string[] = [];
  for (const kind of ['country', 'language'] as const) {
    for (const [code, count] of collect(options.plan, kind)) {
      if (count < minTracks) continue;
      const file = path.join(options.outputDir, playlistFileName(kind, code));
      fs.writeFileSync(file, `${JSON.stringify(buildPlaylist(kind, code), null, 2)}\n`, 'utf8');
      written.push(file);
    }
  }

  const snippetPath = path.join(options.outputDir, 'navidrome-tags.toml');
  fs.writeFileSync(snippetPath, `${configSnippet()}\n`, 'utf8');

  log(`Wrote ${written.length} smart playlist(s) to ${options.outputDir}`);
  log(`Navidrome config snippet: ${snippetPath}`);
  return { written, snippetPath };
}
