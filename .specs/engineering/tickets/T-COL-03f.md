# T-COL-03f Fake machined for Go component tests

Stage S2 · Size S · Depends on T-COL-10 · Unblocks T-COL-03, T-COL-04, T-COL-08b, T-REL-02 · Issue: [#3625](https://github.com/smithersai/smithers/issues/3625)
Spec: spec.md §5.3 (`machine`), §7.6 (rows 1, 5), §8.4.3, §9 (intro), §9.1.1–9.1.4, §9.4.1, §9.5, §16.1.1, §17.2, §19.1 · Delta: delta.md §3 (sleep/stop row), §4 (`smithers-machined`, host relay, delete head loop) · Product: mvp.md §6.7 Sleep and Cleanup, M-27, M-29

## Goal

Owner smithers-3f supplies a deterministic Go fake machined speaking the T-COL-10 bytes.

## Scope

In:
- Script status/read/write/capture/wake_reconcile replies, boot replacement, credential refusal, durable-event seq/event_id, missing_objects, ack loss and reconnect replay.
- Provide a document-stream adapter for T-COL-08b.
Out:
- Real Rust, jj, filesystem durability, machine admission and performance.

## Changes

- Encode and decode only through `packages/backend/internal/machined/wire` (T-COL-10); no local frame types, so the golden frames in `packages/backend/internal/compose/cocontracts_test.go` keep guarding this codec (smithers-3f, 2026-10-02).
- `packages/backend/internal/machined/testfake/` (new), shared by registry, event-ingest and docrelay tests.
- Consume fixtures from T-COL-10 without copying or regenerating expectations.

## Tests

- Contract: the fake replays golden frames byte for byte in both directions, including errors and outbox acknowledgements; mismatches fail.
- Deterministic fault scripts cover lost ack, duplicate event, missing object and newer boot. The same golden-frame suite gates the real Go and Rust codecs.

## Acceptance

- All golden frames replay exactly. This support ticket proves no complete C-COL, C-DUR, C-J3 or C-PERF check.

## Risks and notes

- Keep fake behavior limited to contract scripts. Do not emulate a filesystem or infer expected frames from production encoders.

