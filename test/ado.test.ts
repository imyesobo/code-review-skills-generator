import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdoProvider } from '../src/sources/ado.js';

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe('AdoProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AZURE_DEVOPS_TOKEN;
  });

  it('lists repos and maps PR threads to review comments with bearer auth', async () => {
    process.env.AZURE_DEVOPS_TOKEN = 'tok';
    const calls: { url: string; auth: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization });
      if (url.includes('/_apis/git/repositories?')) {
        return json({ value: [{ name: 'api', project: { name: 'Web' } }, { name: 'old', isDisabled: true, project: { name: 'Web' } }] });
      }
      if (url.includes('/pullrequests?')) {
        return json({ value: [{ pullRequestId: 7, status: 'completed', creationDate: '2026-01-01', createdBy: { displayName: 'Dev', uniqueName: 'dev@x.com', id: '1' } }] });
      }
      return json({
        value: [
          { id: 1, threadContext: { filePath: '/src/a.cs' }, comments: [
            { id: 1, content: 'Please avoid hardcoding the timeout', commentType: 'text', publishedDate: 'd', author: { displayName: 'Rev', uniqueName: 'rev@x.com', id: '2' } },
          ] },
          { id: 2, comments: [{ id: 1, content: 'Dev voted 10', commentType: 'system', publishedDate: 'd', author: { displayName: 'Dev', id: '1' } }] },
          { id: 3, comments: [{ id: 1, content: 'Build failed', commentType: 'text', publishedDate: 'd', author: { displayName: 'Project Collection Build Service (contoso)', id: '3' } }] },
        ],
      });
    });

    const p = new AdoProvider('contoso', 'Web');
    expect(await p.listRepos()).toEqual(['ado:contoso/Web/api']);
    const { comments, cursor } = await p.fetchComments('ado:contoso/Web/api', { maxPrs: 10, log: () => {} });

    expect(calls.every((c) => c.auth === 'Bearer tok' && c.url.includes('api-version=7.1'))).toBe(true);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      repo: 'ado:contoso/Web/api', pr: 7, author: 'rev@x.com', prAuthor: 'dev@x.com', path: 'src/a.cs', kind: 'inline', authorIsBot: false,
      url: 'https://dev.azure.com/contoso/Web/_git/api/pullrequest/7?discussionId=1',
    });
    expect(comments[1].authorIsBot).toBe(true);
    expect(cursor).toBe('2026-01-01');
  });
});
