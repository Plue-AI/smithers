# T-COL-09 Wiki co-editing on the live channel; delete POST+SSE

Stage S3 · Size M · Depends on T-COL-08, T-APP-14a, T-FLW-10 · Unblocks T-INS-07 · Issue: [#3587](https://github.com/smithersai/smithers/issues/3587)
Spec: spec.md §2 (Live document), §6.2.4, §7.4.1–7.4.6, §7.6.1, §13.1–13.2 · Delta: delta.md §4 (wiki row, Modify [S3]) · Product: mvp.md J8.2, §6.11 Pages and editing, M-02
Ready: 2026-10-03 smithers-8a sha256:396865c1ddf6

## Goal

Two members editing one wiki page see each other's keystrokes within 1 s over `/api/live`, the same way code files work. The page's revisions are written once per idle period, and the POST-update and SSE-refetch protocol no longer exists.

## Scope

In:
- The host service owns one Yrs document per open page on topic `doc:wiki:<page>` (§7.4.2). It speaks the same sync step 1/2, update and awareness frames as code documents (§7.4.1), and the browser uses the same `LiveDocProvider` (T-APP-14a).
- The text is `Y.Text("markdown")`, unchanged (§7.6 row 8), so existing page state in PostgreSQL loads as is.
- Persistence (§7.4.2): the merged state plus the rendered Markdown are written to `wiki_pages`/`wiki_page_revisions` in one transaction after 2 s without an update, or 10 s after the oldest unpersisted update under continuous typing, not once per update. Writes keep today's revision check and conflict retry. The revision is attributed to the actors who edited in that period, from `Y.Map("authors")` (§7.4.4).
- Acknowledgment (§7.4.6): only after that commit does the host send `saved{sv}`. The page loads from its stored state after a host restart, never reseeded from Markdown, so reconnecting clients merge without duplication.
- Limits stay: 1 MiB Markdown, 1 MiB update, 8 MiB state (`crates/smithers-ffi/src/wiki_document.rs:11-13`).
- Authorization reuses the wiki read/write gates and revocation watch. A revoked member's subscription ends in ≤ 5 s (§5.6).
- Every update that no `saved` covers stays in the client's `worldDocuments` collection and is resent in sync step 2 on reconnect, so no edit is lost on reload or host crash (today's offline guarantee, extended to unacknowledged updates).
- Old revisions and history stay readable (AGENTS.md: recorded events remain readable).
- Land dark against the specified contracts while T-COL-08 or T-APP-14a is unavailable: do not expose the live wiki editor; refuse document subscriptions and writes without the live transport, shared codec, persistence or authorization/revocation provider. Keep page reads and history available. Delete POST+SSE and its queue in this change; never fall back to them. T-FLW-10 being unavailable disables decision-following runs, not wiki reads; C-J8-05 waits for that integration. Test these refusals through the composed route and production command dispatcher.
- Host wiki processing runs only install-shipped Go/Rust code as the install user. Markdown and CRDT bytes are data, never executable modules or commands. Repository flows and the C-J8-05 coding/check steps run only in branch machines (§1.3, M-29), with no host fallback or sudo. This change adds no root step and consumes no main- or branch-sourced input as root. smithers-3f reviews this boundary.

Out:
- Backlinks, outline and the navigation index (unchanged, §13.2).
- Obsidian over git (§13.3 [D]).
- Implementing plan citations (T-FLW-10) and generated-page refresh (§13.5); only their integration is exercised here.
- Code-document authority, disk reconciliation and topology changes (T-COL-08); a second Yrs core or client provider; a new editor or storage ledger.
- Carets, selections, new co-editing presentation, hosted deployment changes and Cloud-specific compatibility shims.

## Changes

