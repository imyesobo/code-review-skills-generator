import type { Rule } from '../types.js';
import { findCached, type LlmCacheEntry } from '../state.js';
import { requestJson } from '../sources/http.js';

export interface LlmOptions {
  endpoint: string;
  model: string;
  maxRules: number;
  apiKey?: string;
}

const OLLAMA = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, '');

/** Defaults to a local Ollama server (no AI credits). Any OpenAI-compatible endpoint works. */
export const DEFAULT_LLM: LlmOptions = {
  endpoint: `${/^https?:\/\//.test(OLLAMA) ? OLLAMA : `http://${OLLAMA}`}/v1/chat/completions`,
  model: 'gemma4:12b',
  maxRules: 40,
};

const SYSTEM = `You turn clusters of recurring code review comments into concise, durable guidance for AI coding agents.
For each cluster return:
- "title": <= 8 words, no trailing period.
- "rule": one or two imperative sentences (<= 45 words) stating the general practice. Do not mention specific PRs, people or one-off variable names.
- "drop": true if the cluster is not a generalizable practice (chit-chat, one-off question, project status).
Respond with JSON only: {"rules":[{"id":"...","title":"...","rule":"...","drop":false}]}`;

function apply(r: Rule, p: { title?: string; rule?: string; drop?: boolean }): Rule[] {
  if (p.drop) return [];
  return [{ ...r, title: p.title?.trim() || r.title, rule: p.rule?.trim() || r.rule, refinedBy: 'llm' }];
}

/** Apply previously cached LLM wording without calling any model. */
export function applyCachedOnly(rules: Rule[], cache: LlmCacheEntry[]): Rule[] {
  return rules.flatMap((r) => {
    const hit = findCached(r, cache);
    return hit ? apply(r, hit) : [r];
  });
}

/**
 * Refine the top rules with ONE chat-completions request (OpenAI-compatible API).
 * Rules whose comments mostly match a cached refinement reuse it and are not sent.
 * Rules not returned, or on any failure, keep their deterministic wording.
 * New refinements are appended to `cache` (mutated).
 */
export async function refineWithLlm(rules: Rule[], opts: LlmOptions, log: (m: string) => void, cache: LlmCacheEntry[] = []): Promise<Rule[]> {
  const top = new Set(rules.slice(0, opts.maxRules));
  const cached = new Map<Rule, LlmCacheEntry>();
  for (const r of top) {
    const hit = findCached(r, cache, opts.model);
    if (hit) cached.set(r, hit);
  }
  const batch = [...top].filter((r) => !cached.has(r));
  const finish = (byId: Map<string, Refined>) =>
    rules.flatMap((r) => {
      const c = cached.get(r);
      if (c) return apply(r, c);
      const p = byId.get(r.id);
      return p ? apply(r, p) : [r];
    });
  if (cached.size) log(`LLM cache: reused ${cached.size} rule(s)`);
  if (batch.length === 0) return finish(new Map());
  const apiKey = opts.apiKey ?? process.env.LLM_API_KEY ?? 'none';

  const payload = batch.map((r) => ({
    id: r.id,
    category: r.category,
    applyTo: r.applyTo,
    keywords: r.keywords,
    samples: r.examples.map((e) => e.body),
  }));

  try {
    const { data } = await requestJson<{ choices: { message: { content: string } }[] }>(opts.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify({ clusters: payload }) },
        ],
      }),
    });
    const parsed = parseJson(data.choices[0]?.message?.content ?? '');
    const byId = new Map(parsed.map((p) => [p.id, p]));
    log(`LLM refined ${byId.size}/${batch.length} rules with ${opts.model}`);
    for (const r of batch) {
      const p = byId.get(r.id);
      if (p) cache.push({ members: r.members ?? [], title: p.title?.trim() || r.title, rule: p.rule?.trim() || r.rule, drop: !!p.drop, model: opts.model });
    }
    return finish(byId);
  } catch (err) {
    log(`LLM refinement skipped: ${(err as Error).message}`);
    return finish(new Map());
  }
}

interface Refined { id: string; title?: string; rule?: string; drop?: boolean }

export function parseJson(raw: string): Refined[] {
  const content = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) return [];
  try {
    const obj = JSON.parse(content.slice(start, end + 1)) as { rules?: Refined[] };
    return Array.isArray(obj.rules) ? obj.rules.filter((r) => typeof r?.id === 'string') : [];
  } catch {
    return [];
  }
}
