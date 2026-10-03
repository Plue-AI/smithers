# T-TRM-06 Spike: daemon sessions carry VS Code Remote; revocation in 5 s

Stage S1 · Size M · Depends on T-SEC-01 · Unblocks T-TRM-07 · Issue: [#3554](https://github.com/smithersai/smithers/issues/3554)
Spec: spec.md §5.6, §8.10.3, §8.11, §9.5.3, §9.6 · Delta: delta.md §5 (session supervisor row) · Product: mvp.md §6.15 SSH into a branch, §6.8 Terminals, J3.2, J3.3, M-18, M-24, M-29
Ready: 2026-10-03 smithers-8a sha256:0f0689e4c249

## Goal

Before the stage-2 daemon chain starts, answer with a recording and numbers: does the §9.6 session protocol, run by a root supervisor in a microVM with no sshd, carry a real VS Code Remote-SSH session (connect, edit, save, terminal, port forward, reconnect), and does revoking the member end every one of their processes within 5 s?

## Scope

In:
- A disposable, one-command prototype (`scripts/spikes/trm-06/run.sh`):
  - a Rust session supervisor in the guest: `pty`, `exec`, `sftp` and `tcp` sessions, each in its own cgroup under one parent, started as uid 20001 (`ben`) with `umask 002`; the §9.6.2 frames (`data`, `eof`, `resize`, `signal`, `exit`, `window`, `close`); `close_session` and `kill_sessions` with `cgroup.kill` confirmed by `populated 0`; on start, before accepting `open_session`, write `1` to `cgroup.kill` for every child of `/sys/fs/cgroup/smithers/sessions/` and wait for each child to report `populated 0`; refuse admission if emptiness cannot be confirmed;
  - a Go gateway prototype on the host that maps SSH channels and requests onto those frames (`exit-status`, `exit-signal`, `window-change`, `signal`, EOF, window adjust, `direct-tcpip`), over the existing relay (`packages/backend/microsandbox/transport.go:67`, `DialWorkspacePort`) or bridge (`:126`).
- The guest helper's `cgroup_kill` (`packages/backend/microsandbox/guest/smithers-guest.py:78-121`) and `drop_to` (`:124-138`) are implementation references, not test oracles. Do not shell out to the helper's cgroup_kill. Implement startup cleanup in the Rust supervisor. The helper waits up to 10 s; the prototype must independently prove the 5 s revocation bound, uid/gid dropping and no-orphan restart rule. Check: C-SPK-08.
- A one-page result in T-TRM-07: the frame set as built, every measured number, and any frame or rule §9.6 lacks.
- Land dark: build against T-SEC-01’s contract while it is unlanded. Do not register the spike in product startup or expose its listener. `run.sh` refuses root setup, installation, supervisor start and SSH admission until the installed main-pinned prototype is available and smithers-3f accepts the T-SEC-01 R1–R3 receipts and both prototype validation subchecks below. Missing authority, artifacts or receipts fail closed with no host execution fallback. Check: C-SPK-08/root-prototype-install-validation.
- Use a fresh `DefaultImage` machine with `Config.Environments = nil`; do not resolve toolchain/dependency layers, read a branch target index, use a retained layer or install coding artifacts. Build branch prototype code only as an unprivileged machine user; root and the host gateway execute only main-pinned installed prototype bytes. Checks: C-SPK-08/root-prototype-install-validation, C-SPK-08/root-session-input-validation.

Out:
- Product code. T-TRM-07 ports only the validated decisions.
- R4 toolchain/dependency layer builds, branch-selected root toolchains, R5 coding-artifact installation, retained layer reuse, production revocation transactions and delegated terminal credentials.
- Admission, branch-name usernames and key import (T-TRM-03, T-ACC-02); attribution (T-COL-04); the broker's privilege split (T-COL-03).
- Guest sshd, SSH agent forwarding, remote forwarding (`tcpip-forward`), Cursor/Zed certification and any weakening of revocation or isolation.

## Changes

- Reuse `packages/backend/microsandbox/transport.go:67` (`DialWorkspacePort`) for the byte stream. Port the descriptor-confined cgroup cleanup and group/GID/UID-drop pattern from `guest/smithers-guest.py:78-138` into Rust; adapt its fixed agent-only uid 1500 rule to the prototype’s fixed Ben uid 20001 and agent uid 19999. Do not copy its 10 s timeout.
- Implement the §9.6.4 startup barrier in the Rust supervisor: before accepting open_session, cgroup.kill every child of `/sys/fs/cgroup/smithers/sessions/` and wait for populated 0. Cleanup must work after SIGKILL, when no exit handler runs. Do not shell out to smithers-guest.py cgroup_kill. Check: C-SPK-08.

- `scripts/spikes/trm-06/` (new): `run.sh`, `supervisor/` (Rust), `gateway/` (Go), `revoke.sh`, `flow.sh`. The net-new Rust supervisor and SSH-to-frame adapter are disposable protocol probes: `packages/backend/microsandbox/exec.go:599` wraps host PTYs around one guest user, and `packages/backend/internal/routes/terminal_session_manager.go:39` manages host SSH viewers; neither owns guest session cgroups or the §9.6 frame lifetime. Reuse the existing relay and port the helper patterns above instead of rebuilding transport or cleanup plumbing. No change to `packages/`, `apps/` or `crates/`. Delete the directory when T-TRM-07 records the result; the evidence keeps the raw samples.

## Tests

- C-SPK-08 step 8 sends SIGKILL to a supervisor with live foreground and background sessions. Init restarts it. Independently observe every old session cgroup reach populated 0 before the first accepted open_session. Preserve the existing 2 s no-orphan bound and automatic VS Code reconnect assertion. A cleanup failure refuses session admission.

- spike: C-SPK-08, every step, on the reference host with VS Code on a second Mac. Invoke `scripts/spikes/trm-06/run.sh` and the gateway's SSH listener with real OpenSSH and VS Code; session frames must traverse `DialWorkspacePort` or `startBridges`, not a direct supervisor test shim. The revocation driver calls the prototype's host revocation operation, which sends `kill_sessions(ben)`; observe disconnect and guest cgroup emptiness independently.
- Pin expected exit 7, TERM, byte counts, sequence order, fixture content, 5 s revocation and RSS bound in the test harness. No expectation reads spec files, helper timeout constants or the prototype's runtime values. Reject SSH agent forwarding and `tcpip-forward` at the gateway. C-SPK-08 retains raw samples and recording even on NO.

- `C-SPK-08/root-prototype-install-validation` (new subcheck in `run.sh`): enter through the actual launcher and init install/start/restart path. Missing T-SEC-01 receipts, branch-built supervisor/scripts, poisoned PATH/import paths, replaced artifact/destination parents and symlink races must refuse before privileged use, leave outside sentinels unchanged and execute no root or host canary. A main-pinned installed positive control starts. Verify `Config.Environments = nil` rejects layer/coding-artifact requests. Record artifact source, independently computed digest, UID and process samples.
- `C-SPK-08/root-session-input-validation` (new subcheck in `run.sh`): enter the actual SSH listener and authenticated relay/control operation. Refuse root/other-user selection, forged boot credentials, malformed/oversized frames, cgroup traversal, symlinked/raced paths, invalid TCP targets, signals and credit before root use. Observe fixed supplementary groups/GID/UID before argv/env/cwd, SFTP paths/bytes or repository content is used; no session can write outside its permitted workspace/home or reach another user’s home. Include valid PTY/exec/SFTP/TCP controls, reconnect, close, revocation and restart. Literal policy fixtures and outside sentinel bytes/owner/mode define expectations.

## Acceptance

- [C-SPK-08](../checks/C-SPK-08.md): VS Code Remote works end to end over the prototype; revocation leaves no member process within 5 s in 10 of 10 runs; flow control loses no byte and bounds memory; a supervisor restart leaves no orphan. Both named root-validation subchecks pass through `run.sh`. This S1 ticket runs the check’s W0 spike procedure after its S1 security prerequisite; the protocol result still precedes S2 daemon work.
- [C-SEC-02](../checks/C-SEC-02.md), T-SEC-01 R1–R3 subset: accepted production fresh/retained bootstrap, setup and exec/fs/cgroup/relay receipts for the installed adapter. Layer, coding-artifact and unrelated flow checks are outside this spike’s scope.

## Risks and notes

- VS Code starts its server in the background from an exec channel and later reaches it through `direct-tcpip`. If the server dies when that channel closes, §9.6.3's lingering rule is wrong. Confirmed by step 6 of C-SPK-08.
- A process in uninterruptible sleep delays `cgroup.kill`. Confirmed if any revocation run exceeds 5 s; then record which process and state.
- Decisions this spike must not make alone: running an sshd per member (contradicts §8.10.3 and M-29), or dropping the 5 s revocation. smithers-8a accepts the spike report and protocol amendments; Will decides any product change. Neither owner may silently treat sshd or relaxed revocation as a passing result.

## Root-input inventory

Repository payloads and branch builds execute only as unprivileged users inside machines (M-29); no member or agent has sudo. smithers-3f reviews the root boundary. Root executable, script, init and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are refusal fixtures, never accepted root code. Branch/member data is blocked until the named boundary test proves validation before privileged use. R1–R3 below cover the existing adapter and require T-SEC-01’s C-SEC-02 receipts.

### Prototype setup, install and init start/restart

- Inputs: launcher/setup/init/revoke/harness scripts, supervisor/gateway artifacts, source identity and expected digest, fixed install/cgroup paths and account/group/UID/home declarations: **main-pinned installed bundle**, never the branch. Build tools and interpreter/library/import paths, msb, image digest and base executables: **install-controlled main/bundle**; image/approved artifact downloads: **upstream responses selected by main**, verified against the installed identity. Compiler inputs for a branch build: **branch**, used only by an unprivileged machine user, never promoted to root inputs.
- Inputs: host argv/environment/PATH/HOME, VM identity/shape/deadlines, boot secret, relay port and listener/key binding: **install-controlled configuration** with **member-controlled caller values** treated as untrusted. Account/group records, destination/temporary/ancestor entries, init configuration, home/cache entries, cgroup mount and kernel state: **install-controlled image/state**, with **branch/member-controlled retained or replaced entries**. R1–R3 inventories cover shared adapter operations.
- Validation: C-SPK-08/root-prototype-install-validation proves installed source provenance, fixed executable/environment choices, bounded configuration and no-follow destination/account/cgroup setup before privileged use on install and restart. Missing artifacts, receipts or trusted parents refuse before root start.

### Root session supervision and cleanup

- Inputs: host/boot authentication, fixed Ben/agent login-to-UID/GID/group bindings, session/run ownership, generated IDs and the fixed session cgroup parent: **main/install-controlled authenticated state**. SSH key/channel/request bytes, session kind, argv/env/cwd, PTY modes/size, SFTP paths/flags/modes/content, TCP address/port, signal, credit/data/eof/close and kill selectors: **member/branch-controlled data**, never identity authority. Workspace bytes, symlinks and home/cache entries: **branch/member**; cgroup events/process state, filesystem metadata and syscall/network/child exit responses: **install-controlled kernel observations influenced by member processes**.
- Validation: C-SPK-08/root-session-input-validation proves authenticated bounded envelopes, fixed identity and owned session/cgroup selection before root use; argv/env/cwd, SFTP operations and repository bytes are handled only after group/GID/UID drop. Cleanup uses held descriptors under the fixed cgroup parent; startup admission waits for every old group to drain. C-SPK-08 steps 7–8 independently prove the 5 s revocation and 2 s restart bounds.

#### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

#### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

#### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

## Ready checklist

1. Dependencies: S1 T-SEC-01 supplies the existing adapter’s R1–R3 validation. Scope lands dark and refuses activation until accepted receipts and main-pinned prototype artifacts exist; msb 0.6.16, DefaultImage, cgroup.kill/openat2, init and a second Mac with OpenSSH/VS Code are runtime prerequisites. No later daemon/member-user/gateway ticket is needed.
2. Exclusions: product integration, admission/key import, attribution, privilege-split implementation, delegated credentials, production revocation transactions, R4/R5/layer reuse, sshd, forwarding variants and other-editor certification are explicit.
3. Boundary tests: C-SPK-08 uses run.sh, real SSH/VS Code and the real relay; both root-validation subchecks use launcher/init and gateway dispatch. Literal fixtures and independent identity/cgroup/time/sentinel observations define expectations; no spec or runtime policy constants supply the oracle. C-SEC-02 R1–R3 receipts cover the shared adapter.
4. Decisions: smithers-8a accepts the spike evidence and protocol amendments; Will decides product changes; smithers-3f accepts security seams, artifact provenance, validation policy and R1–R3/prototype receipts before activation. A NO result retains evidence and does not relax isolation or revocation.
5. Owner pre-review: smithers-3f’s recorded answer stands: BLOCKING startup-barrier edits applied; helper cleanup remains reference only. Questions covered by that answer: Does startup drain every old cgroup before admission after SIGKILL? Is helper cleanup excluded while C-SPK-08 step 8 proves ordering? Follow-up question for post hoc review: Do the real install/session subchecks prove main-only root code and validation of every branch/member input before use?
6. Security: M-29 confines branch execution/builds to unprivileged machine users; root-input inventory names setup/install/init, supervision/cleanup and R1–R3 sources and their boundary validation tests. smithers-3f reviews and accepts them. Branch-built root code is forbidden; branch/member data stays blocked without passing validation receipts.