- Reshape `crates/smithers-ffi/src/wiki_document.rs`: reuse the existing Yrs core extracted for T-COL-08, with T-COL-08b's shared document protocol, rather than another Yrs implementation. Keep seed/apply/replace and UTF-16 indexing. Extend the root validation to admit `Y.Map("authors")` alongside `Y.Text("markdown")`, while rejecting unrelated roots and client changes to authenticated authorship. Reuse `packages/backend/internal/repohostserver/wiki_document.go:15-27` for the FFI binding.
- Add only `packages/backend/internal/live/wikidoc.go`'s wiki-specific open/close, persist timer and attribution adapter to the shared live transport. The existing stateless merge and revision writer are reused; they lack an open-page lifecycle and the 2 s/10 s flush, which this adapter supplies.
- `packages/backend/internal/services/wiki_collaboration.go`: keep the revision-checked state write. Delete the one-revision-per-update path behind `ApplyWikiUpdate`, and delete `ListWikiUpdates`.
- Delete (with their OpenAPI rows in `docs/api/openapi/repositories.yaml`):
  - `POST` and `GET /api/repos/{owner}/{repo}/wiki/{slug}/updates` (`packages/backend/internal/compose/router.go:1201-1202`; GET row `:6850`, POST operation `:6898`) and the `Apply`/`Updates` handlers (`routes/wiki_collaboration.go:62`, `:118`);
  - the SSE route `…/wiki/{slug}/stream` (`packages/backend/internal/compose/router.go:450-468`; row `:6803`) and `Stream` (`routes/wiki_collaboration.go:159`), including its `wiki_page_<id>` broker channel;
  - `GET …/document` (`packages/backend/internal/compose/router.go:1200`; row `:6709`) only if `rg` shows no consumer besides the editor. `packages/smithers/src/internal/backend/ProductApi.ts:3412-3413` exposes the generated call today; that declaration alone is not a consumer. smithers-b8 and smithers-38 decide retention from the caller audit and approve the public API/client change. If retained, it is a read-only snapshot, never a second sync protocol.
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

- Use checked-in literal text, actor, route and timing expectations; no test reads spec Markdown or production constants to generate its oracle.
- Production-boundary integration: connect two authenticated clients through the composed `GET /api/live` route and its real middleware, wiki adapter, PostgreSQL and native FFI. Send sync/update/awareness frames rather than calling the persistence service directly. Assert no revision before the 2 s idle flush, one revision at idle, and a flush at 10 s during 100 updates/s continuous typing. Hold/fail the commit and assert no premature `saved`; retry a revision conflict without duplicating edits.
- On that route, refuse unauthorized/private-space subscriptions, foreign client-id updates, forged authors-map changes, invalid roots and over-limit inputs without mutation or `saved`. Preserve page-id fencing after deletion/slug reuse and close revoked subscriptions within 5 s, including revocation during subscription startup.
- Client command tests dispatch `wiki.edit` through the production dispatcher with held/refused admission: persist local edits before transmission, never transmit unadmitted drafts, keep Chat usable, and clear only updates covered by `saved`. Retain account/branch fencing and deletion recovery.
- Replace, not delete, the protocol tests:
  - `packages/backend/internal/routes/wiki_collaboration_test.go` and `wiki_collaboration_startup_revocation_test.go` become live-channel tests (subscribe, revoke in ≤ 5 s);
  - `services/wiki_collaboration_integration_test.go` (real PostgreSQL and FFI) asserts one revision per 2 s idle period under 100 updates per second, and a revision attributed to both editors.
- interop: `crates/smithers-ffi/tests/wiki-yjs-interop.ts` gains sync step 1/2 against `yjs 13.6.32`.
- fault: C-DUR-04 K8. Kill the host 1 s after the last keystroke with two clients typing; after restart both reconnect and the page holds every keystroke once. Variant: both tabs close after the last `saved`, the host is killed, and a reopened page holds every acknowledged keystroke.
- unit: `wiki/CloudWiki.test.ts` and `state/controller/cloud-wiki*.test.ts`:
  - an offline edit survives reload and syncs once;
  - an update leaves `worldDocuments` only when a `saved` state vector covers it;
  - a stale acknowledgement from an earlier socket is ignored.
