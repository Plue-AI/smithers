---
title: "Model key isolation"
description: "Verify that repository commands cannot read operator model keys from a managed coding process."
---

## Operator keys

Store provider keys in `SMITHERS_PLATFORM_MODEL_KEYS_FILE`, readable only by
the backend owner (mode `0600`). Coding processes receive a credential scoped
to their binding and call the backend's metered model proxy. Catalog
environments reject raw provider credential names in every topology.

A hosted chat turn with no model, for an owner with no default model, runs a
priced default on managed credit. Its model host receives a
`smithers_chatturn_` credential bound to the turn's current producer
generation. The proxy refuses it once the turn is reclaimed, cancelled,
finished, or its lease lapses, and charges the turn's owner. An explicit
model keeps its own credential and fails when that credential is missing.

Use `SMITHERS_WORKSPACE_ISOLATION=microvm` for untrusted repositories.
Trusted-process execution shares the backend owner's permissions and is not
an isolation boundary: repository commands can read files that owner can read.

If an older self-hosted installation passed operator keys into coding
processes, rotate those keys, review provider usage, remove them from the
service environment, and upgrade. The passthrough was removed in
`e498639d72c3f6a36d4b4b47527ed55fc1a83e0d`.

## Acceptance evidence

The regression must execute a repository command that reads a matching,
live managed process's `/proc/<pid>/environ`. A missing or unreadable process
is a failure, not evidence of isolation. A deliberately leaking process
must make the same probe fail. Assertions and logs must never print keys.

The real microVM test composes the local coding environment and binding
credential through `BuildProcessSpec`, then launches a managed fixture in
the real workspace runtime. The fixture exercises process placement and
environment transport; it is not the packaged coding executable or a
completed model call.

Run it on a machine provisioned with the supported Microsandbox CLI and
guest image:

```bash
SMITHERS_REQUIRE_MICROVM_TESTS=1 SMITHERS_MICROSANDBOX_BIN=/absolute/path/to/msb \
  go test ./packages/backend/internal/compose \
  -run '^TestRealMicroVMHostEnvironmentCannotExposeOperatorKeys$' -count=1 -v
```

The required flag turns a missing CLI into a failure instead of a skip.

`pnpm install` already fetches the pinned `msb` 0.6.16 through the `microsandbox` package. On an Apple silicon Mac, point `SMITHERS_MICROSANDBOX_BIN` at `$(find node_modules/.pnpm -path '*microsandbox-darwin-arm64*/bin/msb')`; on Linux use the matching `microsandbox-linux-*` package.

Final release evidence also requires the packaged coding executable to
complete a model call through the proxy and the distribution acceptance
script to finish with `IMAGE_ACCEPTANCE_OK`. Keep these receipts separate
from a unit-test pass or a skipped microVM test. Track outstanding evidence
in [#2187](https://github.com/smithersai/smithers/issues/2187); distribution
publication and its acceptance belong to
[#2481](https://github.com/smithersai/smithers/issues/2481).
