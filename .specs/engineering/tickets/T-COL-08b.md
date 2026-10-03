# T-COL-08b Backend document relay and optional host mirror

Stage S3 · Size M · Depends on T-COL-10, T-COL-02, T-COL-03f · Unblocks T-COL-08, T-REL-02 · Issue: [#3630](https://github.com/smithersai/smithers/issues/3630)
Spec: spec.md §7.1, §7.4.1–7.4.6, §7.6, §8.4.1, §8.4.3–8.4.4, §9.1.2 (`open_doc`, `close_doc`, `rebase`), §9.2.1–9.2.6, §9.3.4, §9.4.1–9.4.2, §18 · Delta: delta.md §4 (`smithers-machined` S3, live channel S3) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02

## Goal

Implement docrelay.go against a Go fake daemon; keep the browser protocol independent of topology.

## Scope

In:
- Subscribe and authorize topics; resolve the authenticated actor, envelope frames on the reserved daemon document stream, reject cross-branch routing, and revoke subscriptions within 5 s.
- Enforce the 2 MiB budget and restart sync step 1 on overflow. Relay saved and epoch unchanged.
- If ADR 0003 selects a mirror, build codedoc.go here: sync as a §7.4.6 client and rebuild from the daemon after host restart before serving browsers. Reject foreign actor client ids on the browser-facing sync side.
Out:
- Daemon documents (T-COL-08a), client provider (T-APP-14), complete durability and performance proofs (T-COL-08).

## Changes

- Encode and decode only through `packages/backend/internal/machined/wire` (T-COL-10); no local frame types, so the golden frames in `packages/backend/internal/compose/cocontracts_test.go` keep guarding this codec (smithers-3f, 2026-10-02).
- `packages/backend/internal/live/docrelay.go` and `docrelay_integration_test.go`; conditional `codedoc.go`.
- Extend T-COL-03f with scriptable document stream behavior using the T-COL-10 fixtures. No real machine registry dependency; inject the branch connection interface.

## Tests

- Contract: Go fake daemon replays golden frames for sync, actors, awareness, saved, epochs, gone, refusals and backpressure; real relay must produce and consume the same bytes.
- Integration with real PostgreSQL and live middleware: unauthorized subscription refused, revocation ≤ 5 s, actor spoof refused, two branches isolated, overflow restarts sync.
- Mirror topology: kill and rebuild mirror against fake daemon; no premature saved or snapshot before rebuild.

## Acceptance

- Relay authorization and codec component tests pass. C-J3-04, C-DUR-04 K7 and C-PERF-03 require T-COL-08’s real stack.

## Risks and notes

- T-COL-10 fixes topology before implementation. A Go fake proves routing and protocol only; it cannot prove disk durability or p95.

