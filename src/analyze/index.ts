import { createHash } from 'node:crypto';
import type { Dataset, Rule } from '../types.js';
import { CATEGORY_LABELS, categorize } from './categories.js';
import { centroidOf, cluster, medoid, tfidf, topTerms } from './cluster.js';
import { normalize, type CleanComment } from './normalize.js';
import { inferApplyTo } from './scope.js';
import { tokenize } from './tokenize.js';

export interface AnalyzeOptions {
  threshold: number;
  minSupport: number;
  minPrs: number;
  minLength: number;
  includeBots: boolean;
  maxExamples: number;
}

export const DEFAULT_ANALYZE: AnalyzeOptions = {
  threshold: 0.3,
  minSupport: 3,
  minPrs: 2,
  minLength: 20,
  includeBots: false,
  maxExamples: 3,
};

export function analyze(dataset: Pick<Dataset, 'comments'>, opts: AnalyzeOptions = DEFAULT_ANALYZE): Rule[] {
  const comments = normalize(dataset.comments, opts);
  const tokens = comments.map((c) => tokenize(c.text));
  const { vectors } = tfidf(tokens);
  const clusters = cluster(vectors, opts.threshold);

  const rules: Rule[] = [];
  for (const idx of clusters) {
    const members = idx.map((i) => comments[i]);
    const prs = new Set(members.map((c) => `${c.repo}#${c.pr}`));
    const reviewers = new Set(members.map((c) => c.author.toLowerCase()));
    if (members.length < opts.minSupport || prs.size < opts.minPrs) continue;

    const vecs = idx.map((i) => vectors[i]);
    const keywords = topTerms(centroidOf(vecs), 5);
    const category = categorize(idx.map((i) => tokens[i]));
    const center = members[medoid(vecs)];
    const repos = [...new Set(members.map((c) => c.repo))].sort();

    rules.push({
      id: createHash('sha1').update(members.map((m) => m.id).sort().join('|')).digest('hex').slice(0, 10),
      title: `${CATEGORY_LABELS[category]}: ${keywords.slice(0, 3).join(', ')}`,
      rule: summarize(center.text),
      category,
      applyTo: inferApplyTo(members.map((c) => c.path)),
      keywords,
      support: members.length,
      prs: prs.size,
      reviewers: reviewers.size,
      repos,
      confidence: confidence(members.length, prs.size, reviewers.size),
      refinedBy: 'heuristic',
      examples: pickExamples(members, center, opts.maxExamples),
    });
  }
  return rules.sort((a, b) => b.confidence - a.confidence || b.support - a.support);
}

export function confidence(support: number, prs: number, reviewers: number): number {
  const volume = Math.min(1, Math.log2(1 + support) / Math.log2(21));
  const spread = Math.min(1, prs / 5);
  const diversity = Math.min(1, reviewers / 3);
  return Math.round((0.5 * volume + 0.3 * spread + 0.2 * diversity) * 100) / 100;
}

/** First one or two sentences, capped, as an imperative-ish guideline. */
export function summarize(text: string, max = 240): string {
  const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [text];
  let out = sentences[0].trim();
  if (out.length < 60 && sentences[1]) out = `${out} ${sentences[1].trim()}`;
  if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function pickExamples(members: CleanComment[], center: CleanComment, n: number) {
  const ordered = [center, ...members.filter((m) => m !== center)];
  const seenPr = new Set<string>();
  const out = [];
  for (const m of ordered) {
    const key = `${m.repo}#${m.pr}`;
    if (seenPr.has(key)) continue;
    seenPr.add(key);
    out.push({ body: summarize(m.text, 300), url: m.url ?? m.prUrl, path: m.path, repo: m.repo });
    if (out.length >= n) break;
  }
  return out;
}
