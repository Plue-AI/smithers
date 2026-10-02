# T-COL-03 `smithers-machined`: crate, rootfs, init, host connection, capture

Stage S2 · Size L · Depends on T-COL-01, T-MCH-04, T-COL-10 · Unblocks T-STK-11, T-MCH-07, T-MCH-15, T-MCH-12, T-COL-04, T-TRM-01, T-TRM-03, T-TRM-05 · Issue: to file
Spec: spec.md §5.3 (`machine`), §7.6 (rows 1, 5), §8.4.3, §9 (intro), §9.1.1–9.1.3, §16.1.1, §17.2, §19.1 · Delta: delta.md §3 (sleep/stop row), §4 (`smithers-machined`, host relay, delete head loop) · Product: mvp.md §6.7 Sleep and Cleanup, M-27, M-29

## Goal

Every branch machine boots a root daemon that reconciles with the host before any session starts, holds one authenticated connection to the host, and answers `status`, `read_file`, `write_file` and `capture`. A capture leaves `refs/smithers/branches/<id>/head` equal to the working copy's jj snapshot, and the guest bash head loop no longer exists.

## Scope

In:
- A Rust crate built as a static `linux-arm64` musl binary and shipped in the guest rootfs of the install bundle (§16.1.1).
- Boot: the binary is planted digest-checked, as `installGuest` does. The guest's init starts it as root before any session is admitted and restarts it on exit, with backoff (§9.1.3). The machine reports `awake` only after `status()` answers.
- Host connection (§9.1.1) over the host-relay port, on the transport T-COL-01 chose (`relay` or `bridge`). It authenticates with a per-boot `machine` credential scoped to the branch (§5.3) and reconnects with backoff from 250 ms to 5 s. One live connection per machine: a newer boot's connection replaces the older one.
- Framing with stream kinds: control RPC, change events, presence, and a reserved live-document stream kind that S2 code refuses (§7.6 row 5).
- Control RPC (§9.1.2). This ticket implements:
  - `status()`;
  - `read_file(path, at?)`;
  - `write_file(path, base_digest | "absent", content, actor)`: the §7.6 row-1 compare-and-write, done in the daemon so the check and the write can't be split. It replaces the guest-helper write T-COL-10 used in S1;
  - `wake_reconcile()` (§9.1.2), on every boot before any session is admitted: fetch `refs/smithers/branches/<id>/head` from the host. If the host rebased the branch while it slept (§10.5.5), move or rebase `@` onto that head and emit "Rebased onto Tk". A conflict becomes `needs_you{kind: conflict}` on wake (§10.5.4). The machine reports `awake` only after it finishes;
  - `capture()`, run in phases: flush documents (a no-op until T-COL-08) → close bursts (a no-op until T-COL-04) → `jj util snapshot` → push the head and snapshot commits to the host repo store → verify the head ref equals the snapshot commit. The ref is named through a new `repohost.BranchHeadRef` beside `WorkspaceHeadRef` (`packages/backend/internal/repohost/refs.go:166`). T-MCH-07 moves every reader to it and deletes the workspace form.
- The rest of §9.1.2 lands with its owner: `open_session` and `tcp_connect` (T-TRM-01, T-TRM-03), `register_run` (T-COL-04), `rebase` (T-STK-11), `return_to_item` (T-COL-05), and `open_doc`/`close_doc` (T-COL-08, S3). Until then each answers a typed `unsupported`.
- Capture cadence while awake (§9.1.3): after every burst, coalesced to one per 5 s, and at least every 5 min. Sleep, fork, rebase and upgrade also call it (§8.4.3, §8.5.1, §9.4.1, §16.4).
- Operation log policy (§9.1.2a): each snapshot is one jj operation. Weekly, the daemon abandons operations older than 7 days (`jj op abandon`), keeping the ones activity entries reference. Their snapshot commits are already in the host store (§9.3.4).
- Sessions are daemon-owned (§8.10.3, §8.11.1): the guest runs no sshd, and every terminal and SSH session is a PTY or process the daemon starts through `open_session`. This ticket ships the typed `unsupported` stub; T-TRM-01 and T-TRM-03 implement it.
- An on-disk outbox (`/var/lib/smithers-machined/outbox`). Events stay there until the host acknowledges their committed row, and the host upserts by event id. This gives at-least-once delivery with no duplicates.

Out:
- The inotify watcher, attribution, bursts and activity (T-COL-04); moved-off (T-COL-05); presence semantics (T-COL-06); live documents (T-COL-08).
- Rebasing an asleep branch on the host (§10.5.5, T-STK-11). This ticket only reconciles with the result on wake.
- Per-entry Undo and replaced-edit restores ([D], §9.3.5, §9.3.7).
- Sleep and admission policy (T-MCH-06, T-MCH-07), member unix users (T-MCH-11), and reads of sleeping branches (T-MCH-07). Machines run no sshd (§8.10.3).

## Changes

