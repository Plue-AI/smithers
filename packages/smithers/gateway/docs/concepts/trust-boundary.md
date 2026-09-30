---
title: "The trust boundary"
description: "What one gateway credential authorizes, why a network bind needs two opt-ins, which paths are checked at the edge and which authenticate in band, and what a refusal is allowed to say."
sidebar:
  order: 3
---

A gateway is a control plane on a socket. It can launch runs, cancel them,
steer them, and approve capability grants. Every rule here exists because the
failure it prevents is silent: an unauthenticated control plane on a laptop's
network address is a remote execution service that looks like a dev server.

## One credential, one principal

One shared bearer credential authenticates every mount and binds one identity;
it is not a per-user or per-run authorization system. Approval decisions have a
separate host-owned `ApprovalAuthority`, checked before reads/replay and again
at resolution. The default policy permits only the fixed local identities.
A gateway bearer needs explicit delegation to approve or deny.

That principal is server-owned, never client-supplied. A configured credential
stamps `{ id: "gateway", kind: "bearer" }`; a loopback bind with no credential
runs as `{ id: "local", kind: "operator" }`. A decision journaled under the
composition's default operator when a bearer holder made it would name the
wrong one, so `Approval.Submit` reads the authenticated principal and passes it
through to Control rather than letting the runtime default apply.

Delegating approval to `gateway/bearer` delegates it to every holder of that
credential. In particular, an agent sharing it has the same approval authority
as a human. Do not describe such a deployment as independent human approval.
For finer restrictions, supply a host policy over the authenticated principal,
target, decision, and scope. Approval policy is not a sandbox for callers with
arbitrary host code or direct database access.

A credential-free loopback gateway treats all native callers that can reach it
as the local operator. Host/Origin checks block browser-origin attacks; they do
not distinguish a human from a local agent that can make its own HTTP requests.
Use authenticated, independently authorized access and restrict that local
endpoint when human approval must be independent of the agent.

## Scoped, expiring tokens

The bearer credential is one credential, and it grants everything the gateway
serves for as long as it is configured. `smthrs token mint --scope read:runs
--ttl 1h` mints a narrower grant under it: an HMAC-SHA256 token carrying the
procedures the scopes name, an optional run or flow, and an expiry. The gateway
verifies it with the credential it already holds and stores nothing, so
rotating the credential revokes every token minted under it, and nothing else
does.

The edge admits a scoped token on its signature and expiry alone, because an
upgrade names no procedure, and only toward `/rpc`, `/projections`, their
sockets, and `/auth/ticket`; journal sync and the runtime bridge take the
bearer alone, and a ticket issued against a scoped token opens only the
sockets the token could open itself. Every RPC frame is then judged in band: a procedure
the token does not name, a run or flow it does not name, or a call that names
none when the token is confined, is refused with the same typed `Unauthorized`
a wrong credential earns. A `Watch` or `Projection.Subscribe` opened before the
expiry keeps streaming after it, since the check runs when the stream opens;
end the socket to end the grant.

A scoped token stamps `{ id: "gateway", kind: "scoped" }`. Delegating approval
to `gateway/bearer` does not delegate it to every token minted from the bearer;
a host that wants an `approve:runs` token to decide delegates to
`gateway/scoped` explicitly. The runtime bridge accepts the bearer alone.

## Two rules gate a bind, and both fail closed

1. **A non-loopback host requires an explicit `listen` opt-in.** Binding
   `0.0.0.0` because a port was free is how a workspace gateway ends up on a
   shared network by accident.
2. **A non-loopback bind requires a bearer credential.** Reachable from another
   machine, an unauthenticated control plane is a remote execution service.

A loopback bind with no credential is allowed, and is the local default.
Loopback alone does not exclude malicious web pages. Every HTTP request and
WebSocket upgrade must pass the Host allowlist and, when present, an Origin
check against the request's authority, including its port. Cross-origin and
opaque (`null`) origins receive 403 before any RPC runs. Native clients may
omit Origin. Forwarded headers do not override these checks.

