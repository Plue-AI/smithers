# State architecture implementation handoff — September 15, 2026

The user explicitly stopped implementation and requested that completed work be landed on main, with unfinished work recorded as an issue. This document preserves the handoff in the repository. Do not interpret local verification as production rollout or as one clean final aggregate.

## What was implemented

- The app has one pure projection shared by live updates, replay, rebuild and verification: 41 domain projections (38 persisted and three per launch), 149 transition types, storage schema 16, event format version 1 (projector 23).
- Accepted inputs, verified checkpoint and head are authoritative; TanStack DB rows are materialized views. Event, changed rows and head commit atomically. Receipts fence external effects; stale writers are refused. Corrupt caches can rebuild, while invalid authoritative history is refused.
- Commands and human drafts have actor, context and prefix-bound recovery. HTTP chat has stable attempt/leg identities, backend acceptance, durable output and applied cursors. Native SQLite crash/reopen and outbox acknowledgement paths are covered. Ambiguous uncommitted inference/tool execution is not automatically replaced.
- Runtime lifecycle/call facts, stable call IDs, protected results, native-control outbox and nested human waits extend reconstruction across runtime boundaries. Run/approval cards, stars, read receipts, tags and Wiki joins derive views without duplicating durable card authority.
- Idle run/approval polling compares committed observations before dispatch. Explicit queued observations still receive real persistence receipts. Transcript suffixes are anchored to the applied prefix. Diagnostic payloads cap at 2 KiB; accepted event inputs remain complete.
- SQLite admission reads metadata before values, with bounded pages and refusal rather than partial state. Chain retention, privacy rotation and remote-delete outboxes preserve their different authority contracts.
- Cloud agent-session SSE has database message cursors, readiness and periodic repair, committed local cursor advancement and account fencing. It is a separate protocol from durable chat and runtime facts.
- Billing plan/catalog/usage rows are backend observations. Catalog/refusal cards await receipts; delayed billing/checkout replies are fenced by account and controller lifetime.
- Plue issue and notification fact migrations, replay/projection checks and contributor-guide cleanup already landed separately. State commit: `360fceb5c9d5`; old Flows PoC reference removal: `23d94c9a718c`.

Start with [state-architecture.md](state-architecture.md), then [state-events.md](state-events.md), [command-intents.md](command-intents.md), [http-turn-recovery.md](http-turn-recovery.md) and [persistence.md](persistence.md). Runtime evidence is documented under the engine-store and control packages; server chat under `apps/server/docs/agent-turn-events.md`.

## Verification actually obtained

Earlier complete package runs passed engine-store 1,494 tests, journal 458, gateway 459, canonical 238 and server 1,034. Subsequent focused integration runs cover changed seams; these counts overlap and must not be added as unique tests.

The full app aggregate reported 4,455 passes, seven opt-in skips, 11 failures and four timeout-related errors. Ten complete affected files subsequently passed 154 tests under unchanged timing budgets. This is not a clean final full-suite result.

Recent scoped gates include 116 distinct storage tests, fresh browser storage/reset tests, 96 frontend tests, seven physical idle-growth/held-receipt proofs, 33 complete root replay/retention tests, and 32 LiteralPin tests. App, RPC and server typechecks passed before the final incoming-main merge. Billing-specific checks passed 17 root replay/validation tests, 460 RPC/gateway/selected-server tests, and 286 distinct frontend consumer tests. Final WorkspaceSeam was 139/139 after one runner allowance increased from 5 to 30 seconds; the 60-attempt assertions and production timeout remained unchanged. The previous unchanged run was 138/139 with that wall-clock timeout.

Plue was checked against real local PostgreSQL 18 and Atlas: exactly the two new migrations applied and zero remained pending. Relevant Go/auth/projection/SSE tests, OpenAPI 24 tests/545 assertions, and three real local HTTP tests passed. No production deployment, production migration or credentialed canary was performed.

The last merge incorporates main `76fae281af26` (question-gate answers). Four overlaps were resolved in `Runs.test.ts`, controller `turns.ts`, controller `workflows.ts`, and `NestedHumanWaitAcrossDatabases.test.ts`. Both test sets, structured answers, durable pending/input receipts, ownership fences and runtime imports were retained. **That final composition was not retested because the user requested immediate landing and stopping.**

## Follow-up work, in order

1. Verify the landed composition on a frozen checkout. Start with `bun test src/mainview/state/Runs.test.ts` from `apps/app`, then the app `check` script. Run the affected Vitest files `PendingWaits.test.ts` in control, `GatewayServer.test.ts` in gateway, and `NestedHumanWaitAcrossDatabases.test.ts` in packages/smithers, with their package checks. Inspect cleanly merged ControlExecutor/GatewayServer changes as well as the four explicit conflicts. Obtain a reproducible complete app gate or isolate/document remaining timing sensitivity without weakening product assertions.
2. Audit older WorkspaceSeam operations such as `viewWorkspace` and `snapshotWorkspace` for late replies after account replacement/disposal. Billing integration fenced five newly relevant refusal-bearing mutation paths; it did not establish universal coverage of every old entrypoint. Audit remaining polling paths for redundant accepted observations separately from the implemented runtime-pump deduplication.
3. Plan production rollout explicitly. Plue migrations are manual, not implied by deployment. Coordinate legacy writers and fact writers. The migrations are `20260914200000_notification_lifecycle_facts.sql` and `20260914200100_issue_state_facts.sql`. Run authorized staging/production canaries and observe deployed versions; local results do not establish this.
4. Preserve documented boundaries: Plue issue/notification feeds are not universal live SPA subscriptions; issue reconstruction covers the raw row/memberships rather than every joined API view. Saved cloud-session cards are not automatically watched at boot. Native target JSONL uses a tolerant reader, not the same integrity contract as the app journal. Ephemeral memory, OS processes, account validity and remote repositories remain separate authorities. Compaction/privacy intentionally prevent unlimited historical replay. Ambiguous external side effects require observation or explicit retry policy.
5. Native state-root selection is not data migration. Generic runtime defaults to `<root>/.flows/{control,engine}.db`; coding host now defaults to the sibling `.smithers-coding-state/<repo>/.flows` location. Explicit state-dir settings and the in-root compatibility option select existing locations; old databases are not copied automatically. The credentialed native-host acceptance check was skipped because required native artifacts/environment were absent; a real two-database local path probe and relevant unit/source checks passed.

## Why this took too long

The work expanded across frontend persistence, runtime/control journals, HTTP/native chat, backend facts, migrations, recovery, privacy and teaching documentation. Main kept advancing with overlapping onboarding, bounded-loading, runtime state-root, billing and approval changes, leading to repeated integration and test cycles. Large app typechecks and resource-sensitive tests added delay. The agent should have frozen scope and landed reviewed increments earlier; repeated broad verification made the elapsed time and ETA unreliable. Future work should take one bounded issue at a time, integrate once, and rerun only checks justified by the actual incoming delta.

## Local evidence and preservation

The extended code tour and detailed, non-aggregate verification ledger are in `/Users/williamcory/state-architecture-research/{CURRENT-STATE,READING-PATH,VERIFICATION}.md`, with copied receipts under `verification/`. `/tmp/state-stop-*` records the final merge/landing. These are local paths, not repository artifacts. Unrelated dirty main-checkout work must remain preserved and must not be swept into this implementation commit. Do not restore old whole-file backups over newer concurrent work. Main-only and jj-only conventions apply; do not reset or abandon other agents' changes/workspaces.
