# code-review-skills-generator (`crsg`)

Turns recurring pull request review feedback into files for AI coding agents:

| Output | When |
| --- | --- |
| `.github/instructions/<glob>.instructions.md` (`applyTo` frontmatter) | rule's comments concentrate on a path/extension |
| `.github/skills/<category>-review/SKILL.md` | ≥ 2 repo-wide rules in the same category (testing, security, …) |
| `AGENTS.md` (managed section between markers, rest of file preserved) | everything else |

## Sources

Mix GitHub and Azure DevOps freely:

```sh
crsg run github:my-org ado:contoso/Web octo/app https://dev.azure.com/contoso/Api/_git/svc
```

- `owner/repo`, `github:owner/repo`, `github:owner` (all repos of a user **or** org)
- `ado:org/project/repo`, `ado:org/project`, `ado:org` (all repos in project / organization)

## Auth

- **GitHub**: `GITHUB_TOKEN`/`GH_TOKEN`, else `gh auth token`.
- **Azure DevOps**: `AZURE_DEVOPS_TOKEN`, else `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6aa798d` (after `az login`), else `AZURE_DEVOPS_EXT_PAT`. Use `--ado-tenant <tenant>` if the org lives in a non-default Entra tenant.

## Incremental runs

Re-running only processes what's new. State lives in `--state-dir` (default `.crsg/`, gitignored here; commit it, or point it at a cache directory in CI, to share progress):

| File | Purpose |
| --- | --- |
| `state.json` | per-repo cursor = newest PR activity seen; next fetch starts there (minus 1h overlap) instead of `--since` |
| `dataset.json` | all comments, **upserted by stable comment id** (GitHub node id / ADO `org/project/repo#pr/thread/comment`), so re-seen reviews never duplicate and edits replace the old text |
| `rules.json` | previous rules; new clusters inherit the id of the previous rule they overlap most with, so ids stay stable as rules gain comments |
| `llm-cache.json` | LLM wording keyed by the rule's comment ids; reused while ≥ 80% of the comments are unchanged, and also applied on runs without `--llm` |

Each run prints a **"New since last run"** summary (new comments per repo; new/updated/removed rules). Generated `*.instructions.md`/`SKILL.md` files that are no longer produced are deleted; hand-written files are never touched. Use `--full` to ignore state and rebuild.

Azure DevOps PRs have no "last updated" field, so incremental runs also re-scan all **active** PRs.

## Pipeline

```sh
crsg fetch <sources...> --since 180d --max-prs 200   # -> .crsg/dataset.json
crsg analyze [--per-repo] [--llm]                     # -> .crsg/rules.json
crsg generate --out . [--targets agents,instructions,skills] [--dry-run]
```

**Analysis is deterministic by default (no AI credits):** drops bots, PR authors' own replies, approvals/praise and non-actionable comments, then clusters comments with TF‑IDF + cosine similarity. It infers an `applyTo` glob from the commented paths and assigns a category from a keyword lexicon. Rules need `--min-support` comments across `--min-prs` PRs. Confidence combines how often a rule appears, how many PRs it spans and how many reviewers raised it.

`--llm` sends the top `--llm-max-rules` uncached clusters to an OpenAI-compatible endpoint in **one** request. By default that's a **local Ollama** server (`$OLLAMA_HOST`, model `gemma4:12b`), so it uses no AI credits. Use `--llm-endpoint` / `--llm-model` / `LLM_API_KEY` for any other provider. (GitHub Models was retired in July 2026.) The LLM rewrites rule titles and wording and drops clusters that don't generalize. If the call fails, the heuristic output is kept.

Tune with `--threshold` (similarity, default 0.3), `--include-bots` (e.g. to learn from Copilot reviews), `--min-confidence`.

## Develop

```sh
npm install && npm run build && npm test
node dist/cli.js --help
```
