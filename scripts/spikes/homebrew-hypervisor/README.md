# C-SPK-06 input preflight (not qualified)

Run `scripts/spikes/homebrew-hypervisor/run.sh --bundle <absolute-bundle>`.
This disposable entry point currently performs input verification only and always
exits 2. It does not install Homebrew formulas, sign binaries, launch a VM,
bootstrap an agent, or publish receipts. Delete it after the spike is answered.

Required approval: `distribution/homebrew-spike-approved.json` on local `main`,
with version 1, revision (full main-built backend SHA), manifestSHA256, image
`node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b`,
and acceptedBy `["smithers-3f", "smithers-b8"]`. This file is absent today.
Caller hashes and lane-local approval files cannot substitute for main approval.
The manifest uses T-INS-01's version/platform/revision/files layout. Every file
must match its digest and mode; extra files and symlinks refuse. Symlink support
requires a reviewed complete input inventory before qualification.

`python3 -m unittest discover -s scripts/spikes/homebrew-hypervisor -p 'test_*.py' -v`
exercises the shell entry point using inert fixture files and a disposable local
Git repository. These tests are refusal evidence only, never boot evidence.
macOS strips DYLD variables before launching system Python; observable inherited
MSB, SMITHERS and loader variables refuse before verification.

Remaining: fresh macOS user; local unpublished tap A install/signing; bottle B
build/pour; absolute installed msb version/boot/in-machine echo and backend doctor;
resolved loaded library and signatures; keg relocation; disposable GUI LaunchAgent
and logout/login repeat. TestHomebrewSigningAndGUIBoot and
TestHomebrewKegRelocation have not run. No signing alternative is selected.
Use the existing scripts/check-run.mjs for qualification after its reference-host
binding is approved; its current refusal is retained, not bypassed by this spike.
