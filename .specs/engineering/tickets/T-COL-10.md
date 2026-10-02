# T-COL-10 Co-editing architecture: ADR 0003 and the stage-1 contracts (spec §7.6)

Stage S1 · Size M · Depends on T-COL-01 · Unblocks T-COL-03, T-COL-04, T-COL-06, T-COL-07, T-COL-08, T-APP-15 · Issue: to file
Spec: spec.md §7.4, §7.6, §9.2 · Delta: delta.md §4 · Product: mvp.md M-02, M-27, J3.5, §11 item 14

## Goal
Every interface that stage 3 co-editing depends on exists and is enforced from stage 1, so stage 3 adds a document layer without changing a stage-1 or stage-2 API.

## Scope
In:
- ADR 0003 "Live code co-editing: daemon-owned documents on one live channel", recording spec §7.6 and the measured numbers from T-COL-01.
- `base_digest` and actor on every write to a branch's files, with `409 stale` on mismatch.
- Reserved live-channel topics (`doc:code:<branch>:<path>`, `doc:wiki:<page>`) and binary frame kinds 1–2. They are accepted and answered `unsupported` until stage 3.
- A contract test file that pins each §7.6 row.

Out:
- The CodeMirror File card (T-APP-15).
- The daemon connection framing and the capture flush phase (T-COL-03).
- Post-write digests in change events (T-COL-04).
- Presence coordinates (T-COL-06).
- Documents themselves (T-COL-08).

Each of those tickets cites this ADR and adds its row to the contract test.

## Changes
- `docs/architecture/0003-live-code-co-editing.md` (new): the decision, the rejected alternatives (host-side documents through `PUT /files/content`; per-file `msb exec`), the §7.6 table, and the T-COL-01 latency results with their artifact path.
- `packages/backend/internal/routes` handler for `PUT /workspaces/{id}/files/content` (route at `packages/backend/internal/compose/router.go:1430`) → require a `base_digest` field. Return `409 {code: "stale", current_digest}` when the file's current SHA-256 differs.
- `packages/backend/internal/services/workspace_facets.go:244` `WriteWorkspaceFile` → takes `baseDigest` and an actor and performs the compare inside the guest write. The guest helper reads, compares and writes in one call, so the check is not a separate read.
- `docs/api/openapi/*.yaml` → the request field and the 409 response, kept in step with the served route (`openapi_conformance_test.go`).
- Every caller of the write route in `apps/app` and `packages/smithers` (`rg "files/content"`) → sends `base_digest` and handles 409 by reloading. No caller keeps a blind write.
- Live channel (T-COL-02) topic table → reserved names and frame kinds with an `unsupported` reply.
- `packages/backend/internal/compose/cocontracts_test.go` (new) → one assertion per §7.6 row this ticket owns. Later tickets append theirs.

## Tests
- Integration (real PostgreSQL, microVM or process runtime): write with the correct `base_digest` succeeds. A concurrent write by a second actor makes the first actor's next write return 409 and leaves the file unchanged.
- Integration: a write without `base_digest` is rejected with `400`, which proves no blind path remains.
- Unit: the live channel answers a subscription to `doc:code:b:p` with `unsupported` and keeps the connection open.
- Contract test: the OpenAPI document for the write route lists `base_digest` and 409.
- Honest state (C-UI-05 row): a refused stale write shows as refused in the card, never as saved.

## Acceptance
- [C-COL-01](../checks/C-COL-01.md): the stale write is refused, the reserved topics exist, and the ADR is merged.
- [C-UI-05](../checks/C-UI-05.md): Honest state: no state shown before its event; toasts settle only on terminal events

## Risks and notes
- Risk: the guest helper (`microsandbox/guest/smithers-guest.py`) can't compare and write atomically in one `msb exec`. Confirmed if the integration test shows a lost update under concurrent writes. In that case the compare-and-write moves into `smithers-machined` (T-COL-03) and the stage-1 window is documented.
- The CodeMirror choice lives here as a decision and in T-APP-15 as the build. If T-COL-01 shows the relay can't meet the keystroke budget, ADR 0003 records the fallback: a host-side document mirror for fan-out, with the daemon still the disk authority. The tech lead decides.
