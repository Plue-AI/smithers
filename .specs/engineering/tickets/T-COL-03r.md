# T-COL-03r ADR 0004 wire contract, golden frames, Go and Rust codecs, crate skeleton and component hooks

Stage S2 · Size M · Depends on — · Unblocks T-AGT-02, T-COL-03, T-COL-03a, T-COL-03f, T-COL-04, T-COL-04a, T-COL-06, T-COL-08a, T-COL-08b, T-REL-02 · Issue: [#3626](https://github.com/smithersai/smithers/issues/3626)
Spec: spec.md §5.3 (`machine`), §7.6 (rows 1, 5), §9 (intro), §9.1.1–9.1.4, §9.4.1, §9.5, §9.6.2 · Delta: delta.md §4 (`smithers-machined`, host relay) · Product: mvp.md §6.7, M-27, M-29

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §3): the wire contract, golden frames and codecs move here from T-COL-10, because this is their first consumer.

## Goal
Fix the daemon↔host wire contract once, with golden frames that gate the Go and Rust codecs, and supply a compilable Rust crate with injectable hooks so core, watcher and documents build independently.

## Scope
In:
- `docs/architecture/0004-machined-wire.md`: stream-kind discriminants (control, events, presence, reserved documents and sessions), byte order, lengths and bounds, request correlation, every §9.1.2 request and typed error, authenticated actor envelopes, seq/event_id, missing_objects and outbox ack, strict unknown-field refusal, the handshake (protocol version, boot id, relay secret, older-boot replacement), §9.6.2 session frames with 256 KiB initial credit, maximum frame size and the 1 MiB content limit (`MaxWorkspaceFileBytes`). No frame names a branch, machine or uid. Document kinds are reserved: decoded in every stage, refused `unsupported` by the S2 handler. T-COL-08b defines their payloads in S3 without changing reserved bytes.
- Golden frames under `packages/backend/internal/compose/testdata/cocontracts/` (`<name>.bin`, `<name>.json`, `MANIFEST.json`), consumed by Go and Rust; no expected byte comes from a production encoder.
- Go codec `packages/backend/internal/machined/wire/`, stdlib only; the only codec T-COL-03f, T-COL-03, T-COL-04 and T-COL-08b use.
- Rust crate skeleton, codec, hook traits and fake host.

Out:
- Core control handlers, root broker and capture (T-COL-03a); watcher (T-COL-04a); documents (T-COL-08a, T-COL-08b); backend registry (T-COL-03).

## Changes
Reuse: `MaxWorkspaceFileBytes` for the content limit; the `base_digest` write rule from T-COL-10 for `write_file`.

New (no daemon wire exists to reuse; the terminal WebSocket in `packages/backend/internal/routes/terminal_session_manager.go` carries no request correlation, outbox ack or actor envelope, so it was rejected as the frame format):
- `docs/architecture/0004-machined-wire.md`.
- `packages/backend/internal/machined/wire/` and `*_test.go` reading `../../compose/testdata/cocontracts`; a `go list -deps` test keeps it stdlib-only.
- `packages/backend/internal/compose/cocontracts_test.go`: one assertion per §7.6 row the S2 tickets own.
- `crates/smithers-machined/Cargo.toml`, `PACKAGE.ts`, `src/main.rs`, `src/lib.rs`, `src/conn.rs`, `src/rpc.rs`, `src/hooks.rs`, `tests/fake_host.rs`. Pin `yrs = "=0.27.4"` and record it in `MANIFEST.json`.

## Tests
- Go and Rust encode and decode literal requests, responses, errors, reserved kinds, events, acks and session frames, including missing_objects, duplicate receipts and reconnect order.
- Refusal vectors: unknown field (`uid`), an envelope naming a branch, truncated, oversized, unknown kind, reserved-in-S2 and trailing bytes; each is a typed error. The reserved-in-S2 vector proves the handler answers `unsupported`, not a decode failure.
- Rust fake host replays the frames in both directions. Fixture implementations of every hook trait compile.

## Acceptance
- [C-COL-01](../checks/C-COL-01.md): golden-frame component gate and ADR 0004 merged. This ticket claims no durability or journey pass.

## Risks and notes
- No backend, transport deployment or real session dependency. T-COL-03a keeps T-COL-01 for the transport choice and T-TRM-06 for session feasibility.
- A frame change regenerates fixtures and fails both codecs until both pass.