- `crates/smithers-machined/` (new):
  - `Cargo.toml`, `PACKAGE.ts`: build, clippy and test targets plus the musl cross build, globbed by the root `PACKAGE.ts:45`;
  - `src/main.rs`, `src/conn.rs` (framing, reserved kinds), `src/rpc.rs`, `src/capture.rs`, `src/reconcile.rs` (`wake_reconcile`), `src/oplog.rs` (weekly abandon), `src/outbox.rs`.
- `Cargo.toml` (root) `members` and `Cargo.lock` gain the crate.
- `packages/backend/microsandbox/machined.go` (new): plant the daemon and its init supervision after `installGuest` (`microsandbox/runtime.go:582`, `guest.go:56`).
- `packages/backend/internal/machined/` (new): the connection registry keyed by branch, RPC client, outbox acknowledgement, and capture. Capture writes the head to the machine record and publishes `branch:<id>` through `live.Publish` (T-COL-02).
- `packages/backend/internal/services/workspace_facets.go:187` (`ReadWorkspaceFile`) and `:244` (`WriteWorkspaceFile`): awake microVM machines read and write through `read_file` and `write_file`. Delete the `fs read` and `fs write` subcommands of `microsandbox/guest/smithers-guest.py` if `rg` finds no other caller.
- Credential: mint `machine` (§5.3) per boot in place of the head token (`internal/services/workspace_head.go:357` `rotateWorkspaceHeadToken`).
- Delete (zero tech debt):
  - the bash head reporter (`workspace_head.go:52-171` script, install at `:601`, `:632-695`) and `ReportWorkspaceHead` (`:697`);
  - the route `POST …/workspaces/{id}/head` (`compose/router.go:545`) and its OpenAPI row (`docs/api/openapi/repositories.yaml:10439`);
  - the reporter's tests (`workspace_head_test.go`, `workspace_runtime_head*_test.go`).
- `packages/backend/docs/machined.md` (new), plus `docs:sync`, `docs:check` and `smthrs docs //packages/backend:docs`.

## Tests

- unit (`crates/smithers-machined/src/*` `#[cfg(test)]`): the frame codec round-trips. A reserved document frame and an unimplemented RPC get typed refusals. Backoff stays within its bounds. The outbox replays unacknowledged events in order after restart and drops acknowledged ones.
- integration (`crates/smithers-machined/tests/capture.rs`, new, real jj in a Linux runner or microVM): after capture, the ref equals the `jj util snapshot` commit. A capture interrupted between snapshot and push leaves the previous ref untouched. A killed daemon is restarted by init and reconnects.
- integration (`write_file`): a write with a stale `base_digest` returns `stale` and leaves the file unchanged; `"absent"` refuses an existing path.
- integration (`wake_reconcile`, real jj): the host moves the head ref while the machine is off; on boot `@` descends from the new head before the first session opens, and one "Rebased onto Tk" event is sent. A conflicting move yields `needs_you{conflict}` with the paths. An unchanged ref is a no-op with no event.
- integration (`oplog.rs`, fake clock): after 8 days, operations older than 7 days are abandoned except those the host lists as referenced; `jj op log` stays readable by a member uid.
- integration, real PostgreSQL (`packages/backend/internal/machined/registry_integration_test.go`, new):
  - The machine credential for branch A can't call or publish for branch B.
  - A second connection from a new boot replaces the first.
  - An event delivered twice yields one row.
- fault: C-DUR-04 kill points in snapshot, push, outbox write and acknowledgement.
- contract: append the §7.6 row-5 assertions (reserved document kind refused; `capture()` runs its flush phase first) to `packages/backend/internal/compose/cocontracts_test.go` (T-COL-10). They re-run C-COL-01's stage-2 rows.

## Acceptance

- [C-DUR-04](../checks/C-DUR-04.md): killing the daemon or the VM during a capture loses no acknowledged write and never moves the head ref to a commit the host store lacks.

## Risks and notes

- Cross-building a static musl `aarch64-unknown-linux-musl` binary on macOS needs a linker (`cargo-zigbuild` or `cross`). Confirmed if `smthrs build //crates/smithers-machined` fails on a clean Mac. Bundle work belongs to T-INS-01, so coordinate.
- `jj` run as root on a `root:team` working copy can leave root-owned files in `.jj/` that members can't write. Confirmed if a member's `jj st` fails after a capture. Mitigation: run jj with `umask 002` (§5.5.3).
- The head reporter also serves hosted workspaces (`workspace_runtime_head_hosted_integration_test.go`), and Plue composes the same backend. If a hosted path still needs it, deleting it breaks Smithers Cloud. Confirmed if `rg installWorkspaceHeadReporter` reaches a hosted-only caller. Then the daemon must replace it there too, or the tech lead decides the order. Two head publishers must not coexist.
- The framing, the RPC set and the capture flush phase are inputs to ADR 0003 (T-COL-10). Do not change them without it.
