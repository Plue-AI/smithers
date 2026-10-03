# T-COL-12 The coding agent sees outside changes

Stage S2 · Size S · Depends on T-COL-04, T-STK-06 · Unblocks T-REL-02 · Issue: [#3632](https://github.com/smithersai/smithers/issues/3632)
Spec: spec.md §9.3.9, §10.7.3 · Delta: delta.md §4 · Product: mvp.md §6.8 External changes, J3.4
Ready: 2026-10-03 smithers-8a sha256:ad85e392a463

## Goal

Before its next tool call, the coding agent sees who changed which files and re-reads them.

## Scope

In:
- Outside-change notes for the active coding run on the changed branch, coalesced within one turn by actor and file. Preserve participant attribution (M-34).
- Lands dark until T-COL-04: without authenticated, committed watcher facts, admit no note and do not infer attribution from commands.
- Lands dark until T-STK-06: without durable delivery to the pinned run, refuse activation of outside-change delivery; never fall back to a transient queue or another run.
- Lands dark until T-COL-10 (S2): keep this feature disabled until the production agent tools refuse stale writes through the daemon. This is an activation precondition, not a code or schema dependency. C-J3-03 proves joint activation.
- Repository code and the coding tools execute only as the coding participant's unprivileged user inside the branch machine (M-29, spec.md §1.3). smithers-3f reviews this boundary; host event handling treats actor and paths as data, never executable instructions. C-J3-03 tests this through the production run.

Out:
- Digest checks and read-ledger enforcement (T-COL-10), watcher attribution and bursts (T-COL-04), app-agent notes, UI views, new public commands or APIs, and ADR changes.
- New queues, journals, signal protocols, root steps, guest provisioning or root-helper changes. This ticket consumes existing delivery and machine boundaries; it adds no privileged execution.

## Changes

- Reshape `packages/backend/internal/machined/events.go` (planned by T-COL-04; absent today): use its committed burst identity, branch and actor to admit `outside_change{actor, files[]}` through T-STK-06's transactional signal seam, then let the existing worker deliver after commit. Reuse `packages/backend/flowdispatch/service.go:94` (`Signal`) and T-STK-06's `SignalInTx` contract. No active run queues nothing; the run's own coding participant sends no note. A different agent participant still sends a note.
- Reuse `packages/smithers/agent/harness/src/Steering.ts:355` (`Source`) and `packages/smithers/agent/harness/src/Notifications.ts:146` (`make`). Reshape the existing delivery adapter to coalesce by actor and file and insert a system note at the existing boundary before the next tool call, never mid-turn. Preserve boundary replay and burst-id deduplication. The note is not a Steer activity entry; the burst records the change. Paths and actor labels are quoted untrusted data, not instructions or authority.
- Update `packages/smithers/agent/std/docs/reference/flows.md` to describe re-reading changed files; use its existing docs gates. Do not duplicate T-COL-10's tool implementation.
- New production implementation: none beyond reshaping these seams. Extend their existing queues and journal records.

## Tests

- Unit: two committed bursts in one turn produce one insertion retaining both literal actors and all unique paths; repeat a burst id and replay the boundary without another insertion. Test ambiguous outside attribution and a different agent participant separately from the run's own participant.
- Integration: `packages/backend/internal/machined/notes_integration_test.go` (new test), real PostgreSQL and the pinned coding host in a real machine. Drive an SSH edit through authenticated daemon ingestion, the production dispatcher worker and the real `coding/edit-atom` tool bindings; do not call `Steering.Source.drain` or inject a transcript directly. Hold a model turn during the edit: no insertion mid-turn; the committed note precedes the next tool dispatch. The next write follows a fresh read or returns `stale_read` without changing bytes.
- Same suite: duplicate event, crash after commit and lost delivery acknowledgement yield one note; own-participant edits and no-active-run edits yield none; another branch's run receives none. Missing ingest, durable delivery or stale-write enforcement keeps the feature dark. An open question remains open.
- Security case in the same suite: actor labels and filenames containing instruction canaries remain quoted data; no command, privilege change or cross-branch delivery occurs. Observe the coding tool's non-root UID in its branch machine. This ticket introduces no root step; do not exercise a host-process substitute.
- Use fixed actor ids, paths, fixture bytes and expected note text. Expectations never come from spec files or production formatting/digest helpers at runtime.

## Acceptance

- [C-J3-03](../checks/C-J3-03.md): `apps/app/e2e/real/branch-outside-change.spec.ts` (planned automation), real SSH edit and production coding run on the reference host. Step 6's trace proves the note precedes the next tool call and a fresh read precedes writing, or `stale_read` refuses the stale attempt. The integration suite above proves replay, dark activation and isolation at the dispatcher/tool boundary.

## Risks and notes

- Attribute notes from committed watcher facts, not terminal-command heuristics.
- smithers-3f decides the transaction, deduplication, branch/run selection and security seam. smithers-38 decides the library adapter, coalescing and boundary replay contract. smithers-b8 approves the tool reference wording. Contract disagreements go to smithers-8a before implementation; no public API or ADR change is authorized here.

## Ready checklist

1. Dependencies: T-COL-04 supplies committed burst facts; T-STK-06 supplies the called signal seam. Scope names fail-closed activation for both and T-COL-10's S2 stale-write enforcement. All dependencies are S1 or S2; unlanded contracts do not block Ready.
2. Exclusions: Scope names digest enforcement, attribution, app-agent notes, UI, public APIs, ADRs, duplicate queues/protocols and root/provisioning changes.
3. Tests: C-J3-03 uses real SSH and the production run; the named integration suite drives daemon ingestion, dispatcher delivery and coding tool bindings with fixed expectations, including replay and failure cases.
4. Decisions: smithers-3f owns backend/security semantics, smithers-38 owns the library adapter, smithers-b8 owns tool docs, and smithers-8a resolves contract disagreements.
5. Owner review (post hoc under Will's 2026-10-03 directive): smithers-3f: Does signal admission commit with the burst and recover once after a crash? Does selection isolate branch/run and suppress only the run's own participant? smithers-38: Does the existing Source insert before the next tool dispatch and replay the same boundary? Does coalescing retain distinct participants and quote untrusted labels/paths? smithers-b8: Does the tool reference require a fresh read without adding a command or API? These are the required pre-review questions; recorded owner answers stand. No UI view changes require smithers-06.
6. Security: Scope requires repository execution only as an unprivileged machine user; smithers-3f reviews it. No root step or root input is introduced or changed. Root provisioning and helper work remain excluded; T-COL-10's qualified S2 tool boundary must be available before activation. The production integration case observes UID, untrusted-data handling and branch isolation.
