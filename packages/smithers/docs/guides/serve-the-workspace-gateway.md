---
title: "Serve the workspace gateway"
description: "Host this project's control plane over HTTP with smthrs serve, understand the loopback bind rule, and connect a client to the routes it mounts."
---

`smthrs serve` hosts this project's control plane over HTTP, for the product
UI, for another `smthrs --remote`, and for any client that is not this process.
It is the other side of [Local and remote control planes](../concepts/local-and-remote.md).

`smthrs gateway` is an alias of the same verb. Both spellings host the durable
trigger scheduler alongside HTTP, polling registered schedules and queued
occurrences. Neither spelling approves a trigger plan automatically.

## Serve on loopback

```bash
smthrs serve
```

```text
smthrs serve listening on http://127.0.0.1:3000
  /rpc              http://127.0.0.1:3000/rpc              control rpc
  /rpc/ws           ws://127.0.0.1:3000/rpc/ws             control rpc, including watch
  /projections      http://127.0.0.1:3000/projections      projection snapshots
  /projections/ws   ws://127.0.0.1:3000/projections/ws     projection subscriptions
  /sync             http://127.0.0.1:3000/sync             journal sync
  /sync/ws          ws://127.0.0.1:3000/sync/ws            journal sync stream
  /health           http://127.0.0.1:3000/health           workspace identity
  auth  no bearer (loopback Host; loopback browser Origin)
```

The default bind is `127.0.0.1:3000`. It needs no bearer, but requests must
carry a loopback `Host`; when a browser supplies `Origin`, that origin must use
`http` or `https` on `localhost`, `127.0.0.1`, or `[::1]`. Origin-less CLI
requests remain accepted. `--host` and `--port` change the bind. The
banner is rendered from `Serve.mounts`, the same list the composition is built
from, so it cannot advertise a route that answers 404. The server lives exactly
as long as the command.

Point a client at it:

```bash
smthrs --remote http://127.0.0.1:3000 ps
```

## The bind rule

Loopback needs no credential. `Serve.loopbackHosts` is `127.0.0.1`, `::1`, and
`localhost`; the local ingress guard rejects foreign Host values and browser
origins so a web page or rebound hostname cannot inherit the local operator.

Anything else needs both an explicit `--listen` and a bearer token. Export
`SMITHERS_TOKEN` before starting the server:

```bash
smthrs serve --host 0.0.0.0 --port 3000 --listen
```

Omitting either one is refused before the server is built:

```text
Refusing to bind 0.0.0.0: pass --listen to serve on a non-loopback address.
Refusing to bind 0.0.0.0 without a Bearer [REDACTED_TOKEN]: set SMITHERS_TOKEN.
```

`[REDACTED_TOKEN]` in the second sentence is not a value you passed. The
redaction pass every stderr line takes rewrites the phrase "bearer token" in
the CLI's own message.

The rule is strict because the failure it prevents is silent: an
unauthenticated control plane on a laptop's LAN address can launch agents with
the operator's credentials, and nothing about that looks wrong from the
outside. Prefer the exported `SMITHERS_TOKEN` environment variable. Use `smithers auth login` for remote clients; `SMITHERS_TOKEN` supplies the gateway host token.

A valid bearer is not automatically an approver in `smthrs serve` or its
`smthrs gateway` alias. The CLI host defaults to `ApprovalAuthority.local`; a credentialed gateway stamps
`gateway/bearer` and needs explicit host delegation to approve or deny. A local
operator can use `smthrs approvals approve` or `smthrs approvals deny` against
the same workspace.

Programmatic CLI hosts opt in through `Cli.makeCli({ approvalAuthority })` or
`ControlBridge.host`'s third argument. For example, this policy permits the
bearer to approve Plans with `once` scope and deny Plans, but gives it no Node,
`run`, or `remembered` approval authority:

```ts
import { ApprovalAuthority } from "@smthrs/control"
import { bearerPrincipal } from "@smthrs/gateway/node/NodeGateway"
import { Effect } from "effect"

const approvalAuthority = await Effect.runPromise(ApprovalAuthority.make([
  {
    principal: { id: "local", kind: "operator" },
    scopes: ["once", "run", "remembered"],
    targets: ["Plan", "Node"]
  },
  { principal: bearerPrincipal, scopes: ["once"], targets: ["Plan"] }
]))
```

This policy is host configuration, not a request flag. Delegating a shared bearer
delegates every holder, including agents. Custom policies replace the default;
include the local operator delegation to retain local approval through that host.

Lower-level hosts using `NodeControl.layer(Application.Config)` or
`NodeControl.engineDurable` directly retain a different default: a nonempty
`credential` automatically delegates Plan and Node decisions at `once`, `run`,
and `remembered` scopes to the gateway bearer. Supply
`approvalAuthority: ApprovalAuthority.local` to disable that delegation, or
supply a restricted policy such as the one above. See
[approval authority](/pkg/control/guides/approvals/#who-may-decide).

Read the [control-plane guide](/docs/guides/control-plane/)
before opting into a non-loopback bind.

## Identifying a gateway

`GET /health` is the one unauthenticated route. It answers the workspace this
gateway belongs to:

```bash
curl -s http://127.0.0.1:3000/health
```

```json
{
  "workspaceHash": "<16 hex characters>",
  "gatewayId": "cli-<pid>",
  "protocolVersion": "1",
  "version": "1.0.0-rc.0"
}
```

`workspaceHash` is the first 16 hex characters of the SHA-256 of the resolved
project root. A supervisor that finds a gateway already on a port asks
`/health` whether it is this workspace's before deciding to keep it or replace
it. The path itself is never published, because it names directories on the
operator's machine.

## Two removed subcommands

`gateway status` and `gateway stop` were removed. The bare `gateway` verb
survives as the `serve` alias, which is why `gateway` is registered as a
command group rather than an alias: an alias has no subcommands, and
`gateway status` would otherwise reach the parser as a stray positional
argument and exit 2 with `serve`'s usage text, telling an operator migrating a
script nothing.

Both now exit 1 with a sentence naming the replacement and a link to the
migration page.

## See also

- [`smthrs serve`](/cli/serve): the per-verb reference.
- [Local and remote control planes](../concepts/local-and-remote.md): what a
  `--remote` client can and cannot do.
- [`@smthrs/gateway`](/api/gateway): the server this verb hosts.
