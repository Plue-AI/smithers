---
title: "@smthrs/gateway"
description: "One HTTP surface over a Smithers workspace: the control plane, live projections of every run, the journal sync read path, and a health probe, served on one socket that any client can read."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/gateway/docs/README.md"
---

`@smthrs/gateway` puts a Smithers workspace on a socket. One HTTP server carries
four things: the control plane that starts, approves, steers, and cancels runs;
read-only projections of what those runs are doing; the journal sync read path a
follower replicates from; and an unauthenticated health probe that answers which
workspace this process belongs to.

You install it when you want a workspace readable and controllable from outside
the process that owns it: a dashboard, a browser relay, a CI job, another agent,
or your own service.

## The problem it solves

An agent run that takes hours outlives the terminal that started it, and the
people who need to see it are not sitting at that terminal. Handing them the
database is the wrong answer: a reader that opens the engine's tables couples
itself to storage that changes, and it can read things no client should see.

This package answers with a contract instead, and holds three promises:

- **A row is a fold, not a table.** Every served row is computed from the
  ordered control events a run already publishes. The gateway never opens the
  engine database, so a projection cannot drift by reading a column the control
  plane does not expose.
- **A remote reader and a local reader see the same thing.** The rows a browser
  receives through a relay are the rows a local process computes from the same
  events, because there is one code path and no privileged one.
- **A network bind fails closed.** Loopback needs no credential. Anything
  reachable from another machine needs both an explicit opt-in and a bearer
  credential, or the bind is refused before it serves.

Reach for it when you are writing the client, the host, or the relay. Reach for
the command line instead when you want to drive runs from a shell.

## How it relates to the smthrs CLI

[`@smthrs/cli`](https://cli.smithers.sh/reference/api/) is the `smthrs` command line, and it is the top-level
package the rest of Smithers sits under. Start there if you are new.

[`smthrs serve`](https://smithers.sh/docs/reference/cli/serve/) is a host over this package: it resolves a project
on disk, builds the control plane and the journal over that project's database,
and hands the assembly here to bind and serve. Every mount you read in these
pages is the surface that one command puts on a port, which is why a client
written against this contract works against a gateway the CLI serves and against
one you host yourself.

The dependency runs one way. `@smthrs/cli` depends on `@smthrs/gateway`; this
package knows nothing about a terminal, a project directory, or a database file.
Install [`@smthrs/cli`](https://cli.smithers.sh/reference/api/) when you want a gateway without writing code.
Install `@smthrs/gateway` when you are writing a client against the wire, or
embedding the surface in a process of your own.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

The package needs Node.js 26.4.0 or later. For the peers and the
services a running composition supplies, see [Installation](/installation/).

## The smallest real example

The `smthrs` executable comes from [`@smthrs/cli`](https://cli.smithers.sh/reference/api/), not from this
package; [install it](https://smithers.sh/docs/installation/#install-the-cli), then serve a project you already have runs in:

```bash
smthrs serve
```

Then, from anywhere that can reach the port, ask the workspace what its runs
did. The read path speaks RPC over newline-delimited JSON, so one request is one
line:

```bash
curl -s http://127.0.0.1:3000/projections \
  -H 'content-type: application/json' \
  --data-binary '{"_tag":"Request","id":1,"tag":"Projection.Snapshot","payload":{"selector":{"_tag":"workspace-runs"}},"headers":[]}
' | head -1 | jq -ac '.exit.value.rows[] | {runId, verdict}'
```

```json
{"runId":"run-1","verdict":"completed \u2014 shipped"}
{"runId":"run-2","verdict":"waiting-approval \u2014 asks: Write to src/index.ts?"}
{"runId":"run-3","verdict":"failed \u2014 could not resolve seat anthropic:claude-sonnet-4-5"}
```

No client library, no schema of your own, and nothing that knows what a table
looks like. The tag, not the mount, decides whether a request streams, and
`/projections/ws` addresses both procedures: `Projection.Snapshot` there still
answers once, while `Projection.Subscribe` with the same payload on
`/projections/ws` answers a snapshot and then keeps sending, so a view follows
a run instead of polling it.

The folds behind those rows are exported, so a program holding a run's control
events computes the identical row with no gateway at all:

```ts
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"

const row = GatewayProjection.runSummary(run, events)
// row.verdict is the single line a run card leads with.
```

That bind is loopback, so it needs no credential and no opt-in. Its requests
still need a loopback `Host`, and any supplied browser `Origin` must be a
canonical HTTP(S) origin whose host and port equal the request's `Host`;
Origin-less CLI clients remain accepted. Anything else needs both a
bind opt-in and a bearer, and the layer fails with a typed `bind_failed`
`GatewayError` rather than binding. See
[Serve beyond loopback](/guides/serve-beyond-loopback/).

For a gateway you can probe and read within a minute, start with the
[Quickstart](/quickstart/).

## The package at a glance

The root entry point exports one namespace per module, and each is also
importable from `@smthrs/gateway/<Module>`:

| Namespace           | What it is                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GatewayServer`     | The whole HTTP surface as one application layer: seven mounts, the ingress guard, and the keepalives.           |
| `node/NodeGateway`  | The Node host that binds that surface to a socket under the bind and credential policy.                         |
| `Projections`       | The served read path: a snapshot of any selector, or a snapshot followed by a live tail.                        |
| `GatewaySchema`     | The wire vocabulary: selectors, cursors, snapshots, and the five subscription frames.                           |
| `GatewayProjection` | The served row types and the pure folds that compute them from control events.                                  |
| `GatewayRpcs`       | The remote procedures this package adds: the read path, and the composite approval mutation.                    |
| `Diagnosis`         | What happened to a run, folded from its own events and rendered as a verdict line and a card.                   |
| `GatewayError`      | Every stable failure code the gateway answers with, from a refused bind to a refused read.                      |
| `Sync`              | [`@smthrs/sync`](https://smithers-sync.smithers.sh/reference/api/) re-exported whole, so a host mounts the journal read path from one import. |

Every export, with its signature, is on the [API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, the public import forms, and
  the four services a host supplies.
- [Quickstart](/quickstart/): serve a workspace, probe its identity, read a
  snapshot off the wire, and follow one run live.
- Concepts: [projections](/concepts/projections/),
  [subscriptions and cursors](/concepts/subscriptions/), and
  [the trust boundary](/concepts/trust-boundary/).
- Guides: [host the gateway in your own process](/guides/host-the-gateway/),
  [read a projection over HTTP](/guides/read-a-projection/),
  [follow a run over a WebSocket](/guides/follow-a-run/),
  [submit an approval from a client](/guides/submit-an-approval/),
  [serve beyond loopback](/guides/serve-beyond-loopback/),
  [diagnose what happened to a run](/guides/diagnose-a-run/), and
  [test against a real gateway](/guides/testing/).
- [Troubleshooting](/troubleshooting/): every refusal this package answers
  with, what causes it, and what to change.
- [`@smthrs/control`](https://control.smithers.sh/reference/api/): the control plane these projections fold,
  and the contract `/rpc` mounts unchanged.
- [`@smthrs/cli`](https://cli.smithers.sh/reference/api/): the `smthrs` command line that hosts this gateway,
  and the package the rest of Smithers sits under.
