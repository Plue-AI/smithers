# T-COL-03 Host registry, per-boot credentials, daemon planting and head-reporter replacement

Stage S2 · Size M · Depends on T-MCH-04, T-COL-03a, T-COL-03f, T-COL-10 · Unblocks T-COL-04, T-MCH-07, T-MCH-08, T-MCH-12, T-MCH-15, T-REL-02, T-STK-11, T-TRM-01, T-TRM-03, T-TRM-05, T-TRM-07 · Issue: [#3560](https://github.com/smithersai/smithers/issues/3560)
Spec: spec.md §5.3 (`machine`), §7.6 (rows 1, 5), §8.4.3, §9 (intro), §9.1.1–9.1.4, §9.4.1, §9.5, §16.1.1, §17.2, §19.1 · Delta: delta.md §3 (sleep/stop row), §4 (`smithers-machined`, host relay, delete head loop) · Product: mvp.md §6.7 Sleep and Cleanup, M-27, M-29

## Goal

Register one authenticated connection per branch and boot, plant and supervise the daemon, and route reads, writes and capture through it. Replace the bash head reporter with the daemon capture path, preserving pending-work detection.

## Scope

In:
- Implement the Go half of §9.1 and §9.5.3: branch-keyed registry, authenticated per-boot connections, newer-boot replacement, RPC client, object verification, transactional event receipts and acknowledgement only after commit. Consume T-COL-10 schemas and golden frames.
- Plant and supervise T-COL-03a’s binary, mint per-boot machine credentials and the relay secret, and admit no session or awake state before wake_reconcile finishes.
- Route awake reads, compare-and-writes and capture through the daemon. Publish the captured head and machine state. Replace and delete the head reporter and its route and tests.
Out:
- Rust core, broker, lock, capture, oplog and outbox producer (T-COL-03a).
- Watcher and change-event ingest (T-COL-04a, T-COL-04); documents (T-COL-08a, T-COL-08b, T-COL-08).

## Changes
- Encode and decode only through `packages/backend/internal/machined/wire` (T-COL-10); no local frame types, so the golden frames in `packages/backend/internal/compose/cocontracts_test.go` keep guarding this codec (smithers-3f, 2026-10-02).
- `packages/backend/microsandbox/machined.go` (new): plant the daemon and its init supervision after `installGuest` (`microsandbox/runtime.go:582`, `guest.go:56`).
- `packages/backend/internal/machined/` (new): the connection registry keyed by branch, RPC client, outbox acknowledgement, and capture. Capture writes the head to the machine record and publishes `branch:<id>` through `live.Publish` (T-COL-02).
- `packages/backend/internal/services/workspace_facets.go:187` (`ReadWorkspaceFile`) and `:244` (`WriteWorkspaceFile`): awake microVM machines read and write through `read_file` and `write_file`. Delete the `fs read` and `fs write` subcommands of `microsandbox/guest/smithers-guest.py` if `rg` finds no other caller.
- Credential: mint `machine` (§5.3) per boot in place of the head token (`internal/services/workspace_head.go:357` `rotateWorkspaceHeadToken`).
- Delete (zero tech debt):
  - the bash head reporter (`workspace_head.go:52-171` script, install at `:601`, `:632-695`) and `ReportWorkspaceHead` (`:697`);
  - the route `POST …/workspaces/{id}/head` (`compose/router.go:545`) and its OpenAPI row (`docs/api/openapi/repositories.yaml:10439`);
  - the reporter's tests (`workspace_head_test.go`, `workspace_runtime_head*_test.go`).
- `packages/backend/docs/machined.md` (new), plus `docs:sync`, `docs:check` and `smthrs docs //packages/backend:docs`.
- Consume T-COL-10 framing and T-COL-03f fake machined. Do not define a second codec contract.

- Before deleting `ReportWorkspaceHead`, move T-STK-12’s pending-work hook to `packages/backend/internal/machined/` capture ingest: after accepting a captured head for an `in_review` TODO, compare its tree with the accepted generation’s tree and signal `edited` once per new tree. Preserve stack locking, durable signal delivery and replay deduplication. Replace the head-report tests with capture-path tests; keep no reporter shim. Check: C-STK-06.

## Tests

- integration, real PostgreSQL (`packages/backend/internal/machined/registry_integration_test.go`, new):
  - The machine credential for branch A can't call or publish for branch B.
  - A second connection from a new boot replaces the first.
  - An event delivered twice yields one row.

- Contract: replay T-COL-10 golden frames against the Go RPC client and registry, first with T-COL-03f, then with T-COL-03a. Reserved document frames get typed unsupported in S2; capture calls flush first.
- Integration, real daemon, Linux VM and host store: all original capture, wake, stale-write, branch-credential and newer-boot cases, plus init restart. Run C-DUR-04 capture kill points K3–K6. T-COL-04 runs the complete K1–K6 matrix once bursts exist.
- Integration: reject unauthenticated relay and cross-branch actor envelopes (C-COL-04); run the C-COL-03 writer matrix with the real Go client.

- Integration, real PostgreSQL and daemon capture: an in_review TODO with a changed captured tree signals `edited` once; identical trees and replayed captures signal nothing. Re-run T-STK-12’s head-report cases through capture ingest. Check: C-STK-06.

## Acceptance

- [C-DUR-04](../checks/C-DUR-04.md): killing the daemon or the VM during a capture loses no acknowledged write and never moves the head ref to a commit the host store lacks.
- [C-COL-03](../checks/C-COL-03.md): the mutation lock and freeze sequence lose no write from any writer.
- [C-COL-04](../checks/C-COL-04.md): no path, special file or forged identity gets past the daemon's confinement.
- [C-COL-01](../checks/C-COL-01.md): real S2 assertions for this component re-run the T-COL-10 golden-frame gate.

## Risks and notes

- Cross-building a static musl `aarch64-unknown-linux-musl` binary on macOS needs a linker (`cargo-zigbuild` or `cross`). Confirmed if `smthrs build //crates/smithers-machined` fails on a clean Mac. Bundle work belongs to T-INS-01, so coordinate.
- `jj` must never leave files in `.jj/` that members can't write. The daemon runs jj as `machined` with `umask 002` (§9.5.1), never as root. Confirmed broken if a member's `jj st` fails after a capture.
- The head reporter also serves hosted workspaces (`workspace_runtime_head_hosted_integration_test.go`), and Plue composes the same backend. If a hosted path still needs it, deleting it breaks Smithers Cloud. Confirmed if `rg installWorkspaceHeadReporter` reaches a hosted-only caller. Then the daemon must replace it there too, or the tech lead decides the order. Two head publishers must not coexist.
- The framing, the RPC set and the capture flush phase are inputs to ADR 0003 (T-COL-10). Do not change them without it.
