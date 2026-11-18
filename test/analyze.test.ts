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
      c('Rename this variable to something descriptive'),
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
