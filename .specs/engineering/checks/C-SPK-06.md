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

## Pass when (daemon context)
- The same signed binary boots a microVM when started by a launchd daemon with `UserName` set to the installing user (`launchctl bootstrap system/…`), before any GUI login, and the plist install needs exactly one `sudo`. If this fails, record it and the T-INS-05 fallback (launchd agent plus automatic login) is chosen.

## Pass when
- For A and for B: the entitlements include `com.apple.security.hypervisor` = true; `Signature=adhoc`; no `com.apple.quarantine` attribute; step 2 prints 0.6.16; step 3 prints `ok`; step 4 reports ready.
- The screen recording shows no Gatekeeper, privacy or password prompt in steps 1 to 6.
- The ticket records one line per variant: "A: yes|no, B: yes|no", plus the formula lines that produced the passing variant.

## Fail when
- The poured `msb` lacks the entitlement and the boot fails with `HV_DENIED` or an `hv_vm_create` refusal.
- The VM boots through another `msb` (the command line in step 3 points outside `/opt/homebrew`).
- `libkrunfw` resolves from outside the keg.
- The variant passes only for the macOS user who built the bottle.

## Evidence
`.artifacts/checks/C-SPK-06/<UTC timestamp>/`: `codesign-A.txt`, `codesign-B.txt`, `xattr.txt`, `boot-A.log`, `boot-B.log`, `doctor-A.json`, `doctor-B.json`, the formula file, `brew config`, `sw_vers`, the screen recording, the commit of `smithers-backend`.
