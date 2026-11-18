import type { SourceProvider } from '../types.js';
import { AdoProvider } from './ado.js';
import { GitHubProvider } from './github.js';
import { parseSource } from './spec.js';

export function providerFor(source: string): SourceProvider {
  const spec = parseSource(source);
  return spec.provider === 'github'
    ? new GitHubProvider(spec.owner, spec.repo)
    : new AdoProvider(spec.org, spec.project, spec.repo);
}

/** Key format "ado:org/project/repo" -> provider capable of fetching it. */
export function providerForRepoKey(key: string): SourceProvider {
  return providerFor(key);
}
