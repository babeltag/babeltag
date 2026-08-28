#!/usr/bin/env node
/** The babeltag command line. */
import { parseArgs } from 'node:util';
import path from 'node:path';
import type { Confidence } from './core/types.ts';
import { rankedCounts, summarize } from './core/plan.ts';
import type { WritePolicy } from './core/plan.ts';
import type { LanguageSource } from './core/resolve.ts';
import { defaultUserAgent } from './mb/client.ts';
import { statePaths } from './lib/paths.ts';
import { LockHeldError } from './lib/lock.ts';
import { loadPlan, scan } from './commands/scan.ts';
import { apply } from './commands/apply.ts';
import { undo } from './commands/undo.ts';
import { generatePlaylists } from './commands/playlists.ts';
import { configSnippet } from './navidrome.ts';

export const VERSION = '1.0.0';

const HELP = `babeltag ${VERSION}
Tag a music library by artist country and song language, so Navidrome smart
playlists can split it into shows.

USAGE
  babeltag scan <library>       Look at the library and write a plan. Never edits files.
  babeltag apply <library>      Write the planned tags. Journals every change.
  babeltag undo <library>       Put every tagged file back exactly as it was.
  babeltag playlists <library>  Generate Navidrome smart playlists + config snippet.
  babeltag config               Print the navidrome.toml snippet and exit.

SCAN OPTIONS
  --language-source <s>  script (default) or musicbrainz.
                         "script" trusts the writing system first and only asks
                         MusicBrainz about Latin-script titles - fast, and for a
                         non-Latin library it barely touches the network.
                         "musicbrainz" asks about every track that has a recording
                         id: more accurate, but one request per second per track.
  --offline              Skip MusicBrainz entirely; script detection still works.
  --refresh-cache        Throw away cached lookups and ask again.

APPLY OPTIONS
  --yes                  Actually write. Without it, apply only reports.
  --min-confidence <c>   high or medium (default: medium).
  --overwrite            Replace tag values that are already set.

PLAYLIST OPTIONS
  --out <dir>            Where to write playlists (default: <library>/playlists).
  --min-tracks <n>       Skip a country/language with fewer than n tracks (default: 1).

GENERAL
  -h, --help             Show this help.
  -v, --version          Show the version.

TYPICAL RUN
  babeltag scan  /music
  babeltag apply /music --yes
  babeltag playlists /music
  # then add the printed snippet to navidrome.toml and run a FULL scan.
`;

interface Parsed {
  command: string;
  library: string | undefined;
  values: Record<string, string | boolean | undefined>;
}

function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      offline: { type: 'boolean' },
      'refresh-cache': { type: 'boolean' },
      'language-source': { type: 'string' },
      yes: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      'min-confidence': { type: 'string' },
      out: { type: 'string' },
      'min-tracks': { type: 'string' },
    },
  });
  return { command: positionals[0] ?? '', library: positionals[1], values };
}

function requireLibrary(library: string | undefined): string {
  if (!library) throw new Error('a library path is required — try "babeltag --help"');
  return path.resolve(library);
}

function readConfidence(raw: unknown): Confidence {
  if (raw === undefined) return 'medium';
  if (raw === 'high' || raw === 'medium') return raw;
  throw new Error(`--min-confidence must be "high" or "medium", got "${String(raw)}"`);
}

function readLanguageSource(raw: unknown): LanguageSource {
  if (raw === undefined) return 'script';
  if (raw === 'script' || raw === 'musicbrainz') return raw;
  throw new Error(`--language-source must be "script" or "musicbrainz", got "${String(raw)}"`);
}

function reportPlan(library: string, policy: WritePolicy, log: (m: string) => void): void {
  const plan = loadPlan(library);
  const summary = summarize(plan, policy);

  log('');
  log(`${summary.tracks} track(s) in the plan.`);

  const countries = rankedCounts(summary.countries, 'country');
  if (countries.length > 0) {
    log('');
    log('By country:');
    for (const row of countries) log(`  ${row.code}  ${row.name.padEnd(24)} ${row.count}`);
  }
  if (summary.unresolvedCountry > 0) log(`  --  ${'no country found'.padEnd(24)} ${summary.unresolvedCountry}`);

  const languages = rankedCounts(summary.languages, 'language');
  if (languages.length > 0) {
    log('');
    log('By language:');
    for (const row of languages) log(`  ${row.code} ${row.name.padEnd(24)} ${row.count}`);
  }
  if (summary.unresolvedLanguage > 0) log(`  --- ${'no language found'.padEnd(24)} ${summary.unresolvedLanguage}`);

  log('');
  log(`${summary.writes} tag value(s) would be written across ${summary.filesToChange} file(s).`);
}

export async function run(argv: string[], log: (message: string) => void = console.log): Promise<number> {
  const { command, library, values } = parse(argv);

  if (values.help || command === 'help' || command === '') {
    log(HELP);
    return 0;
  }
  if (values.version) {
    log(VERSION);
    return 0;
  }
  if (command === 'config') {
    log(configSnippet());
    return 0;
  }

  const userAgent = defaultUserAgent(VERSION);

  switch (command) {
    case 'scan': {
      const root = requireLibrary(library);
      await scan({
        library: root,
        userAgent,
        offline: values.offline === true,
        languageSource: readLanguageSource(values['language-source']),
        refreshCache: values['refresh-cache'] === true,
        log,
      });
      reportPlan(root, { minConfidence: 'medium', overwrite: false }, log);
      log('');
      log('Nothing has been changed. Review the numbers above, then run:');
      log(`  babeltag apply ${library} --yes`);
      return 0;
    }

    case 'apply': {
      const root = requireLibrary(library);
      const policy: WritePolicy = {
        minConfidence: readConfidence(values['min-confidence']),
        overwrite: values.overwrite === true,
      };
      const plan = loadPlan(root);

      if (values.yes !== true) {
        reportPlan(root, policy, log);
        log('');
        log('This was a report only. Add --yes to write these tags.');
        return 0;
      }
      const result = await apply({
        library: root,
        plan,
        minConfidence: policy.minConfidence,
        overwrite: policy.overwrite,
        log,
      });
      if (result.tagsWritten > 0) {
        log('');
        log(`If anything looks wrong: babeltag undo ${library}`);
      }
      return 0;
    }

    case 'undo': {
      const root = requireLibrary(library);
      const result = await undo({ library: root, log });
      return result.failed.length > 0 ? 1 : 0;
    }

    case 'playlists': {
      const root = requireLibrary(library);
      const plan = loadPlan(root);
      const outputDir = typeof values.out === 'string' ? path.resolve(values.out) : path.join(root, 'playlists');
      const minTracksRaw = values['min-tracks'];
      const minTracks = typeof minTracksRaw === 'string' ? Number.parseInt(minTracksRaw, 10) : 1;
      if (!Number.isFinite(minTracks) || minTracks < 1) throw new Error('--min-tracks must be a positive number');

      generatePlaylists({ plan, outputDir, minTracks, log });
      log('');
      log('Next: add the snippet to navidrome.toml, point Navidrome at the playlist');
      log('folder, and run a FULL scan (a quick scan will not pick up tag changes).');
      return 0;
    }

    default:
      log(`Unknown command "${command}".`);
      log(HELP);
      return 2;
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LockHeldError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error(`babeltag: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly, so tests can import `run` freely.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main();
}

export { statePaths };
