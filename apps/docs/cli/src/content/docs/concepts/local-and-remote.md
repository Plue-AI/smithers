---
title: "Local and remote control planes"
description: "What changes when a command runs against --remote: which layer is built, who owns the executor, whether a verb can wait for a run, and which operations refuse."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/concepts/local-and-remote.md"
---

Every command handler talks to the `Control` service and to nothing else. A
handler that reached into a store would answer differently under `--remote`,
and the point of the control plane is that it does not.

What changes is which implementation of `Control` gets built, and that decision
is made from `Application.Config` before the parser reads a token.

## The two compositions

| | Local | Remote |
| --- | --- | --- |
| Selected by | No `--remote` and no `SMITHERS_REMOTE` | Either one |
| `Control` implementation | `ControlLive`, in this process | `ControlClient` over RPC |
| Databases | Opens `.flows/control.db` and `.flows/engine.db` | Opens none |
| Executor | `NodeControl.layerExecutor`, in this process | The server's |
| Transport | None | HTTP for `/rpc`, WebSocket for `/rpc/ws` |
| Credential | Not used | `--credential`, else `SMITHERS_API_KEY`, as a bearer token |
| Memory | The durable store over the control database | Refused |

`--remote` must be an `http://` or `https://` URL. `NodeControl.makeConfig`
validates it and raises a usage error naming the flag, so a bad URL exits 2
before a transport can report a lower-level exception. The RPC path is appended
if it is missing, so both `https://host:3000` and `https://host:3000/rpc` reach
the same endpoint, and the WebSocket URL is derived from the same base.

## Executor ownership

`ExecutorOwnership` is the fact that decides whether a verb may wait for a run
to finish. A local composition that built an executor answers `true`. A
`--remote` client answers `false`, because the run is another process's to
drive and waiting here would hang on work this process never performs. The
default is `false`, so a composition that forgets to declare ownership refuses
to wait rather than waiting forever.

`Application.layer` supplies the value from what it actually built, so the fact
and the composition cannot disagree.

This is what makes the attached verbs behave differently across the two
compositions. Locally, `flow execute`, `flow start`, `approvals approve`, and
`approvals deny` stay attached after
the receipt is accepted, wait for the run to settle, and report the run's
outcome as their own exit status. Against `--remote` they print the receipt and
return, and the exit status is the receipt's alone.

## What a remote invocation refuses

Two operations are local by nature and say so rather than pretending:

- **Memory.** The control plane owns memory. Building the local store under
  `--remote` would create a `.flows/control.db` beside the operator's shell and
  write facts the server never reads, which is worse than a refusal because it
  looks like it worked. `smthrs memory` therefore refuses against a remote
  plane.
- **Detached launches.** `flow start -d` spawns a local executor, so combining it with
  `--remote` or `SMITHERS_REMOTE` exits 1.

`--mcp-config` is meaningless under `--remote` for the same reason: it
configures the local executor's flow catalog, and a remote composition's
executor is not this process's to configure.

## Serving the other side

`smthrs serve` is the other half: it hosts this project's control plane over
HTTP so another `smthrs --remote`, the product UI, or any other client can
reach it. The bind rule is strict, and the routes it mounts are the list the
banner is rendered from. See
[Serve the workspace gateway](/guides/serve-the-workspace-gateway/).

## Embedding

`Application.layer(config, registry, engine, executor)` is the
transport-neutral composition: it picks local or RPC from the same `Config` and
leaves its HTTP, serialization, and socket requirements for a platform module
to satisfy. `NodeControl.layer(config)` is the Node one that satisfies them and
adds the registry, the durable engine, the output service, the project
services, and the gateway host. See
[Embed the command tree](/guides/embed-the-command-tree/).
