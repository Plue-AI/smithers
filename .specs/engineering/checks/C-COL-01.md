# C-COL-01 Stage-1 co-editing contracts hold

Proves: mvp.md M-02, M-27 · spec.md §7.1, §7.6 · Layer: unit+integration · Stage: S1 · Tickets: T-COL-10, T-COL-07, T-APP-15, T-UI-11
Automation: `packages/backend/internal/compose/cocontracts_test.go` (new), `apps/app/src/mainview/cards/CodeSurface.test.tsx` · Runs in: CI

## Setup
A backend with real PostgreSQL and one running workspace (microVM on the reference host, process runtime in CI), with two signed-in members, A and B, and the file `src/a.ts`. Steps 1–6 gate stage 1. Step 7 covers the §7.6 rows that T-COL-03, T-COL-04 and T-COL-06 append to the same test file, and re-runs in stage 2.

## Steps
1. A reads `src/a.ts` and gets digest d0.
2. B writes `src/a.ts` with `base_digest = d0`; the response carries d1.
3. A writes `src/a.ts` with `base_digest = d0`.
4. A writes without `base_digest`.
4a. The coding agent's std `read` returns `src/a.ts`; B then writes it; the agent's `write`, `edit` and `apply_patch` each try to change it.
5. Open `/api/live` as A and subscribe to `doc:code:<branch>:src/a.ts` and `doc:wiki:<page>`.
6. Render the File card for `src/a.ts` in the app's unit harness.
7. (S2 re-run) Read the daemon framing table, a change event and a presence heartbeat.

## Pass when
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
