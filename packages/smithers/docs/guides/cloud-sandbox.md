---
title: Cloud sandbox
description: Place a flow's commands and files on a scoped Smithers Cloud workspace.
---

`CloudSandbox.make(options)` from `@smthrs/cli/CloudSandbox` returns a
`Sandbox.Provider`. Pass it to `Sandbox.layerHost(provider, { session })` to
place the flow's processes and filesystem on one Cloud workspace.

```ts
import { CloudSandbox } from "@smthrs/cli"
import { Sandbox } from "@smthrs/sandbox"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const host = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  const provider = CloudSandbox.make({
    spawner,
    repository: "owner/repository",
    sourceBookmark: "main",
    resources: { vcpu: 4, memory_mib: 8192, disk_gib: 40 }
  })
  return Sandbox.layerHost(provider, { session: "run:unique-issue" })
})
```

Build this with the local host's `ChildProcessSpawner`. The provider uses the
shared CLI login: `SMITHERS_API_ORIGIN` and `SMITHERS_TOKEN`, or the origin-bound
login from `smthrs auth login`. Supply `environment` to resolve another local
login. The token remains in the control transport; workspace creation contains
only its name, optional source bookmark and requested resources.

Each session key and canonical requested size map to `smthrs-` plus their SHA-256 hash. The Cloud API creates
or resumes that name and the provider polls until it is running. Concurrent
agents need distinct keys. Reusing a key resumes the same workspace and is an
exclusive claim: releasing either holder deletes it.

SSH commands use the same canonical transport that
`NodeControl.workspaceSshPrefix` exports, with pinned advertised host keys.
The `@smthrs/cli/CloudSandbox` subpath loads independently of the flow engine. Every command resolves a fresh grant and defaults `HOME` to `/home/developer` and the per-user locations (`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `NPM_CONFIG_CACHE`, `BUN_INSTALL`, `BUN_INSTALL_CACHE_DIR`) to directories under it, so `jj`, `npm` and `bun` use the workspace user's configuration and caches. An explicit child environment can override any of them for that command. Files and commands share
`/home/developer/workspace`; set `workdir` to use another absolute guest path.
Closing the layer scope ends commands and deletes the Cloud workspace,
including when provisioning or SSH setup fails or the caller is interrupted.
A deletion failure fails release so it remains visible.

`pollInterval` defaults to three seconds, `readyTimeout` to ten minutes, and
`namePrefix` to `smthrs-`. Workspace control requests are bounded to thirty seconds. The optional
`api: WorkspaceApi` transport allows deterministic provisioning and
cancellation tests; ordinary callers use the shared authenticated client.
Agent authentication belongs to each command's explicit input or environment,
separate from workspace provisioning.

Run the live smoke test with a disposable repository and a local Cloud login:

```sh
SMITHERS_CLOUD_SANDBOX_SMOKE=1 \
SMITHERS_CLOUD_SANDBOX_REPOSITORY=owner/repository \
pnpm --filter @smthrs/cli exec vitest run test/CloudSandbox.test.ts --coverage.enabled=false
```

The smoke test provisions a workspace, runs a command, round-trips binary
bytes, and releases the scope. It deletes its workspace on success or failure.

`resources` accepts optional positive integer `vcpu`, `memory_mib` and
`disk_gib` fields. Different sizes use different workspace names for the same
session, and key order does not affect reuse. The server validates its configured
limits before provisioning; `workspace_resources_exceeded` is surfaced to the
flow as a provider failure. Omit `resources` to keep the server defaults.
