# T-INS-03 Spike: Homebrew ad-hoc signing and Hypervisor.framework from a launchd daemon

Stage W0 · Size S · Depends on — · Unblocks T-INS-02, T-INS-05, T-INS-08 · Issue: [#3471](https://github.com/smithersai/smithers/issues/3471)
Spec: spec.md §16.1.1 · Delta: delta.md §1 (Add: formula in a `smithersai/homebrew-tap` repository) · Product: mvp.md §6.1, §12.5, M-10; overview.md E-01
Ready: 2026-10-02 smithers-8a sha256:7d315a2e97ef

## Goal
Two recorded yes-or-no answers before stage 1 needs them: whether a formula in a Homebrew tap installs an `msb` that keeps `com.apple.security.hypervisor` and boots a microVM on a fresh Mac, and whether Hypervisor.framework works from a launchd daemon that runs as the installing user (`UserName`) before anyone logs in (§16.1.2).

## Scope
In:
- A local tap made with `brew tap-new` and never pushed.
- Variant A: the formula downloads a prebuilt tarball (`msb` 0.6.16 and `lib/libkrunfw.5.dylib`, signature stripped) and its `install` step runs `codesign --force --sign - --entitlements msb.entitlements`.
- Variant B: a bottle of variant A, built with `brew install --build-bottle` and `brew bottle`, then poured.
- Both variants on a new administrator account on macOS 15 or later, with Homebrew at `/opt/homebrew` and no global npm `microsandbox`. T-INS-08 inherits these prerequisites and one sudo for the LaunchDaemon. Check: C-SPK-06.
- Daemon context: a LaunchDaemon plist in `/Library/LaunchDaemons` with `UserName` = the installing user, `RunAtLoad` and `KeepAlive`, running the passing variant's `msb`. Installing it takes one `sudo`. Reboot to the login window and, with nobody logged in, boot a microVM from the daemon.
- The decision the answer drives (§16.1.2): if the daemon boots a VM, T-INS-08 ships the LaunchDaemon with its one `sudo` at `smthrs host start`. On daemon failure, test a LaunchAgent using `launchctl bootstrap gui/$(id -u) <agent plist>` and record its VM boot and doctor output. Record the literal LaunchAgent plist. Automatic login remains unproven until C-INS-06 step 5; this spike does not claim a tested automatic-login fallback. The tech lead records the selected path before stage 1 ends. Checks: C-SPK-06, C-INS-06.

Out:
- The real tap (T-INS-05), the `smthrs host` lifecycle group and the production plist (T-INS-08).
- A `.pkg` (rejected in overview.md E-01). Notarization only as the fallback below.
- Signing any binary other than `msb`: only `msb` calls Hypervisor.framework.
- Repository flows, agents, dependency installation and checks on the host; Ruby toolchain detection; production automatic-login configuration; published signing artifacts.

## Changes
- `scripts/spikes/homebrew-hypervisor/` (new, disposable): `Formula/smithers-spike.rb`, `msb.entitlements` (hypervisor plus `com.apple.security.cs.disable-library-validation`, as upstream ships), `spike.daemon.plist`, `run.sh`. Delete the directory once the answers and the working formula and plist lines are recorded on the issue.
- No product code changes.
- W0 input: use C-SPK-06’s local backend build option with its commit recorded, not T-INS-01’s S1 bundle. Use the pinned image at `packages/backend/microsandbox/runtime.go:57`, msb 0.6.16 and its adjacent libkrunfw. Set `SMITHERS_DATA_ROOT=<tmp>` and `SMITHERS_MICROSANDBOX_BIN=<installed msb>` for doctor in every tested service context. Doctor checks msb doctor and the version pin; only the in-VM `echo ok` proves hypervisor execution. Record the realpath of the loaded dylib. Before starting, smithers-3f verifies the clean-user Mac, local tap and artifact provenance; attach hashes. Check: C-SPK-06.

Known before the spike, read on the maintainer's Mac: the upstream `@superradcompany/microsandbox-darwin-arm64` 0.6.16 `bin/msb` is ad-hoc signed (`codesign -dvv`: `flags=0x2(adhoc)`, no team id), carries both entitlements above, and links `Hypervisor.framework`; `lib/libkrunfw.5.dylib` sits beside it. The signing question is therefore narrow: does a Homebrew install or bottle pour keep that signature, or can the formula restore it.

## Tests
- Spike only. [C-SPK-06](../checks/C-SPK-06.md) defines the signing steps and their evidence.
- Daemon steps: retain the literal `spike.daemon.plist`, exact `sudo launchctl bootstrap system <plist>` and `launchctl print system/<label>` command lines, installing-user identity and prerequisites. After reboot to the login window, with no console user, run in-VM `echo ok` and `SMITHERS_DATA_ROOT=<tmp> SMITHERS_MICROSANDBOX_BIN=<installed msb> smithers-backend microvm doctor` under the daemon. Repeat after login and logout. On daemon failure, retain the literal LaunchAgent plist, `launchctl bootstrap gui/$(id -u) <agent plist>` and its boot/doctor evidence. Automatic login remains unproven until C-INS-06 step 5. Check: C-SPK-06.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1, R qualification; does not block W0 completion.

- [C-SPK-06](../checks/C-SPK-06.md): evidenced signing-variant and daemon decisions and a tested LaunchAgent boot/doctor alternative on daemon failure. Automatic login remains unproven until C-INS-06 step 5.
- The daemon answer and the T-INS-08 path (LaunchDaemon or launchd agent plus automatic login) are recorded on the issue.

## Risks and notes
- Homebrew rewrites and re-signs Mach-O files during bottle relocation. If that drops entitlements, variant B fails. Observation that confirms the risk: `codesign -d --entitlements -` on the poured `msb` lacks `com.apple.security.hypervisor` and the boot fails with `HV_DENIED`. Fallback: ship variant A only, or re-sign in `post_install`.
- Hypervisor.framework refusal under the LaunchDaemon is a daemon no. A passing login-shell doctor is not LaunchAgent evidence. Bootstrap the LaunchAgent in the GUI domain and record its VM boot and doctor result. Automatic login remains unproven until C-INS-06 step 5. Checks: C-SPK-06, C-INS-06.
- `msb` loads `libkrunfw` by a path relative to itself. Observation: a VM boot error naming `libkrunfw` after relocation.
- Formula downloads carry no quarantine attribute today. Observation that confirms a problem: `xattr -l` shows `com.apple.quarantine` and first launch prompts.
- If both signing variants fail, the fallback is Developer ID signing plus notarization of `msb` and the bundle inside the same formula, not a `.pkg`. This Mac holds a valid "Developer ID Application" identity (team 4QU7J75P89; ops agent, 2026-10-02), so the fallback costs about a day. `notarytool` keychain credentials are unconfirmed; ops is checking. Record the failure mode first.

## Ready checklist

1. No ticket dependency is required in W0: C-SPK-06 permits a local backend build instead of the S1 bundle. The clean Mac/user, pinned artifacts, local tap and artifact hashes are required inputs checked by smithers-3f before start.
2. Out names the real tap, production lifecycle/plist, .pkg, other binaries, host repository execution, Ruby detection, production automatic login and published artifacts.
3. C-SPK-06 invokes the Homebrew-installed msb and production doctor with `SMITHERS_DATA_ROOT=<tmp>` and the keg msb path. Record literal yes/no results, version 0.6.16, in-VM output ok, loaded dylib realpath and daemon login-window/login/logout evidence. Retain literal plists and exact bootstrap/print lines. An alternate runtime or doctor alone does not prove VM boot. On daemon no, record GUI-domain LaunchAgent boot/doctor; automatic login waits for C-INS-06 step 5. Expectations are literal fixtures or independent input logs, never runtime spec or production-code oracles.
4. smithers-3f accepts the signing/plist evidence; smithers-8a records the variant, notarization fallback and LaunchDaemon versus automatic-login choice on #3471 before stage 1 ends. smithers-b8 approves the host-command/quickstart handoff. The spike does not enable automatic login.
5. Owner pre-review: smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-3f: answered, BLOCKING edits applied (tech lead adopts).
6. Root-input inventory: sudo plist install and system-domain launchctl consume the installed-bundle spike.daemon.plist bytes/path/metadata and all label/UserName/program/argv/env/cwd/log/KeepAlive/RunAtLoad fields; install-controlled sudo/launchctl/domain/destination, OS account identity and inherited environment; approved msb/keg/libkrunfw/formula/bottle/tarball/hash/signature/entitlement/backend identities (install-controlled, with branch-authored formula/entitlements and upstream responses). launchd registration runs as root; the job must run as the installing user. Guest uid-0 boot/echo consumes the probe argv/script (main-pinned or installed-bundle only), pinned image/runtime and upstream image/guest OS responses, plus R1–R3 if the adapter is used. Root executable, script, plist and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are forbidden at root. R4 reads the target index only from main, runs toolchain steps as agent, and validates destinations before use. The sudo plist comes only from the reviewed spike script in the installed bundle, run once on the reference host after smithers-3f reviews the script; never from a lane workspace. Branch plist substitutions are refusal fixtures only. Lands only after T-SEC-01 (R1–R3) and `TestRootLayerInputsValidatedBeforeUse`, `C-SPK-06/root-plist-input-validation`, `C-SPK-06/guest-root-probe-provenance` pass; may start before. R4 is owned by T-MCH-10’s sec10 follow-up; R5 is owned by T-FLW-01’s follow-up where used. R5 proves artifact bytes come only from the installed bundle/catalog digest, never the branch.

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
