#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_ANALYZE } from './analyze/index.js';
import { DEFAULT_LLM, type LlmOptions } from './analyze/llm.js';
import { DEFAULT_GENERATE, type Target } from './generate/index.js';
import { analyzeDataset, fetchDataset, generateFromRuleSet, readJson, writeJson } from './pipeline.js';
import type { Dataset, RuleSet } from './types.js';

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

Fetch options:
  --since <90d|YYYY-MM-DD>   only PRs updated since (default 180d)
  --max-prs <n>              max PRs per repo (default 200)
  --data <file>              dataset path (default .crsg/dataset.json)

Analyze options:
  --rules <file>             rules path (default .crsg/rules.json)
  --per-repo                 produce separate rules per repo instead of one combined set
  --threshold <0-1>          clustering similarity (default ${DEFAULT_ANALYZE.threshold})
  --min-support <n>          min comments per rule (default ${DEFAULT_ANALYZE.minSupport})
  --min-prs <n>              min distinct PRs per rule (default ${DEFAULT_ANALYZE.minPrs})
  --include-bots             keep comments from bots
  --llm                      refine wording with one batched LLM call (OpenAI-compatible)
  --llm-model <id>           default ${DEFAULT_LLM.model}
  --llm-endpoint <url>       default GitHub Models; key from LLM_API_KEY or GitHub token
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
    data: { type: 'string', default: '.crsg/dataset.json' },
    rules: { type: 'string', default: '.crsg/rules.json' },
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

const log = (m: string) => console.error(m);
const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));

function parseSince(v: string | undefined): Date | undefined {
  if (!v || v === 'all') return undefined;
  const rel = v.match(/^(\d+)d$/);
  const d = rel ? new Date(Date.now() - Number(rel[1]) * 86_400_000) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid --since: ${v}`);
  return d;
}

async function doFetch(sources: string[]) {
  if (!sources.length) throw new Error('No sources given. See --help.');
  const dataset = await fetchDataset(sources, { since: parseSince(values.since), maxPrs: num(values['max-prs'], 200), log });
  writeJson(values.data!, dataset);
  log(`Saved ${dataset.comments.length} comments from ${dataset.repos.length} repo(s) to ${values.data}`);
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
  const ruleSet = await analyzeDataset(dataset, {
    ...DEFAULT_ANALYZE,
    threshold: num(values.threshold, DEFAULT_ANALYZE.threshold),
    minSupport: num(values['min-support'], DEFAULT_ANALYZE.minSupport),
    minPrs: num(values['min-prs'], DEFAULT_ANALYZE.minPrs),
    includeBots: values['include-bots']!,
    perRepo: values['per-repo']!,
    llm,
    log,
  });
  writeJson(values.rules!, ruleSet);
  log(`Saved rules to ${values.rules}`);
  return ruleSet;
}

function doGenerate(ruleSet: RuleSet) {
  const targets = values.targets!.split(',').map((t) => t.trim()) as Target[];
  const bad = targets.filter((t) => !['agents', 'instructions', 'skills'].includes(t));
  if (bad.length) throw new Error(`Unknown target(s): ${bad.join(', ')}`);
  generateFromRuleSet(
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
      await doAnalyze(readJson<Dataset>(values.data!));
      break;
    case 'generate':
      doGenerate(readJson<RuleSet>(values.rules!));
      break;
    case 'run':
      doGenerate(await doAnalyze(await doFetch(rest)));
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. See --help.`);
  }
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
