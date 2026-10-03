# T-COL-03r ADR 0004 wire contract, golden frames, codecs, skeleton, FIFO executor and hooks

Stage S2 · Size M · Depends on — · Unblocks T-AGT-02, T-COL-03, T-COL-03a, T-COL-03f, T-COL-04, T-COL-04a, T-COL-05, T-COL-06, T-COL-08a, T-COL-08b, T-STK-08, T-TRM-07 · Issue: [#3626](https://github.com/smithersai/smithers/issues/3626)
Spec: spec.md §5.3 (`machine`), §7.6.1–7.6.3, §9 (intro), §9.1.1–9.1.4, §9.4.1, §9.5, §9.6.2 · Delta: delta.md §4 (`smithers-machined`, host relay) · Product: mvp.md §6.7, M-27, M-29
Ready: 2026-10-03 smithers-8a sha256:ff456be85e43

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §3): the wire contract, golden frames and codecs move here from T-COL-10, because this is their first consumer.

## Goal
Fix the daemon↔host wire contract once, with golden frames that gate the Go and Rust codecs, and supply a compilable Rust crate with injectable hooks so core, watcher and documents build independently.

## Scope
In:
- Objects travel as git bundles on ADR 0004 object streams before their events. The host verifies bundles and chooses branch-scoped incoming refs. Check: C-DUR-04. Security review: smithers-3f must approve before this lands (gaps 5–8).
- Reserve durable event variant 5 for transcripts (§9.6.6). T-AGT-02 owns the payload, framing limits and golden-frame extensions to these same codecs before import activation. Check: C-AGT-02.
- Supply `src/lock.rs` (FIFO executor and `LockCx`) with the skeleton so watcher and document hooks build before T-COL-03a. T-COL-03a owns `freeze.rs` and the production freeze sequence. Check: C-COL-03.
- ADR 0004 at `docs/architecture/0004-machined-wire.md` is this ticket’s contract: stream-kind discriminants (control, events, presence, reserved documents and sessions), byte order, lengths and bounds, request correlation, every §9.1.2 request and typed error, authenticated actor envelopes, seq/event_id, missing_objects and outbox ack, strict unknown-field refusal, the handshake (protocol version, boot id, nonce HMAC proof of the relay secret, older-boot replacement), §9.6.2 session frames with 256 KiB initial credit, maximum frame size and the 1 MiB content limit (`MaxWorkspaceFileBytes`). No daemon-sent frame and no actor envelope names a branch, machine or uid; `open_session` and `kill_sessions` carry the host’s `{login, uid}` for the broker’s check. Check: C-COL-04. Security review: smithers-3f must approve before this lands (gaps 5–8). Document kinds are reserved: decoded in every stage, refused `unsupported` by the S2 handler. T-COL-08b defines their payloads in S3 without changing reserved bytes.
- Golden frames under `packages/backend/internal/compose/testdata/cocontracts/` (`<name>.bin`, `<name>.json`, `MANIFEST.json`), consumed by Go and Rust; no expected byte comes from a production encoder.
- Go codec `packages/backend/internal/machined/wire/`, stdlib only; the only codec T-COL-03f, T-COL-03, T-COL-04 and T-COL-08b use.
- Rust crate skeleton, codec, hook traits and fake host.
- Lands dark until T-COL-03a and T-COL-03: the crate is not planted or started in a machine; `src/main.rs` exits nonzero without opening a connection or invoking hooks. The library dispatcher returns typed `unsupported` for each unimplemented hook, including document requests in S2. `TestMachinedSkeletonDisabled` and `reserved_document_unsupported` prove these defaults. No dependency code or schema is called by this ticket.

Out:
- Core control handlers, root broker and capture (T-COL-03a); watcher (T-COL-04a); documents and ADR 0003 topology (T-COL-08a, T-COL-08b, T-COL-11); backend registry, credentials and daemon planting (T-COL-03); transport measurements (T-COL-01); relay/bridge selection is a boot-file setting; real session processes, cgroups and SSH integration (T-TRM-06, T-TRM-07). No new presence roster or lease protocol (T-COL-06), UI, public app API, or TypeScript library export.

## Changes
Reuse: the 1 MiB limit already defined by `MaxWorkspaceFileBytes` (`packages/backend/internal/services/workspace_facets.go:23–27`); the §7.6.1 `base_digest` write rule owned by T-COL-10 for the `write_file` payload. These are contract values, not imports of services or calls to T-COL-10 code. The stdlib-only codec uses the literal limit; `TestWireContentLimit` compares it with fixed 1 MiB and 1 MiB + 1 fixtures. T-COL-03 enables the existing guest byte stream (`packages/backend/microsandbox/transport.go:92–102`); this ticket adds framing only, not another transport.

