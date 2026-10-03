# C-SPK-06 A Homebrew-installed `msb` keeps the hypervisor entitlement and boots a microVM

Proves: mvp.md §6.1 Install on a Mac, §12.5, M-10 · spec.md §16.1.1 · Layer: spike · Stage: W0 · Tickets: T-INS-03
Automation: `scripts/spikes/homebrew-hypervisor/run.sh` (new, disposable; deleted after the answer is recorded) · Runs in: reference host, new macOS user

## Setup
- Reference host (checks/README.md), macOS 15 or later. A new admin macOS user with no Homebrew state, Homebrew at `/opt/homebrew`, no global npm `microsandbox`, no nvm.
- A local tap from `brew tap-new smithers-spike/tap`, never pushed, holding formula `smithers-spike`:
  - variant A: a prebuilt tarball with `msb` 0.6.16 and `lib/libkrunfw.5.dylib` (signature stripped); `install` runs `codesign --force --sign - --entitlements msb.entitlements`;
  - variant B: a bottle of A from `brew install --build-bottle` and `brew bottle`, poured with `brew install <bottle>`.
- `smithers-backend` from the T-INS-01 bundle (or a local Go build at the same commit).

## Steps
1. Install variant A. Record `codesign -dvv`, `codesign -d --entitlements -` and `xattr -l` for the installed `msb` and `libkrunfw.5.dylib`.
2. Run the installed `msb --version`.
3. Boot a microVM with the installed `msb` from the pinned image (`packages/backend/microsandbox/runtime.go:57`) and run `echo ok`. Record the wall time and the VM process's full command line.
4. Run `SMITHERS_MICROSANDBOX_BIN=<installed msb> smithers-backend microvm doctor`.
5. `brew uninstall smithers-spike`; pour variant B; repeat steps 1 to 4.
6. Log out, log back in, repeat step 3 for B.

## Pass when
- The issue records each attempted variant’s entitlement, signature, runtime version, resolved library path, boot/doctor result, prompts and failure evidence.
- A negative result completes the spike with a tested selected alternative: A-only, post_install re-signing, or Developer ID signing plus notarization.
- Record daemon yes/no and the selected LaunchDaemon or LaunchAgent plus automatic-login path. smithers-8a records the T-INS-08 fallback on #3471.
- T-INS-08’s C-INS-06 gates the selected S1 bundle’s boot/lifecycle. T-INS-05’s C-REL-02 gates the selected Homebrew distribution on a fresh user. An intentionally rejected variant need not pass.

## Fail when
- For the selected shipping variant: The poured `msb` lacks the entitlement and the boot fails with `HV_DENIED` or an `hv_vm_create` refusal.
- For the selected shipping variant: The VM boots through another `msb` (the command line in step 3 points outside `/opt/homebrew`).
- For the selected shipping variant: `libkrunfw` resolves from outside the keg.
- For the selected shipping variant: The variant passes only for the macOS user who built the bottle.

## Evidence
`.artifacts/checks/C-SPK-06/<UTC timestamp>/`: `codesign-A.txt`, `codesign-B.txt`, `xattr.txt`, `boot-A.log`, `boot-B.log`, `doctor-A.json`, `doctor-B.json`, the formula file, `brew config`, `sw_vers`, the screen recording, the commit of `smithers-backend`.
