import type { FetchOptions, ReviewComment, SourceProvider } from '../types.js';
import { pMap, requestJson, runCli } from './http.js';

/** Well-known Entra ID resource/application ID for Azure DevOps. */
export const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6aa798d';
const API_VERSION = '7.1';

/**
 * Auth order: AZURE_DEVOPS_TOKEN (Entra bearer token) ->
 * `az account get-access-token --resource <ADO> [--tenant $AZURE_DEVOPS_TENANT]` -> AZURE_DEVOPS_EXT_PAT (PAT, basic auth).
 */
export function resolveAdoAuthHeader(): string {
  if (process.env.AZURE_DEVOPS_TOKEN) return `Bearer ${process.env.AZURE_DEVOPS_TOKEN}`;
  try {
    const tenant = process.env.AZURE_DEVOPS_TENANT;
    const token = runCli('az', [
      'account', 'get-access-token', '--resource', ADO_RESOURCE_ID, '--query', 'accessToken', '-o', 'tsv',
      ...(tenant ? ['--tenant', tenant] : []),
    ]);
    if (token) return `Bearer ${token}`;
  } catch (err) {
    if ((err as { code?: string }).code === 'ETIMEDOUT') {
      throw new Error('`az account get-access-token` timed out. Run `az login` and retry, or set AZURE_DEVOPS_TOKEN.');
    }
  }
  const pat = process.env.AZURE_DEVOPS_EXT_PAT;
  if (pat) return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  throw new Error('No Azure DevOps credentials. Run `az login` (set AZURE_DEVOPS_TENANT if your org lives in another tenant), or set AZURE_DEVOPS_TOKEN (from `az account get-access-token`).');
}

interface Identity { displayName: string; uniqueName?: string; id: string; isContainer?: boolean }
interface AdoPr { pullRequestId: number; status: string; creationDate: string; closedDate?: string; createdBy: Identity }
interface AdoComment { id: number; content?: string; commentType: string; publishedDate: string; isDeleted?: boolean; author: Identity }
interface AdoThread { id: number; isDeleted?: boolean; threadContext?: { filePath?: string } | null; comments: AdoComment[] }

export class AdoProvider implements SourceProvider {
  private auth?: string;

  constructor(private org: string, private project?: string, private repo?: string) {}

  private get base() {
    return `https://dev.azure.com/${encodeURIComponent(this.org)}`;
  }

  private async get<T>(url: string): Promise<T> {
    this.auth ??= resolveAdoAuthHeader();
    const sep = url.includes('?') ? '&' : '?';
    const { data } = await requestJson<T>(`${url}${sep}api-version=${API_VERSION}`, {
      headers: { authorization: this.auth, accept: 'application/json' },
    });
    return data;
  }

  async listRepos(): Promise<string[]> {
    if (this.project && this.repo) return [`ado:${this.org}/${this.project}/${this.repo}`];
    const scope = this.project ? `${this.base}/${encodeURIComponent(this.project)}` : this.base;
    const { value } = await this.get<{ value: { name: string; isDisabled?: boolean; project: { name: string } }[] }>(
      `${scope}/_apis/git/repositories`,
    );
    return value.filter((r) => !r.isDisabled).map((r) => `ado:${this.org}/${r.project.name}/${r.name}`);
  }

  async fetchComments(repoKey: string, opts: FetchOptions): Promise<ReviewComment[]> {
    const [org, project, repo] = repoKey.replace(/^ado:/, '').split('/');
    const repoUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
    const webUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;

    const prs: AdoPr[] = [];
    for (let skip = 0; prs.length < opts.maxPrs; ) {
      const top = Math.min(100, opts.maxPrs - prs.length);
      const { value } = await this.get<{ value: AdoPr[] }>(
        `${repoUrl}/pullrequests?searchCriteria.status=all&$top=${top}&$skip=${skip}`,
      );
      const fresh = opts.since ? value.filter((p) => new Date(p.closedDate ?? p.creationDate) >= opts.since!) : value;
      prs.push(...fresh);
      // Results are ordered newest first; stop once we pass the `since` horizon.
      if (value.length < top || fresh.length < value.length) break;
      skip += value.length;
    }

    const perPr = await pMap(prs, 4, async (pr) => {
      const { value: threads } = await this.get<{ value: AdoThread[] }>(`${repoUrl}/pullRequests/${pr.pullRequestId}/threads`);
      const prUrl = `${webUrl}/pullrequest/${pr.pullRequestId}`;
      const prAuthor = pr.createdBy.uniqueName ?? pr.createdBy.displayName;
      const out: ReviewComment[] = [];
      for (const t of threads) {
        if (t.isDeleted) continue;
        const path = t.threadContext?.filePath?.replace(/^\//, '');
        for (const c of t.comments) {
          if (c.isDeleted || c.commentType !== 'text' || !c.content) continue;
          const author = c.author.uniqueName ?? c.author.displayName;
          out.push({
            id: `ado:${org}/${project}/${repo}#${pr.pullRequestId}/${t.id}/${c.id}`,
            provider: 'ado',
            repo: repoKey,
            pr: pr.pullRequestId,
            prUrl,
            prAuthor,
            author,
            authorIsBot: isAdoBot(c.author),
            body: c.content,
            path,
            url: `${prUrl}?discussionId=${t.id}`,
            createdAt: c.publishedDate,
            kind: path ? 'inline' : 'review',
          });
        }
      }
      return out;
    });

    const comments = perPr.flat();
    opts.log(`  ${repoKey}: ${prs.length} PRs scanned, ${comments.length} comments`);
    return comments;
  }
}

function isAdoBot(id: Identity): boolean {
  const n = `${id.displayName} ${id.uniqueName ?? ''}`;
  return !!id.isContainer || /build service|project collection|\bbot\b|azure pipelines|copilot|sonar|github advanced security/i.test(n);
}
