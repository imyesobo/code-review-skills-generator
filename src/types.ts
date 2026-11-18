export type Provider = 'github' | 'ado';

export interface ReviewComment {
  id: string;
  provider: Provider;
  /** Canonical repo key, e.g. "github:owner/repo" or "ado:org/project/repo". */
  repo: string;
  pr: number;
  prUrl: string;
  prAuthor: string;
  author: string;
  authorIsBot: boolean;
  body: string;
  path?: string;
  url?: string;
  createdAt: string;
  kind: 'inline' | 'review';
}

export interface Dataset {
  fetchedAt: string;
  sources: string[];
  repos: string[];
  comments: ReviewComment[];
}

export interface RuleExample {
  body: string;
  url?: string;
  path?: string;
  repo: string;
}

export interface Rule {
  id: string;
  title: string;
  rule: string;
  category: string;
  applyTo?: string;
  keywords: string[];
  support: number;
  prs: number;
  reviewers: number;
  repos: string[];
  confidence: number;
  refinedBy: 'heuristic' | 'llm';
  examples: RuleExample[];
  /** Ids of the comments behind this rule; used to keep ids/LLM wording stable across runs. */
  members?: string[];
}

/** Rules keyed by output scope: "*" for combined, otherwise a repo key. */
export type RuleSet = Record<string, Rule[]>;

export interface FetchOptions {
  since?: Date;
  maxPrs: number;
  log: (msg: string) => void;
}

export interface SourceProvider {
  /** Expand a source spec (e.g. an org) into concrete repo keys. */
  listRepos(): Promise<string[]>;
  /** `cursor` = newest PR activity timestamp seen, used as the next incremental starting point. */
  fetchComments(repoKey: string, opts: FetchOptions): Promise<{ comments: ReviewComment[]; cursor?: string }>;
}
