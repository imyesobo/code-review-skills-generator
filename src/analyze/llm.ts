import type { Rule } from '../types.js';
import { requestJson } from '../sources/http.js';
import { resolveGitHubToken } from '../sources/github.js';

export interface LlmOptions {
  endpoint: string;
  model: string;
  maxRules: number;
  apiKey?: string;
}

export const DEFAULT_LLM: LlmOptions = {
  endpoint: 'https://models.github.ai/inference/chat/completions',
  model: 'openai/gpt-4.1-mini',
  maxRules: 40,
};

const SYSTEM = `You turn clusters of recurring code review comments into concise, durable guidance for AI coding agents.
For each cluster return:
- "title": <= 8 words, no trailing period.
- "rule": one or two imperative sentences (<= 45 words) stating the general practice. Do not mention specific PRs, people or one-off variable names.
- "drop": true if the cluster is not a generalizable practice (chit-chat, one-off question, project status).
Respond with JSON only: {"rules":[{"id":"...","title":"...","rule":"...","drop":false}]}`;

/**
 * Refine the top rules with ONE chat-completions request (OpenAI-compatible API).
 * Rules not returned, or on any failure, keep their deterministic wording.
 */
export async function refineWithLlm(rules: Rule[], opts: LlmOptions, log: (m: string) => void): Promise<Rule[]> {
  const batch = rules.slice(0, opts.maxRules);
  if (batch.length === 0) return rules;
  const apiKey = opts.apiKey ?? process.env.LLM_API_KEY ?? resolveGitHubToken();

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
    return rules.flatMap((r) => {
      const p = byId.get(r.id);
      if (!p) return [r];
      if (p.drop) return [];
      return [{ ...r, title: p.title?.trim() || r.title, rule: p.rule?.trim() || r.rule, refinedBy: 'llm' as const }];
    });
  } catch (err) {
    log(`LLM refinement skipped: ${(err as Error).message}`);
    return rules;
  }
}

interface Refined { id: string; title?: string; rule?: string; drop?: boolean }

export function parseJson(content: string): Refined[] {
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
