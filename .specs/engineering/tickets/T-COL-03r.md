# T-COL-03r Rust crate skeleton, golden-frame codec and component hooks

Stage S2 · Size S-M · Depends on T-COL-10 · Unblocks T-COL-03a, T-COL-04a, T-COL-08a, T-REL-02 · Issue: [#3626](https://github.com/smithersai/smithers/issues/3626)
Spec: spec.md §5.3 (`machine`), §7.6 (rows 1, 5), §8.4.3, §9 (intro), §9.1.1–9.1.4, §9.4.1, §9.5, §16.1.1, §17.2, §19.1 · Delta: delta.md §3 (sleep/stop row), §4 (`smithers-machined`, host relay, delete head loop) · Product: mvp.md §6.7 Sleep and Cleanup, M-27, M-29

## Goal

Supply a compilable Rust crate, a golden-frame codec and injectable hooks so core, watcher and documents can build independently.

## Scope

In:
- Crate skeleton and conn.rs/rpc.rs codec consuming ADR 0004 and T-COL-10 golden frames.
- Hook traits for mutation locking, outbox, capture flush, burst close, session registry, document reconciliation and recorded versions. Component fixtures inject these interfaces; integration uses the production implementations.
- Rust fake host driven by shared golden frames.
Out:
- Core control handlers, root broker and durable capture (T-COL-03a); watcher (T-COL-04a); documents (T-COL-08a); backend registry (T-COL-03).

## Changes

- `crates/smithers-machined/Cargo.toml`, `PACKAGE.ts`, `src/main.rs`, `src/lib.rs`: initial compilable crate and build/test targets. T-COL-03a completes the musl binary and root workspace registration.
- `crates/smithers-machined/src/conn.rs`, `src/rpc.rs`: codec and typed request/response declarations.
- `crates/smithers-machined/src/hooks.rs`: injectable component traits.
- `crates/smithers-machined/tests/fake_host.rs`: load and replay `packages/backend/internal/compose/testdata/cocontracts/` frames without copying expected bytes.

## Tests

- Codec and fake host replay literal golden frames in both directions, including unsupported kinds, errors, acknowledgements, truncated frames and bounds. Expectations come from fixture bytes, never production encoders. Check: C-COL-01.
- Compile fixture implementations of every hook trait with the crate. Real durability and confinement checks remain with their implementation tickets.

## Acceptance

- C-COL-01 golden-frame component gate passes. All hook fixtures compile. This support ticket claims no complete durability or product journey pass.

## Risks and notes

- No backend, transport deployment or real session dependency. T-COL-03a retains T-COL-01 for the transport choice and T-TRM-06 for session feasibility.
