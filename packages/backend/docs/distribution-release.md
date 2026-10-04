---
title: "Preview image builds"
description: "Build and verify the preview-only Smithers image."
---

The Docker image is a private preview of Home, never an install or release artifact (M-41). Machines are off; no workspace, flow, terminal or check runs. Native PostgreSQL and app data reset with container replacement. No repository credentials or model keys enter the build or runtime.

From the repository root:

```bash
BUILD_SHA=$(git rev-parse HEAD)
docker buildx build --platform linux/amd64 --build-arg "BUILD_SHA=$BUILD_SHA" \
  -f distribution/Dockerfile --load -t smithers-preview:local .
SMITHERS_BUILD_SHA="$BUILD_SHA" SMITHERS_DOCKER_SKIP_BUILD=1 \
  bash distribution/test-preview.sh smithers-preview:local
```

The Docker backend stage invokes `sh scripts/build-backend.sh OUTPUT BUILD_SHA preview`. Only the optional `preview` argument adds `-tags smithers_preview`; two-argument install builds keep their existing behavior and unknown modes fail before compiling.

The Distribution image workflow builds and tests linux/amd64 on GitHub-hosted amd64. It checks Home, install bootstrap, unauthenticated workspace refusal, non-root execution, listeners, credential-free image configuration, revision and shutdown. Releases neither build nor publish this image. See the [preview image guide](../../../distribution/README.md#preview-image).
