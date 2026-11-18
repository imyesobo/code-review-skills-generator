export type SourceSpec =
  | { provider: 'github'; owner: string; repo?: string }
  | { provider: 'ado'; org: string; project?: string; repo?: string };

/**
 * Parse a source spec. Supported forms:
 *   owner/repo | github:owner/repo | github:owner | https://github.com/owner[/repo]
 *   ado:org | ado:org/project | ado:org/project/repo
 *   https://dev.azure.com/org[/project[/_git/repo]] | https://org.visualstudio.com/project[/_git/repo]
 */
export function parseSource(input: string): SourceSpec {
  const raw = input.trim().replace(/\/+$/, '').replace(/\.git$/, '');

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.hostname === 'github.com') {
      if (!parts[0]) throw new Error(`Invalid GitHub URL: ${input}`);
      return { provider: 'github', owner: parts[0], repo: parts[1] };
    }
    if (url.hostname === 'dev.azure.com') {
      return adoFromParts(parts[0], parts[1], parts[2] === '_git' ? parts[3] : undefined, input);
    }
    const vs = url.hostname.match(/^([^.]+)\.visualstudio\.com$/);
    if (vs) return adoFromParts(vs[1], parts[0], parts[1] === '_git' ? parts[2] : undefined, input);
    throw new Error(`Unsupported source host: ${url.hostname}`);
  }

  const m = raw.match(/^(github|gh|ado|azure|azdo):(.+)$/i);
  const prefix = m?.[1].toLowerCase();
  const parts = (m ? m[2] : raw).split('/').filter(Boolean);

  if (prefix === 'ado' || prefix === 'azure' || prefix === 'azdo') {
    if (parts.length > 3) throw new Error(`Invalid Azure DevOps source: ${input}`);
    return adoFromParts(parts[0], parts[1], parts[2], input);
  }
  if (!prefix && parts.length !== 2) {
    throw new Error(`Ambiguous source "${input}". Use github:owner, github:owner/repo or ado:org[/project[/repo]].`);
  }
  if (parts.length < 1 || parts.length > 2) throw new Error(`Invalid GitHub source: ${input}`);
  return { provider: 'github', owner: parts[0], repo: parts[1] };
}

function adoFromParts(org: string | undefined, project: string | undefined, repo: string | undefined, input: string): SourceSpec {
  if (!org) throw new Error(`Invalid Azure DevOps source: ${input}`);
  return { provider: 'ado', org, project: project || undefined, repo: repo || undefined };
}
