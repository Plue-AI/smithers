# C-COL-01 Stage-1 co-editing contracts hold

Proves: mvp.md M-02, M-27 · spec.md §7.1, §7.6 · Layer: unit+integration · Stage: S1 · Tickets: T-COL-10, T-COL-07, T-APP-15, T-COL-03, T-COL-03a, T-COL-03r, T-COL-04a, T-COL-03a, T-COL-03, T-COL-04a, T-COL-04, T-COL-06
Automation: `packages/backend/internal/compose/cocontracts_test.go` (new), `apps/app/src/mainview/cards/CodeSurface.test.tsx` · Runs in: CI (pure codecs and View units); reference host (T-COL-07 real-machine lane)

## Setup
A backend with real PostgreSQL and one running workspace on a real microVM on the reference host for T-COL-07 guarded-write cases; pure codec cases remain DB-free and host-side, with two signed-in members, A and B, and the file `src/a.ts`. Steps 1–6 gate stage 1. Step 7 covers the §7.6 rows that T-COL-03, T-COL-04 and T-COL-06 append to the same test file, and re-runs in stage 2.

## Steps
1. A reads `src/a.ts` and gets digest d0.
2. B writes `src/a.ts` with `base_digest = d0`; the response carries d1.
3. A writes `src/a.ts` with `base_digest = d0`.
4. A writes without `base_digest`.
4a. Through the production coding/edit-atom tool bindings in a real machine, dispatch std read on fixed src/a.ts fixture bytes; B then writes fixed replacement bytes; dispatch write, edit and apply_patch with the stale read. Repeat against the authenticated daemon path in S2. Do not call FileMutation or write_file directly or fake the guarded filesystem. Expected bytes and independently calculated digests are test fixtures, never derived from spec files or production code at runtime.
4b. Through the real coding/edit-atom apply_patch binding, exercise add, delete, update and move in S1 and through the authenticated daemon in S2. Change each read source or destination externally, create a formerly absent destination, and try an unread existing destination. Submit a two-file patch whose later hunk is stale; repeat with an outside replacement at exchange.
5. Open `/api/live` as A and subscribe to `doc:code:<branch>:src/a.ts` and `doc:wiki:<page>`.
6. Render the File card for `src/a.ts` in the app's unit harness.
6a. (S1 contract gate) Replay the literal daemon↔host and browser golden frames with Go, Rust and TS contract codecs. Assert stream kinds, all RPC schemas, typed unsupported, actor envelopes and outbox ack bytes. The fakes replay the same fixtures; production codecs re-run them when implemented.
7. (S2 re-run) Exercise the real daemon framing, capture flush phase, change event and presence heartbeat. T-COL-03a and T-COL-03 prove the connection and flush; T-COL-04a and T-COL-04 prove post_digest; T-COL-06 proves coordinates.

## Pass when

- Step 4b: every stale or unread affected path returns stale_read. Both move paths are validated; source removal is guarded. The later stale hunk leaves all earlier hunks byte-identical, no new destination and no removed source. Displaced-digest rollback preserves the outside writer’s bytes. No read-ledger or diagnostic update reports a successful refused patch.

- T-APP-15 branch identity: two File cards for the same repository path on different branches receive only their own branch machine’s literal hover, diagnostics and definition answers, including when the shell selects the other branch.
- Step 2 returns 200 and the file holds B's content.
- Step 3 returns `409 {code: "stale", current_digest: d1}`, and the file still holds B's content byte for byte.
- Step 4 returns 400.
- Step 4a: each agent write returns `stale_read` naming the path, and the file holds B's content byte for byte.
- Step 5 returns `{"t":"err","code":"unsupported"}` (§7.1) for both topics, and the socket stays open.
- Step 6 renders a CodeMirror `EditorView`, and `rg "adapters/code-view" apps packages` returns no consumer.
- Step 5's frames name the document only by its topic: no frame or error carries a machine, VM or relay address, so the browser never learns where the Yrs authority lives (§7.6).
- The ADR `docs/architecture/0003-live-code-co-editing.md` exists on `main` with the §7.6 contracts. Its topology decision (§7.4.2) is filled in from the T-COL-01 re-run before T-COL-08 starts.
- (S2) The daemon framing reserves a document stream kind, `capture()` reports a flush phase, `file_written` and burst events carry per-file `post_digest`, and presence `where` carries `{path, line}`.

## Fail when
- Any write succeeds without a digest, or a stale write changes the file. That is a silent overwrite.
- A reserved topic closes the socket.
- The File card still renders through the Pierre file view.

## Evidence
`.artifacts/checks/C-COL-01/<ts>/`: test output, the HTTP transcript of steps 1–4, the live-channel frame log of step 5, the commit and the install version.
