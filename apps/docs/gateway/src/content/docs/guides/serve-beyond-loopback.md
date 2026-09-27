---
title: "Serve beyond loopback"
description: "Bind a gateway on a network address: the two opt-ins the policy requires, the credential every mount then enforces, and the request limits worth setting at the same time."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/gateway/docs/guides/serve-beyond-loopback.md"
---

A loopback gateway needs no credential. Its ingress still accepts only a
loopback `Host` and, when present, a loopback browser `Origin`; Origin-less CLI
requests keep working. Anything reachable from another machine needs two
opt-ins, and the policy refuses the bind rather than serving without them.

## The two rules

1. **A non-loopback host requires an explicit `listen` opt-in.**

   ```text
   Refusing non-loopback gateway bind 0.0.0.0 without an explicit --listen opt-in
   ```

2. **A non-loopback bind requires a bearer credential.**

   ```text
   Refusing non-loopback gateway bind 0.0.0.0 without a bearer credential
   ```

`NodeGateway.isLoopbackHost` accepts `127.0.0.1`, `::1`, and `localhost`.
Every other host, a LAN address and a public one alike, is treated as reachable
from elsewhere.

Both refusals are `bind_failed` `GatewayError` values, answered before anything
binds.

## Bind it

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"

const gateway = NodeGateway.layer(health, {
  host: "0.0.0.0",
  port: 7331,
  listen: true,
  credential: process.env.SMITHERS_TOKEN,
  allowedHosts: ["gateway.example.com"],
  // Optional, and worth setting behind a relay that cuts idle tunnels sooner
  // than 600 seconds.
  heartbeatMillis: 10_000,
  // Optional. One MiB by default.
  maxRequestBodyBytes: 256 * 1024
})
```

From the command line, bind the machine's concrete LAN address so that address
is also admitted by the Host policy (replace this example with your address):

```bash
export SMITHERS_TOKEN="<the bearer token from your secret manager>"
smthrs serve --host 192.168.1.10 --port 3000 --listen
```

The server reads the bearer from `SMITHERS_TOKEN`, which keeps it out of the
long-lived process's argv. See
[Serve the workspace gateway](https://cli.smithers.sh/guides/serve-the-workspace-gateway/).

## What the credential then covers

One credential authenticates every mount and binds one principal,
`{ id: "gateway", kind: "bearer" }`. This authenticator has no per-user or
per-run identity. Approval authority is separately configured on the owning
Control runtime: by default the bearer cannot approve or deny. To delegate,
provide `ApprovalAuthority` with that exact identity and allowed target kinds
and scopes. Delegation applies to everyone holding the shared credential; it
does not distinguish a human from an agent. See
[the approval contract](https://control.smithers.sh/guides/approvals/#who-may-decide).

The loopback Host/Origin restriction belongs to the credential-less local
mode. A bearer-protected non-loopback gateway accepts the network hostname it
was deployed under and relies on the configured credential instead.

Clients send it as a bearer token:

```bash
curl -s https://gateway.example.com/projections \
  -H "authorization: Bearer $SMITHERS_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary '{"_tag":"Request","id":1,"tag":"Projection.Snapshot","payload":{"selector":{"_tag":"workspace-runs"}},"headers":[]}
'
```

A WebSocket client sends the same header on the upgrade request. Node's global
`WebSocket` cannot set headers on an upgrade, so a browser reaches a
credentialed gateway through a relay that holds the credential rather than
holding it itself.

`/health` stays unauthenticated even here. It answers identity and nothing
else: no token, no run, no path.

## Two refusals that look alike and are not

`POST /rpc` is not edge-authenticated. It authenticates in band and answers
`@smthrs/control`'s typed `Unauthorized`, so a caller sees a control error
rather than a transport error, exactly as it would against a control server
hosting the same procedures. `/rpc/ws`, `/projections`, `/sync`, and both other
sockets are checked at the edge and answer 401 with a `unauthorized`
`GatewayError` body.

Why the two differ, and why it matters to a client's error handling, is in
[the trust boundary](/concepts/trust-boundary/#edge-authentication-and-where-it-deliberately-stops).

## Bound the requests while you are here

For a wildcard bind, set `allowedHosts: ["gateway.example.com"]` on
`NodeGateway.ServerOptions` to admit the hostname clients use. These entries
contain no ports or wildcards. A concrete bind host and the loopback names are
also accepted. The Host and Origin checks apply before bearer authentication;
a browser's Origin must match the requested authority, including its port.

This server binds plain HTTP. For network access, terminate TLS at a trusted
proxy or use an encrypted tunnel so the bearer token is not sent in cleartext.

An HTTP RPC body is capped at `GatewayServer.defaultMaxRequestBodyBytes`, one
MiB. A declared `content-length` over the limit is refused without reading the
body; a body that declares no length, or declares less than it sends, is
measured as it is read. Declared overflow is 413 `request_too_large`; the Node
host hard-closes a streaming overflow rather than draining attacker-controlled
bytes, so that client may see a connection reset. A body the server could not
read for another reason is 400 `malformed_request`.

`maxRequestBodyBytes` and `heartbeatMillis` are checked the same way and must
both be positive safe integers. A body limit of zero would refuse every request
and a cadence of zero would spin, so a composition that asks for either is
refused with `bind_failed` before it binds rather than after it is serving.

## Check the policy without composing anything

```ts
const refusal = NodeGateway.bindRefusal(options)
if (refusal !== undefined) {
  // refusal.code === "bind_failed", refusal.message names the rule that refused
}
```

`bindRefusal` is the same value `listenOptions` fails with and `layer` fails
through. Operating system listen failures, such as an address already in use,
are mapped to the same sanitized `bind_failed` shape, so a host has one failure
contract to handle rather than two.
