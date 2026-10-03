# T-TRM-06 Spike: daemon sessions carry VS Code Remote; revocation in 5 s

Stage W0 · Size M · Depends on — · Unblocks T-TRM-07 · Issue: [#3554](https://github.com/smithersai/smithers/issues/3554)
Spec: spec.md §5.6, §8.10.3, §8.11, §9.5.3, §9.6 · Delta: delta.md §5 (session supervisor row) · Product: mvp.md §6.15 SSH into a branch, §6.8 Terminals, J3.2, J3.3, M-18, M-24, M-29

## Goal

Before the stage-2 daemon chain starts, answer with a recording and numbers: does the §9.6 session protocol, run by a root supervisor in a microVM with no sshd, carry a real VS Code Remote-SSH session (connect, edit, save, terminal, port forward, reconnect), and does revoking the member end every one of their processes within 5 s?

## Scope

In:
- A disposable, one-command prototype (`scripts/spikes/trm-06/run.sh`):
  - a Rust session supervisor in the guest: `pty`, `exec`, `sftp` and `tcp` sessions, each in its own cgroup under one parent, started as uid 20001 (`ben`) with `umask 002`; the §9.6.2 frames (`data`, `eof`, `resize`, `signal`, `exit`, `window`, `close`); `close_session` and `kill_sessions` with `cgroup.kill` confirmed by `populated 0`; on start, before accepting `open_session`, write `1` to `cgroup.kill` for every child of `/sys/fs/cgroup/smithers/sessions/` and wait for each child to report `populated 0`; refuse admission if emptiness cannot be confirmed;
  - a Go gateway prototype on the host that maps SSH channels and requests onto those frames (`exit-status`, `exit-signal`, `window-change`, `signal`, EOF, window adjust, `direct-tcpip`), over the existing relay (`packages/backend/microsandbox/transport.go:67`, `DialWorkspacePort`) or bridge (`:126`).
- The guest helper's `cgroup_kill` (`packages/backend/microsandbox/guest/smithers-guest.py:62-96`) and `drop_to` (`:99-106`) are implementation references, not test oracles. Do not shell out to the helper's cgroup_kill. Implement startup cleanup in the Rust supervisor. The helper waits up to 10 s; the prototype must independently prove the 5 s revocation bound, uid/gid dropping and no-orphan restart rule. Check: C-SPK-08.
- A one-page result in T-TRM-07: the frame set as built, every measured number, and any frame or rule §9.6 lacks.

Out:
- Product code. T-TRM-07 rebuilds only the validated decisions.
- Admission, branch-name usernames and key import (T-TRM-03, T-ACC-02); attribution (T-COL-04); the broker's privilege split (T-COL-03).
- Guest sshd, SSH agent forwarding, remote forwarding (`tcpip-forward`), Cursor/Zed certification and any weakening of revocation or isolation.

## Changes

- Implement the §9.6.4 startup barrier in the Rust supervisor: before accepting open_session, cgroup.kill every child of `/sys/fs/cgroup/smithers/sessions/` and wait for populated 0. Cleanup must work after SIGKILL, when no exit handler runs. Do not shell out to smithers-guest.py cgroup_kill. Check: C-SPK-08.

- `scripts/spikes/trm-06/` (new): `run.sh`, `supervisor/` (Rust), `gateway/` (Go), `revoke.sh`, `flow.sh`. No change to `packages/`, `apps/` or `crates/`. Delete the directory when T-TRM-07 records the result; the evidence keeps the raw samples.

## Tests

- C-SPK-08 step 8 sends SIGKILL to a supervisor with live foreground and background sessions. Init restarts it. Independently observe every old session cgroup reach populated 0 before the first accepted open_session. Preserve the existing 2 s no-orphan bound and automatic VS Code reconnect assertion. A cleanup failure refuses session admission.

- spike: C-SPK-08, every step, on the reference host with VS Code on a second Mac. Invoke `scripts/spikes/trm-06/run.sh` and the gateway's SSH listener with real OpenSSH and VS Code; session frames must traverse `DialWorkspacePort` or `startBridges`, not a direct supervisor test shim. The revocation driver calls the prototype's host revocation operation, which sends `kill_sessions(ben)`; observe disconnect and guest cgroup emptiness independently.
- Pin expected exit 7, TERM, byte counts, sequence order, fixture content, 5 s revocation and RSS bound in the test harness. No expectation reads spec files, helper timeout constants or the prototype's runtime values. Reject SSH agent forwarding and `tcpip-forward` at the gateway. C-SPK-08 retains raw samples and recording even on NO.

## Acceptance

- [C-SPK-08](../checks/C-SPK-08.md): VS Code Remote works end to end over the prototype; revocation leaves no member process within 5 s in 10 of 10 runs; flow control loses no byte and bounds memory; a supervisor restart leaves no orphan.

## Risks and notes

- VS Code starts its server in the background from an exec channel and later reaches it through `direct-tcpip`. If the server dies when that channel closes, §9.6.3's lingering rule is wrong. Confirmed by step 6 of C-SPK-08.
- A process in uninterruptible sleep delays `cgroup.kill`. Confirmed if any revocation run exceeds 5 s; then record which process and state.
- Decisions this spike must not make alone: running an sshd per member (contradicts §8.10.3 and M-29), or dropping the 5 s revocation. smithers-8a accepts the spike report and protocol amendments; Will decides any product change. Neither owner may silently treat sshd or relaxed revocation as a passing result.

## Ready checklist

1. Dependencies: standalone W0 prototype uses existing `msb` 0.6.16, `DefaultImage`, transport and guest helper plus a second Mac with OpenSSH/VS Code. It does not require the later daemon, member-user or SSH-gateway tickets; synthetic users are prototype setup.
2. Exclusions: product implementation, admission, key import, attribution, privilege-split implementation, sshd, agent/remote forwarding and other-editor certification are explicit.
3. Boundary tests: C-SPK-08 enters the prototype gateway through OpenSSH/VS Code and the real transport; its host revocation operation exercises kill_sessions. Literal fixtures and independently observed cgroups, bytes and time bounds supply the oracle, never spec files or implementation constants.
4. Decisions: smithers-8a accepts evidence and frame amendments; Will decides product changes to sshd, isolation or the 5 s rule. smithers-3f accepts the gateway/supervisor security seam before a rerun.
5. Owner pre-review: smithers-3f: answered, BLOCKING edits applied (tech lead adopts). Startup kills and drains all old session cgroups before open_session, including after SIGKILL; C-SPK-08 step 8 proves that barrier. The helper is reference only and is never invoked for cgroup cleanup.
6. Root-input inventory: uid-0 user/cgroup setup, prototype/init installation/start/restart and root session supervision consume main-pinned or installed-bundle run.sh/supervisor/init/harness bytes; branch build outputs are refusal fixtures only and argv/env/destination paths; install-controlled image/msb/compiler/approved artifact identity, account/group/home/cgroup/kernel state and upstream image/tool/editor responses; member-controlled session/control frame fields (user/id/kind/argv/env/cwd, PTY/exec/SFTP path/flags/modes/bytes, TCP target, resize/signal/credit/data/eof/close/kill), branch workspace tree and retained member symlinks/cache/home; authenticated host relay/protocol/boot binding (install-controlled). R1–R4 inventories apply where adapter bootstrap/layers are used. Root executable, script, plist and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are forbidden at root. R4 reads the target index only from main, runs toolchain steps as agent, and validates destinations before use. Lands only after T-SEC-01 (R1–R3) and `TestRootLayerInputsValidatedBeforeUse`, `C-SPK-08/root-prototype-install-validation`, `C-SPK-08/root-session-input-validation` pass; may start before. R4 is owned by T-MCH-10’s sec10 follow-up; R5 is owned by T-FLW-01’s follow-up where used. R5 proves artifact bytes come only from the installed bundle/catalog digest, never the branch.

### Criterion 6 root-input inventory

The following audited inputs include hostile refusal fixtures. They do not authorize branch-built bytes at root. The adopted source restrictions above govern accepted inputs.

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

#### R4

Inputs by privileged substep:

- Prepare boot/bootstrap: base OCI image, parent/newest same-family snapshot, owner/holder/repository/name/key labels, CPU/memory/disk/timeout/budget, net-rule allowlist — **install-controlled** configuration/state; recipe key, network destinations and selected tools are **branch-derived**. Image and snapshot contents include upstream OS and prior **branch-derived** outputs. R1/R2 also apply.
- Toolchain root recipe: `.smithers/target-index.json` Environment.Toolchain download versions/URLs/SHA256, Rust channel/components/targets, PostgreSQL major, destinations; or detected language/version evidence from repository manifests and version files — **branch**. Bundled `toolchains.json`, detector and script templates — **main/install-controlled**. `.smithers/machine.json` package additions — **main**, explicitly pinned by resolver. Downloads/archive entries/install scripts/tool `--version` output, Rust dist metadata/artifacts, apt package indexes/packages/maintainer scripts and PGDG key — upstream network responses, **branch-selected** for indexed download URLs/pins, otherwise **install-controlled** approved upstreams. GitHub-hosted release responses are **GitHub**, selected by the branch where index supplies the URL. `/etc/os-release`, apt sources/keyrings, root temp dirs and existing executable/filesystem state — **install-controlled** image/snapshot, including prior branch outputs. Every env.json key/value and root subprocess environment is consumed; fixed overrides are HOME=/root, TMPDIR=/var/tmp, DEBIAN_FRONTEND=noninteractive, system PATH, empty PYTHONPATH; other base_environment values remain inputs.
- Root input plant: all declared input path names and bytes (package/lock/workspace manifests, Go/Cargo inputs, selected tool entry/source files, dprint config, Python/requirements/pyproject inputs as selected by recipe); `tarFiles` regular-entry metadata, generated tar bytes; fixed destination/cache path and UID/GID, existing prepare directory/ancestors — **branch** files/names, **main** tar construction/script/UID, **install-controlled** snapshot paths with prior **branch-derived** cache content. This root step consumes file bytes even though later dependency installers run as agent.
- Root browser system install: Playwright selection/version triggering shipped apt script — **branch**; fixed package argv — **main**; apt sources/signatures/indexes/packages/scripts — **install-controlled** image/upstream network. It is separate from the unprivileged browser installer.
- Marker/sync and offline verification: serialized schema/kind/key/name/parent/repository/inventory/creation record, marker path, existing marker/temp/parent files and snapshot — **install-controlled** record with **branch-derived** recipe identity and output; script/destination — **main**. Reading a matching marker verifies identity, not trust of all layer contents.
