# C-SPK-01 fanotify reports writer pid and uid in the libkrunfw guest

Proves: mvp.md M-27, §6.8 External changes · spec.md §9.3.1, §9.3.2 · Layer: spike · Stage: W0 · Tickets: T-MCH-03
Automation: `scripts/spikes/mch-03-fanotify/run.sh` (new) · Runs in: reference host

## Setup

- The reference host (the team's Mac mini, macOS 15+, whatever its size; record its host profile, spec §8.2.1), `main` at the commit under test, `msb` 0.6.16 from the pinned path (`packages/backend/microsandbox/cli.go` `RequiredVersion`).
- One VM booted with the runtime's flags: image `DefaultImage` (`packages/backend/microsandbox/runtime.go:57`), `--root-disk 32768M`, `--no-net`.
- In the guest: users `u1` (20001), `u2` (20002) and `agent` (19999), and a copy of a real repository (`smithersai/smithers` at a fixed commit) in `/workspace` with `node_modules/` present.
- The probe runs as root with the §9.3.1 init flags and a `FAN_MARK_FILESYSTEM` mark on `/workspace`, plus an ignore mark on `/workspace/node_modules`.

## Steps

1. Record `uname -r`, `stat -f -c %T /workspace`, and the probe's `fanotify_init` and `fanotify_mark` return codes.
2. For each uid, through `msb exec` and then through a PTY: create, modify (open, write, close), rename, and delete 1,000 files, using a short-lived writer (`sh -c`) for half and a long-lived writer for the other half.
3. Do an editor-style save: write `x.tmp`, then `rename` it over `x.ts`.
4. Write 100 files under `node_modules/`.
5. For every event, the probe reads the event pid's uid from `/proc/<pid>/status` (or from the pidfd) and logs `{event, path, pid, uid, resolved}`.
6. If step 1 fails: boot the fallback libkrunfw build and repeat steps 1–5.

## Pass when

- `fanotify_init` with `FAN_REPORT_DFID_NAME | FAN_REPORT_PIDFD` and the filesystem mark both succeed (on the stock kernel, or on the fallback kernel with the build recorded).
- Every operation in step 2 produces its expected event type: 8,000 operations per uid (4 operations × 1,000 files × 2 entry paths), 24,000 in all, 0 missing.
- 100% of step 2 and 3 events resolve to the writer's uid, including short-lived writers. A permission-event variant counts if the run records which variant reached 100%.
- Step 3 yields `FAN_MOVED_FROM` and `FAN_MOVED_TO` naming `x.tmp` and `x.ts`.
- Step 4 delivers 0 events to user space.

## Fail when

- `ENOSYS` or `EINVAL` from `fanotify_init` (no `CONFIG_FANOTIFY`, or a kernel older than 5.15 for `FAN_REPORT_PIDFD`) and no fallback run.
- Events arrive, but some pids belong to `msb`'s exec agent or another process rather than the writer.
- Short-lived writers show unresolved uids above 0 and the report still says "pass".
- A rename shows only as a delete plus a create.

## Evidence

`.artifacts/checks/C-SPK-01/<UTC timestamp>/`: `events.jsonl`, `summary.json` (counts per uid, operation and entry path; unresolved count), kernel release and filesystem type, the probe source digest, the `msb` version, the host profile, the commit, and for the fallback, the libkrunfw build log and wall time.
