# T-COL-03a Rust daemon core, broker, capture and durable outbox

Stage S2 · Size L · Depends on T-COL-01, T-COL-03r, T-TRM-06 · Unblocks T-COL-03, T-REL-02 · Issue: [#3624](https://github.com/smithersai/smithers/issues/3624)
Spec: spec.md §5.3 (`machine`), §7.6 (rows 1, 5), §8.4.3, §9 (intro), §9.1.1–9.1.4, §9.4.1, §9.5, §16.1.1, §17.2, §19.1 · Delta: delta.md §3 (sleep/stop row), §4 (`smithers-machined`, host relay, delete head loop) · Product: mvp.md §6.7 Sleep and Cleanup, M-27, M-29

## Goal

Build the daemon independently of the backend, against a Rust fake host and real jj in a Linux VM.

## Scope

In:
- A Rust crate built as a static `linux-arm64` musl binary. T-COL-03 plants it in the guest rootfs.
- Boot: the binary is planted digest-checked, as `installGuest` does. The guest's init starts the root broker before any session is admitted. The broker starts the daemon as `machined` (uid 19998, groups `{team}`) and restarts it on exit, with backoff, after ending every session (§9.1.3, §9.5.1, §9.6.4). The machine reports `awake` only after `status()` answers.
- Host connection (§9.1.1) over the host-relay port, on the transport T-COL-01 chose (`relay` or `bridge`). It authenticates with a per-boot `machine` credential scoped to the branch (§5.3) and reconnects with backoff from 250 ms to 5 s. On `relay`, the daemon accepts the host only after it presents the per-boot connection secret (§9.5.3). One live connection per machine: a newer boot's connection replaces the older one.
- Implement the connection framing, RPC schemas and outbox acknowledgement bytes fixed by T-COL-10; this ticket does not define the wire contract.
- Control RPC (§9.1.2). This ticket implements:
  - `status()`;
  - `read_file(path, at?)`;
  - `write_file(path, base_digest | "absent", content, actor)`: the §7.6 row-1 compare-and-write, done in the daemon under the mutation lock with the `RENAME_EXCHANGE` swap and displaced-digest check (§9.4.1), so the check and the write can't be split, even against an outside writer. Paths resolve with `openat2` confined to `/workspace` (§9.5.2). It replaces the guest-helper write T-COL-10 used in S1;
  - `wake_reconcile()` (§9.1.2), on every boot before any session is admitted: fetch `refs/smithers/branches/<id>/head` from the host. If the host rebased the branch while it slept (§10.5.5), move or rebase `@` onto that head and emit "Rebased onto Tk". A conflict becomes `needs_you{kind: conflict}` on wake (§10.5.4). The machine reports `awake` only after it finishes;
  - `capture()`, run in phases: flush documents (a no-op until T-COL-08) → close bursts (a no-op until T-COL-04) → `jj util snapshot` → push the head to the host repo store → verify the head ref equals the snapshot commit → return once the outbox is empty (§9.1.4). T-COL-03 adds `repohost.BranchHeadRef` beside `WorkspaceHeadRef` (`packages/backend/internal/repohost/refs.go:166`). T-MCH-07 moves every reader to it and deletes the workspace form.
- The rest of §9.1.2 lands with its owner: `open_session`, `tcp_connect`, `close_session` and `kill_sessions` (T-TRM-07), `register_run` (T-COL-04), `rebase` (T-STK-11), `return_to_item` (T-COL-05), and `open_doc`/`close_doc` (T-COL-08, S3). Until then each answers a typed `unsupported`.
- Capture cadence while awake (§9.1.3): after every burst, coalesced to one per 5 s, and at least every 5 min. Sleep, fork, rebase and upgrade also call it (§8.4.3, §8.5.1, §9.4.1, §16.4).
- Operation log policy (§9.1.2a): each capture is one jj operation, and nothing outside the machine references one. Weekly, the daemon abandons operations older than 7 days (`jj op abandon`) and runs `jj util gc`. Pending outbox refs (§9.1.4) keep unpushed objects alive.
- Sessions are daemon-owned (§8.10.3, §8.11.1): the guest runs no sshd, and every terminal and SSH session is a PTY or process the daemon starts through `open_session`. This ticket ships the typed `unsupported` stub and the session cgroup parent; T-TRM-07 implements the sessions in the broker (§9.6).
- The outbox (§9.1.4): objects durable and held by `refs/smithers/pending/<event id>` before an event enters; `seq` and `event_id`; refs pushed before the event is sent; the Rust fake host checks objects and models transactional receipts before acknowledging `seq`; T-COL-03 implements that host path; resend in order after any reconnect or restart. `file_written` and presence skip it.
- The mutation lock (§9.4.1): one per branch, in arrival order, over `write_file`, saves, burst closes, `capture()`, `rebase`, `return_to_item()`, `wake_reconcile()` and the overflow resync. It also provides the §9.4.2 freeze sequence (freeze the session cgroup parent, wait ≤ 1 s for `frozen 1`, drain, capture, run the rewrite, thaw) that T-STK-11 and T-COL-05 call.
- Privilege split (§9.5): the root broker (session cgroups, freeze and kill, `/run/smithers/env`, home and token-file IO through a child dropped to the member) and the `machined` daemon (everything else), joined by a socketpair. `openat2` confinement for every working-copy path. The agent-only local socket `/run/smithers/machined.sock` (`root:agent` 0660) with `SO_PEERCRED` and cgroup-to-run mapping; `register_run` accepted only from the host.

Out:
- Go registry, credential minting, rootfs planting and head-reporter deletion (T-COL-03).
- Watcher, documents and real session implementation retain their existing owners.

## Changes


- `crates/smithers-machined/` (new):
  - `Cargo.toml`, `PACKAGE.ts`: build, clippy and test targets plus the musl cross build, globbed by the root `PACKAGE.ts:45`;
  - `src/main.rs`, `src/conn.rs` (framing, reserved kinds), `src/rpc.rs`, `src/capture.rs`, `src/reconcile.rs` (`wake_reconcile`), `src/oplog.rs` (weekly abandon and gc), `src/outbox.rs`, `src/lock.rs` (mutation lock and freeze sequence), `src/broker.rs` (root broker and socketpair), `src/confine.rs` (`openat2` resolution, regular-file checks), `src/local.rs` (agent socket).
- `Cargo.toml` (root) `members` and `Cargo.lock` gain the crate.
- Extend T-COL-03r’s crate and `conn.rs`/`rpc.rs` codec with the production control handlers, broker, lock, capture, reconcile, oplog, outbox, confinement and agent socket listed above. T-COL-03r owns the initial skeleton, hook traits and `tests/fake_host.rs`; retain its golden-frame tests.

## Tests

- unit (`crates/smithers-machined/src/*` `#[cfg(test)]`): the frame codec round-trips. A reserved document frame and an unimplemented RPC get typed refusals. Backoff stays within its bounds. The outbox replays unacknowledged events in order after restart and drops acknowledged ones.
- integration (`crates/smithers-machined/tests/capture.rs`, new, real jj in a Linux runner or microVM): after capture, the ref equals the `jj util snapshot` commit. A capture interrupted between snapshot and push leaves the previous ref untouched. A killed daemon is restarted by init and reconnects.
- integration (`write_file`): a write with a stale `base_digest` returns `stale` and leaves the file unchanged; `"absent"` refuses an existing path.
- integration (`wake_reconcile`, real jj): the host moves the head ref while the machine is off; on boot `@` descends from the new head before the first session opens, and one "Rebased onto Tk" event is sent. A conflicting move yields `needs_you{conflict}` with the paths. An unchanged ref is a no-op with no event.
- integration (`oplog.rs`, fake clock): after 8 days, every operation older than 7 days is abandoned and gc'd, objects behind a pending outbox ref survive, the working copy and `@` are unchanged, and `jj op log` stays readable by a member uid.
- integration (`lock.rs`, real jj and cgroup v2): C-COL-03's writer matrix for capture and the freeze sequence; a forced freeze timeout thaws within 1 s and answers `busy`.
- integration (`confine.rs`, `broker.rs`): C-COL-04's path, special-file and identity cases; `ps` shows the daemon as `machined` and only the broker as root.
- fault: C-DUR-04 kill points in snapshot, push, outbox write and acknowledgement.

- Contract: the Rust fake host replays golden frames byte for byte, including requests, refusals, acknowledgements, missing objects and reconnect. Run the same vectors against the real Rust codec.
- Fault tests cover the Rust portions of C-DUR-04 K1–K6 against the fake; full host/VM evidence remains in T-COL-04.

## Acceptance

- [C-COL-01](../checks/C-COL-01.md): real S2 assertions for this component re-run the T-COL-10 golden-frame gate.
- C-COL-03: Rust mutation-lock and freeze cases.
- C-COL-04: Rust confinement and broker cases.
- C-DUR-04: Rust capture and outbox kill cases. Fake results are component evidence, not full-check passes.

## Risks and notes

- No backend dependency. The fake models host receipts and object availability; it does not prove real transactions.
- Keep the existing musl build and member-writable jj metadata requirements from T-COL-03.

