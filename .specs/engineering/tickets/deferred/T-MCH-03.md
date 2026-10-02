# T-MCH-03 Spike: fanotify reports the writer pid in the libkrunfw guest

Stage W0 · Size S · Depends on — · Unblocks — · Issue: [#3436](https://github.com/smithersai/smithers/issues/3436)
Spec: spec.md §9.3.1, §9.3.2, §21 · Delta: delta.md §4 · Product: mvp.md J3.4, §6.8 External changes, M-27

## Goal

By the end of day 3, a recorded yes or no: inside a microVM booted by `msb` 0.6.16, a root process gets one fanotify event per write to the working copy, and each event's pid resolves to the writing process and its uid.

## Scope

In:
- One disposable probe, run with one command, as root in a VM booted the way today's runtime boots machines (`packages/backend/microsandbox/runtime.go:567-570`, `DefaultImage` at `:57`, block root disk via `--root-disk`).
- `fanotify_init(FAN_CLASS_NOTIF | FAN_REPORT_DFID_NAME | FAN_REPORT_PIDFD)` and `fanotify_mark(FAN_MARK_ADD | FAN_MARK_FILESYSTEM)` on the filesystem holding `/workspace` (`runtime.go:46`), with the §9.3.1 events: `FAN_CLOSE_WRITE`, `FAN_CREATE`, `FAN_DELETE`, `FAN_MOVED_FROM`, `FAN_MOVED_TO`, `FAN_ATTRIB`, `FAN_OPEN`.
- Writers: uids 20001 and 20002 and 19999, each through `msb exec` and through a PTY; short-lived writers (`sh -c 'echo x > f'`) and long-lived ones (an editor-style temp file plus `rename`).
- Record: kernel release, `/workspace` filesystem type, whether an ignore mark on `node_modules/` suppresses events in the kernel, and how many events have a pid that no longer resolves to a uid when read.
- If the answer is no: build libkrunfw with `CONFIG_FANOTIFY=y` (and `CONFIG_FANOTIFY_ACCESS_PERMISSIONS=y`), boot it under the same `msb`, rerun the identical probe, and record the build recipe and its wall time.

Out:
- `smithers-machined`, bursts and the attribution table (T-COL-03, T-COL-04).
- Session cgroups (`/smithers/session-<id>`, §9.3.2), which the daemon's `open_session` creates (§8.10.3, §8.11.1, T-COL-03). Machines run no sshd.
- Shipping a custom libkrunfw in the bundle; that is a T-INS-01 change made only after the day-3 decision.

## Changes

- `scripts/spikes/mch-03-fanotify/` (new): `probe.c` (static linux-arm64, musl), `run.sh` that boots one VM with `SMITHERS_MICROSANDBOX_BIN`, copies the probe in, runs the write matrix, and writes `events.jsonl` plus `summary.json`.
- `scripts/spikes/mch-03-fanotify/libkrunfw/` (new, fallback only): kernel config fragment and build script.
- Both directories are disposable (CLAUDE.md prototype rule). The decision and its numbers go to the issue and the C-SPK-01 evidence. The directory is deleted when T-COL-04 lands its own fanotify integration test under `crates/smithers-machined/tests` (new).

## Tests

- spike: 4 operations (create, modify, delete, rename) × 1,000 files × 2 entry paths × 3 uids. Each must produce its event with a pid whose `/proc/<pid>/status` uid equals the writer's uid. This is C-SPK-01.
- spike: 100 writes into an ignored `node_modules/` produce 0 delivered events with the kernel ignore mark set.
- No unit tests: the probe is thrown away. T-COL-04 owns the lasting tests.

## Acceptance

- [C-SPK-01](../checks/C-SPK-01.md): fanotify initializes with the §9.3.1 flags in the guest, and every write in the matrix carries a pid that resolves to the writer's uid; or the fallback kernel passes the same matrix.

## Risks and notes

- The stock libkrunfw kernel has no `CONFIG_FANOTIFY`. Confirmed if `fanotify_init` returns `ENOSYS`. Then the fallback applies: build our own libkrunfw (about +1 week, overview.md). The tech lead decides on day 3. That decision also changes T-INS-01 (bundle) and T-INS-03 (signing of a rebuilt dylib).
- The kernel predates 5.15, so `FAN_REPORT_PIDFD` is refused with `EINVAL`. §9.3.1 requires the flag, so this triggers the same fallback: the install ships its own libkrunfw build.
- A short-lived writer exits before the daemon reads `/proc/<pid>`, so its uid can't be resolved. Confirmed if `summary.json` shows unresolved events above 0 for the `sh -c` writers. Mitigation to measure in the same run: a `FAN_OPEN_PERM` mark on write opens holds the writer until the daemon has read its uid and cgroup. That needs `CONFIG_FANOTIFY_ACCESS_PERMISSIONS`.
- `/workspace` sits on a filesystem without file handles, so `FAN_REPORT_DFID_NAME` or `FAN_MARK_FILESYSTEM` fails with `EOPNOTSUPP` or `EXDEV`. Confirmed by the probe's init log. Then the working copy must move to an ext4 disk (`msb create --mount-disk`). That is a T-COL-03 change.
- Open: §9.3.1 lists no permission events. If short-lived writers go unresolved, whether to add the `FAN_OPEN_PERM` hold measured above (owner: tech lead).
