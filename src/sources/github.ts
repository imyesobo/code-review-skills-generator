import type { FetchOptions, ReviewComment, SourceProvider } from '../types.js';
import { requestJson, runCli } from './http.js';

const API = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');

export function resolveGitHubToken(): string {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  try {
    return runCli('gh', ['auth', 'token']);
  } catch {
    throw new Error('No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.');
  }
}

interface Author { login: string; __typename: string }
interface PrNode {
  number: number;
  url: string;
  updatedAt: string;
  author: Author | null;
  reviewThreads: { nodes: { path: string; comments: { nodes: CommentNode[] } }[] };
  reviews: { nodes: (CommentNode & { state: string })[] };
}
interface CommentNode { id: string; body: string; url: string; createdAt: string; author: Author | null }

const PR_QUERY = `
query($owner: String!, $name: String!, $cursor: String, $pageSize: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $pageSize, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url updatedAt
        author { login __typename }
        reviewThreads(first: 50) {
          nodes { path comments(first: 20) { nodes { id body url createdAt author { login __typename } } } }
        }
        reviews(first: 30) { nodes { id body url createdAt state author { login __typename } } }
      }
    }
  }
}`;

export class GitHubProvider implements SourceProvider {
  private token?: string;

  constructor(private owner: string, private repo?: string) {}

  private headers() {
    this.token ??= resolveGitHubToken();
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'code-review-skills-generator',
    };
  }

  private async rest<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (url) {
      const { data, headers }: { data: T[]; headers: Headers } = await requestJson<T[]>(url, { headers: this.headers() });
      items.push(...data);
      url = headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return items;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { data } = await requestJson<{ data: T; errors?: { message: string }[] }>(`${API}/graphql`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (data.errors?.length) throw new Error(`GitHub GraphQL: ${data.errors.map((e) => e.message).join('; ')}`);
    return data.data;
  }

  async listRepos(): Promise<string[]> {
    if (this.repo) return [`github:${this.owner}/${this.repo}`];
    const [{ data: owner }, { data: viewer }] = await Promise.all([
      requestJson<{ type: string }>(`${API}/users/${this.owner}`, { headers: this.headers() }),
      requestJson<{ login: string }>(`${API}/user`, { headers: this.headers() }),
    ]);
    const path =
      owner.type === 'Organization'
        ? `/orgs/${this.owner}/repos?type=all`
        : viewer.login.toLowerCase() === this.owner.toLowerCase()
          ? '/user/repos?affiliation=owner'
          : `/users/${this.owner}/repos?type=owner`;
    const repos = await this.rest<{ full_name: string; archived: boolean; fork: boolean; disabled?: boolean }>(path);
    return repos.filter((r) => !r.archived && !r.fork && !r.disabled).map((r) => `github:${r.full_name}`);
  }

  async fetchComments(repoKey: string, opts: FetchOptions): Promise<ReviewComment[]> {
    const [owner, name] = repoKey.replace(/^github:/, '').split('/');
    const out: ReviewComment[] = [];
    let cursor: string | null = null;
    let seen = 0;

    while (seen < opts.maxPrs) {
      type Resp = { repository: { pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PrNode[] } } };
      const data: Resp = await this.graphql<Resp>(PR_QUERY, {
        owner, name, cursor, pageSize: Math.min(25, opts.maxPrs - seen),
      });
      const page = data.repository.pullRequests;
      let reachedSince = false;
      for (const pr of page.nodes) {
        if (opts.since && new Date(pr.updatedAt) < opts.since) { reachedSince = true; break; }
        seen++;
        const base = { provider: 'github' as const, repo: repoKey, pr: pr.number, prUrl: pr.url, prAuthor: pr.author?.login ?? '' };
        for (const t of pr.reviewThreads.nodes) {
          for (const c of t.comments.nodes) out.push(toComment(base, c, 'inline', t.path));
        }
        for (const r of pr.reviews.nodes) if (r.body.trim()) out.push(toComment(base, r, 'review'));
      }
      opts.log(`  ${repoKey}: ${seen} PRs scanned, ${out.length} comments`);
      if (reachedSince || !page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
    return out;
  }
}

function toComment(
  base: Pick<ReviewComment, 'provider' | 'repo' | 'pr' | 'prUrl' | 'prAuthor'>,
  c: CommentNode,
  kind: ReviewComment['kind'],
  path?: string,
): ReviewComment {
  const login = c.author?.login ?? 'ghost';
  return {
    ...base,
    id: `gh:${c.id}`,
    author: login,
    authorIsBot: c.author?.__typename === 'Bot' || login.endsWith('[bot]'),
    body: c.body,
    path,
    url: c.url,
    createdAt: c.createdAt,
    kind,
  };
}
