---
title: "Workspace connection revocation"
description: "Terminal and language-server connections stop when access is revoked."
---

## Connection behavior

Terminal and language-server requests subscribe to access revocations after
authentication and before repository authorization and workspace session lookup.
Recently revoked tokens and disabled accounts are checked after subscription.
Access checks run while that subscription is active, and the same subscription
remains active through startup and relay.

Custom routers must install `routes.WorkspaceSocketRevocations` after
authentication and before repository authorization for both connection routes.

Revocation observed before the WebSocket upgrade returns HTTP 403. If revocation
races or follows the upgrade, the connection closes with code 1008. Clients must
stop reconnecting with the revoked credential in either case. Terminal input and
resize messages stop even when a client ignores the close handshake. Revocation
delivery does not wait for that handshake.

Admission retains at most 64 unresolved revocation identities. Overflow cancels
startup and returns HTTP 503 (`service_unavailable`, `Retry-After: 1`); retry after
that delay. A matching revocation still returns HTTP 403.

Matching pending launches are canceled. A new durable terminal records its
creator's identity before publication; reconnecting does not replace that
identity. Revoking a reconnecting caller closes that caller's connection without
changing the creator's authorization.

## Local verification

The route regression tests use the real HTTP and WebSocket handlers, session
managers, and revocation bus, with controlled authorization and SSH fixtures.
Channels pause startup to deliver revocations deterministically. Run from the
repository root:

```bash
go test -race -count=1 ./packages/backend/internal/routes -run 'WorkspaceSocket|TerminalGuardCleanup|LSPRevokedRelay|RevokesMatchingPendingLaunch|ReusedSessionCallerRevoked|CancellationInterruptsStalledHandshake|RuntimeTerminal'
```

These tests do not establish hosted deployment or database acceptance.
