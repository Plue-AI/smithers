# C-MNT-01 Passive events require maintainer admission

Proves: mvp.md §14, M-05, M-26, M-29 · spec.md §6.1.2b, §10.2.1, §12.4, §16.4, §17.3, §17.5 · Layer: integration · Stage: M · Tickets: T-MNT-01
Automation: packages/backend/internal/services/maintainer_admission_db_test.go (new) · Runs in: real PostgreSQL, catalog dispatch and durable flow runtime; local GitHub protocol server for repeatable delivery and fault injection

## Setup

Launch and M catalogs; owner, maintainer, Member, outsider with GitHub write access but no roster entry, suspended member and another App. Persisted synced issue and PR revisions. Counters for jobs, proposals, run credentials, machine requests and TODOs.

## Steps

1. Deliver outsider issue-open/edit/comment/mention/label and PR-open/push/review events, twice and across a host restart.
2. Query launch palette, help, agent tools, CLI and direct API; query M Incoming and catalog.
3. Request triage/review as each credential and role, including delegated agents. Change role or subject revision between request and confirmation.
4. Confirm one fresh request as its requesting maintainer; duplicate the request and delivery after restart.
5. Exercise Make TODO and todo-label doors for team and outsider text with the C-SEC-03 matrix.

## Pass when

- Step 1 adds only synced input/activity and cursor receipts; zero new jobs, proposals, run credentials, machine requests or TODOs. Non-member todo labels are reverted once.
- Launch surfaces hide M commands and direct calls refuse them. M Incoming lists the original identities without launching work.
- Only owner/maintainer sessions or their own confirmed delegated requests admit work; wrong confirmer, suspended actor or stale subject admits zero.
- Step 4 creates exactly one durable run request with pinned subject/action/actor/version; 202 is requested, not completion.
- Step 5 preserves §10.2.1 and C-SEC-03, including refusal before a Member's outsider draft and exact label snapshots.

## Fail when

- Any event bypasses manual admission, any Member admits outsider work, or catalog hiding alone is treated as authorization.

## Evidence

`.artifacts/checks/C-MNT-01/<UTC>/`: exact commit and install versions, detected host profile when machines run, per-step requests and receipts, database counter deltas, recorded inputs and output digests, logs and browser recordings where applicable. Redact credentials; retain denial and recovery receipts. An unexecuted check is pending.