A loopback bind with no credential is allowed, and is the local default. The
trust boundary there is the machine account, so the ingress guard requires a
loopback `Host` value. A browser request carrying `Origin` must also carry a
canonical `http` or `https` origin whose host and port equal that `Host`. That
rejects cross-site WebSockets and DNS-rebound hostnames without
requiring a CLI to invent a credential: non-browser clients carrying no
`Origin` remain accepted.
The default accepted Host names are `127.0.0.1`, `localhost`, and `[::1]`.
The Node host also admits a concrete bind host. Network and reverse-proxy
names must be listed explicitly in `NodeGateway.ServerOptions.allowedHosts`
(hostnames without ports); wildcard binds do not allow arbitrary Host names.
`NodeGateway.isLoopbackHost` accepts `127.0.0.1`, `::1`, and `localhost`, and
nothing else.

`NodeGateway.bindRefusal` answers the policy as a value, so a host can inspect
it before composing anything. `listenOptions` returns the same refusal in its
typed effect channel, and `layer` fails through its layer channel. Operating
system listen failures, an address already in use among them, are mapped to the
same sanitized `bind_failed` contract, so a caller has one shape to handle.

## Local request identity is checked before authentication

`NodeGateway.layer` enables `IngressOptions.loopbackOnly` whenever no bearer
credential is configured. Before any route, request body, or WebSocket upgrade
is handled, `layerIngress` refuses a foreign or absent `Host` with 421
`invalid_host`. It refuses an `Origin` whose host and port differ from the
request's `Host`, or that is not a canonical HTTP(S) origin, with 403
`invalid_origin`.

The Origin header is optional on purpose. Browsers attach it to WebSocket and
cross-origin requests; CLI clients normally do not. A same-origin Origin and an
Origin-less request both continue to reach the mount. A bearer-protected
non-loopback gateway does not enable the loopback `Host` rule, but the Origin
check still runs there: a browser client is served from the gateway's origin or
through a same-origin proxy.

## Edge authentication, and where it deliberately stops

`GatewayServer.protectedPaths` is checked before a body is read or an upgrade
is answered: `/projections`, `/sync`, `/rpc/ws`, `/projections/ws`, and
`/sync/ws`.

`POST /rpc` is deliberately not on that list. The control mount authenticates
in band through `ControlRpcs.ControlAuth`, whose declared error is
`ControlError.Unauthorized`, and that typed control error is the refusal
[the control plane publishes](/docs/guides/control-plane/): missing, malformed,
empty, and incorrect credentials all return the same typed error.

An edge 401 answered ahead of the mount would erase that. `ControlClient`
filters a non-2xx status, so every refusal would reach a caller as a
`TransportError`: the one class `@smthrs/control` reserves for a request that
failed _before_ a declared control response reached it. It would also make the
gateway refuse a call differently from `NodeControl.layerServer` hosting the
very same `ControlRpcs`.

The body limit still applies to `/rpc`, so an unauthenticated caller buys one
bounded body read and nothing else.

`/rpc/ws` stays edge-authenticated for a different reason. A socket is a
resource the server holds open, the RPC middleware can only refuse frames on a
socket that already exists, and a refused handshake has no RPC channel to
answer a typed error on. Its refusal is a transport fact either way.

## Browsers open sockets with a single-use ticket

A browser `WebSocket` cannot set an `Authorization` header, and a bearer in a
query string would land in logs and history. A credentialed gateway therefore
serves `POST /auth/ticket`: a request carrying an accepted bearer receives
`{ "ticket": "<64 hex>", "expiresInMs": 30000 }`. The client then opens
`/rpc/ws`, `/projections/ws`, or `/sync/ws` as `<mount>?ticket=<ticket>`.

- The ticket request passes the same Host and Origin checks as every other
  request, so a page from another origin cannot mint one.
- The first upgrade that presents a ticket consumes it, whether or not the
  upgrade completes. A replay, an unknown ticket, or one presented after 30
  seconds is refused with 401 `unauthorized`.
- The socket runs under the bearer the ticket was issued for, so every RPC
  frame authenticates exactly as it would with the header.
- A ticket opens only those three sockets. It never unlocks a request/response
  mount.
- Tickets live in the gateway's memory; a restart invalidates every
  outstanding one. At most 1,024 are outstanding; the oldest is dropped first.

A gateway with no bearer credential needs no ticket and does not serve
`/auth/ticket`.

