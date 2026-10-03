# T-GH-09 Recover one GitHub operation per item

Stage S1 · Size M · Depends on T-GH-01, T-STK-01, T-GH-02, T-ACC-03, T-STK-12 · Unblocks T-FLW-09, T-FLW-11, T-GH-03, T-GH-06, T-MNT-01, T-MNT-03, T-REL-02, T-STK-04, T-STK-09 · Issue: [#3520](https://github.com/smithersai/smithers/issues/3520)
Spec: spec.md §12.4 · Checks: C-GH-09, C-DUR-03, C-SEC-03

## Goal
Recover proposal, merge and Drop writes without duplicate effects.

## Scope
In: push, open PR, body, merge and close PR from the existing propose/merge/drop paths.
Out: a per-target queue, supersession, mirror/landing writers and check-run creation.

## Changes
- Extend mythical_items.pending_op to {kind, target, desired, precondition, state}. The stack lease permits one operation in flight per item. Keep the current push recovery branch.
- Commit intent and mark it potentially sent before the call. At restart or uncertain response, reconcile that slot before the next operation. Do not overwrite it.
- Push compares the remote head with desired/precondition; open PR looks up the head branch; body compares its digest; merge reads the PR; close uses the canonical App's event then current state. A foreign change refuses a repeat.
- Merge sends only with current maintainer authority, the bound head, checks.Land or checks.Automerge, and the shared readiness decision. An already-merged PR settles without a second send. Missing decision wiring refuses sends.
- Drop waits for an uncertain proposal operation to settle, then closes any created PR. The item's dropped state preserves that obligation across restart.
- Labels, unlabels, comments and issue-close remain best-effort retries. Keep mythicalCommentMarker and require canonical App identity when finding its comment.
- Refuse machine proxy POST/PUT/PATCH/DELETE before token issuance or upstream mutation.

## Tests
- Through production callers with real PostgreSQL and fake GitHub, kill before send, after send and after remote success before settlement for each of the five kinds. Restart: one slot, lookup before repeat, one effective result.
- Hold CreatePull's response, Drop, restart and release it: the PR closes once. A later body waits for the current slot to settle.
- Remote push head differs from desired and precondition: conflict, no overwrite. A person reopens a closed PR after the App's close: recovery does not close it again.
- Lost merge response: settle from GitHub with no second merge. Revoked approver, stale head, missing approval or competing fence: no send.
- A member or another App quoting a comment marker cannot satisfy canonical-App lookup.
- Machine proxy mutations: zero token issuance and upstream calls.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): passes for this ticket’s phase at its stated layer.
- [C-GH-09](../checks/C-GH-09.md): scoped five-kind recovery and authority cases pass.
- [C-DUR-03](../checks/C-DUR-03.md): process-kill recovery passes for those kinds.
- [C-SEC-03](../checks/C-SEC-03.md): machine proxy refuses mutation.
- [C-STK-06](../checks/C-STK-06.md): accepted proposal replay and Drop settle once.

## Risks and notes
An uncertain slot blocks the next item operation until lookup establishes its result. It never authorizes a new merge.
