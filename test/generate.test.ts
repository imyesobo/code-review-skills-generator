import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATE, END, mergeManaged, planFiles, START } from '../src/generate/index.js';
import type { Rule } from '../src/types.js';

const rule = (p: Partial<Rule>): Rule => ({
  id: Math.random().toString(36).slice(2), title: 'T', rule: 'Do X.', category: 'general', keywords: ['x'],
  support: 3, prs: 3, reviewers: 2, repos: ['github:o/r'], confidence: 0.6, refinedBy: 'heuristic', examples: [], ...p,
});

describe('planFiles', () => {
  const opts = { ...DEFAULT_GENERATE, out: '.' };

  it('routes scoped rules to instructions, categories to skills, rest to AGENTS.md', () => {
    const files = planFiles(
      [
        rule({ applyTo: 'src/**/*.ts' }),
        rule({ category: 'security', title: 'No secrets' }),
        rule({ category: 'security', title: 'Sanitize input' }),
        rule({ category: 'naming', title: 'Lonely' }),
        rule({ title: 'General one' }),
      ],
      opts,
    );
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(Object.keys(byPath).sort()).toEqual([
      '.github/instructions/src-ts.instructions.md',
      '.github/skills/security-review/SKILL.md',
      'AGENTS.md',
    ]);
    expect(byPath['.github/instructions/src-ts.instructions.md']).toMatch(/^---\napplyTo: "src\/\*\*\/\*\.ts"\n---/);
    expect(byPath['.github/skills/security-review/SKILL.md']).toMatch(/^---\nname: security-review\ndescription: ".+"\n---/);
    expect(byPath['AGENTS.md']).toContain('Lonely');
    expect(byPath['AGENTS.md']).toContain('General one');
  });

  it('falls back to AGENTS.md when instructions/skills are disabled', () => {
    const files = planFiles([rule({ applyTo: '**/*.ts', category: 'testing' })], { ...opts, targets: ['agents'] });
    expect(files.map((f) => f.path)).toEqual(['AGENTS.md']);
  });
});

describe('mergeManaged', () => {
  it('replaces only the managed section', () => {
    const existing = `# Mine\n\nkeep\n\n${START}\nold\n${END}\n\ntail\n`;
    expect(mergeManaged(existing, `${START}\nnew\n${END}`)).toBe(`# Mine\n\nkeep\n\n${START}\nnew\n${END}\n\ntail\n`);
  });
});
