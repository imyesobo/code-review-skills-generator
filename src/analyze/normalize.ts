import type { ReviewComment } from '../types.js';

const NOISE =
  /^(lgtm|looks good( to me)?|nice( work| one| catch)?|great( work)?|thanks?( you)?|thx|done|fixed|resolved|addressed|ok(ay)?|\+1|ship ?it|approved?|same( here)?|agreed?|good catch|why\??|\?+)[\s.!:)]*$/i;

const SYSTEM_NOISE = /unable to review this pull request|reviewed \d+ out of \d+ changed files|pull request overview|generated (no|\d+) comments?/i;

/** Signals that a comment asks for a change or states a practice (vs. praise / status). */
const ACTIONABLE =
  /\b(should|shouldn't|must|please|consider|avoid|prefer|instead|don't|do not|never|always|need(s|ed)? to|missing|why not|can we|could (we|you)|would (be|it)|let's|rename|remove|move|extract|replace|add|use|make sure|ensure|nit|typo|wrong|incorrect|bug|leak|unused|duplicate[sd]?|redundant|unnecessary|hard ?code[sd]?|magic|risky|unsafe|breaks?|fails?)\b|\?/i;

/** Strip markdown noise that carries no reusable guidance. */
export function cleanBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```suggestion[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(requirement|changes recommended|needs a closer look|suggestion|issue|problem)\s*:\s*/gim, '')
    .replace(/(^|\s)@[\w.-]+/g, ' ')
    .replace(/^\s*(nit|nitpick|minor|optional|suggestion|question)\s*[:-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^((well done|nice( work| catch| one)?|great( work| job| catch)?|good catch|thanks?( you)?( for [^.!]*)?|lgtm|looks good( to me)?)[.!,]+\s*)+/i, '')
    .trim();
}

export interface NormalizeOptions {
  includeBots: boolean;
  minLength: number;
}

export interface CleanComment extends ReviewComment {
  text: string;
}

export function normalize(comments: ReviewComment[], opts: NormalizeOptions): CleanComment[] {
  const seen = new Set<string>();
  const out: CleanComment[] = [];
  for (const c of comments) {
    if (!opts.includeBots && c.authorIsBot) continue;
    if (c.author && c.author.toLowerCase() === c.prAuthor.toLowerCase()) continue;
    const text = cleanBody(c.body);
    if (text.length < opts.minLength || NOISE.test(text) || SYSTEM_NOISE.test(text) || !ACTIONABLE.test(text)) continue;
    const dedupeKey = `${c.repo}#${c.pr}:${text.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ ...c, text });
  }
  return out;
}
