/**
 * `babeltag apply` — write the planned tags into the files.
 *
 * The only command that modifies music. Every change is journalled before it happens, each
 * write is read back to prove it landed, and a failure stops the run with the journal
 * intact so `undo` can put everything back.
 */
import fs from 'node:fs';
import type { Confidence, ScanPlan } from '../core/types.ts';
import { decideEntry } from '../core/plan.ts';
import type { WritePolicy } from '../core/plan.ts';
import { readField, writeField } from '../tags/io.ts';
import { Journal } from '../lib/journal.ts';
import { Lock } from '../lib/lock.ts';
import { statePaths } from '../lib/paths.ts';

export interface ApplyOptions {
  library: string;
  plan: ScanPlan;
  minConfidence?: Confidence;
  overwrite?: boolean;
  log?: (message: string) => void;
}

export interface ApplyResult {
  filesChanged: number;
  tagsWritten: number;
  skippedFiles: number;
  missingFiles: number;
  journalPath: string;
}

export async function apply(options: ApplyOptions): Promise<ApplyResult> {
  const log = options.log ?? (() => {});
  const paths = statePaths(options.library);
  const policy: WritePolicy = {
    minConfidence: options.minConfidence ?? 'medium',
    overwrite: options.overwrite ?? false,
  };

  return Lock.around(paths.lock, () => {
    const journal = new Journal(paths.journal);
    const result: ApplyResult = {
      filesChanged: 0,
      tagsWritten: 0,
      skippedFiles: 0,
      missingFiles: 0,
      journalPath: paths.journal,
    };

    for (const entry of options.plan.entries) {
      // Cheap pre-filter on the plan alone: nothing resolved, or nothing confident
      // enough, means we never need to open the file at all.
      if (decideEntry({ ...entry, existingCountry: null, existingLanguage: null }, policy).writes.length === 0) {
        result.skippedFiles++;
        continue;
      }
      if (!fs.existsSync(entry.path)) {
        // The library moved on since the scan; not worth aborting a long run for.
        result.missingFiles++;
        continue;
      }

      // Decide against what is on disk RIGHT NOW, not what the scan saw. The file may
      // have been retagged since, and the journal must record the value we actually
      // replaced. One decision function, one source of truth.
      const current = {
        ...entry,
        existingCountry: readField(entry.path, 'country'),
        existingLanguage: readField(entry.path, 'language'),
      };
      const { writes } = decideEntry(current, policy);
      if (writes.length === 0) {
        result.skippedFiles++;
        continue;
      }

      for (const write of writes) {
        journal.record({
          filePath: entry.path,
          format: entry.format,
          kind: write.kind,
          previous: write.previous,
          written: write.value,
        });
        // writeField verifies the value reads back, and throws if it does not.
        writeField(entry.path, write.kind, write.value);
        result.tagsWritten++;
      }
      result.filesChanged++;
    }

    log(`Tagged ${result.filesChanged} file(s) with ${result.tagsWritten} value(s).`);
    if (result.missingFiles > 0) log(`${result.missingFiles} file(s) from the plan no longer exist.`);
    if (result.tagsWritten > 0) log(`Undo journal: ${result.journalPath}`);
    return result;
  });
}
