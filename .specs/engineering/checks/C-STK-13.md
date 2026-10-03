# C-STK-13 Pre-approved TODOs merge only when MergeReady holds

Proves: mvp.md M-39, M-05, §2 rule 6, Appendix B.4 · spec.md §3, §6.1, §10.6.2, §15.1.5 · Layer: integration · Stage: S1 · Tickets: T-STK-16
Automation: `packages/backend/internal/services/todo_preapproval_db_test.go` (new) · Runs in: production install router and catalog dispatcher, real PostgreSQL, fake GitHub

## Setup
Seed an owner, maintainer and Member, distinct session/person and delegated/agent/run/machine credentials, and two TODOs in stack order. Pin current heads, required checks and main containment in independent fixtures. The fake GitHub records requests and holds dispatch or responses at explicit barriers. Use no live GitHub writes.

## Steps
1. As maintainer, preapprove T1 while its required check is pending. Settle it green through production ingestion and deliver the fact twice.
2. Attempt both commands with delegated, agent, run and machine credentials, including a forged person attribution. Attempt preapprove as Member. Inspect rows, events and outbound intents.
3. Hold evaluation before send, remove T1's approval, then release evaluation. In a separate case remove after the fake receives the request and lose its response; restart and reconcile.
4. Preapprove, rebase onto a new main, and settle rebase. Deliver green for the old head while the new head is pending, then green for the new head.
5. Preapprove T1 and T2 with initially green checks. Hold T1's merge response. Complete T1 and fold main; settle T2's rebase and new-head checks.
6. Persist a ready, pre-approved TODO without an outbound intent. Restart twice and redeliver its ready fact. Repeat with a pending and an unknown merge intent.
7. Open Needs you on a pre-approved green TODO; deliver readiness facts, then clear Needs you through its production command.
8. Create a TODO with the default off. As owner enable **New TODOs start pre-approved**; create another TODO through the normal creation path. Disable the setting and create a third. Attempt setting writes as non-owner and agent. Make the inherited approved TODO ready.
9. Keep a required check pending, then failed; provide optional green checks. Exercise a protected-path refusal, then remove approving-member authority before send.

## Pass when
- Step 1: pending blocks; green produces exactly one squash merge request with current sha, one durable completion and `Merged · pre-approved by <name>` after main contains the commit.
- Step 2: disallowed credentials receive 403 permission/permission with no pre-approval, confirmation, fence or outbound intent. Member approval also fails permission. Valid add/remove events name the actual person and via.
- Step 3: removal before send produces zero merge requests and retains removed_at. After send, §12.4.1b lookup settles the result without a blind repeat or fabricated approval.
- Step 4: the approval record survives unchanged; no old-head merge occurs; exactly one merge uses the green new head.
- Step 5: only T1 sends first. T2 sends only after T1 is confirmed on main and T2's rebased current head is green.
- Step 6: boot evaluation merges once; existing intents reconcile through the same outbound path before new dispatch. Duplicate recovery adds no merge.
- Step 7: Needs you blocks all sends; clearing it triggers evaluation and one ready merge.
- Step 8: only the second TODO inherits the enabling owner's attributed approval. Existing approvals remain after disable. Unauthorized writes change no field or event. The inherited TODO merges only when ready.
- Step 9: each blocking fact prevents send; pre-approval bypasses no protected-path, required-check or current-authority rule.

## Fail when
An agent grants approval, removal before send loses, a stale head merges, a later TODO merges first, recovery duplicates a merge, or a default-setting change rewrites existing TODO approvals.

## Evidence
`.artifacts/checks/C-STK-13/<ts>/`: route statuses and envelopes, attributed events and approval history, PostgreSQL intent/fence snapshots, fake GitHub request and lookup log, ordered head/check/fold facts, restart receipts and source revision. Redact credentials.
