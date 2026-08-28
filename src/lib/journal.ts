/**
 * The undo journal.
 *
 * This tool edits files people cannot re-download. Every single change is written here,
 * and flushed, *before* the audio file is touched — so a run killed at any moment leaves a
 * complete record of everything already done. Undo replays it backwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AudioFormat, JournalRecord, TagKind } from '../core/types.ts';

export class Journal {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  get filePath(): string {
    return this.#filePath;
  }

  /**
   * Record an intended change and flush it to disk.
   *
   * Called before the write, never after: a journal entry with no corresponding change is
   * harmless (undo restores a value that is already correct), while a change with no
   * journal entry is unrecoverable.
   */
  record(entry: {
    filePath: string;
    format: AudioFormat;
    kind: TagKind;
    previous: string | null;
    written: string;
  }): void {
    const record: JournalRecord = {
      ts: new Date().toISOString(),
      path: entry.filePath,
      format: entry.format,
      kind: entry.kind,
      previous: entry.previous,
      written: entry.written,
    };
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    // JSON.stringify does the escaping, so a tag value containing a newline cannot
    // corrupt the file.
    fs.appendFileSync(this.#filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** Every recorded change, oldest first. A torn final line is discarded. */
  read(): JournalRecord[] {
    if (!fs.existsSync(this.#filePath)) return [];
    const records: JournalRecord[] = [];
    for (const line of fs.readFileSync(this.#filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JournalRecord;
        if (parsed?.path && parsed?.kind) records.push(parsed);
      } catch {
        // Incomplete final line from an interrupted run.
      }
    }
    return records;
  }

  exists(): boolean {
    return fs.existsSync(this.#filePath);
  }

  clear(): void {
    fs.rmSync(this.#filePath, { force: true });
  }
}
