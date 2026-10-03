# T-INS-03 Record Homebrew signing and LaunchAgent evidence

Stage R · Size S · Depends on T-INS-01 · Unblocks T-INS-05 · Issue: [#3471](https://github.com/smithersai/smithers/issues/3471)
Spec: spec.md §1.3, §16.1.0–§16.1.2 · Delta: delta.md §0–§1 · Product: mvp.md §6.1, M-10, M-29 · Check: C-SPK-06
Ready: 2026-10-03 smithers-8a sha256:bae4217452ca

## Goal
Record whether the formula and bottle preserve the pinned msb's hypervisor entitlement and relocatable library path. This is release evidence only; it does not select or gate the S1 service.

## Scope
In: local unpublished tap; prebuilt tarball and poured bottle; fresh macOS user; pinned msb, image and libkrunfw from T-INS-01's digest-verified bundle; a disposable GUI-domain test LaunchAgent.
Land dark: if T-INS-01 has not landed, commit only the evidence harness against its specified manifest/layout contract. Refuse qualification when bundle files or digests are missing; do not substitute a branch build or claim a passing receipt. Check: C-SPK-06.
Out: production tap and release publication (T-INS-05); production lifecycle, automatic-login configuration and changes to T-INS-08's per-user LaunchAgent; LaunchDaemons and sudo; upgrade/backup/restore (T-INS-07); repository checkout, toolchain detection, dependency installs, retained machines and guest-helper setup.

## Changes
- Record artifact hashes, backend commit, signing entitlements, loaded library realpath and the tested formula variant.
- Preserve prior spike results as historical evidence on the issue. They do not authorize a different service.
- Reuse the installed `msb` and `smithers-backend microvm doctor` (`apps/backend/main.go:71–74`, `apps/backend/isolation.go:239–270`), unchanged. Pins exist at `packages/backend/microsandbox/cli.go:19` (0.6.16) and `runtime.go:57` (image digest).
- No product code. The C-SPK-06 disposable `scripts/spikes/homebrew-hypervisor/run.sh` is new: no Homebrew hypervisor harness exists today. Use the existing `scripts/check-run.mjs` receipt runner; do not add another runner. Remove the disposable harness after recording its answer.

## Tests
- C-SPK-06 `TestHomebrewSigningAndGUIBoot`: install A through `brew install --formula`, build/pour B through Homebrew, then invoke each installed absolute `msb` path for version, fresh-machine boot and in-machine `echo ok`; invoke the installed `smithers-backend microvm doctor`. Repeat under the disposable agent bootstrapped by `launchctl bootstrap gui/<uid>` and after logout/login. Record the literal plist, commands, process UIDs, signatures, entitlements, image/artifact digests and loaded library realpath. No fake CLI, direct adapter call or host echo supplies boot evidence.
- C-SPK-06 `TestHomebrewKegRelocation`: relocate the keg and repeat through the same installed commands and GUI agent. Require literal version `0.6.16`, entitlement `com.apple.security.hypervisor`, output `ok` and a loaded library inside the relocated keg.
- C-SPK-06 `TestHomebrewSpikeRootInputs`: through the harness entry point, reject a branch artifact/image, repository mount, alternate guest command or inherited guest environment before any privileged guest invocation; record that no VM command ran. Positive control uses the main-pinned inputs listed below.
- Expected version, entitlement, output and refusal cases are literal fixtures. Store approved artifact/image digests with the evidence; verify hashes independently. No test reads the spec or derives expected values from production constants or functions at runtime.

## Acceptance
- [C-SPK-06](../checks/C-SPK-06.md): record each variant's result and the three named tests; a rejected variant includes failure evidence and a tested selected alternative. Retain machine-written receipts bound to the landed commit and verified log digests.
- C-J1-04 and C-REL-02 qualify the integrated service and shipping distribution in their owning tickets; they are not acceptance gates for this evidence-only ticket.

## Risks and notes
Bottle relocation can strip entitlements. Record that failure before choosing tarball-only, re-signing or notarization. smithers-3f accepts the signing, relocation and root-input evidence and chooses the tested signing alternative; smithers-b8 accepts its packaging/CLI handoff to T-INS-05. Will decides any change to supported distribution or service behavior; this ticket authorizes no such change. No ADR or public API change is in scope.

## Security preconditions and root inputs
M-29 confines repository code to unprivileged users inside machines. This spike executes no repository payload. Homebrew installation/signing, the backend doctor and GUI LaunchAgent run as the installing user, without sudo. Only fresh machines from the main-pinned base image are allowed; no branch checkout, mount, layer, snapshot, helper or dependency output enters them. smithers-3f reviews the complete root-input inventory and TestHomebrewSpikeRootInputs evidence under C-SPK-06.

Guest boot and any diagnostic exec running as root consume only:
- Kernel, init, root filesystem, shell, dynamic loader, libraries, account/config files and image startup code: the T-INS-01 base-image archive selected by the main-pinned digest; verify archive/manifest digests before boot. No branch-built image or executable is allowed.
- Boot/exec command, machine name, resource flags, working directory, environment, stdin and mount configuration: literal main-committed harness settings; fixed diagnostic `echo ok`, empty stdin, scrubbed environment, fresh machine state and no repository mounts. Record the complete argv/env/cwd and effective UID. No caller-selected command or branch value is passed to root.
- Host `msb`, libkrunfw and backend bytes, their paths, signing entitlement file and artifact metadata: main-built T-INS-01 artifacts verified against the approved hashes; the local formula only installs/signs those bytes as the installing user. macOS/Homebrew tools and GUI UID come from the reference host; record their versions and paths.
- Filesystem, device and process observations: the fresh pinned guest and reference-host OS, with no retained member/branch state; VM output is evidence, never an executable input.

TestHomebrewSpikeRootInputs proves refusal before boot/exec for all branch-sourced alternatives. An unlisted or branch-sourced root input blocks execution and qualification; hashes do not authorize branch-built root code. Check: C-SPK-06.

## Ready checklist
1. Depends on T-INS-01 supplies the digest-verified backend, msb, library and image; missing artifacts refuse qualification, and an unlanded dependency lands dark against its contract.
2. Out of scope names release publication, production lifecycle, automatic login, LaunchDaemons/sudo, upgrade/backup/restore and repository/layer/helper execution.
3. C-SPK-06 names Homebrew install/pour, installed msb, production backend doctor and real GUI launchctl boundaries; three named tests use literal expectations and independently verified artifact hashes.
4. smithers-3f accepts signing/security evidence and chooses the tested signing alternative; smithers-b8 accepts the packaging/CLI handoff; Will decides product changes. No ADR or public API change is authorized.
5. Owner pre-review, recorded before start and reviewed post hoc under Will's directive: smithers-3f asks whether all root inputs are main-pinned and enumerated, whether relocated GUI boot proves library/signature behavior, and whether a rejected variant has a tested alternative; smithers-b8 asks whether the evidence leaves T-INS-08's service contract intact and whether T-INS-05 can consume the recorded signing procedure. No UI view or TypeScript library implementation changes.
6. M-29 and the root-input inventory forbid repository payloads and branch-built root code; smithers-3f reviews TestHomebrewSpikeRootInputs refusal evidence before qualification. Host steps require no privilege escalation.
