# T-COL-03f Fake machined for Go component tests

Stage S2 · Size S · Depends on T-COL-03r · Unblocks T-COL-03, T-COL-04, T-COL-08b, T-REL-02 · Issue: [#3625](https://github.com/smithersai/smithers/issues/3625)
Spec: spec.md §5.3 (`machine`), §7.6.1–7.6.2, §8.4.3, §9 (intro), §9.1.1–9.1.4, §9.4.1, §9.5, §16.1.1, §17.2, §19.1 · Delta: delta.md §3 (sleep/stop row), §4 (`smithers-machined`, host relay, delete head loop) · Product: mvp.md §6.7 Sleep and Cleanup, M-27, M-29

## Goal

Owner smithers-3f supplies a deterministic Go fake machined speaking the T-COL-03r bytes.

## Scope

In:
- Script status/read/write/capture/wake_reconcile replies, boot replacement, credential refusal, durable-event seq/event_id, missing_objects, ack loss and reconnect replay.
- Provide an injectable byte-stream seam for T-COL-08b; S2 reserved document requests return `unsupported`. S3 payloads remain with T-COL-08b.
- Lands dark until T-COL-03r: no runnable fake or contract PASS without its codec and committed fixtures; missing contracts fail the component gate. Never substitute local frame types or register the fake in install composition.
Out:
- Real Rust, jj, filesystem durability, machine admission and performance.
- Root broker, process execution, machine provisioning, real credentials, production fake selection, S3 document semantics and host registry/event-ingest implementations.

## Changes

- Encode and decode only through `packages/backend/internal/machined/wire` (T-COL-03r); no local frame types, so the golden frames in `packages/backend/internal/compose/cocontracts_test.go` keep guarding this codec (smithers-3f, 2026-10-02).
- Reuse T-COL-03r's codec, committed fixtures and `packages/backend/internal/compose/cocontracts_test.go` gate first. Add only scripted peer behavior in `packages/backend/internal/machined/testfake/`, shared by registry, event-ingest and docrelay tests. The existing `packages/backend/sandbox/sandboxfake/fake.go` records provider lifecycle and Execute calls; it has no multiplexed daemon protocol, handshake or outbox acknowledgements, so it cannot serve as this wire peer. Do not add another filesystem or lifecycle fake.
- Consume fixtures from T-COL-03r without copying or regenerating expectations.

## Tests

- `TestMachinedFakeGoldenReplay` in `packages/backend/internal/compose/cocontracts_test.go`: connect the scripted peer through a byte stream to the production `machined/wire` encoder/decoder; replay committed request, response, error and acknowledgement vectors in both directions. Compare bytes and decoded fields against literal T-COL-03r fixtures, never spec text or expectations generated from production code at runtime.
- `TestMachinedFakeFaultReplay` at the same wire boundary: script lost ack, duplicate event, missing object, rejected credential, boot replacement and reconnect order; compare the full transcript with committed literal expectations. Reserved S2 document requests return `unsupported`. This proves scripted transport behavior only; consumer tickets test their production registry, event-ingest and docrelay dispatchers with this peer, without bypassing them.
- `TestMachinedFakeUnscriptedRefusal`: an unlisted request fails rather than returning success or launching a command. The same T-COL-03r golden vectors gate the real Go and Rust codecs; this ticket adds no second codec gate.

## Acceptance

- All golden frames replay exactly. This support ticket proves no complete C-COL, C-DUR, C-J3 or C-PERF check.

## Risks and notes

- Keep fake behavior limited to contract scripts. Do not emulate a filesystem or infer expected frames from production encoders.
- smithers-3f decides the Go test seam, script coverage and reuse choice. ADR 0004 and wire changes stay with T-COL-03r; this ticket cannot redefine them or introduce a public API.
- Security review: smithers-3f verifies that the peer treats frames, paths, argv and credentials as test data only. It runs unprivileged, starts no repository command, broker, shell or VM, and consumes no real secret. There is no root step, so the root-input inventory is empty. Repository execution in consumer tests remains machine-only under M-29 and §17.3; fake replay cannot prove confinement. `TestMachinedFakeUnscriptedRefusal` gates fail-closed script behavior.

## Ready checklist

1. Dependencies: T-COL-03r is the sole called code/contract dependency, at S2; Scope names the dark landing and fails the gate when codec or fixtures are unavailable. Consumer tickets are unblocked users, not dependencies.
2. Exclusions: Out names real daemon, durability, admission, performance, root broker, execution, provisioning, credentials, production fake selection, S3 semantics and consumer implementations.
3. Tests: named golden, fault and refusal tests exercise the production wire codec through bytes with committed literal expectations; consumer dispatcher evidence stays with consumer tickets. No test reads spec files or generates its oracle from runtime code.
4. Decisions: smithers-3f approves the Go seam, coverage and reuse; T-COL-03r owns ADR 0004 and wire changes. No new public API is in scope.
5. Owner pre-review: smithers-3f (Go and infra), before start, with post hoc review allowed by the parallel-build directive. Questions: Does the byte-stream seam let registry/event-ingest/docrelay tests use production dispatch without bypasses? Does the fake reuse the single codec and literal fixtures without another filesystem/lifecycle implementation? Does the S2 document refusal keep S3 payload ownership with T-COL-08b?
6. Security: smithers-3f reviews the unprivileged data-only peer and its refusal test; no repository execution, real secret or root step is in scope, so there are no root inputs. Consumer repository execution must remain inside machines.