## A path is classified the way the router will resolve it

The guard runs before the router, so it has to reach the router's verdict. An
alias it did not recognize would walk past the credential check and the body
limit and be answered by the mount anyway.

Measured against the `HttpRouter` this package is built on, all of `/%72pc`,
`/rpc;transport-parameter`, `/rpc/`, `//rpc`, `///rpc`, `/rpc//`, `/RPC`,
`/./rpc`, and `/foo/../rpc` reach the `/rpc` handler, while `/rpc%2f`,
`/rpc%3Bp`, `/%2frpc`, and `/rpc%20` do not.

`GatewayServer.routedPath` reproduces that. It resolves dot segments with
`URL`, takes each segment without its `;` parameter, drops empty segments,
decodes the rest with `decodeURI`, and compares without regard to case.
`decodeURI` rather than `decodeURIComponent` is what leaves a reserved
character encoded, which is what keeps `/rpc%2f` a different path here exactly
as it is to the router. An invalid escape is left as written, because it names
no mount either way.

This is not only about crafted aliases. `ControlClient`'s HTTP protocol posts
every call to `/rpc/`, so a literal comparison skipped the body limit on the
path `@smthrs/control`'s own client uses.

The normalization errs toward matching: a spelling it resolves to a mount that
the router then refuses is answered 401 rather than 404, which costs an
unauthenticated caller nothing it was entitled to.

## Ingress runs before the transport parses anything

`GatewayServer.layerIngress` is one global middleware, and it applies these
checks in order:

1. Refuses a `Host` outside `allowedHosts`, or a non-loopback `Host` when
   configured as `loopbackOnly`, with 421 `invalid_host`, then a browser
   `Origin` whose host and port differ from the request's `Host` with 403
   `invalid_origin`. These checks cover HTTP and WebSocket upgrades alike.
2. Refuses an unauthenticated request to a protected path with 401
   `unauthorized`.
3. For a `POST` to an RPC mount, refuses a declared `content-length` over the limit with 413
   `request_too_large`. A body that declares no length is measured as it is
   read; the Node host destroys its source as soon as it crosses the limit, so
   a streaming client may observe a connection reset instead of a response.
4. Refuses a body carrying no RPC request message with 400
   `malformed_request`.

The fourth check exists because `effect/unstable/rpc` hands every decoded
message to the server loop, and a body that decodes to something else, `{}`,
`[]`, prose, or nothing at all, reached it as a message with no tag and died
there. The gateway answered `500 Internal Server Error` with an empty body,
which is the wrong half of the contract twice over: it tells an operator the
gateway broke, and it tells a client to retry a request that can never succeed.

The transport's own parser answers that question, not a second reading of the
wire format, so whatever `RpcSerialization` the host composed is the one
authority. A body naming a procedure that does not exist is a _yes_: that is an
RPC-level defect the protocol itself reports. A binary framing is always a yes,
because its body is not text and the mount owns it.

## Health carries identity and nothing else

`GET /health` is unauthenticated on purpose. A supervisor decides whether to
keep or replace a gateway process by asking which workspace it belongs to, and
a probe that needed a credential could not answer that about a gateway it did
not start.

The response carries the workspace hash, the gateway id, the protocol version,
and the package version. It never carries a token, a run, or a path. The
workspace hash is a digest of the resolved project root rather than the root
itself, because the path names directories on the operator's machine.

`/health` also answers while the rest of the process is degraded. A gateway
whose read path cannot read still comes up and still answers the identity
question, because startup must never be blocked by a subsystem that failed to
recover.

## A refusal says the least it can

`GatewayError.cause` carries a redacted summary of an internal failure: its tag
and its stable code, never its message, its nested cause, or the SQL and file
paths a `PersistenceError` carries. Projection logs contain only an
allowlisted operation identifier and known control error tag/code pairs. The
runtime bridge answers with a stable code and logs the full cause of any failure
the caller did not cause to the host log, so a failed launch can be diagnosed
from the host.

The reason is the error's reach. `GatewayError` is the RPC error schema, so
anything left on it is serialized to every bearer holder and forwarded to a
browser by a relay, and a cause JSON cannot encode would make the error frame
itself fail to encode.
