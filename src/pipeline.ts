import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { analyze, type AnalyzeOptions } from './analyze/index.js';
import { applyCachedOnly, refineWithLlm, type LlmOptions } from './analyze/llm.js';
import { writeFiles, type GenerateOptions } from './generate/index.js';
import { providerFor } from './sources/index.js';
import {
  diffRules, emptyState, fetchSince, mergeDatasets, stabilizeIds, type LlmCacheEntry, type RuleDiff, type State,
} from './state.js';
import type { Dataset, ReviewComment, RuleSet } from './types.js';

export type Log = (msg: string) => void;

export interface FetchResult {
  dataset: Dataset;
  state: State;
  addedByRepo: Map<string, number>;
}

/**
 * Fetch review comments incrementally: each repo resumes from its stored cursor
 * (unless `full`), and results are upserted into the previous dataset by comment id.
 */
export async function fetchDataset(
  sources: string[],
  opts: { since?: Date; maxPrs: number; log: Log; previous?: Dataset; state?: State; full?: boolean },
): Promise<FetchResult> {
  const state: State = structuredClone(opts.state ?? emptyState());
  const fetched: ReviewComment[] = [];
  const repos: string[] = [];
  for (const source of sources) {
    const provider = providerFor(source);
    const keys = await provider.listRepos();
    opts.log(`${source}: ${keys.length} repo(s)`);
    for (const key of keys) {
      const since = opts.full ? opts.since : fetchSince(opts.since, state.repos[key]);
      try {
        const { comments, cursor } = await provider.fetchComments(key, { since, maxPrs: opts.maxPrs, log: opts.log });
        fetched.push(...comments);
        repos.push(key);
        const prevCursor = opts.full ? undefined : state.repos[key]?.cursor;
        state.repos[key] = {
          cursor: [prevCursor, cursor].filter((c): c is string => !!c).sort().at(-1),
          lastFetchedAt: new Date().toISOString(),
        };
      } catch (err) {
        opts.log(`  ! ${key}: ${(err as Error).message}`);
      }
    }
  }
  const next: Dataset = { fetchedAt: new Date().toISOString(), sources, repos, comments: fetched };
  const { dataset, added } = mergeDatasets(opts.full ? undefined : opts.previous, next);
  const addedByRepo = new Map<string, number>(repos.map((r) => [r, 0]));
  for (const c of added) addedByRepo.set(c.repo, (addedByRepo.get(c.repo) ?? 0) + 1);
  return { dataset, state, addedByRepo };
}

export async function analyzeDataset(
  dataset: Dataset,
  opts: AnalyzeOptions & { perRepo: boolean; llm?: LlmOptions; llmCache?: LlmCacheEntry[]; previous?: RuleSet; log: Log },
): Promise<{ ruleSet: RuleSet; diffs: Record<string, RuleDiff> }> {
  const groups: Record<string, ReviewComment[]> = {};
  for (const c of dataset.comments) (groups[opts.perRepo ? c.repo : '*'] ??= []).push(c);

  const ruleSet: RuleSet = {};
  const diffs: Record<string, RuleDiff> = {};
  for (const [scope, comments] of Object.entries(groups)) {
    let rules = stabilizeIds(analyze({ comments }, opts), opts.previous?.[scope]);
    opts.log(`${scope === '*' ? 'all repos' : scope}: ${comments.length} comments -> ${rules.length} rules`);
    if (opts.llm && rules.length) rules = await refineWithLlm(rules, opts.llm, opts.log, opts.llmCache);
    else if (opts.llmCache?.length) rules = applyCachedOnly(rules, opts.llmCache);
    ruleSet[scope] = rules;
    diffs[scope] = diffRules(opts.previous?.[scope], rules);
  }
  return { ruleSet, diffs };
}

/** "*" writes into `out`; per-repo scopes go to out/<provider>/<owner>/<repo>. */
export function generateFromRuleSet(ruleSet: RuleSet, opts: GenerateOptions, log: Log) {
  for (const [scope, rules] of Object.entries(ruleSet)) {
    const out = scope === '*' ? opts.out : join(opts.out, ...scope.replace(':', '/').split('/'));
    const { files, removed } = writeFiles(rules, { ...opts, out });
    const dry = opts.dryRun ? '[dry-run] ' : '';
    for (const f of files) log(`${dry}${join(out, f.path)}`);
    for (const p of removed) log(`${dry}removed stale ${join(out, p)}`);
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
