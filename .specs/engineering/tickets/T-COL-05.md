# T-COL-05 Moved off the item: detect; Return to Tn; Keep for now

Stage S2 · Size M · Depends on T-COL-04, T-COL-03, T-COL-03a, T-COL-03r, T-STK-01, T-MCH-04, T-COL-10 (S2), T-CAT-01, T-COL-02, T-TRM-07 · Unblocks T-APP-10, T-COL-08, T-REL-02 · Issue: [#3562](https://github.com/smithersai/smithers/issues/3562)
Spec: spec.md §3 (`workspaces`; moved-off branch fact), §4.1 (working → needs_you), §6.1.2 (`in-card`), §9.1.2 (`return_to_item`), §9.3.2–9.3.4, §9.3.8, §9.4.2, §10.8, §14.5.2 · Delta: delta.md §4 (moved-off detection) · Product: mvp.md §6.8 External changes, M-27, M-14

## Goal

A hand-run `git checkout main` or `jj edit` that takes an item branch's working copy off its item shows "Maya moved this branch off T2" as Needs you. The coding agent's write tool refuses while the branch is moved off. **Return to T2** puts the working copy back on its pre-move commit, and **Keep for now** holds the TODO in Needs you until the working copy is back on the item.

## Scope

In:
- Detection (§9.3.8). When a metadata watch fires (`.jj/repo/op_heads/heads/`, `.git/HEAD`, `.git/refs/`, `packed-refs`; §9.3.3) and after every overflow resync (§9.3.2), check two conditions: the item change is still present (by change id), and `@` descends from it (`jj log -r '<item_change>::@'` is non-empty). If either fails, emit `moved_off{by, item}` through the outbox, with `by` attributed like a burst (§9.3.1). The pre-move commit is `@` of the latest operation in `jj op log` whose `@` descends from the item change; it covers git moves and jj moves alike.
- Host: in one transaction, set `branches.moved_off` and open `needs_you{kind: moved_off}` through T-STK-01's wait API. Publish `branch:<id>` and `todo:<n>`. Toasts go to the TODO's owner and the members present on the branch (§10.8.3). The entry's action is Resolve → `/branch Tn` (§14.5.2).
- The agent stops writing: extend T-COL-10's authenticated daemon write boundary to refuse coding-agent mutations with `moved_off` under the mutation lock (§9.3.8). Map that refusal to the existing `StdError.Code`; do not add a root-written state file or a second write protocol. The TODO flow parks in the durable wait. Check: C-J3-09 and `TestMovedOffAgentDispatch`.
- Two in-card controls (§6.1.2 `in-card` catalog rows, registered through T-CAT-01):
  - **Return to Tn** answers the wait (first answer wins, §10.8.2). The daemon's `return_to_item()` (§9.1.2) runs `jj edit` back to the pre-move working-copy commit under the §9.4.2 sequence (lock, sessions frozen, bursts closed, capture, rewrite, documents reconciled, thaw), so no session writes during the move back. Anything written after the move stays in its own commit and is recoverable. The host clears `moved_off`, settles the wait and writes one activity entry attributed to the person who pressed it. The run continues.
  - **Keep for now** records the move. The TODO stays in Needs you, and the write refusal stays, until a later metadata event shows `@` back on the item. Then the host clears `moved_off` and settles the wait.
- Capture (T-COL-03) records the item change's last commit, never `@`, while `moved_off` is set. The stack keeps the item's last captured change throughout.
- Lands dark until T-COL-04, T-COL-03, T-COL-03a, T-COL-03r, T-STK-01, T-MCH-04, T-COL-10 (S2), T-CAT-01, T-COL-02 and T-TRM-07: build against their specified contracts; an absent watcher, branch binding, codec, capture, wait, authorization, publication, agent-write guard or freeze provider refuses activation and Return without a rewrite or resumed coding-agent writes. Do not fall back to host execution or the legacy undo route. `TestMovedOffUnavailableProviders` proves each missing provider refuses.
- Lands dark until T-APP-10, T-APP-02 and T-UI-15 wire the controls: keep the controls unavailable in the app; the backend refusal and wait remain enforced. These are activation preconditions, not code dependencies. Check: C-J3-09.
- Lands dark until the trusted guest root boundary passes T-SEC-01's C-SEC-02 receipts and the broker validation test below: admit no moved-off rewrite through an unvalidated root broker. T-SEC-01 is an activation precondition. Check: `TestMovedOffUnavailableProviders`.

Out:
- Per-entry Undo of ordinary bursts (§9.3.5 [D]).
- Scratch branches, which have no item and so no detection.
- Conflict handling and rebase (T-STK-08); Return reuses the shared freeze sequence and does not implement another rebase engine.
- Branch/TODO Views and Containers (T-UI-15, T-APP-10, T-APP-02), S3 document reconciliation (T-COL-08), exact per-write attribution, command-name activity and replaced-edit flags. Keep the document hook a no-op in S2.
- Slash, palette, CLI and skill doors for these in-card controls; legacy operation Undo; host execution of repository code; new root recipes or privilege grants.

## Changes

Reshape existing code first:
- `packages/smithers/agent/std/src/internal/FileMutation.ts` and `src/StdError.ts`: extend the existing mutation/error path through T-COL-10's S2 guest binding; no independent state-file poll or error class.
- `packages/smithers/ui/src/app-operations/`: extend T-CAT-01 descriptors with `todo.return-to-item` (person and app agent) and `todo.keep-moved` (person only), with the Appendix B.4 policies and no CLI door. Dispatch through the shared authorizer before any effect.
- Extend T-COL-03a's capture/mutation-lock hooks, T-COL-04's metadata/overflow hooks and host event transaction, T-COL-03r's codecs and T-STK-01's existing branch-wait/first-answer guard. Do not duplicate watcher, outbox, capture, broker or wait implementations.
- Store the moved-off branch fact on the existing `workspaces` row identified by T-MCH-04. There is no `branches` table in current §3. Add `moved_off jsonb` only if absent; no new table. smithers-3f approves the column encoding and smithers-8a accepts any ownership reservation required by T-PRC-02. Assign an unlanded migration number at landing, preserving landed history.

New modules within those contracts, only if extraction keeps their existing owners:
- `crates/smithers-machined/src/moved_off.rs` (planned): detection and `return_to_item()` using existing watcher, capture and freeze hooks.
- `packages/backend/internal/machined/moved_off.go` (planned): existing event-ingest and wait-service integration, Return and Keep handlers.
- Reuse rejected: `packages/backend/internal/services/workspace_head.go:55` is a polling head reporter without metadata-event recovery or first-answer handling; the guest helper is one-shot. delta.md §4 permits the daemon feature, not another daemon or polling loop. The legacy undo service reverts operations rather than restoring the pre-move commit.

## Tests

- Boundary fixtures: use committed literal repository/file fixtures, recorded pre-move commits and independently computed SHA-256 values. No test reads spec Markdown or derives expected policy, bytes or error codes from production helpers at runtime.
- `TestMovedOffAgentDispatch`: invoke the production `coding/edit-atom` bindings for write, edit and apply_patch inside a real machine, through the authenticated daemon write path. While moved off, each returns literal `moved_off` and changes no file, including a queued mutation after Return starts. Missing or unbound daemon authority refuses. Direct FileMutation calls are not acceptance evidence.
- `TestMovedOffUnavailableProviders`: through the served command dispatcher and production activation path, remove each provider listed under Lands dark; assert no rewrite, no resumed agent writes and no legacy/host fallback.
- `TestReturnToItemBrokerValidatesFreezeInputs`: through the production Return dispatcher and real broker socketpair, reject unknown/forged session ids, cgroup paths, operations, extra fields and oversized frames before privileged effects; substitute repository symlinks and hostile config and prove no root process reads or executes them. A valid fixed-parent freeze/thaw still succeeds. Root input inventory is below.
- Coverage gate (library, ledger #3480): every `@smthrs/std` src file this ticket edits gets a per-file 100/100/100/100 gate in `packages/smithers/agent/std/vitest.config.ts`, as `src/Container.ts` already has.
- unit (`moved_off.rs`): the descent predicate over a fixture jj repo for each of these:
  - `git checkout main`, `git switch -c x main`, `jj edit main` and `jj new main` → moved off;
  - `jj abandon <item>` → change missing;
  - `git commit` on the item, `jj new` on top, and a rebase that keeps the change id → not moved off.
- integration, real jj, inotify and cgroups (`crates/smithers-machined/tests/moved_off.rs`, new): a second uid runs `git checkout main` and gets one `moved_off` naming that member. Return to Tn puts `@` and the file bytes back on the pre-move commit, and a file written after the move stays in its own commit. Git `HEAD` follows (colocated repository).
- integration, real PostgreSQL (`packages/backend/internal/machined/moved_off_integration_test.go`, planned): ingest through the production authenticated machine event connection, then invoke `todo.return-to-item` and `todo.keep-moved` through the served catalog command dispatcher and shared authorizer. Two Return presses race; one succeeds and the other gets literal `409 {answered_by}`. Keep leaves the wait open until the metadata watcher observes return. Redelivery opens one wait. Wrong branch, stale wait, unbound credential and delegated Keep refuse without effects. Settling moved-off leaves any other open wait intact. No direct handler/service invocation substitutes for these assertions.
- integration (`crates/smithers-machined/tests/moved_off.rs`): C-COL-05's metadata cases. `jj edit` to a change off the item with an identical tree raises `moved_off` within 1 s though no tracked file changed; `git checkout -b x` on the same commit raises nothing; a move made during a forced overflow is raised after the resync.
- e2e: C-J3-09.

## Acceptance

- [C-COL-05](../checks/C-COL-05.md): metadata watches and the overflow resync raise every move.
- [C-J3-09](../checks/C-J3-09.md): `git checkout main` over SSH shows Needs you with Return to Tn and Keep for now. Return restores the item, Keep holds Needs you until the working copy is back, and the agent writes nothing while moved off.
- [C-COL-03](../checks/C-COL-03.md), folded into T-COL-03: reuse its production freeze/mutation-lock writer matrix for Return; no write is lost or lands mid-rewrite, and queued stale writes refuse.
- [C-UI-13](../checks/C-UI-13.md): current static View reachability gate belongs to the card-wiring tickets; this ticket claims no Container integration pass from it.
- The three named boundary tests above pass. C-COL-05 is folded into T-COL-04; rerun its metadata/overflow cases against this detector, not a second watcher.

## Risks and notes

- In a colocated repository, `jj edit` must also move git `HEAD`. Confirmed broken if `git rev-parse HEAD` after Return differs from `@-`.
- An existing jj undo path, `POST …/workspaces/{id}/operations/{op_id}/undo` (`compose/router.go:557`, `services/change_operations.go:367`, `jj op revert` through `msb exec`), is a different behavior. T-CUT-02 decides whether it stays. This ticket must not route Return through it or add a third jj path.
- smithers-3f decides the daemon/broker seam, recovery failure behavior, schema encoding and wire extension; smithers-38 signs off the std mutation/error API; smithers-b8 signs off the in-card descriptor and served command API; smithers-06 decides View presentation within the existing card contract. smithers-8a resolves cross-owner disagreements and accepts any ADR change. Owner review is post hoc under Will's parallel-build directive; do not invent owner answers.

## Security preconditions

- M-29: repository code, Git/jj hooks/config-selected helpers, coding tools and test fixture commands execute only inside branch machines as unprivileged users. Only install/main-built code runs on the host or in the root broker. Detection, operation-log reads, capture and `jj edit` run as `machined`, never root. smithers-3f reviews this boundary. Check: C-SEC-02 and `TestReturnToItemBrokerValidatesFreezeInputs`.
- Root step reused here: broker freeze/thaw. Complete inputs: broker executable and protocol/size limits (main/install bundle, digest checked); socketpair descriptors and peer identity (main-controlled boot, no public broker listener); operation discriminant and freeze/thaw request (main-built daemon, influenced by branch/member activity); session ids and membership (main-controlled broker registry, authenticated host sessions, influenced by member processes); fixed `/sys/fs/cgroup/smithers/sessions/` descriptor and child cgroup names (main-controlled broker, never a caller path); cgroup membership, `cgroup.events`/`frozen` state, clock/deadline, write/wait errors (guest kernel, influenced by branch/member processes). Repository contents, jj operation ids and return targets remain daemon-only inputs. Root consumes no repository config, scripts, argv, environment, paths or file bytes. Branch-influenced request and kernel inputs block activation until `TestReturnToItemBrokerValidatesFreezeInputs` proves bounded decoding, registry-only targeting, fixed-subtree confinement and timeout/thaw handling. smithers-3f owns acceptance. Add no root state writer.

## Ready checklist

1. Code/schema dependencies are listed in Depends on and the matching index row; Scope names fail-closed activation for every listed provider and the separate UI/security landing preconditions. Missing dependencies do not block Ready.
2. Out explicitly excludes Undo, scratch detection, rebase/conflict engines, S3 documents, View/Container work, deferred attribution/flags, CLI/skill doors and new root mechanisms.
3. Served catalog commands, authenticated event ingest, real agent dispatch and real broker tests define acceptance; literal fixtures and independent hashes supply expectations. C-J3-09 proves the real SSH/browser journey; folded checks reuse their owning suites.
4. smithers-3f decides backend/daemon/schema/security seams; smithers-38 signs off std API; smithers-b8 signs off command API; smithers-06 decides View presentation; smithers-8a accepts ADR/reservation changes and resolves disagreements.
5. Owner pre-review questions, recorded for post hoc review: smithers-3f: Does Return reuse the capture/freeze/outbox contracts? Does the workspace fact preserve independent waits? Are all root inputs covered by the named validation test? smithers-38: Do all std mutations use the daemon guard? Does `moved_off` extend the existing error API without another ledger? smithers-b8: Do both controls use the served authorizer and Appendix B.4 policies? Does missing authority refuse without a new door? smithers-06: Do existing Branch/TODO Views expose both actions through `onAction`? Does Keep leave Needs you visible until return? No owner answer is fabricated.
6. Security preconditions confine repository execution to unprivileged machine users, enumerate every consumed root freeze/thaw input and its source, and block branch-influenced inputs until the named broker test passes; smithers-3f reviews them.
