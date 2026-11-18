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

## Pipeline

```sh
crsg fetch <sources...> --since 180d --max-prs 200   # -> .crsg/dataset.json
crsg analyze [--per-repo] [--llm]                     # -> .crsg/rules.json
crsg generate --out . [--targets agents,instructions,skills] [--dry-run]
```

**Analysis is deterministic by default (no AI credits):** drops bots, PR authors' own replies, approvals/praise and non-actionable comments, then clusters comments with TF‑IDF + cosine similarity. It infers an `applyTo` glob from the commented paths and assigns a category from a keyword lexicon. Rules need `--min-support` comments across `--min-prs` PRs. Confidence combines how often a rule appears, how many PRs it spans and how many reviewers raised it.

`--llm` sends the top `--llm-max-rules` clusters to an OpenAI-compatible endpoint in **one** request. By default that's GitHub Models with your GitHub token; use `LLM_API_KEY` / `--llm-endpoint` / `--llm-model` to override. The LLM rewrites rule titles and wording and drops clusters that don't generalize. If the call fails, the heuristic output is kept.

Tune with `--threshold` (similarity, default 0.3), `--include-bots` (e.g. to learn from Copilot reviews), `--min-confidence`.

## Develop

```sh
npm install && npm run build && npm test
node dist/cli.js --help
```