New (no daemon wire exists to reuse; the terminal WebSocket in `packages/backend/internal/routes/terminal_session_manager.go:456–480,599–614` sends terminal bytes and replay completion, with no daemon request correlation, outbox ack or actor envelope, so it was rejected as the frame format):
- Create `docs/architecture/0004-machined-wire.md` (ADR 0004); smithers-22 commit `471cdd152` lands it. Keep ADRs under `docs/architecture/`, not `.specs/adr/`. Check: C-COL-01.
- `packages/backend/internal/machined/wire/` and `*_test.go` reading `../../compose/testdata/cocontracts`; a `go list -deps` test keeps it stdlib-only.
- `packages/backend/internal/compose/cocontracts_test.go`: `TestMachinedWireGoldenFrames`, `TestMachinedWireRefusals`, `TestWireContentLimit` and `TestMachinedSkeletonDisabled`. Assert §7.6.1 write preconditions and §7.6.2 wire, presence and digest sentences. Exercise the exported Go codec and the compiled Rust crate; reserve real host integration for T-COL-03.
- `crates/smithers-machined/Cargo.toml`, `PACKAGE.ts`, `src/main.rs`, `src/lib.rs`, `src/conn.rs`, `src/rpc.rs`, `src/hooks.rs`, `src/lock.rs` (FIFO executor and `LockCx`), `tests/fake_host.rs`. Pin `yrs = "=0.27.4"` and record it in `MANIFEST.json`.

## Tests
- C-COL-03 component gate: enqueue fixture jobs in fixed arrival order and observe the same execution order. Compile watcher/document fixture hooks against `LockCx` without production core handlers.
- `TestMachinedWireGoldenFrames` and Rust `wire_golden_frames`: call the exported production encoders and decoders with literal requests, responses, errors, reserved kinds, events, acks and session frames. Fixed fixtures cover missing_objects, duplicate-receipt acks and reconnect ordering; this proves representation, not durable receipt handling.
- `TestMachinedWireRefusals` and Rust `wire_refusals`: unknown field (`uid`), an envelope naming a branch, truncated, oversized, unknown kind and trailing bytes return the fixed typed errors. `TestWireContentLimit` checks the literal content boundary.
- Rust `reserved_document_unsupported` and `unimplemented_hook_unsupported`: the fake host feeds literal frames through production `src/conn.rs` decoding and `src/rpc.rs` dispatch with default hooks; assert the literal response frame and no hook side effect. Reserved-in-S2 reaches dispatch and answers `unsupported`, not a decode failure. Fixture implementations of every hook trait compile.
- `TestMachinedSkeletonDisabled`: start the compiled `src/main.rs` executable as an unprivileged process and assert nonzero exit, no connection and no hook side effect.
- All expected bytes, limits, ordering and typed errors are committed literals independently reviewed by smithers-3f. No test reads spec files or derives expectations from production constants, encoders or code at runtime.

## Acceptance

- [C-COL-03](../checks/C-COL-03.md): the daemon-host wire contract (ADR 0004) holds under its fault cases
- [C-COL-01](../checks/C-COL-01.md), S2 wire component only: the named Tests above pass and ADR 0004 is merged with smithers-8a acceptance and smithers-3f wire/API sign-off. C-COL-01 is folded into ticket tests; this ticket owns the wire assertions, not T-COL-10’s stale-write gate or later integration, durability and journey gates.

## Risks and notes
- No backend, transport deployment or real session dependency. The boot file selects relay or bridge; neither this ticket nor T-COL-03a waits on T-COL-01. T-TRM-06 supplies session-feasibility evidence.
- smithers-8a accepts ADR 0004 and decides contract or scope disagreements; smithers-3f approves Go/Rust wire exports, hook seams, frame bounds and security refusals. A frame change requires their approval and independently updated literal fixtures before both codecs pass.
- Security review owner: smithers-3f. This ticket parses frames and dispatches unsupported hooks as an unprivileged component. It executes no repository code, loads no branch scripts or configuration, and introduces no root step; root-input inventory is empty. M-29 applies at integration: repository code runs only inside machines as a non-root session user. The broker and its complete main/branch input inventory and branch-input validation tests belong to T-COL-03a and T-TRM-07; this skeleton cannot enable them.

## Ready checklist
1. Dependencies: `Depends on —` is correct under rule 3; this ticket calls no other ticket’s code or schema. Scope lands dark until T-COL-03a and T-COL-03, with nonzero executable exit and typed `unsupported` defaults.
2. Exclusions: Scope names core, root broker, capture, watcher, documents/topology, registry/planting, transport, session/cgroup/SSH integration, presence leases, UI and public app/TypeScript APIs. New framing and the crate are justified against the existing terminal byte protocol; the guest transport and write contract are reused.
3. Tests: named Go codec and Rust connection/dispatcher tests consume independent literal fixtures; `TestMachinedSkeletonDisabled` exercises the compiled executable. No runtime spec parsing or production-derived expectation; later host and durability boundaries remain with their tickets.
4. Decisions: smithers-8a accepts ADR 0004 and scope disputes; smithers-3f signs off codec exports, hooks, frame bounds, fixtures and security refusals.
5. Owner pre-review: smithers-3f for backend/infra and the Go/Rust seam. Questions: Do the codecs and hooks cover §9.1.2 and §9.6.2 without implementing another owner’s handlers? Are frame bounds, actor/uid refusals and reserved document dispatch correct? Does the disabled executable prevent transport, root or repository execution before integration? Record answers here; under the parallel-build directive, owner review occurs post hoc and does not block Ready.
6. Security: smithers-3f reviews the unprivileged parser, unsupported hooks and disabled executable. No repository execution or root step is added; the root-input inventory is empty. Machine-only non-root execution and root-input validation remain required before the owning integration tickets enable execution.
