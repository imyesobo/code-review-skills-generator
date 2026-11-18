import { describe, expect, it } from 'vitest';
import { diffRules, fetchSince, findCached, mergeComments, stabilizeIds, CURSOR_OVERLAP_MS } from '../src/state.js';
import type { ReviewComment, Rule } from '../src/types.js';

const comment = (id: string, body = 'x'): ReviewComment => ({
  id, provider: 'github', repo: 'github:o/r', pr: 1, prUrl: '', prAuthor: 'a', author: 'b', authorIsBot: false, body, createdAt: '', kind: 'inline',
});
const rule = (id: string, members: string[], p: Partial<Rule> = {}): Rule => ({
  id, title: id, rule: 'r', category: 'general', keywords: [], support: members.length, prs: 1, reviewers: 1, repos: [],
  confidence: 0.5, refinedBy: 'heuristic', examples: [], members, ...p,
});

describe('incremental state', () => {
  it('upserts comments by id and reports only unseen ones as added', () => {
    const { comments, added } = mergeComments([comment('1', 'old'), comment('2')], [comment('1', 'edited'), comment('3')]);
    expect(comments.map((c) => [c.id, c.body])).toEqual([['1', 'edited'], ['2', 'x'], ['3', 'x']]);
    expect(added.map((c) => c.id)).toEqual(['3']);
  });

  it('resumes from the cursor minus overlap, never before --since', () => {
    const cursor = '2026-06-10T00:00:00.000Z';
    const fromCursor = new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS);
    expect(fetchSince(new Date('2026-01-01'), { cursor, lastFetchedAt: '' })).toEqual(fromCursor);
    expect(fetchSince(new Date('2026-07-01'), { cursor, lastFetchedAt: '' })).toEqual(new Date('2026-07-01'));
    expect(fetchSince(undefined, undefined)).toBeUndefined();
  });

  it('keeps rule ids stable as clusters grow and diffs against the previous run', () => {
    const prev = [rule('keep', ['a', 'b', 'c']), rule('gone', ['x', 'y', 'z'])];
    const next = stabilizeIds([rule('h1', ['a', 'b', 'c', 'd']), rule('h2', ['m', 'n', 'o'])], prev);
    expect(next.map((r) => r.id)).toEqual(['keep', 'h2']);
    const d = diffRules(prev, next);
    expect([d.added.map((r) => r.id), d.changed.map((r) => r.id), d.removed.map((r) => r.id)]).toEqual([['h2'], ['keep'], ['gone']]);
  });

  it('reuses cached LLM wording only for mostly-unchanged clusters of the same model', () => {
    const cache = [{ members: ['a', 'b', 'c', 'd', 'e'], title: 'T', rule: 'R', drop: false, model: 'm' }];
    expect(findCached(rule('r', ['a', 'b', 'c', 'd', 'e', 'f']), cache, 'm')).toBe(cache[0]);
    expect(findCached(rule('r', ['a', 'b', 'c', 'd', 'e', 'f']), cache, 'other')).toBeUndefined();
    expect(findCached(rule('r', ['a', 'b', 'q', 'r', 's']), cache, 'm')).toBeUndefined();
  });
});
