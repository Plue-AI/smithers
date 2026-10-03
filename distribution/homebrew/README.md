# Tap release handoff

`Formula/smithers.rb.in` is the unmounted source for
`smithersai/homebrew-tap/Formula/smithers.rb`. There is no existing formula to reuse.
It preserves the signed CLI directory and installs the server beside it in
`libexec`, using GitHub Release assets and the existing tag-bound Cosign identity.
Its download strategy verifies cached and fresh archive bytes before extraction.

Do not publish this template or enable the disconnected release job. T-INS-01
must supply the assembler's output and manifest verifier, T-INS-03 the approved
signing and relocation procedure, and T-INS-08 the real keg-resolution test.
The unresolved tokens deliberately prevent installation. The CLI and server
archives must have separate digests in the formula and belong to the same signed
`SHA256SUMS`; extend `scripts/installer-release.mjs`, never add a second signer.

After the dependencies land, build and pour the bottle as an unprivileged user,
qualify C-REL-02 through the candidate tap and production CLI, retain the fault
and UID logs, and obtain smithers-3f and smithers-b8's approvals. Only then add
bottle metadata, publish verified assets to `smithersai/smithers` GitHub Releases
and open the tap formula bump. Hosted installer buckets do not serve this path.
The template does not qualify upgrades; T-INS-07 owns them.
