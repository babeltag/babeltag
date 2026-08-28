/**
 * Turning resolved values into a decision about what to write.
 *
 * The plan records what we *learned*; this decides what to *do* with it. Keeping those
 * apart means changing the confidence gate or the overwrite policy never needs a re-scan.
 */
import { CONFIDENCE_RANK } from './types.ts';
import type { Confidence, PlanEntry, ScanPlan, TagKind } from './types.ts';
import { countryName, languageName } from './iso.ts';

export interface WriteDecision {
  kind: TagKind;
  value: string;
  previous: string | null;
}

export type SkipReason =
  | 'nothing-resolved'
  | 'below-confidence'
  | 'already-correct'
  | 'would-overwrite';

export interface WritePolicy {
  minConfidence: Confidence;
  overwrite: boolean;
}

export interface EntryDecision {
  writes: WriteDecision[];
  skipped: Array<{ kind: TagKind; reason: SkipReason; existing: string | null }>;
}

function decideOne(
  kind: TagKind,
  resolvedValue: string | null,
  confidence: Confidence,
  existing: string | null,
  policy: WritePolicy,
): WriteDecision | { reason: SkipReason } {
  if (!resolvedValue) return { reason: 'nothing-resolved' };
  if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[policy.minConfidence]) {
    return { reason: 'below-confidence' };
  }
  // Idempotent: a second run over an already-tagged library writes nothing.
  if (existing === resolvedValue) return { reason: 'already-correct' };
  if (existing && !policy.overwrite) return { reason: 'would-overwrite' };
  return { kind, value: resolvedValue, previous: existing };
}

/** What `apply` would do to one file under the given policy. */
export function decideEntry(entry: PlanEntry, policy: WritePolicy): EntryDecision {
  const writes: WriteDecision[] = [];
  const skipped: EntryDecision['skipped'] = [];

  const candidates: Array<[TagKind, string | null, Confidence, string | null]> = [
    ['country', entry.country.value, entry.country.confidence, entry.existingCountry],
    ['language', entry.language.value, entry.language.confidence, entry.existingLanguage],
  ];

  for (const [kind, value, confidence, existing] of candidates) {
    const decision = decideOne(kind, value, confidence, existing, policy);
    if ('reason' in decision) skipped.push({ kind, reason: decision.reason, existing });
    else writes.push(decision);
  }
  return { writes, skipped };
}

export interface PlanSummary {
  tracks: number;
  filesToChange: number;
  writes: number;
  countries: Map<string, number>;
  languages: Map<string, number>;
  unresolvedCountry: number;
  unresolvedLanguage: number;
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

export function summarize(plan: ScanPlan, policy: WritePolicy): PlanSummary {
  const summary: PlanSummary = {
    tracks: plan.entries.length,
    filesToChange: 0,
    writes: 0,
    countries: new Map(),
    languages: new Map(),
    unresolvedCountry: 0,
    unresolvedLanguage: 0,
  };

  for (const entry of plan.entries) {
    if (entry.country.value) bump(summary.countries, entry.country.value);
    else summary.unresolvedCountry++;
    if (entry.language.value) bump(summary.languages, entry.language.value);
    else summary.unresolvedLanguage++;

    const { writes } = decideEntry(entry, policy);
    if (writes.length > 0) {
      summary.filesToChange++;
      summary.writes += writes.length;
    }
  }
  return summary;
}

/** Counts sorted biggest-first, with human-readable names, for the CLI report. */
export function rankedCounts(
  counter: Map<string, number>,
  kind: TagKind,
): Array<{ code: string; name: string; count: number }> {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => ({
      code,
      name: kind === 'country' ? countryName(code) : languageName(code),
      count,
    }));
}
