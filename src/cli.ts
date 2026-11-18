#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_ANALYZE } from './analyze/index.js';
import { DEFAULT_LLM, type LlmOptions } from './analyze/llm.js';
import { DEFAULT_GENERATE, type Target } from './generate/index.js';
import { analyzeDataset, fetchDataset, generateFromRuleSet, readJson, writeJson } from './pipeline.js';
import { formatReport, readJsonIfExists, statePaths, type LlmCacheEntry, type RuleDiff, type State } from './state.js';
import type { Dataset, Rule, RuleSet } from './types.js';

const HELP = `crsg - generate AI agent instructions & skills from pull request reviews

Usage:
  crsg run <source...>      fetch + analyze + generate
  crsg fetch <source...>    download review comments to --data
  crsg analyze              cluster comments from --data into rules at --rules
  crsg generate             write AGENTS.md / *.instructions.md / SKILL.md from --rules

Sources (mix freely):
  owner/repo, github:owner/repo     single GitHub repo
  github:owner                      all repos of a GitHub user or organization
  ado:org/project/repo              single Azure DevOps repo
  ado:org/project | ado:org         all repos in an Azure DevOps project / organization
  https://github.com/... | https://dev.azure.com/... URLs also work

Auth:
  GitHub:       GITHUB_TOKEN / GH_TOKEN, else \`gh auth token\`
  Azure DevOps: AZURE_DEVOPS_TOKEN, else \`az account get-access-token\` (az login), else AZURE_DEVOPS_EXT_PAT
                --ado-tenant <id|domain> (or AZURE_DEVOPS_TENANT) when the org is in a non-default tenant

State (incremental runs):
  --state-dir <dir>          where state.json, dataset.json, rules.json, llm-cache.json live (default .crsg)
                             Commit it to share progress across machines/CI, or gitignore it.
  --full                     ignore stored cursors/rules and rebuild from scratch
  --no-report                don't print the "new since last run" summary
  --json                     machine-readable: silence progress logs, print one JSON summary to stdout
                             ({"ok":false,"error":...} and exit 1 on failure). Intended for AI agents/CI.

Fetch options:
  --since <90d|YYYY-MM-DD>   first-run horizon; later runs resume from each repo's cursor (default 180d)
  --max-prs <n>              max PRs per repo per run (default 200)
  --data <file>              dataset path (default <state-dir>/dataset.json)

Analyze options:
  --rules <file>             rules path (default <state-dir>/rules.json)
  --per-repo                 produce separate rules per repo instead of one combined set
  --threshold <0-1>          clustering similarity (default ${DEFAULT_ANALYZE.threshold})
  --min-support <n>          min comments per rule (default ${DEFAULT_ANALYZE.minSupport})
  --min-prs <n>              min distinct PRs per rule (default ${DEFAULT_ANALYZE.minPrs})
  --include-bots             keep comments from bots
  --llm                      refine wording with one batched LLM call (OpenAI-compatible)
  --llm-model <id>           default ${DEFAULT_LLM.model}
  --llm-endpoint <url>       default local Ollama ($OLLAMA_HOST or 127.0.0.1:11434); key from LLM_API_KEY
  --llm-max-rules <n>        rules sent to the LLM (default ${DEFAULT_LLM.maxRules})

Generate options:
  --out <dir>                output root (default .)
  --targets <list>           agents,instructions,skills (default all)
  --min-confidence <0-1>     drop weaker rules (default 0)
  --dry-run                  print files without writing
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    since: { type: 'string', default: '180d' },
    'max-prs': { type: 'string', default: '200' },
    'state-dir': { type: 'string', default: '.crsg' },
    data: { type: 'string' },
    rules: { type: 'string' },
    full: { type: 'boolean', default: false },
    'no-report': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'per-repo': { type: 'boolean', default: false },
    threshold: { type: 'string' },
    'min-support': { type: 'string' },
    'min-prs': { type: 'string' },
    'include-bots': { type: 'boolean', default: false },
    llm: { type: 'boolean', default: false },
    'llm-model': { type: 'string' },
    'llm-endpoint': { type: 'string' },
    'llm-max-rules': { type: 'string' },
    out: { type: 'string', default: '.' },
    targets: { type: 'string', default: 'agents,instructions,skills' },
    'min-confidence': { type: 'string', default: '0' },
    'dry-run': { type: 'boolean', default: false },
    'ado-tenant': { type: 'string' },
  },
});

// --json: progress logs are silenced and a single JSON summary goes to stdout.
const warnings: string[] = [];
const log = (m: string) => {
  if (/^\s*! |refinement skipped/.test(m)) warnings.push(m.trim().replace(/^! /, ''));
  if (!values.json) console.error(m);
};
const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));

function parseSince(v: string | undefined): Date | undefined {
  if (!v || v === 'all') return undefined;
  const rel = v.match(/^(\d+)d$/);
  const d = rel ? new Date(Date.now() - Number(rel[1]) * 86_400_000) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid --since: ${v}`);
  return d;
}

const paths = statePaths(values['state-dir']!);
const dataPath = values.data ?? paths.dataset;
const rulesPath = values.rules ?? paths.rules;
const report = {
  addedByRepo: undefined as Map<string, number> | undefined,
  diffs: undefined as Record<string, RuleDiff> | undefined,
  dataset: undefined as Dataset | undefined,
  ruleSet: undefined as RuleSet | undefined,
  files: undefined as { written: string[]; removed: string[] } | undefined,
};

