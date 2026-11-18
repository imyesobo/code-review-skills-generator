import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { analyze, type AnalyzeOptions } from './analyze/index.js';
import { refineWithLlm, type LlmOptions } from './analyze/llm.js';
import { writeFiles, type GenerateOptions } from './generate/index.js';
import { providerFor } from './sources/index.js';
import type { Dataset, ReviewComment, RuleSet } from './types.js';

export type Log = (msg: string) => void;

export async function fetchDataset(sources: string[], opts: { since?: Date; maxPrs: number; log: Log }): Promise<Dataset> {
  const comments: ReviewComment[] = [];
  const repos: string[] = [];
  for (const source of sources) {
    const provider = providerFor(source);
    const keys = await provider.listRepos();
    opts.log(`${source}: ${keys.length} repo(s)`);
    for (const key of keys) {
      try {
        comments.push(...(await provider.fetchComments(key, opts)));
        repos.push(key);
      } catch (err) {
        opts.log(`  ! ${key}: ${(err as Error).message}`);
      }
    }
  }
  return { fetchedAt: new Date().toISOString(), sources, repos, comments };
}

export async function analyzeDataset(
  dataset: Dataset,
  opts: AnalyzeOptions & { perRepo: boolean; llm?: LlmOptions; log: Log },
): Promise<RuleSet> {
  const groups: Record<string, ReviewComment[]> = {};
  for (const c of dataset.comments) (groups[opts.perRepo ? c.repo : '*'] ??= []).push(c);

  const result: RuleSet = {};
  for (const [scope, comments] of Object.entries(groups)) {
    let rules = analyze({ comments }, opts);
    opts.log(`${scope === '*' ? 'all repos' : scope}: ${comments.length} comments -> ${rules.length} rules`);
    if (opts.llm && rules.length) rules = await refineWithLlm(rules, opts.llm, opts.log);
    result[scope] = rules;
  }
  return result;
}

/** "*" writes into `out`; per-repo scopes go to out/<provider>/<owner>/<repo>. */
export function generateFromRuleSet(ruleSet: RuleSet, opts: GenerateOptions, log: Log) {
  for (const [scope, rules] of Object.entries(ruleSet)) {
    const out = scope === '*' ? opts.out : join(opts.out, ...scope.replace(':', '/').split('/'));
    const files = writeFiles(rules, { ...opts, out });
    for (const f of files) log(`${opts.dryRun ? '[dry-run] ' : ''}${join(out, f.path)}`);
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
