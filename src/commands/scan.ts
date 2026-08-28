/**
 * `babeltag scan` — look at the library, work out what every track is, write a plan.
 *
 * This command never opens a file for writing. That is the whole safety model: you can
 * always scan, read the plan, and decide afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PlanEntry, ScanPlan } from '../core/types.ts';
import { Resolver } from '../core/resolve.ts';
import type { LanguageSource } from '../core/resolve.ts';
import { MusicBrainzClient } from '../mb/client.ts';
import { LookupCache } from '../mb/cache.ts';
import { readTrack } from '../tags/io.ts';
import { walkLibrary } from '../lib/walk.ts';
import { statePaths } from '../lib/paths.ts';

export interface ScanOptions {
  library: string;
  userAgent: string;
  offline?: boolean;
  languageSource?: LanguageSource;
  refreshCache?: boolean;
  log?: (message: string) => void;
  /** Injected in tests so the scan never touches the network. */
  fetchImpl?: typeof fetch;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export async function scan(options: ScanOptions): Promise<ScanPlan> {
  const log = options.log ?? (() => {});
  const paths = statePaths(options.library);

  if (!fs.existsSync(paths.root)) throw new Error(`library not found: ${paths.root}`);

  const { audio, unsupported } = walkLibrary(paths.root);
  log(`Found ${audio.length} taggable file${audio.length === 1 ? '' : 's'}.`);
  if (unsupported.length > 0) {
    log(`Skipping ${unsupported.length} file(s) in formats babeltag cannot tag.`);
  }

  const client = options.offline
    ? null
    : new MusicBrainzClient({ userAgent: options.userAgent, fetchImpl: options.fetchImpl });
  const cache = LookupCache.open(paths.cache, options.refreshCache ?? false);
  const resolver = new Resolver({
    client,
    cache,
    languageSource: options.languageSource ?? 'script',
  });

  const entries: PlanEntry[] = [];
  const errors: ScanPlan['errors'] = [];
  const started = Date.now();

  for (const [index, file] of audio.entries()) {
    try {
      const track = readTrack(file);
      // Country first: a shared writing system can only be narrowed once we know it.
      const country = await resolver.resolveCountry(track);
      const language = await resolver.resolveLanguage(track, country.value);

      entries.push({
        path: file,
        format: track.format,
        artistKey: Resolver.artistKeyFor(track),
        title: track.title,
        country,
        language,
        existingCountry: track.existingCountry,
        existingLanguage: track.existingLanguage,
      });
    } catch (error) {
      // One unreadable file must never end a scan of twenty thousand.
      errors.push({ path: file, error: (error as Error).message });
    }

    const done = index + 1;
    if (done % 25 === 0 || done === audio.length) {
      const elapsed = Date.now() - started;
      const remaining = Math.round((elapsed / done) * (audio.length - done));
      const eta = done === audio.length ? '' : ` — about ${formatDuration(remaining)} left`;
      log(`  ${done}/${audio.length} resolved (${cache.hits} from cache)${eta}`);
    }
  }

  const plan: ScanPlan = {
    version: 1,
    library: paths.root,
    createdAt: new Date().toISOString(),
    entries,
    unsupported,
    errors,
  };

  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.plan, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  log(`Plan written to ${path.relative(process.cwd(), paths.plan) || paths.plan}`);
  if (errors.length > 0) log(`${errors.length} file(s) could not be read; see the plan for details.`);
  if (resolver.lookupFailures > 0) {
    // Say it plainly: those tracks are not "unknown", they are "not asked yet".
    log(
      `${resolver.lookupFailures} MusicBrainz lookup(s) failed (the service was busy). ` +
        'Nothing was cached for them — re-run scan later to fill the gaps.',
    );
  }

  return plan;
}

export function loadPlan(library: string): ScanPlan {
  const paths = statePaths(library);
  if (!fs.existsSync(paths.plan)) {
    throw new Error(`no plan found for ${paths.root} — run "babeltag scan" first`);
  }
  const plan = JSON.parse(fs.readFileSync(paths.plan, 'utf8')) as ScanPlan;
  if (plan.version !== 1) throw new Error(`unrecognised plan version ${plan.version}`);
  return plan;
}
