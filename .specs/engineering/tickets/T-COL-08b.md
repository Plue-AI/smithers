# T-COL-08b Backend document relay and optional host mirror

Stage S3 · Size M · Depends on T-COL-03r, T-COL-02, T-COL-03f · Unblocks T-APP-14a, T-COL-08, T-COL-08a · Issue: [#3630](https://github.com/smithersai/smithers/issues/3630)
Spec: spec.md §7.1, §7.4.1–7.4.6, §7.6, §8.4.1, §8.4.3–8.4.4, §9.1.2 (`open_doc`, `close_doc`, `rebase`), §9.2.1–9.2.6, §9.3.4, §9.4.1–9.4.2, §18 · Delta: delta.md §4 (`smithers-machined` S3, live channel S3) · Product: mvp.md J3.5, §6.8 Live co-editing, §9 Live updates, M-02
Ready: 2026-10-03 smithers-8a sha256:d7e8a228d414

## Goal

Define the document wire payloads and implement docrelay.go against a Go fake daemon; keep the browser protocol independent of topology.

Scope changed by the minimal-code synthesis, 2026-10-03 (v1 §3): the reserved `doc:*` topics, document stream frames and the TS document contract move here from T-COL-10, because this is their first consumer.

## Scope

In:
- ADR 0004 `open_doc(path)` returns a stream id; `close_doc(stream)` closes it. T-COL-08b may add a path for logs without changing the stream selector. Check: C-COL-01.
- Reserved live-channel topics `doc:code:<branch>:<path>` and `doc:wiki:<page>` and binary frame kinds 1–2 on T-COL-02's channel.
- ADR 0004 S3 section: document sync, saved state vectors and epochs as payloads of the document kinds T-COL-03r reserved, without changing reserved bytes. Golden document frames join `packages/backend/internal/compose/testdata/cocontracts/`.
- `packages/rpc/src/LiveDoc.ts` (smithers-38): per-module TS contract; the `409 stale` refusal and `unsupported` reply are tagged schemas. `packages/rpc/src/testing/LiveDocRelay.ts`: fake relay that replays the golden browser frames for T-APP-14a. Pin `yjs` 13.6.32 in `packages/rpc/package.json` and record it in `MANIFEST.json`.
- Subscribe and authorize topics; resolve the authenticated actor, envelope frames on the reserved daemon document stream, reject cross-branch routing, and revoke subscriptions within 5 s.
- Enforce the 2 MiB budget and restart sync step 1 on overflow. Relay saved and epoch unchanged.
- If ADR 0003 selects a mirror, adapt the shared Yrs core extracted from `crates/smithers-ffi/src/wiki_document.rs:53` for the host mirror; `codedoc.go` is its relay adapter, not a second document engine. Sync as a §7.4.6 client and rebuild from the daemon after host restart before serving browsers. Reject foreign actor client ids on the browser-facing sync side.
- Build against the specified contracts of T-COL-03r, T-COL-02 and T-COL-03f while they are unavailable. Lands dark until T-COL-03r and T-COL-02: without the wire codec or authenticated live-channel handler, document subscriptions and frames are refused, never routed through another transport. T-COL-03f is test support only; no production fake fallback.
- Lands dark until T-COL-11: without an accepted ADR 0003 topology decision, refuse code-document subscriptions with `unsupported`; do not select a topology by default. Lands dark until T-COL-03 and T-COL-08a: without an authenticated branch connection and supported daemon document handler, refuse code-document subscriptions and updates with `unsupported`, send no snapshot or `saved`, and never open host working-copy files or launch a process. The branch connection is injected; this ticket does not call the real registry.
- Lands dark until T-COL-09: reserve and decode wiki topics but refuse them with `unsupported` until its authorized wiki adapter is mounted. `TestDocRelayDarkLanding` exercises each missing provider through the composed route. These activation preconditions are not code/schema dependencies.
Out:
- Daemon documents, disk writes/reconciliation, capture flush, safe-idle and rebase implementation (T-COL-08a); real machine registry/transport (T-COL-03); wiki persistence and old wiki POST/SSE removal (T-COL-09).
- Client provider and File card actions (T-APP-14a), UI Views, carets/selections, presence roster changes, a second Yrs core or live transport, host repository execution, root helpers and installation.
- Topology measurements/selection (T-COL-11), complete durability and performance proofs (T-COL-08).

## Changes

- Encode and decode only through `packages/backend/internal/machined/wire` (T-COL-03r); no local frame types, so the golden frames in `packages/backend/internal/compose/cocontracts_test.go` keep guarding this codec (smithers-3f, 2026-10-02).
- Extend T-COL-02's existing live-channel handler and middleware with `packages/backend/internal/live/docrelay.go` and `docrelay_integration_test.go`; conditional `codedoc.go`. These are planned paths, absent on inspected main, not existing implementations. Reuse the broker and durable cursors through T-COL-02; no parallel WebSocket server.
- The conditional mirror reuses the extracted Yrs core through its shared binding. No new TS or Go CRDT engine; if the shared binding is unavailable, mirror subscriptions remain `unsupported`. The relay topology requires no host document engine.
- Extend T-COL-03f with scriptable document stream behavior using the T-COL-03r fixtures plus this ticket's document frames. No real machine registry dependency; inject the branch connection interface.

## Tests

- Contract: Go, Rust and TS decode the same checked-in literal document frames; the version test checks the dependency pins against the reviewed `MANIFEST.json`. Expected bytes, tags, actors, state vectors, epochs and limits are literal fixtures, never generated by a production encoder or read from spec Markdown or implementation constants.
- `TestDocRelayWireContract`: connect authenticated WebSocket clients to the production composed `/api/live` route with real middleware and PostgreSQL, injecting T-COL-03f only at the branch connection seam. Replay golden sync, actors, awareness, saved, epochs, gone, stale/unsupported and backpressure frames in both directions; assert literal browser and daemon bytes. No direct relay or middleware bypass establishes acceptance.
- `TestDocRelayAuthorization`: on that route, refuse unauthorized subscriptions, foreign actor/client ids and forged authors-map updates; isolate two branches; revoke during subscription startup and after admission within 5 s. In relay topology assert the authenticated actor envelope reaches the fake daemon and its spoof refusal returns unchanged; in mirror topology assert the browser-facing mirror refuses the spoof before forwarding.
- `TestDocRelayBackpressure`: on that route, exceed the literal 2 MiB send budget and assert `gap` and sync step 1 restart.
- `TestDocRelayMirrorRecovery`: if ADR 0003 selects a mirror, discard and rebuild it against the fake daemon through the composed route; no snapshot before rebuild and no `saved` synthesized by the mirror. Assert saved state vectors and epochs relay unchanged across reconnect.
- `TestDocRelayDarkLanding`: on that route, remove each Scope provider in turn and assert the stated refusal, no daemon write, no host file/process fallback and no premature `saved`. Missing test support fails the test rather than enabling a production fake.
- `TestDocRelayDataOnly`: at subscription/open/update/close on that route, send literal repository text containing command syntax as document data; assert only the allowed document stream is used, with no exec/session, provisioning, privilege or host working-copy operation. Missing/unsupported daemon support refuses without executing anything. This ticket adds no execution lifecycle; real machine execution and root broker proofs remain with T-COL-03/T-COL-08a and their security gates.

## Acceptance

- All named contract and composed-route tests above pass, including dark landing and data-only processing. Run the mirror recovery test only for the accepted mirror topology. This is relay/component evidence against a fake daemon, not a durability or latency pass. C-J3-04, C-DUR-04 K7 and C-PERF-03 require T-COL-08’s real stack.

## Risks and notes

- smithers-8a accepts ADR 0004's S3 payload section and ADR 0003's topology decision after smithers-3f reviews the Go/daemon and security seams. smithers-38 approves the TS contract, golden fixtures, version pins and shared Yrs binding; smithers-b8 approves the browser-facing protocol/refusal API. No reserved-byte or topology change is decided by this ticket. Will decides any product guarantee change.
- T-COL-11 fixes topology before activation; the ticket can land dark against the specified contract. A Go fake proves routing and protocol only; it cannot prove disk durability or p95.
- Security: host relay/mirror processing uses install-shipped code as the non-root install user. Repository text and CRDT payloads are data, never loaded as modules or executed. Repository code runs only in machines (M-29), with no host fallback or sudo. This ticket adds no root step: root consumes no main- or branch-sourced inputs here. It neither installs/loads/executes branch-produced bytes as root nor generates/loads a sudo plist; both engineering README hard rules apply. smithers-3f reviews this boundary; `TestDocRelayDataOnly` and `TestDocRelayDarkLanding` prove the relay refusal path.

## Ready checklist

1. Dependencies: T-COL-03r supplies the wire codec/schema, T-COL-02 the production live handler, T-COL-03f the injected fake. All are earlier-stage code dependencies. Scope states dark refusals for unavailable contracts, topology, daemon connection/documents and wiki adapter; activation-only preconditions do not enter Depends on.
2. Exclusions: Scope assigns daemon/disk/capture/rebase, registry, wiki migration, client/actions and topology work elsewhere and excludes Views, carets/selections, duplicate engines/transports, host repository execution and root installation.
3. Boundary tests: named tests enter composed `/api/live` with real authorization/revocation middleware and PostgreSQL; only the daemon seam is fake. Checked-in literal golden bytes and limits fix expectations independently. Real-stack checks remain with T-COL-08.
4. Decisions: smithers-8a accepts ADR payloads/topology, smithers-3f approves Go/daemon/security seams, smithers-38 approves TS/shared-core/pin seams, smithers-b8 approves the public protocol API, and Will decides product guarantee changes.
5. Owner pre-review: smithers-3f: Does the composed route enforce authorization and revocation without cross-branch routing? Does the mirror rebuild before snapshots and forward only daemon save acknowledgments? Does every unavailable provider refuse without host execution or privilege escalation? smithers-38: Are literal Go/Rust/TS fixtures interoperable without duplicate codecs or Yrs cores? Are the LiveDoc subpath, fake export and exact version pins approved? smithers-b8: Are topic/refusal/saved/epoch payloads compatible with the File and wiki clients? Does dark landing keep unavailable documents uneditable without a fallback transport? Existing recorded answers stand; owners review amendments post hoc under Will's parallel-build directive.
6. Security: smithers-3f reviews M-29 and data-only processing; `TestDocRelayDataOnly` and `TestDocRelayDarkLanding` prove no relay-triggered execution or host fallback at the mounted route. No root step or root inputs exist in this scope; branch-produced root bytes and lane-generated sudo plists remain forbidden.

