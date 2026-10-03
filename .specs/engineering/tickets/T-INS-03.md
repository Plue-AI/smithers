# T-INS-03 Spike: Homebrew ad-hoc signing and Hypervisor.framework from a launchd daemon

Stage W0 · Size S · Depends on — · Unblocks T-INS-02, T-INS-05, T-INS-08 · Issue: [#3471](https://github.com/smithersai/smithers/issues/3471)
Spec: spec.md §16.1.1 · Delta: delta.md §1 (Add: formula in a `smithersai/homebrew-tap` repository) · Product: mvp.md §6.1, §12.5, M-10; overview.md E-01
Ready: 2026-10-02 smithers-8a sha256:d99afc0fe69f

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
6. The privileged operation installs the test plist; the daemon runs as the installing macOS user. Host execution is packaged runtime code only; the fixed echo probe runs inside the VM. No repository code runs on the host and no member/agent gains guest sudo (§1.3, M-29). smithers-3f reviews C-SPK-06’s process command lines and launchctl identity evidence.
