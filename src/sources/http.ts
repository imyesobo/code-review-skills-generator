import { execFileSync } from 'node:child_process';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch() + JSON with retries on 429/5xx (honours Retry-After). */
export async function requestJson<T>(url: string, init: RequestInit = {}, retries = 4): Promise<{ data: T; headers: Headers }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) {
      const text = await res.text();
      try {
        return { data: JSON.parse(text) as T, headers: res.headers };
      } catch {
        throw new HttpError(res.status, `${init.method ?? 'GET'} ${url} returned non-JSON: ${text.slice(0, 120)}`);
      }
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, `${init.method ?? 'GET'} ${url} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
  }
}

/** Map with bounded concurrency, preserving order. */
export async function pMap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function runCli(cmd: string, args: string[], timeoutMs = 30_000): string {
  return execFileSync(cmd, args, {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  }).trim();
}
