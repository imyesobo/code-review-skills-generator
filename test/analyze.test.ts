import { describe, expect, it } from 'vitest';
import { analyze, DEFAULT_ANALYZE } from '../src/analyze/index.js';
import { cleanBody, normalize } from '../src/analyze/normalize.js';
import { inferApplyTo } from '../src/analyze/scope.js';
import type { ReviewComment } from '../src/types.js';

let n = 0;
const c = (body: string, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id: `c${n++}`, provider: 'github', repo: 'github:o/r', pr: n, prUrl: `u${n}`, prAuthor: 'dev',
  author: `rev${n % 3}`, authorIsBot: false, body, createdAt: '', kind: 'inline', ...extra,
});

describe('normalize', () => {
  it('drops bots, self-replies, approvals and code-only comments', () => {
    const out = normalize(
      [
        c('LGTM!'),
        c('Please add a unit test for this branch', { authorIsBot: true }),
        c('I will add a unit test for this branch', { author: 'dev' }),
        c('```suggestion\nfoo()\n```'),
        c('nit: please add a unit test for this branch'),
      ],
      { includeBots: false, minLength: 20 },
    );
    expect(out.map((o) => o.text)).toEqual(['please add a unit test for this branch']);
  });

  it('strips quotes, links and mentions', () => {
    expect(cleanBody('> old\n@bob see [docs](https://x.y) here')).toBe('see docs here');
  });
});

describe('inferApplyTo', () => {
  it('detects test files, directories and extensions', () => {
    expect(inferApplyTo(['src/a.test.ts', 'src/b/c.spec.ts', 'src/d.test.ts'])).toBe('src/**/*.{test,spec}.ts');
    expect(inferApplyTo(['api/x.cs', 'api/y/z.cs'])).toBe('api/**/*.cs');
    expect(inferApplyTo(['a/x.py', 'b/y.py'])).toBe('**/*.py');
    expect(inferApplyTo(['a/x.py', undefined, undefined])).toBeUndefined();
  });
});

describe('analyze', () => {
  it('clusters recurring feedback into ranked, scoped rules', () => {
    const comments = [
      c('Please add unit tests covering the error path', { path: 'src/a.test.ts' }),
      c('Missing unit tests for the error path here', { path: 'src/b.test.ts' }),
      c('Add unit tests for this error path too', { path: 'src/c.test.ts' }),
      c('Avoid logging the access token, it leaks secrets', { path: 'src/auth.ts' }),
      c('Rename this variable to something descriptive', { path: 'lib/x.py' }),
      c('Should this README section mention the CLI flags?', { path: 'docs/readme.md' }),
      c('Please bump the chart version for this release', { path: 'deploy/chart.yaml' }),
    ];
    const rules = analyze({ comments }, DEFAULT_ANALYZE);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ category: 'testing', support: 3, prs: 3, applyTo: 'src/**/*.{test,spec}.ts' });
  });
});

describe('actionable filter', () => {
  it('drops praise and AI-review boilerplate but keeps requests', () => {
    const out = normalize(
      [
        c('Clean implementation. Types and docs are up to date.'),
        c('Copilot was unable to review this pull request because of quota'),
        c('### 🟡 Changes recommended\n**Requirement:** avoid hardcoding the timeout value'),
      ],
      { includeBots: true, minLength: 20 },
    );
    expect(out.map((o) => o.text)).toEqual(['avoid hardcoding the timeout value']);
  });
});

describe('stem', async () => {
  const { stem } = await import('../src/analyze/tokenize.js');
  it('conflates simple inflections', () => {
    expect(new Set(['type', 'types', 'typed'].map(stem)).size).toBe(1);
    expect(new Set(['test', 'tests', 'testing'].map(stem)).size).toBe(1);
  });
});

describe('summarize', async () => {
  const { summarize } = await import('../src/analyze/index.js');
  it('does not split on dots inside versions or hosts', () => {
    expect(summarize('Pin to v0.44 on github.com please. Then rebuild everything.')).toBe('Pin to v0.44 on github.com please. Then rebuild everything.');
    expect(summarize('Avoid hardcoding the retry timeout in the HTTP client constructor here. Use the config value instead of it.')).toBe(
      'Avoid hardcoding the retry timeout in the HTTP client constructor here.',
    );
  });
});

describe('isDiscriminative', async () => {
  const { isDiscriminative, globToRegExp } = await import('../src/analyze/scope.js');
  it('matches generated globs', () => {
    expect(globToRegExp('src/**/*.{test,spec}.ts').test('src/a/b.spec.ts')).toBe(true);
    expect(globToRegExp('src/**/*.{test,spec}.ts').test('src/b.test.ts')).toBe(true);
    expect(globToRegExp('**/*.go').test('main.go')).toBe(true);
    expect(globToRegExp('**/*.go').test('main.gox')).toBe(false);
  });
  it('rejects scopes that cover most reviewed files', () => {
    const all = ['a.go', 'b/c.go', 'd/e.go', 'docs/x.md'];
    expect(isDiscriminative('**/*.go', all)).toBe(false);
    expect(isDiscriminative('**/*.md', all)).toBe(true);
  });
});

describe('keywords', () => {
  it('are shown as real words, not stems', () => {
    const comments = [
      c('Please require the assertion helpers in tests here'),
      c('These assertions should require the shared helpers'),
      c('Use the required assertion helpers for this check'),
    ];
    const [r] = analyze({ comments }, { ...DEFAULT_ANALYZE, minPrs: 1 });
    expect(r.keywords).toContain('require');
    expect(r.keywords.some((k) => k === 'requir')).toBe(false);
  });
});
