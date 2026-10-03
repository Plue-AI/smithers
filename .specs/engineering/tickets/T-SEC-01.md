# T-SEC-01 Guest root boundary validation

Stage S1 · Size M · Depends on — · Unblocks T-ACC-02, T-AGT-04, T-APP-01, T-APP-05, T-APP-15, T-COL-03, T-FLW-01, T-FLW-02, T-FLW-03, T-FLW-04, T-FLW-05, T-FLW-09, T-FLW-11, T-GH-03, T-GH-06, T-GH-07, T-INS-02, T-INS-07, T-MCH-01, T-MCH-11, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05, T-STK-02 · Issue: [#3657](https://github.com/smithersai/smithers/issues/3657)
Owner: smithers-3f
Spec: spec.md §1.3, §11.1, §17.3 · Delta: delta.md §4 · Product: mvp.md §9, M-29, M-30
Ready: 2026-10-02 smithers-8a sha256:361c57d6c22b

## Goal
Validate the shared guest root boundary before the nine flagged tickets land. Tickets may start before this ticket completes.

## Scope
In:
- R1 guest helper installation and privileged interpreter startup.
- R2 root setup, ownership/mode changes and home defaults.
- R3 root exec supervision, file-operation entry, cgroup cleanup and relay.

Out:
- R4 layer builds, owned by frozen T-MCH-10’s sec10 follow-up.
- R5 packaged artifacts and coding binding, owned by frozen T-FLW-01’s follow-up.
- The S2 root broker/daemon, per-member identity allocation, host launcher and sudo/launchd installation, toolchain selection and public API changes.

## Changes
- Extend existing microsandbox plumbing: `packages/backend/microsandbox/guest.go:16–77`, `runtime.go:586–599`, `exec.go:189–215`, `files.go:29`, `transport.go:126–139`, and `guest/smithers-guest.py` setup, home_defaults, run_exec and fs dispatch. No new prerequisite ticket is required: R1–R3 already exist in the microsandbox adapter. Landing requires a bundle-controlled `msb`, trusted guest interpreter/base executables and passing fresh/retained-machine R1–R3 tests below; a process adapter or host Python run supplies no acceptance evidence. R4/R5 follow-ups do not block this shared hardening slice.
- Pin privileged interpreter and install-command provenance, fixed PATH/PYTHONPATH and the digest-checked helper before root exec. Check: C-SEC-02, TestGuestHelperInstallPinsInterpreterAndEnv.
- Use no-follow ownership/mode operations (`lchown`, `-h`) and refuse symlinked ancestors before setup/home writes. Preserve confinement across replacements. Check: C-SEC-02, TestRootSetupNeverFollowsMemberSymlinks.
- Before UID drop, parse only the envelope’s fixed-identity fields. Apply argv/env/cwd/paths after dropping supplementary groups, GID and UID. Ignore hostile LD_PRELOAD/PYTHONPATH before the drop. Keep cleanup IDs within the fixed cgroup subtree and relay endpoints within installed authority. Check: C-SEC-02, TestRootPreflightParsesOnlyEnvelope.

## Tests
- `TestGuestHelperInstallPinsInterpreterAndEnv`: fixed PATH/PYTHONPATH and a digest-checked helper before root execs anything. Exercise hostile executable/import paths and helper parent/temporary substitutions through production startup; no root canary or outside write; trusted inputs succeed.
- `TestRootSetupNeverFollowsMemberSymlinks`: chown/chmod/home defaults use no-follow (`lchown`, `-h`) and refuse symlinked ancestors. The fixture is a member home with symlinks to `/etc` and `/root`. Include leaf/ancestor replacement races and retained wake; outside sentinel bytes, owner and mode remain unchanged.
- `TestRootPreflightParsesOnlyEnvelope`: request parsing before the UID drop reads only fixed-identity fields; argv/env/cwd/paths are applied after the drop; hostile env (`LD_PRELOAD`, `PYTHONPATH`) is ignored pre-drop. Include malformed/oversized/unknown envelopes, root/other-user selection, cgroup traversal and relay bounds. Independently observe empty supplementary groups and fixed GID/UID before payload execution.
- All three tests are driven from C-SEC-02 through the real microsandbox adapter with bundled `msb`, not a fake CLI or direct Python import. `TestGuestHelperInstallPinsInterpreterAndEnv` and `TestRootSetupNeverFollowsMemberSymlinks` call `Runtime.CreateWorkspace` and retained `Runtime.StartWorkspace`; verify trust before retained wake’s `kill-all`, which precedes `prepareGuest`. `TestRootPreflightParsesOnlyEnvelope` uses `Runtime.ExecuteCommand`, `OpenWorkspaceTerminal` (including `put-request`/`--request`), file APIs through `fileOperation`, cancellation/restart cleanup and `DialWorkspacePort` through production relay dispatch.
- Keep expected identities, allowed endpoints, refusal cases and sentinel bytes/owner/mode as literal test fixtures. Compute the helper digest independently from approved bundle bytes. No test reads the spec or derives expected policy from production constants or functions at runtime. The direct Python import in `guest_test.go:111` is supplemental coverage only. Check: C-SEC-02.

## Acceptance
- [C-SEC-02](../checks/C-SEC-02.md): all three named tests pass against production fresh and retained-machine paths with positive controls and machine-written receipts.
- No branch build output is installed, loaded or executed by root. Passing tests do not waive this prohibition.

## Risks and notes
- smithers-3f decides and accepts the interpreter/install provenance, identity envelope, no-follow/race protection, cgroup and relay validation seams, and signs off C-SEC-02 R1–R3 receipts before landing. No public API or ADR change is in scope.
- Digest equality alone does not prove parent, interpreter or import-path trust. Identity/path validation must precede use and resist replacement races.
- Existing setup follows symlinks and run_exec processes environment/cwd before drop. This ticket owns correcting those existing shared boundaries, not nine independent implementations.

## Root steps, inputs and sources

Repository code executes only as an unprivileged user inside a machine (M-29, spec §1.3); members and agents receive no sudo. smithers-3f reviews every root-input validation below. Root installs, loads or executes only main-pinned or bundle-shipped code; branch-built scripts, binaries, interpreters, imports and toolchains are forbidden even if a digest matches. Branch/member data remains a landing blocker until the named C-SEC-02 test proves validation before privileged use.

- R1: `TestGuestHelperInstallPinsInterpreterAndEnv` proves base/interpreter/helper provenance, fixed startup environment, trusted ancestors and replacement resistance on fresh and retained paths before any privileged helper, including cleanup. A branch-derived executable or import is refused.
- R2: `TestRootSetupNeverFollowsMemberSymlinks` proves bounded env.json data, fixed allowed keys/cache targets, trusted account identity and no-follow home/cache writes across replacement races. Branch-selected values cannot choose root executable/import paths; arbitrary or malformed values are refused before root use.
- R3: `TestRootPreflightParsesOnlyEnvelope` proves bounded envelope/request-file parsing, fixed non-root identity, protected request-file parents, cgroup names/subtree and relay endpoints. Command env/argv/cwd/file payloads are applied only after group/GID/UID drop; root never resolves a payload-selected path.

### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Terminal request ID, `/run/smithers/requests` directory/ancestors, request `.json` bytes, ownership/mode, stdin/file descriptors, terminal size and signal inputs — **main/install-controlled** IDs and transport settings; request payload and retained filesystem entries can be **branch/member-controlled**. Protected no-follow request creation/read/removal and bounded parsing are proved by TestRootPreflightParsesOnlyEnvelope.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

## Ready checklist
1. Depends on —: existing R1–R3 plumbing needs no new ticket; bundle-controlled runtime, trusted guest executables and passing fresh/retained R1–R3 receipts are landing preconditions.
2. Out of scope explicitly excludes R4/R5, the S2 broker/daemon and identity allocation, host launcher/sudo installation, toolchain selection and public API changes.
3. C-SEC-02 names production lifecycle, command, terminal, file, cleanup and relay boundaries; literal fixtures and an independently computed bundle digest define expectations.
4. smithers-3f accepts every root-boundary seam and validation decision and signs off the R1–R3 receipts before landing.
5. smithers-3f: authored the ruling 19:4x, ok. Pre-review questions covered by that ruling: Are R1–R3 owned together here? Which tests gate landing? Are branch-built root payloads forbidden regardless of test results?
6. M-29 confines repository execution to unprivileged machine users; R1–R3 list input sources and named validation tests, reviewed by smithers-3f; branch-built root code remains forbidden.

