# factory/

Smithers' own coding factory. Target workflow:

```text
GitHub issue -> mythical stack item -> Smithers Cloud run -> checks/review
  -> GitHub PR -> owner merge -> append-only main -> wiki refresh + issue receipt
```

This is the operating target, not a claim that the Cloud loop is qualified.
Prioritize blockers to completing this loop before adding features. Local
Codex/Claude work is transitional bootstrap or repair; record each blocker in
an issue. GitHub remains synchronized; Cloud owns the coding and CI/CD work.

- `queue/` — legacy intake needing reconciliation with GitHub issues. Files do
  not prove that a job is registered or running. See [queue/README.md](queue/README.md).
- `flows/` — existing local factory tooling, not evidence of Cloud deployment.
  Canonical file flows use `flows/<name>/flow.ts` and the root AGENTS.md contract.
- `wiki/` — the wiki pages and recipe (the page catalog is `.smithers/coding-project.json`); reuse the existing app
  wiki workflows and preserve their source/review receipts.
- `reports/` — runtime reports and logs, not tracked.

Only the stack service writes `mythical`. This repository sends changes upstream:
the owner merges its GitHub PR, with one commit per stack item on append-only
`main`. Remove temporary worktrees after landing. Never rewrite `main` or push
`mythical` by hand.
Close issues and refresh documentation from real completion evidence.

Tracking: [Cloud issue automation](https://github.com/smithersai/smithers/issues/1695),
[wiki refresh](https://github.com/smithersai/smithers/issues/1651), and
[backlog reconciliation](https://github.com/smithersai/smithers/issues/1708).
