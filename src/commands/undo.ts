/**
 * `babeltag undo` — put every tagged file back exactly as it was.
 *
 * Replays the journal newest-first, so a field written twice ends up at its original
 * value. Restoring is idempotent: if a file already holds the old value (because the run
 * died between journalling and writing), setting it again changes nothing.
 */
import fs from 'node:fs';
import { clearField, writeField } from '../tags/io.ts';
import { Journal } from '../lib/journal.ts';
import { Lock } from '../lib/lock.ts';
import { statePaths } from '../lib/paths.ts';

export interface UndoOptions {
  library: string;
  /** Keep the journal afterwards instead of clearing it. */
  keepJournal?: boolean;
  log?: (message: string) => void;
}

export interface UndoResult {
  restored: number;
  removed: number;
  missingFiles: number;
  failed: Array<{ path: string; error: string }>;
}

export async function undo(options: UndoOptions): Promise<UndoResult> {
  const log = options.log ?? (() => {});
  const paths = statePaths(options.library);
  const journal = new Journal(paths.journal);

  if (!journal.exists()) throw new Error(`nothing to undo — no journal at ${paths.journal}`);

  return Lock.around(paths.lock, () => {
    const result: UndoResult = { restored: 0, removed: 0, missingFiles: 0, failed: [] };
    // Newest first, so a field written more than once lands back on its original value.
    const records = journal.read().reverse();

    for (const record of records) {
      if (!fs.existsSync(record.path)) {
        result.missingFiles++;
        continue;
      }
      try {
        if (record.previous === null) {
          // The field did not exist before this run, so restoring means removing it.
          clearField(record.path, record.kind);
          result.removed++;
        } else {
          writeField(record.path, record.kind, record.previous);
          result.restored++;
        }
      } catch (error) {
        result.failed.push({ path: record.path, error: (error as Error).message });
      }
    }

    log(`Restored ${result.restored} value(s) and removed ${result.removed} added tag(s).`);
    if (result.missingFiles > 0) log(`${result.missingFiles} file(s) no longer exist.`);
    if (result.failed.length > 0) log(`${result.failed.length} file(s) could not be restored.`);

    // Only clear a journal that fully replayed; otherwise the record must survive.
    if (!options.keepJournal && result.failed.length === 0) journal.clear();
    return result;
  });
}
