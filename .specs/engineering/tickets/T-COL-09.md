# T-COL-09 Wiki co-editing on the live channel; delete POST+SSE

Stage S3 · Size M · Depends on T-COL-08 · Unblocks — · Issue: to file
Spec: spec.md §2 (Live document), §6.2.4, §7.4.1–7.4.5, §7.6 (row 8), §13.1–13.2 · Delta: delta.md §4 (wiki row, Modify [S3]) · Product: mvp.md J8.2, §6.11 Pages and editing, M-02

## Goal

Two members editing one wiki page see each other's keystrokes within 1 s over `/api/live`, the same way code files work. The page's revisions are written once per idle period, and the POST-update and SSE-refetch protocol no longer exists.

## Scope

In:
- The host service owns one Yrs document per open page on topic `doc:wiki:<page>` (§7.4.2). It speaks the same sync step 1/2, update and awareness frames as code documents (§7.4.1), and the browser uses the same `LiveDocProvider` (T-COL-08).
- The text is `Y.Text("markdown")`, unchanged (§7.6 row 8), so existing page state in PostgreSQL loads as is.
- Persistence: the merged state plus the rendered Markdown are written to `wiki_pages`/`wiki_page_revisions` once per 2 s idle period, not once per update (§7.4.2). Writes keep today's revision check and conflict retry. The revision is attributed to the actors who edited in that period, from `Y.Map("authors")` (§7.4.4).
- Limits stay: 1 MiB Markdown, 1 MiB update, 8 MiB state (`crates/smithers-ffi/src/wiki_document.rs:11-13`).
- Authorization reuses the wiki read/write gates and revocation watch. A revoked member's subscription ends in ≤ 5 s (§5.6).
- Edits made offline stay in the `worldDocuments` collection and sync on reconnect, so no edit is lost on reload (today's guarantee, kept).
- Old revisions and history stay readable (AGENTS.md: recorded events remain readable).

Out:
- Backlinks, outline and the navigation index (unchanged, §13.2).
- Obsidian over git (§13.3 [D]).
- Plan citations of page revisions (T-FLW-10) and generated-page refresh (§13.5).

## Changes

- `packages/backend/internal/live/wikidoc.go` (new): open/close per page, sync via FFI, the 2 s idle persist, attribution.
- `crates/smithers-ffi/src/wiki_document.rs`: add the sync-protocol operations through the codec shared with `smithers-machined` (ADR 0003, T-COL-10), and keep seed/apply/replace. FFI binding in `packages/backend/internal/repohostserver/wiki_document.go:15-27`.
- `packages/backend/internal/services/wiki_collaboration.go`: keep the revision-checked state write. Delete the one-revision-per-update path behind `ApplyWikiUpdate`, and delete `ListWikiUpdates`.
- Delete (with their OpenAPI rows in `docs/api/openapi/repositories.yaml`):
  - `POST` and `GET /api/repos/{owner}/{repo}/wiki/{slug}/updates` (`compose/router.go:1187-1188`; rows `:6850`, `:6898`) and the `Apply`/`Updates` handlers (`routes/wiki_collaboration.go:62`, `:118`);
  - the SSE route `…/wiki/{slug}/stream` (`router.go:444-462`; row `:6803`) and `Stream` (`routes/wiki_collaboration.go:159`), including its `wiki_page_<id>` broker channel;
  - `GET …/document` (`router.go:1186`; row `:6709`) only if `rg` shows no consumer besides the editor. `packages/smithers/src/internal/backend/ProductApi.ts:8225` uses it today, so check whether a catalog CLI path needs it.
  - Regenerate the clients.
- Client (`apps/app/src/mainview/`):
  - replace `update` and `revisions` in `wiki/CloudWiki.ts:284-320`;
  - replace the POST queue and pending acknowledgement logic in `state/controller/cloud-wiki.ts:150-241` and `:625-680` with `LiveDocProvider`;
  - keep `editWikiState`'s range splice (`wiki/CloudWiki.ts:169`) as the editor binding.
- Docs:
  - rewrite `apps/app/docs/workbench-lanes/wiki-collaboration.md`;
  - update `packages/backend/docs/wiki.md` and `apps/server/docs/wiki-collaboration.md` (the Worker `/updates` proxy note);
  - run `docs:sync`, `docs:check` and `smthrs docs` on each package.

## Tests

- Replace, not delete, the protocol tests:
  - `packages/backend/internal/routes/wiki_collaboration_test.go` and `wiki_collaboration_startup_revocation_test.go` become live-channel tests (subscribe, revoke in ≤ 5 s);
  - `services/wiki_collaboration_integration_test.go` (real PostgreSQL and FFI) asserts one revision per 2 s idle period under 100 updates per second, and a revision attributed to both editors.
- interop: `crates/smithers-ffi/tests/wiki-yjs-interop.ts` gains sync step 1/2 against `yjs 13.6.32`.
- unit: `wiki/CloudWiki.test.ts` and `state/controller/cloud-wiki*.test.ts`:
  - an offline edit survives reload and syncs once;
  - a stale acknowledgement from an earlier socket is ignored.
- integration: a page stored by the old protocol opens, edits and saves without losing its history.
- e2e: `apps/app/e2e/playwright/wiki*.spec.ts` updated. C-J8-02 at S3.
- integration: `packages/backend/internal/compose/openapi_conformance_test.go` passes with the deleted rows.

## Acceptance

- [C-J8-02](../checks/C-J8-02.md) (S3 run): two people co-edit a page live in < 1 s p95. The POST and SSE routes return 404 and are absent from OpenAPI, and old revisions stay readable.

## Risks and notes

- Persisting per idle period means a host crash loses up to 2 s of merged state on the host. Clients still hold the updates and resend them in sync step 2 on reconnect. Confirmed broken if a C-DUR kill of the host during typing leaves the reopened page missing keystrokes that both clients had.
- Several host processes can't each own a page. The install runs one host service (§1.2), so one in-memory owner is correct. Confirmed broken if a test starts two backends against one database and both accept edits for one page.
- The hosted Cloud (Plue composes this backend) loses the POST+SSE wiki path too. Confirm with the tech lead that no hosted client depends on it before deleting.
