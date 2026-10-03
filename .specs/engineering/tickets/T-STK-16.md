# T-STK-16 Pre-approved TODOs merge when ready (M-39)

Stage S1 · Size M · Depends on T-STK-04, T-GH-09, T-APP-04 (confirmations), T-STK-01 · Unblocks T-REL-02 · Issue: [#3641](https://github.com/smithersai/smithers/issues/3641)
Spec: spec.md §2 rule 6, §3, §6.1, §10.6.2, §15.1.5 · Delta: none (M-39 addition) · Product: mvp.md M-39 (Will, 2026-10-02; product commit c6b76339), M-05, §2 rule 6, Appendix B.4

## Goal
A maintainer pre-approves a TODO once. Its PR merges when the shared MergeReady decision permits it, including after a rebase. PRs remain human-gated by default. Check: C-STK-13.

## Scope
In:
- A TODO pre-approval record with approver member id, via, timestamp and removed_at. It is not revision-bound and survives rebases. Retain removed records and attributed events. Check: C-STK-13.
- `todo.preapprove` and `todo.unapprove`, maintainer-only in-card commands. Accept only session or trusted person credentials. Refuse delegated, agent, run and machine credentials with HTTP 403, class permission, code permission, before any record, confirmation or merge effect. An agent cannot grant approval through a person attribution header. Check: C-STK-13.
- A durable evaluator on checks settled, stack order change, Needs-you cleared, rebase settled and pre-approval added, plus boot recovery. Reuse T-STK-04's DecideMerge, stack lock, TODO locks and reviewed-head checks. Check: C-STK-13.
- Merge through T-GH-09's existing outbound path, attributed to the pre-approving maintainer: `Merged · pre-approved by <name>`. Recheck current approving-member authority before send. Check: C-STK-13.
- Removal committed before the merge request is sent prevents the send. Serialize removal with dispatch on the same locks and durable send boundary. After send, follow §12.4.1b reconciliation; removal cannot recall a sent request. Check: C-STK-13.
- Repository field `new_todos_preapproved`, default false, with owner-only person writes and attributed events. Persist the owner who enabled it and the change timestamp. At TODO creation, atomically read the setting and create a pre-approval attributed to that owner with via `smithers`. Later setting changes affect no existing TODO or pre-approval. Agent-created TODOs inherit the owner's standing decision; the agent grants no approval. Check: C-STK-13.

Out:
- A second merge predicate, lock protocol or outbound queue; agent approval; bypassing required checks, stack order, Needs you or protected-path policy; automatic retry of a definitive GitHub merge refusal.
- Settings presentation (T-APP-03); rewriting frozen tickets.

## Changes
- Add a forward-only PostgreSQL migration for the TODO pre-approval record and repository default, including the default's approving-owner attribution. Keep at most one active pre-approval per TODO and retain removal history. Check: C-STK-13.
- Register both typed commands in the production catalog and dispatcher. Their credential refusal is the explicit permission/permission rule above, including delegated credentials normally refused as never. Emit attributed add/remove events in the mutation transaction. Check: C-STK-13.
- Persist reevaluation work with each relevant fact transaction. Coalesce duplicate facts and replay unfinished evaluation at boot. Recover existing outbound merge rows before creating new intents. Check: C-STK-13.
- Feed the current accepted PR head into DecideMerge. Bind each outbound intent to that head and the active pre-approval record; preserve the TODO approval across head changes but supersede an unsent stale intent. Under the shared fence, recheck current head, active pre-approval and approving-member authority immediately before send. Only that operation's own verified fence is excluded from the readiness decision. Check: C-STK-13.
- Consume T-GH-09's target serialization, uncertainty lookup and completion-on-main rules. Duplicate evaluations create one merge intent; uncertain requests reconcile before any repeat. Keep a definitive refusal as a visible receipt rather than blindly retrying it. Check: C-STK-13.

## Tests
Production routes and catalog dispatcher, real PostgreSQL, fake GitHub; independent literal fixtures and a controllable send barrier. C-STK-13 covers every case:
- Maintainer preapprove, then green checks: exactly one squash merge at the current head, attributed receipt.
- Delegated/agent/run/machine refusal: literal 403 permission/permission, no pre-approval record or effects. Member person also cannot approve.
- Remove before send: no merge request. Remove after send: reconcile without a blind second request.
- Rebase after approval: approval survives; old-head green does not permit merge; new-head green does.
- Two pre-approved TODOs: strictly stack order; the second waits for fold, rebase and green checks on its new head.
- Boot with a ready pre-approved TODO: one merge across duplicate recovery and fact delivery.
- Open Needs you: no merge until cleared and reevaluated.
- Default off; owner enables it; only later TODOs inherit the owner's approval. Disable affects only future TODOs. Non-owner and agent writes fail without changes or attributed success events.
- Pending/failed required checks and protected-path refusal cannot be bypassed. Current authority loss before dispatch prevents send.

## Acceptance
- [C-STK-13](../checks/C-STK-13.md): all cases pass at the production boundary.

## Risks and notes
- Pre-approval is durable person authority, not a revision-bound Review & merge approval. Never fabricate a session for the evaluator. Existing fences and outbound reconciliation remain authoritative.
- Settings stays default off for ordinary repositories. Smithers' own install enables it through its owner during dogfood setup (M-39).
