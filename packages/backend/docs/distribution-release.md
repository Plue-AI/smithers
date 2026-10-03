---
title: "Self-host image releases"
description: "Build, publish, and verify the public Smithers container image."
---

## Install a published release

Use the digest-pinned `ghcr.io/smithersai/smithers@sha256:...` reference in the
[release notes](https://github.com/smithersai/smithers/releases). Follow the
[installation and backup guide](../../../distribution/README.md) with that
reference in `SMITHERS_IMAGE`. A release without an image receipt is not an
available container release.

## Build from source

From the repository root at the desired revision:

```bash
export SMITHERS_IMAGE=smithers:local
BUILD_SHA=$(jj log -r @ --no-graph -T commit_id)
docker build --build-arg "BUILD_SHA=$BUILD_SHA" \
  -f distribution/Dockerfile -t "$SMITHERS_IMAGE" .
SMITHERS_BUILD_SHA="$BUILD_SHA" SMITHERS_DOCKER_SKIP_BUILD=1 \
  bash distribution/test-image.sh "$SMITHERS_IMAGE"
```

Use that local image with the installation guide. Source acceptance uses local
scripted model and evaluator responses, an actual PostgreSQL service, and the
packaged coding runtime. It checks file creation, judged completion, restart,
backup, restore, and version mismatch refusal; it does not measure model quality.

Standard file writes hold an exclusive sibling lock until the write settles.
The coding host releases only lock directories it created successfully and
refuses cleanup if a lock contains files. A pre-existing lock remains in place;
confirm its writer has stopped before recovering it manually.

## Publish

The existing Release workflow validates the image before publication. Its image
step builds `linux/amd64` and `linux/arm64` with the release version embedded in
the container, pushes the version tag, logs out of GHCR, and pulls both platforms
using an empty Docker credential directory. It also verifies anonymous pulls of
the manifest digest before adding that reference to the release notes. Dry runs
build both architectures into a local OCI archive and skip publication. Reruns
replace the existing image receipt while retaining the rest of the release notes. The Distribution image workflow runs the same acceptance
script on main.

The repository token requires `packages: write` and `contents: write`. GHCR's
package visibility must be public: the first package publication may require an
organization owner to change it in package settings. A private package fails the
anonymous-pull gate and receives no release-note receipt. After fixing visibility,
resume the release using its existing candidate procedure; never treat a pushed
private image as a completed public release.

`node scripts/set-release-version.mjs <version>` updates the image reference,
Dockerfile default, and persisted distribution version together with package
versions. The release contract test refuses drift. Record the release run, both
platform pulls, the digest, and container acceptance before marking publication
complete. A successful build alone proves none of those external receipts.
