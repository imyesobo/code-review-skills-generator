---
name: code-review-skills-generator
description: Generate or refresh AGENTS.md, path-scoped *.instructions.md and SKILL.md files for AI agents from recurring pull request review comments in GitHub repos/orgs and Azure DevOps projects/orgs. Use when the user asks to learn conventions from PR reviews, turn review feedback into agent instructions or skills, or update those files with new reviews.
license: MIT
argument-hint: "sources, e.g. github:my-org ado:contoso/Web, and the target repo directory"
metadata:
  phase: improve
---

# Code review skills generator

All the work is done by the deterministic `crsg` CLI. Do not fetch, cluster or summarize review comments yourself.

## Prerequisites

- `crsg` on PATH (`npm install && npm run build && npm link` in the code-review-skills-generator repo). If it's missing, use `node <repo>/dist/cli.js`.
- GitHub: `gh auth login`. Azure DevOps: `az login` (add `--ado-tenant <tenant>` if the org is in another Entra tenant).

## Sources

`github:owner/repo`, `github:owner` (every repo of a user/org), `ado:org/project/repo`, `ado:org/project`, `ado:org`, or GitHub / dev.azure.com URLs. Several can be mixed in one command.

## Steps

1. Run once and read only the JSON on stdout:

   ```sh
   crsg run <sources...> --out <target-repo> --state-dir <target-repo>/.crsg --json
   ```

   Add `--dry-run` if the user wants a preview first. Add `--per-repo` when sources span several unrelated repos and the user wants separate files per repo.

2. If `ok` is false, apply the fix from the table below and retry once. Then stop and report. Also check `warnings`: they list repos that failed to fetch and skipped LLM calls.

3. If `comments.new` is 0 and every `rules.*.added/updated/removed` list is empty, tell the user nothing changed and stop.

4. Otherwise report: new comments per repo, the added/updated/removed rule titles, and `files.written` / `files.removed`.

5. Only if the user asks for better wording, re-run with `--llm` (local Ollama, no AI credits; cached per rule). Do not hand-edit generated files: the next run overwrites them. Tune instead with `--min-support`, `--min-prs`, `--min-confidence`, `--threshold` or `--targets`.

Later runs are incremental. State in `--state-dir` remembers per-repo cursors and the comments already seen. Use `--full` only if the user asks for a rebuild.

## Errors

| `error` contains | Fix |
| --- | --- |
| `No GitHub token` | ask the user to run `gh auth login` |
| `No Azure DevOps credentials` / `AADSTS` / `timed out` | ask the user to run `az login`; for another tenant, add `--ado-tenant` |
| `-> 401` / `-> 403` | the account can't read that repo/org: confirm the source with the user |
| `Ambiguous source` | prefix it with `github:` or `ado:` |
| `LLM refinement skipped` (in `warnings`) | Ollama isn't running: start it, or drop `--llm` (heuristic wording is still produced) |
