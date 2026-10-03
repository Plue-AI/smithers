# T-SEC-01 Guest root boundary validation

Stage S1 · Size M · Depends on — · Unblocks — · Issue: [#3657](https://github.com/smithersai/smithers/issues/3657)
Owner: smithers-3f
Spec: spec.md §1.3, §11.1, §17.3 · Delta: delta.md §4 · Product: mvp.md §9, M-29, M-30

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

## Changes
- Extend existing microsandbox plumbing: `packages/backend/microsandbox/guest.go:16–77`, `runtime.go:586–599`, `exec.go:189–215`, `files.go:29`, `transport.go:126–139`, and `guest/smithers-guest.py` setup, home_defaults, run_exec and fs dispatch. No new prerequisite ticket is required.
- Pin privileged interpreter and install-command provenance, fixed PATH/PYTHONPATH and the digest-checked helper before root exec. Check: C-SEC-02, TestGuestHelperInstallPinsInterpreterAndEnv.
- Use no-follow ownership/mode operations (`lchown`, `-h`) and refuse symlinked ancestors before setup/home writes. Preserve confinement across replacements. Check: C-SEC-02, TestRootSetupNeverFollowsMemberSymlinks.
- Before UID drop, parse only the envelope’s fixed-identity fields. Apply argv/env/cwd/paths after dropping supplementary groups, GID and UID. Ignore hostile LD_PRELOAD/PYTHONPATH before the drop. Keep cleanup IDs within the fixed cgroup subtree and relay endpoints within installed authority. Check: C-SEC-02, TestRootPreflightParsesOnlyEnvelope.

## Tests
- `TestGuestHelperInstallPinsInterpreterAndEnv`: fixed PATH/PYTHONPATH and a digest-checked helper before root execs anything. Exercise hostile executable/import paths and helper parent/temporary substitutions through production startup; no root canary or outside write; trusted inputs succeed.
- `TestRootSetupNeverFollowsMemberSymlinks`: chown/chmod/home defaults use no-follow (`lchown`, `-h`) and refuse symlinked ancestors. The fixture is a member home with symlinks to `/etc` and `/root`. Include leaf/ancestor replacement races and retained wake; outside sentinel bytes, owner and mode remain unchanged.
- `TestRootPreflightParsesOnlyEnvelope`: request parsing before the UID drop reads only fixed-identity fields; argv/env/cwd/paths are applied after the drop; hostile env (`LD_PRELOAD`, `PYTHONPATH`) is ignored pre-drop. Include malformed/oversized/unknown envelopes, root/other-user selection, cgroup traversal and relay bounds. Independently observe empty supplementary groups and fixed GID/UID before payload execution.
- All three tests are driven from C-SEC-02 at the real lifecycle boundary. Extend `guest_test.go:111`’s existing setup test rather than treating its happy-path result as hostile-input proof.

## Acceptance
- [C-SEC-02](../checks/C-SEC-02.md): all three named tests pass against production fresh and retained-machine paths with positive controls and machine-written receipts.
- No branch build output is installed, loaded or executed by root. Passing tests do not waive this prohibition.

## Risks and notes
- Digest equality alone does not prove parent, interpreter or import-path trust. Identity/path validation must precede use and resist replacement races.
- Existing setup follows symlinks and run_exec processes environment/cwd before drop. This ticket owns correcting those existing shared boundaries, not nine independent implementations.

## Root steps, inputs and sources

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
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.
