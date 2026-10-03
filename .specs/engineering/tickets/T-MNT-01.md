# T-MNT-01 Gate maintainer admission and expose passive incoming items

Stage M · Size S · Depends on T-CAT-01, T-CUT-03, T-ACC-05, T-STK-09, T-GH-02, T-GH-09, T-APP-01, T-APP-19 · Unblocks T-MNT-02, T-MNT-04 · Issue: [#3593](https://github.com/smithersai/smithers/issues/3593)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings

## Goal

New outsider issues and PRs appear under Incoming. They start no work until an owner or maintainer requests it.

## Scope

In:
- Reuse hidden event admission, dispatch and the GitHub synced store. Incoming is a Home filter over issue/PR identities, not a second queue of TODOs.
- Stage-M catalog entries for issue triage and outside-PR review have minimum role maintainer; delegated requests require the requesting maintainer's own session confirmation.
- Pin subject text digest, issue context or PR base/head, requester, action and flow version at admission. Recheck live role and subject revision when confirming. Reject changed input before admission.
- Launch binaries keep these surfaces hidden and deny direct calls. Stage M enables only this reviewed catalog extension, not every retained action.

Out:
- Automatic launches from outsider events, new trigger infrastructure, dispatcher screen, issue-sweep, or changing the launch Make TODO rule.

## Changes

- Extend the shared catalog and authorizer, retained admission adapter and Home projection. Persist idempotent manual requests in the existing durable request/job store.
- Deduplicate by subject revision plus action and accepted request identity; duplicate delivery cannot manufacture a new permission. Explicit Retry retains attempt history.
- Add Incoming view props and container through the T-APP-19 seam. Show requested, queued, working, waiting, failed and done from real receipts.
- Document the M catalog extension and hidden launch behavior. Product agent approves command names and 06 approves the card controls before implementation (C-MNT-01).

## Tests

- Unit: permission matrix and revision digest boundaries.
- Integration: C-MNT-01 through real catalog dispatch, poll consumption and durable admission; exercise browser-session and delegated CLI/API requests.
- E2E security: C-MNT-06. No launch gate moves to M.

## Acceptance

- [C-MNT-01](../checks/C-MNT-01.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows and containers, smithers-3f Go services and infrastructure, smithers-38 package contracts and runtime composition. Each signs off the touched boundary before implementation; an untouched boundary is recorded as such.

## Risks and notes

Who decides: Will owns release scope; smithers-8a owns admission mechanics; an owner or maintainer decides each outsider admission. No model decides trust. Passive sync is not a run. Checks C-MNT-01 and C-MNT-06 prove this boundary.
