/**
 * Where babeltag keeps its state.
 *
 * Everything lives in a single `.babeltag/` folder beside the library, so the plan, cache,
 * journal and lock travel with the library and a user can delete the lot in one go.
 */
import path from 'node:path';

export const STATE_DIR = '.babeltag';

export interface StatePaths {
  root: string;
  dir: string;
  plan: string;
  cache: string;
  journal: string;
  lock: string;
}

export function statePaths(libraryRoot: string): StatePaths {
  const root = path.resolve(libraryRoot);
  const dir = path.join(root, STATE_DIR);
  return {
    root,
    dir,
    plan: path.join(dir, 'plan.json'),
    cache: path.join(dir, 'cache.jsonl'),
    journal: path.join(dir, 'journal.jsonl'),
    lock: path.join(dir, 'lock.json'),
  };
}
