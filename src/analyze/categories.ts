import { stem } from './tokenize.js';

const LEXICON: Record<string, string[]> = {
  testing: ['test', 'tests', 'testing', 'spec', 'mock', 'mocking', 'stub', 'coverage', 'assert', 'assertion', 'fixture', 'flaky', 'e2e', 'unit'],
  security: ['security', 'secret', 'secrets', 'token', 'credential', 'sanitize', 'injection', 'xss', 'csrf', 'auth', 'authorization', 'permission', 'password', 'escape', 'encrypt', 'vulnerability'],
  performance: ['performance', 'perf', 'slow', 'memory', 'allocation', 'cache', 'caching', 'complexity', 'lazy', 'batch', 'query', 'queries', 'n+1', 'optimize', 'expensive'],
  'error-handling': ['error', 'errors', 'exception', 'exceptions', 'throw', 'catch', 'try', 'handle', 'handling', 'fail', 'failure', 'retry', 'null', 'undefined', 'nullable', 'fallback'],
  naming: ['name', 'naming', 'rename', 'renamed', 'variable', 'camelcase', 'descriptive', 'misleading', 'confusing'],
  documentation: ['doc', 'docs', 'documentation', 'comment', 'comments', 'readme', 'jsdoc', 'docstring', 'changelog', 'explain'],
  typing: ['type', 'types', 'typing', 'any', 'interface', 'generic', 'generics', 'cast', 'typed', 'nullable', 'enum'],
  logging: ['log', 'logs', 'logging', 'logger', 'console', 'debug', 'telemetry', 'trace', 'metric', 'metrics'],
  'api-design': ['api', 'endpoint', 'breaking', 'contract', 'backward', 'compatibility', 'deprecate', 'version', 'versioning', 'public'],
  style: ['format', 'formatting', 'lint', 'linter', 'indent', 'indentation', 'whitespace', 'style', 'prettier', 'import', 'imports', 'unused', 'dead'],
  architecture: ['abstraction', 'coupling', 'dependency', 'inject', 'injection', 'layer', 'module', 'responsibility', 'refactor', 'duplicate', 'duplication', 'reuse', 'helper'],
};

const STEMMED: [string, Set<string>][] = Object.entries(LEXICON).map(([k, ws]) => [k, new Set(ws.map(stem))]);

export const CATEGORY_LABELS: Record<string, string> = {
  testing: 'Testing',
  security: 'Security',
  performance: 'Performance',
  'error-handling': 'Error handling',
  naming: 'Naming',
  documentation: 'Documentation',
  typing: 'Typing',
  logging: 'Logging & observability',
  'api-design': 'API design',
  style: 'Code style',
  architecture: 'Architecture & design',
  general: 'General',
};

export function categorize(tokenLists: string[][]): string {
  const scores = new Map<string, number>();
  for (const tokens of tokenLists) {
    const set = new Set(tokens);
    for (const [cat, words] of STEMMED) {
      let hit = 0;
      for (const w of set) if (words.has(w)) hit++;
      if (hit) scores.set(cat, (scores.get(cat) ?? 0) + hit);
    }
  }
  const best = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  // Require the category to show up in a meaningful share of the cluster.
  return best && best[1] >= Math.max(1, tokenLists.length * 0.3) ? best[0] : 'general';
}
