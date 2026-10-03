# T-STK-08 Rebase now, conflicts (agent once, then Needs you with Resolve) and presence-aware rebase

Stage S1, S2 · Size L · Depends on S1: T-STK-01, T-STK-02, T-STK-12, T-FLW-02, T-FLW-11, T-MCH-08 (S1), T-UI-04 · S2: T-COL-03, T-COL-04, T-COL-06, T-MCH-04, T-MCH-07 · Unblocks T-APP-01, T-APP-02, T-APP-10, T-COL-08, T-GH-06, T-GH-07, T-REL-01, T-REL-02, T-REL-04 · Issue: [#3532](https://github.com/smithersai/smithers/issues/3532)
Spec: spec.md §8.5.0, §8.5.2a, §9.4.2, §10.5.1–§10.5.5, §14.5.2, §15.1.5 · Delta: delta.md §6 (Modify rebase) · Product: mvp.md §4.2 Rebase, J7.4, J10.4, M-32, Appendix A `/branch.rebase`

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ticket merges STK-08+11). Absorbs T-STK-08 ([#3573](https://github.com/smithersai/smithers/issues/3573)).

## Goal
S1: anyone on a branch rebases it now; the stack service performs it and records "Smithers, for Ben". A conflict gets one agent attempt, then Needs you with the paths and Resolve; nothing retries silently. S2: with people on the branch the rebase waits as "Rebase pending" and never runs during a write made through Smithers.

## Scope
In:
- S1: `/branch.rebase` and `branch.rebase-now` (`agent: run`), `POST /api/branches/{b} {rebase}`. Item branches rebase onto `rebase_pending.onto`; scratch branches onto their fork source's current head. jj operations are the engine's own. A clean rebase reruns checks only; an agent-resolved conflict is new work (implement, check, review). Approvals clear after any rebase.
- S1: one resolution attempt inside the item's `todo` run (`conflictAttempts`, default 1, an install setting via T-FLW-02), then a `conflict` wait through T-STK-01 with the paths. **Done** settles only when `jj resolve --list` is clear, else `409 {code: still_conflicted}`.
- S2: `Decide(pending, presence)`: agent alone → next durable boundary; people present → "Rebase pending" until they leave or press Rebase now. Awake branches rebase through the daemon's `rebase(onto)` under the §9.4.2 freeze (mutation lock, cgroup freeze ≤ 1 s, capture, rebase, thaw; lock < 2 s). Asleep branches rebase on the host against the captured head without waking.

Out: Fork and Add to stack (T-MCH-08); other conflict producers (T-GH-06, T-COL-05); the Branch card (T-APP-10); live document reload (T-COL-08, S3); free-form model history commands; a synthetic TODO for a scratch conflict.

## Changes
- Reshape `integrate` (`packages/backend/internal/services/mythical_items.go:1812`, conflict case `:1840`): persist the conflict and spent budget, send `conflict{paths, onto}` to the existing run, then raise the wait. Stop calling `mythicalRetry` (`:1215`) for conflicts; never write `retrying` or `blocked` for them.
- Reshape `prompt` (`:1723`): the resolution message reuses the retry-feedback text.
- Reshape `merge3` (`mythical_git.go:233`) and `rebaseCandidate` (`:533`) to keep the conflict tree and materialize it in the guest working copy before the agent starts.
- Reuse `replant` (`mythical_git.go:461`) and T-STK-12's stack claim and fence; a fenced item stays pending.
- Delete the `conflict` label derived from `retrying` in `itemStateLabel` (`packages/rpc/src/StackView.ts:56`).
- Reuse T-STK-01's `product_job_events` for the `rebase` entry with the system actor and requester.
- S2 Reshape: `integrate` calls the daemon `rebase` for an awake branch; the host path stays only for asleep branches. One path per case, no fallback.
- New (S1): the Rebase now flow in `branch_rebase_now.go`. Rejected reuse: `POST /mythical/items/{id}/retry` relaunches an attempt and has no scratch-branch or target semantics.
- New (S2): `Decide` in `todo_rebase.go` and the daemon `rebase(onto)` RPC in `crates/smithers-machined`. Rejected reuse: no presence-aware scheduler or guest-side rebase exists; the host-side `rebaseCandidate` cannot freeze writers.

## Tests
- S1 integration, real PostgreSQL, git and jj, and the scripted provider in a microVM: case A resolves once and verifies; case B fails and raises `needs_you{conflict, paths}` with no second attempt in 10 passes; case C Done while conflicted returns `409`. Restart after budget reservation still records one attempt; `conflictAttempts = 0` records none. Scratch from `main` and from T2 rebase onto the right head. One `Idempotency-Key` rebases once.
- S2: unit decision table over presence {none, agent, agent + person, person + SSH} × pending; `crates/smithers-machined/tests/rebase.rs` closes an open burst first and lands a held `write_file` after the rebase; Alice present gives "Rebase pending", Alice leaving rebases within 2 s; an asleep branch rebases with zero wakes.

## Acceptance
- S1: [C-J7-03](../checks/C-J7-03.md), [C-SEC-02](../checks/C-SEC-02.md), [C-UI-13](../checks/C-UI-13.md).
- S2: [C-COL-03](../checks/C-COL-03.md), [C-J10-04](../checks/C-J10-04.md), [C-PERF-06](../checks/C-PERF-06.md).

## Risks and notes
- Risk: today's host-side rebase writes the candidate in the stack repository, so the agent may start without conflict markers. Observation: case B's lane has no markers. Then check out the conflicted change first.
- Risk: `jj rebase` on a large working copy exceeds 2 s. Observation: C-PERF-06 p95 ≥ 2 s on the reference host. Escalate before changing the §9.4.2 sequence.
