# Issue selection and worker briefs

`issues.ts` separates pure selection from its Effect observer. Call
`observeIssues({ repo, triagePath, selection })` to read open GitHub issues,
including labels and bodies, with `gh issue list`. `triagePath` defaults to
`~/Smithers-Ops/dispatch/final.json`; a missing file uses default ranks. Invalid
JSON, invalid rows, permission failures and GitHub failures return
`IssueReadError`, rather than an empty queue. Interruption aborts the command.

Triage rows contain `repo`, `n`, `type`, `severity`, `effort`, `needs_will` and
`title`. Short repository names normalize to `smithersai/<name>`. Selection keys
use `owner/repo#number`. `needs_will` is retained as triage data; the live
`blocked-on-will` label controls decisions, matching the dispatcher.

`candidates(repo, issues, rows, options)` orders boosts first, then unblocked
issues, severity, effort and descending issue number. Labels override triage
ranks. It skips claimed, reserved, excluded, epic and human-approval issues,
plus history marked closed or requiring an operator action. Every filtered or cooling open issue still sets `pending: true`. Only a current
`will-only` GitHub label on an unclaimed issue excludes it from completion;
old history and triage classifications cannot prove an open issue completed.
Pass `now`, `last` and `retryAfter` in epoch seconds. Pure selection defaults
`now` to zero; the observer supplies current time. Attempts cool for three hours
each, capped at twenty-four hours.

`SelectionOptions.reserved` replaces the dispatcher's six reserved Smithers
issues; an empty set enables all of them. `taken` is local to the repository and
includes both active leads and extras. Use canonical `exclude` keys for busy
issues across repositories. `skip` and `history` use canonical issue keys. The observer returns
`{ issues, candidates, pending }`; use the bodies in `issues` for bundling.

`selectCandidates({ repos, exclude, triagePath, selection })` composes those
observations as an Effect. It deduplicates repository names, filters canonical
keys in `exclude`, and returns `{ candidates, openIssues, pending }`. Each
candidate has `repo`, `lead`, `extras`, and named `severity` and `effort` ranks.
Issue references include `repo`, `n` and `title`. Each issue is assigned once,
and `openIssues` counts every fetched open issue, including exclusions. The
caller must retain `pending` when deciding whether the burndown is complete.
Its `selection` accepts the per-repository options except `taken`: busy issues
across repositories must use canonical `exclude` keys.

`areas(body)` extracts production source paths. `pick_companions(lead,
candidates, bodies, taken)` chooses at most two unblocked, medium-or-lower,
simple issues sharing a source file with the lead. It orders by overlapping
file count, effort and ascending issue number. Test files, hard work, critical
or high severity, and blocked companions are excluded.

Will's never-bundle rule sets `bundleable: false` on each candidate whose
title or label names security, money (billing, pricing, price, credit,
payment, invoice), merge or landing, an unclear root cause, or cross-package
design (design, architecture, epic). Such an issue is never a companion and
never leads a bundle; it runs alone. Burndown is the only dispatcher that
bundles; `mega-dispatch` and the `Smithers-Ops/dispatch` feeder are retired
for bundling.

`brief({ repo, lead, extras, others, workdir, landing })` produces the worker's
instructions. `landing.claimBy` must match the launcher's claim owner;
`landing.lockPath` can override the dispatch VCS lock path. Workers prepare one
commit per issue, retaining the issue-to-commit mapping, and report
`READY <commit-id>` in issue order. They retain ready claims for the merge queue
and release skipped or failed claims. The queue owns publishing main and
verified issue closure. This module does not implement landing; that belongs
to the merge-queue member.

The package test command (`pnpm --dir flows test`) runs selection and brief
regressions through `test/burndown-selection.test.ts`. Run that entry point
from the repository root:

```sh
node --experimental-strip-types --test flows/test/burndown-selection.test.ts
```

Tests inject the GitHub command at its I/O boundary to avoid network rate limits
and subscription-dependent evidence. File and JSON validation use real files.

The port retains dispatch's 1,000-open-issue limit and label-based exclusion.
An expired claim whose `in-progress` label remains is excluded until the host
reconciles it. Selection does not take over claims; the launcher's claim tool
checks ownership before starting work. Claim ownership includes the launcher
hostname, so workers on another host must have the launcher refresh and release
their claims.
