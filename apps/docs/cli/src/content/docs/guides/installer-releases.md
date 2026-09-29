---
title: "Signed installer releases"
description: "Archive layout, release identity, and acceptance evidence for the npm CLI installer."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/guides/installer-releases.md"
---

Installer archives contain the same `@smthrs/cli` npm candidate that passes the
release gates. They include Node and installed dependencies; they do not build
another CLI. Linux and macOS each have amd64 and arm64 archives:

```text
smithers-v<version>-<os>-<arch>.tar.gz
  smithers
  runtime/node
  node_modules/
```

The launcher resolves installation symlinks and uses its adjacent runtime.
Installers must preserve the whole directory, verify before extraction, stage in
a private directory, and atomically replace the installation only after success.
Archive ownership is normalized to root. Installers should extract as the
installing user or use `--no-same-owner`. Extracting just `smithers` is unsupported.

## Release checks

The Release workflow consumes its tested npm candidate on each native platform.
It uses the portable Node distribution installed by `actions/setup-node`;
Homebrew builds that depend on external dylibs are not release runtimes.
It installs with lifecycle scripts disabled, archives the installation, removes
the build directory, then executes the relocated version, help, initialization, target listing, and
flow listing commands.
Each archive has a receipt binding its SHA-256 digest to the npm candidate and
source revision. All four receipts must agree with the tested npm candidate before signing.
Receipts are diagnostic evidence; the signature authenticates archive bytes,
not the separate receipt JSON.

Only `.github/workflows/release.yml` running at the exact version tag can sign.
A main-ref dispatch cannot sign for a supplied `releaseTag`. Cosign v3 signs the
complete filename-bearing `SHA256SUMS` and immediately verifies the bundle against:

- Issuer: `https://token.actions.githubusercontent.com`
- Identity: `https://github.com/smithersai/smithers/.github/workflows/release.yml@refs/tags/v<version>`

Verification uses Cosign's certificate and transparency-log checks. There is no
unsigned fallback or mirror-provided verification key. See
[Sigstore blob verification](https://docs.sigstore.dev/cosign/verifying/verify/).

The publication command verifies again, refuses an existing version prefix,
uploads archives, receipts, checksums and `SHA256SUMS.sigstore.json`, and writes
`latest.txt` last for a newer stable release. Prereleases and older stable
versions never replace latest. Publication is serialized across tags. An upload
failure leaves latest unchanged. GitHub retains only one pending publication per
concurrency group; redispatch a cancelled publication at its tag. A partial prefix
requires operator reconciliation before retry; never overwrite an existing
signed release.

## Hosted setup and outstanding evidence

Private deployment configuration supplies the `installer-publish` environment:
`SMITHERS_INSTALLER_BUCKET`, `SMITHERS_INSTALLER_S3_ENDPOINT`,
`SMITHERS_INSTALLER_ACCESS_KEY_ID`, and `SMITHERS_INSTALLER_SECRET_ACCESS_KEY`.
Set `SMITHERS_INSTALLER_FORMAT=npm-directory-v1` only after the hosted installer
supports the directory layout and atomic replacement. Public npm installation
and self-hosting do not require these settings.

The implementation is not a production release receipt. Track completion in
[Smithers #2845](https://github.com/smithersai/smithers/issues/2845) and the hosted
installer migration in [Plue #702](https://github.com/smithersai/plue/issues/702).
Completion requires a real signed tag, all four native consumer receipts, and
the default hosted installer succeeding for that tag. Unsigned copies, wrong
issuer/workflow/tag, changed checksums, and changed archives must fail before
extraction while preserving the previous installation.
