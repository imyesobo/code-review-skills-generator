import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dataset, ReviewComment, Rule, RuleSet } from './types.js';

export interface RepoState {
  /** Newest PR activity timestamp seen; next fetch starts here (minus overlap). */
  cursor?: string;
  lastFetchedAt: string;
}

export interface State {
  version: 1;
  repos: Record<string, RepoState>;
}

export interface LlmCacheEntry {
  members: string[];
  title: string;
  rule: string;
  drop: boolean;
  model: string;
}

export interface StatePaths {
  dir: string;
  state: string;
  dataset: string;
  rules: string;
  llmCache: string;
}

export function statePaths(dir: string): StatePaths {
  return {
    dir,
    state: join(dir, 'state.json'),
    dataset: join(dir, 'dataset.json'),
    rules: join(dir, 'rules.json'),
    llmCache: join(dir, 'llm-cache.json'),
  };
}

export function readJsonIfExists<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
}

export function emptyState(): State {
  return { version: 1, repos: {} };
}

/** Re-scan this much before the cursor to tolerate clock skew / eventual consistency. */
export const CURSOR_OVERLAP_MS = 60 * 60 * 1000;

/** Effective lower bound for a repo fetch: the later of --since and (cursor - overlap). */
export function fetchSince(since: Date | undefined, repo: RepoState | undefined): Date | undefined {
  if (!repo?.cursor) return since;
  const fromCursor = new Date(new Date(repo.cursor).getTime() - CURSOR_OVERLAP_MS);
  return since && since > fromCursor ? since : fromCursor;
}

/**
 * Upsert comments by their stable provider id. Returns the merged list plus ids that
 * were never seen before (edited comments replace the old copy but are not "new").
 */
export function mergeComments(previous: ReviewComment[], incoming: ReviewComment[]): { comments: ReviewComment[]; added: ReviewComment[] } {
  const byId = new Map(previous.map((c) => [c.id, c]));
  const added: ReviewComment[] = [];
  for (const c of incoming) {
    if (!byId.has(c.id)) added.push(c);
    byId.set(c.id, c);
  }
  return { comments: [...byId.values()], added };
}

export function mergeDatasets(prev: Dataset | undefined, next: Dataset): { dataset: Dataset; added: ReviewComment[] } {
  if (!prev) return { dataset: next, added: next.comments };
  const { comments, added } = mergeComments(prev.comments, next.comments);
  return {
    dataset: {
      fetchedAt: next.fetchedAt,
      sources: [...new Set([...prev.sources, ...next.sources])],
      repos: [...new Set([...prev.repos, ...next.repos])].sort(),
      comments,
    },
    added,
  };
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  return inter / (sa.size + new Set(b).size - inter);
}

/** Best-matching item (by member overlap) with similarity >= min, or undefined. */
function bestMatch<T>(members: string[], candidates: T[], get: (t: T) => string[], min: number): T | undefined {
  let best: T | undefined;
  let bestSim = min;
  for (const c of candidates) {
    const s = jaccard(members, get(c));
    if (s >= bestSim) { bestSim = s; best = c; }
  }
  return best;
}

/**
 * Keep rule ids stable across runs: a new rule that shares enough comments with a
 * previous rule inherits its id (greedy, highest overlap first).
 */
export function stabilizeIds(next: Rule[], prev: Rule[] | undefined, min = 0.3): Rule[] {
  if (!prev?.length) return next;
  const pairs: { n: number; p: number; s: number }[] = [];
  next.forEach((r, n) => prev.forEach((q, p) => {
    const s = jaccard(r.members ?? [], q.members ?? []);
    if (s >= min) pairs.push({ n, p, s });
  }));
  pairs.sort((a, b) => b.s - a.s);
  const usedN = new Set<number>();
  const usedP = new Set<number>();
  const ids = next.map((r) => r.id);
  for (const { n, p } of pairs) {
    if (usedN.has(n) || usedP.has(p)) continue;
    usedN.add(n); usedP.add(p);
    ids[n] = prev[p].id;
  }
  // Fresh hash ids could collide with an inherited one; keep them unique.
  const taken = new Set(ids.filter((_, i) => usedN.has(i)));
  return next.map((r, i) => ({ ...r, id: usedN.has(i) || !taken.has(ids[i]) ? ids[i] : `${ids[i]}-${i}` }));
}

/** `model` undefined = accept a refinement from any model. */
export function findCached(rule: Rule, cache: LlmCacheEntry[], model?: string, min = 0.8): LlmCacheEntry | undefined {
  return bestMatch(rule.members ?? [], model ? cache.filter((e) => e.model === model) : cache, (e) => e.members, min);
}

export interface RuleDiff { added: Rule[]; changed: Rule[]; removed: Rule[] }

export function diffRules(prev: Rule[] | undefined, next: Rule[]): RuleDiff {
  const before = new Map((prev ?? []).map((r) => [r.id, r]));
  const after = new Set(next.map((r) => r.id));
  const added: Rule[] = [];
  const changed: Rule[] = [];
  for (const r of next) {
    const p = before.get(r.id);
    if (!p) added.push(r);
    else if (p.support !== r.support || p.rule !== r.rule || p.applyTo !== r.applyTo) changed.push(r);
  }
  return { added, changed, removed: (prev ?? []).filter((r) => !after.has(r.id)) };
}

export function formatReport(addedByRepo: Map<string, number>, diffs: Record<string, RuleDiff>): string {
  const lines = ['', 'New since last run:'];
  const total = [...addedByRepo.values()].reduce((a, b) => a + b, 0);
  lines.push(`  comments: ${total}${total ? ` (${[...addedByRepo].filter(([, n]) => n).map(([r, n]) => `${r} +${n}`).join(', ')})` : ''}`);
  for (const [scope, d] of Object.entries(diffs)) {
    const label = scope === '*' ? 'rules' : `rules ${scope}`;
    lines.push(`  ${label}: +${d.added.length} new, ~${d.changed.length} updated, -${d.removed.length} removed`);
    for (const r of d.added) lines.push(`    + ${r.title}`);
    for (const r of d.removed) lines.push(`    - ${r.title}`);
  }
  return lines.join('\n');
}

export type { RuleSet };
