# T-INS-03 Record Homebrew signing and LaunchAgent evidence

Stage R · Size S · Depends on — · Unblocks T-INS-05 · Issue: [#3471](https://github.com/smithersai/smithers/issues/3471)
Spec: spec.md §16.1.1 · Product: mvp.md §6.1, M-10 · Check: C-SPK-06

## Goal
Record whether the formula and bottle preserve the pinned msb's hypervisor entitlement and relocatable library path. This is release evidence only; it does not select or gate the S1 service.

## Scope
In: local unpublished tap; prebuilt tarball and poured bottle; fresh macOS user; pinned msb, image and libkrunfw.
Out: production lifecycle, automatic-login configuration and changes to T-INS-08's per-user LaunchAgent.

## Changes
- Record artifact hashes, backend commit, signing entitlements, loaded library realpath and the tested formula variant.
- Preserve prior spike results as historical evidence on the issue. They do not authorize a different service.
- No product code.

## Tests
- Run C-SPK-06 for both variants in the installing user's GUI LaunchAgent: record version, in-VM echo ok, doctor result and loaded library realpath.
- Relocate the keg and repeat. Require the same version and entitlements, ok, and a library inside the relocated keg.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): passes for this ticket’s phase at its stated layer.
- [C-SPK-06](../checks/C-SPK-06.md): record each variant's result; a rejected variant includes failure evidence and the selected alternative.
- [C-REL-02](../checks/C-REL-02.md): qualify the selected distribution.

## Risks and notes
Bottle relocation can strip entitlements. Record that failure before choosing tarball-only, re-signing or notarization.