async function doFetch(sources: string[]) {
  if (!sources.length) throw new Error('No sources given. See --help.');
  const { dataset, state, addedByRepo } = await fetchDataset(sources, {
    since: parseSince(values.since),
    maxPrs: num(values['max-prs'], 200),
    log,
    previous: readJsonIfExists<Dataset>(dataPath),
    state: readJsonIfExists<State>(paths.state),
    full: values.full,
  });
  writeJson(dataPath, dataset);
  writeJson(paths.state, state);
  report.addedByRepo = addedByRepo;
  report.dataset = dataset;
  const added = [...addedByRepo.values()].reduce((a, b) => a + b, 0);
  log(`Saved ${dataset.comments.length} comments (+${added} new) from ${dataset.repos.length} repo(s) to ${dataPath}`);
  return dataset;
}

async function doAnalyze(dataset: Dataset) {
  const llm: LlmOptions | undefined = values.llm
    ? {
        endpoint: values['llm-endpoint'] ?? DEFAULT_LLM.endpoint,
        model: values['llm-model'] ?? DEFAULT_LLM.model,
        maxRules: num(values['llm-max-rules'], DEFAULT_LLM.maxRules),
      }
    : undefined;
  const llmCache = readJsonIfExists<LlmCacheEntry[]>(paths.llmCache) ?? [];
  const { ruleSet, diffs } = await analyzeDataset(dataset, {
    ...DEFAULT_ANALYZE,
    threshold: num(values.threshold, DEFAULT_ANALYZE.threshold),
    minSupport: num(values['min-support'], DEFAULT_ANALYZE.minSupport),
    minPrs: num(values['min-prs'], DEFAULT_ANALYZE.minPrs),
    includeBots: values['include-bots']!,
    perRepo: values['per-repo']!,
    llm,
    llmCache,
    previous: values.full ? undefined : readJsonIfExists<RuleSet>(rulesPath),
    log,
  });
  writeJson(rulesPath, ruleSet);
  if (llm) writeJson(paths.llmCache, llmCache);
  report.diffs = diffs;
  report.ruleSet = ruleSet;
  log(`Saved rules to ${rulesPath}`);
  return ruleSet;
}

function doGenerate(ruleSet: RuleSet) {
  const targets = values.targets!.split(',').map((t) => t.trim()) as Target[];
  const bad = targets.filter((t) => !['agents', 'instructions', 'skills'].includes(t));
  if (bad.length) throw new Error(`Unknown target(s): ${bad.join(', ')}`);
  report.files = generateFromRuleSet(
    ruleSet,
    { ...DEFAULT_GENERATE, out: values.out!, targets, minConfidence: num(values['min-confidence'], 0), dryRun: values['dry-run']! },
    log,
  );
}

async function main() {
  if (values['ado-tenant']) process.env.AZURE_DEVOPS_TENANT = values['ado-tenant'];
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) return void console.log(HELP);
  switch (cmd) {
    case 'fetch':
      await doFetch(rest);
      break;
    case 'analyze':
      await doAnalyze(readJson<Dataset>(dataPath, 'Run `crsg fetch <source...>` first (or use `crsg run`).'));
      break;
    case 'generate':
      doGenerate(readJson<RuleSet>(rulesPath, 'Run `crsg analyze` first (or use `crsg run`).'));
      break;
    case 'run':
      doGenerate(await doAnalyze(await doFetch(rest)));
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. See --help.`);
  }
  if (values.json) console.log(JSON.stringify(jsonSummary(cmd), null, 2));
  else if (!values['no-report'] && (report.addedByRepo || report.diffs)) {
    log(formatReport(report.addedByRepo ?? new Map(), report.diffs ?? {}));
  }
}

const brief = (r: Rule) => ({ id: r.id, title: r.title, category: r.category, applyTo: r.applyTo, support: r.support, confidence: r.confidence });

function jsonSummary(command: string) {
  const { addedByRepo, diffs, dataset, ruleSet, files } = report;
  return {
    ok: true,
    command,
    dryRun: values['dry-run'],
    paths: { stateDir: paths.dir, dataset: dataPath, rules: rulesPath, out: values.out },
    ...(dataset && {
      comments: {
        total: dataset.comments.length,
        new: [...(addedByRepo?.values() ?? [])].reduce((a, b) => a + b, 0),
        newByRepo: Object.fromEntries(addedByRepo ?? []),
      },
      repos: dataset.repos,
    }),
    ...(ruleSet && {
      rules: Object.fromEntries(
        Object.entries(ruleSet).map(([scope, rules]) => [
          scope,
          {
            total: rules.length,
            added: diffs?.[scope]?.added.map(brief) ?? [],
            updated: diffs?.[scope]?.changed.map(brief) ?? [],
            removed: diffs?.[scope]?.removed.map(brief) ?? [],
          },
        ]),
      ),
    }),
    ...(files && { files }),
    warnings,
  };
}

main().catch((err) => {
  const message = (err as Error).message;
  if (values.json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`error: ${message}`);
  process.exit(1);
});
