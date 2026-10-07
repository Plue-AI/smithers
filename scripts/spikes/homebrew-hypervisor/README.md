# C-SPK-06 input preflight (not qualified)

Run `scripts/spikes/homebrew-hypervisor/run.sh --bundle <absolute-bundle>`.
Without `--execute`, this disposable entry point performs input verification and
exits 2 without installing or booting anything. With `--execute`, it runs the real
macOS harness after approval and refuses execution on Linux. Delete it after the
spike is answered.

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

Pending proof: fresh macOS user, A/B signing and boot, GUI service, relocated
keg, logout/login repeat, owner-selected signing alternative and C-SPK-06 receipt.
Use the existing scripts/check-run.mjs for qualification after its reference-host
binding is approved; its current refusal is retained.

Real harness: `run.sh --bundle <absolute-approved-bundle> --execute`. The entry
point verifies the inventory and main-committed harness before any Homebrew or
VM command. It runs `TestHomebrewSigningAndGUIBoot` followed by
`TestHomebrewKegRelocation`, retaining command argv, scrubbed environment, UID,
wall time, exit status and SHA256-bound logs under `.artifacts/checks/C-SPK-06`.
The local tap is unpublished. A failed variant retains evidence and stops;
selection of an alternative remains with the named owners. This is raw evidence,
not a passing receipt from a second check runner.

After logout/login, repeat from the fresh user with the same approved bundle;
remove the disposable tap/keg from the previous run first. Keep both evidence
directories and bind them to the landed SHA using `scripts/check-run.mjs` only
when its reference-host mapping is approved. Fresh-user and logout/login state
are owner-observed requirements, not asserted by this harness. No Mac execution
or C-SPK-06 qualification has been recorded on the Linux lane.