- integration: a page stored by the old protocol opens, edits and saves without losing its history.
- e2e: retain and update `apps/app/e2e/playwright/wiki*.spec.ts` as component evidence. Run `apps/app/e2e/real/wiki-coedit.spec.ts` (C-J8-02 S3) against the real install through `/wiki.page` and the production `wiki.edit` binding. Probe GET and POST `/updates` and GET `/stream` through the composed HTTP router for 404; assert all removed operations are absent from OpenAPI. Run `apps/app/e2e/real/wiki-decision-follow.spec.ts` (C-J8-05) through real TODO admission and its machine-run plan/check path after T-FLW-10 is available.
- integration: `packages/backend/internal/compose/openapi_conformance_test.go` passes with the deleted rows.

## Acceptance

- [C-DUR-04](../checks/C-DUR-04.md) K8: a host kill loses no acknowledged wiki update and duplicates none.
- [C-J8-02](../checks/C-J8-02.md) (S3 run): two people co-edit a page live in < 1 s p95. The POST and SSE routes return 404 and are absent from OpenAPI, and old revisions stay readable.
- [C-J8-05](../checks/C-J8-05.md): After a decision page is co-edited, the next related TODO's plan cites the new revision and its change follows it; a control run before the edit follows the old one (3 of 3 runs)

## Risks and notes

- A host crash loses up to 10 s of unpersisted merged state on the host, none of it acknowledged. Clients keep those updates in `worldDocuments` and resend them in sync step 2 on reconnect. Confirmed broken if C-DUR-04 K8 leaves the reopened page missing a keystroke a client had, or holding one twice.
- Several host processes can't each own a page. The install runs one host service (§1.2), so one in-memory owner is correct. Confirmed broken if a test starts two backends against one database and both accept edits for one page.
- smithers-22 decides the shared-backend cutover after smithers-b8's caller audit; hosted deployment work stays outside this ticket. No compatibility protocol survives the cutover.
- Decision owners: smithers-3f accepts the Go/FFI persistence and security seam; smithers-38 accepts the shared Rust/TS codec and generated package API seam with smithers-3f; smithers-b8 accepts dispatcher, client recovery and route-consumer changes; smithers-06 accepts any change to wiki view props or presentation. ADR 0003 remains T-COL-11's decision, not this ticket's. Record seam review answers; existing recorded answers stand, and outstanding owner review is post hoc under Will's 2026-10-03 directive.

## Ready checklist

1. Dependencies: T-COL-08 and T-APP-14a supply live transport, shared Yrs/codec and provider; their graph includes authorization and revocation. T-FLW-10 supplies C-J8-05's planning contract. Scope states dark, fail-closed landing for unavailable contracts; all dependencies are S3 or earlier.
2. Exclusions: Scope excludes citation implementation, generated refresh, navigation changes, Obsidian over git, code authority/topology, duplicate cores/providers, new editor/storage, carets/selections and hosted deployment work.
3. Tests: composed `/api/live` and removed HTTP routes, production `wiki.edit` dispatcher, real browser `/wiki.page` and machine-run TODO boundaries; literal fixtures supply independent expectations. C-DUR-04 K8, C-J8-02 S3 and C-J8-05 provide real-stack evidence.
4. Decisions: smithers-3f owns persistence/security, smithers-38 the shared codec/package API, smithers-b8 client/dispatcher and consumer audit, smithers-06 view changes, and smithers-22 the cutover; ADR topology remains with T-COL-11.
5. Owner pre-review: smithers-3f: does commit-before-saved preserve conflict retry and authorization, and does authors-map validation reject spoofed updates? smithers-b8: does the dispatcher preserve admission and account/branch fencing, and which real callers need `/document`? smithers-38: does the shared codec preserve old state while admitting only the authenticated authors map, and is the generated API cut approved? smithers-06: does reusing the existing wiki editor preserve focus/undo, and do any changed view props need design review? Recorded answers stand; review is post hoc under the parallel-build directive.
6. Security: Scope limits host processing to install-shipped code and treats wiki bytes as data; repository execution stays in machines without sudo or host fallback. No root step or root input is introduced. smithers-3f reviews; route tests prove authorization, revocation, identity fencing and spoof/limit refusals.
