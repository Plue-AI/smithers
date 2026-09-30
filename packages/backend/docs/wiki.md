---
title: "Wiki API and persistence"
description: "Scoped Markdown navigation, content and replay on the existing wiki model."
---

## Model

Existing `wiki_pages` and `wiki_page_revisions` remain the only page model and event history. `coding/wiki` remains the only generator; `.smithers/coding-project.json` `pages` is its only catalog; `mythical_wikis` remains its refresh receipt. Generated pages and authored pages use the same service. No organization API or independent wiki runtime.

Generated Markdown includes each reviewed section's source-line citations. The mythical publisher binds archived source links to `/api/repos/{owner}/{repo}/contents/{path}?ref={folded-main-commit}#L{line}`. The immutable main commit has the reviewed stack tip's tree and remains addressable after the refresh workspace is retired. The app opens these links with `files.read <path>:<line> <owner/repo> --ref <commit>` in the existing embedded file reader. Source digests and review receipts remain on the refresh; the page slug remains `generated-<id>` across revisions.

## Scope and permissions

Prefix `/api/repos/{owner}/{repo}/wiki`. All wiki routes accept `?visibility=public|private`, default `public`. Carry the query on every request, including pagination, document, update stream, history and content. Invalid visibility returns 400. Responses use `Cache-Control: private, no-store`.

`public` means repository-readable: a private repository stays private. `private` requires explicit repository access (owner, authorized organization/team member or collaborator); incidental public-repository read permission is insufficient. Writes require existing repository write access. Visibility is immutable; publication requires an explicit copy. Private edits do not dispatch repository wiki webhooks or publish to the public repository history sidecar.

A viewer who can read a repository but not its private space gets 403 with code `wiki_space_unreadable`, so a client can say so instead of retrying. A repository the viewer cannot read refuses with the generic `forbidden` code and never discloses its private space.

## Pages and navigation

Existing list/search (`GET /wiki?q=...`), create (`POST /wiki`), read/PATCH/DELETE (`/wiki/{slug}`), revisions, document, updates and SSE routes remain. Page DTO:

```json
{"id":7,"slug":"home","title":"Home","body":"# Home\n[[Guides/Start#Install|start]]","revision":2,"visibility":"private","path":"Home.md","content_digest":"<64 lowercase hex>","author":{"id":1,"login":"owner"},"created_at":"...","updated_at":"..."}
```

Create accepts `{title, slug?, body, path?}`; default path is `<slug>.md`. PATCH accepts `{title?, slug?, body?, path?, expected_revision?}`. Supply `expected_revision` to protect against stale saves; it is mandatory after collaborative editing starts. Markdown paths are case-preserving relative `.md` filenames and unique case-insensitively within scope. Slug is the independent route key; a path rename does not rewrite incoming Markdown. Page ID survives renames. Exact body bytes, including YAML frontmatter, are preserved. Markdown is limited to 1 MiB.

`GET /wiki/navigation/index` returns `{pages,folders,tags,checkpoint}`. `pages` contains page metadata (body is empty), `metadata:{frontmatter,aliases,tags,headings,links,error?}` and `backlinks:[{page_id,path,heading?,embed}]`. Links have `{target,heading?,alias?,embed,page_id?}`. Resolution checks source-relative path, root path, then unique name/title/alias within this scope; unresolved or ambiguous links omit page_id. Folders and tags are sorted arrays. `checkpoint` is the wiki's event sequence read just before the pages (0 before the first event), so the pages are at least that new: fold `GET /wiki/history/events?after=<checkpoint>` over the index and duplicates are harmless. Invalid YAML is retained in the body and reported as metadata.error. Code and HTML comments are excluded from navigation. This is a navigation parser, not a full Obsidian renderer. Render Markdown safely in the UI; no trusted HTML is returned.

## Attachments and history

Attachments use the same page/revision model with `attachment:{digest,media_type,size}` and an empty body. They appear in the index and resolve from `![[assets/image.png]]`.

- `PUT /wiki/attachments/{slug}?path=assets/image.png&expected_revision=0&visibility=private`: raw bytes, Content-Type required. Zero creates; subsequent writes require the exact current revision. Maximum 16 MiB. Non-Markdown relative path required. Returns page DTO, status 200. A stale revision/path collision returns 409. Repeating an uncertain write requires reading the current page first; no blind overwrite.
- Rename via existing PATCH with `path` and `expected_revision`; delete via existing DELETE. Content kind is immutable.
- `GET /wiki/history/{pageID}`: revisions newest first, including renamed/deleted pages, paginated with `page`/`per_page` (or `cursor`/`limit`), `X-Total-Count` and a `Link` header whose URLs keep `visibility`. Existing `/wiki/{slug}/revisions` addresses only a current page. Revisions include page_id, path, visibility, content_digest and optional attachment.
- `GET /wiki/history/{pageID}/{revision}/content`: exact Markdown or attachment bytes, authorized through that scoped revision. Works after deletion. SHA-256 checked on read. ETag is the quoted digest; no public digest-only endpoint. Raster image formats may render inline; other content downloads with a sandbox CSP and nosniff. Missing/corrupt content returns 503.

Markdown and attachments use the existing backend blob adapter, namespaced by repository and visibility and addressed by SHA-256. Compose `WithWikiContent(blobStore)` into every WikiService host; local backend composition is wired here. Pre-upgrade SQL snapshots hydrate missing Markdown blobs lazily after digest verification. Existing bytes that fail digest verification are refused. No content garbage collection is introduced; retained revisions retain their content.

## Event replay

`GET /wiki/history/events?after=0&visibility=private` returns up to 100 events ordered by a commit-ordered, per-repository/per-visibility `sequence`:

```json
{"version":1,"sequence":1,"page_id":7,"revision":1,"visibility":"private","slug":"home","path":"Home.md","title":"Home","content_digest":"<sha256>","deleted":false,"author":{"id":1,"login":"owner"},"at":"..."}
```

Attachment events also include attachment metadata. No body: read the event's revision/content endpoint. Persist the projection and final sequence atomically; request after that sequence until a short page. Replay from zero for a new projection. A delete removes the page from the fold, retaining its history. Sequence never mixes public/private scopes; persist repository identity and visibility with the cursor. Duplicate deliveries are harmless; gaps and unknown versions fail the fold. The SQL projection has an explicit transaction-fenced rebuild helper, not a second write API. Existing page-level SSE continues to use page revisions and rechecks authorization. Revocation watching begins before the first authorization read and covers subscription and replay. A retained token revocation, narrowed token scope, or suspended account refuses admission with 403; revocation after admission terminates the stream with `revoked` before further private revision metadata is emitted. An account enabled again can open a fresh stream; a revoked token remains invalid. Watchers are released when the request ends, including failed admission.

## Sync and UI acceptance

The trusted host calls `WikiService.SyncWiki(ctx, actor, owner, repo, connection, adapter)` in its existing background work. The context selects visibility with `WithWikiVisibility`; the authenticated actor must retain repository write access. This is a backend composition port, not an HTTP endpoint accepting arbitrary filesystem paths.

The host operator lists Obsidian folders in the backend config file. Each worker process syncs every folder on its own disk once per interval (default 60 seconds, at most one day) and logs a failing folder without blocking the others. Configure a folder on one worker process only: another process's copy of the same path is a separate connection. Each pass resolves `login` again, so a deactivated account, a login-prohibited account or lost write access stops that folder. Folders are accepted only from this file, never over HTTP. Startup refuses entries without `feature_flags.wiki`, with a relative folder, a visibility other than `public` or `private`, a repeated connection for one repository and visibility, or a folder listed twice.

```yaml
feature_flags:
  wiki: true
wiki_sync:
  interval_seconds: 60
  obsidian:
    - owner: acme
      repo: notes
      login: alice
      visibility: private
      connection: vault
      folder: /srv/obsidian/vault
```

`NewObsidianSync(folder)` opens an explicitly supplied local folder. Close it after use. The adapter preserves Markdown bytes, frontmatter, wiki links and attachments. It detects local renames by filesystem identity (path fallback on systems without an inode), compares content digests before overwriting, and refuses symlinks, hardlinks, traversal, case-fold collisions and oversized files. Hidden directories, including `.obsidian` and `.git`, are excluded. This is folder sync; it does not claim git commit provenance. The folder must be trusted: another local process can still change a file between the final comparison and a filesystem operation.

`NewNotionSync(credential, parentPageID, client)` requires explicitly supplied connection credentials. It reads child pages of that parent using the provider's [Markdown API](https://developers.notion.com/reference/retrieve-page-markdown), and creates, updates, renames and archives pages through the same reconciliation port. It refuses attachments, frontmatter, wiki links, embeds, tables, enhanced blocks, truncated pages and unknown blocks. A conversion that fails exact read-back verification remains an unknown outcome. Notion offers no atomic revision compare-and-set here; its last-edited version and digest are checked before writes. This adapter has fixture receipts only; live provider acceptance requires supplied credentials and actual receipts.

Migration 0058 extends the existing `issue_sync_channels` and `issue_sync_deliveries`; it adds no queue, worker or page table. Chat and documents call the same `ClaimSyncDelivery` and `SettleSyncDelivery` operations. A document delivery carries its immutable wiki page identity/revision, desired path/digest and expected external identity/version. Deletion is a nil desired document; a rename changes the path while retaining wiki identity. Repository/owner foreign keys remove document deliveries with their scope. Claims are ordered within the connection and receipts are token-fenced.

The channel stores the existing `WikiProjection`, external baselines and commit-ordered cursor together. Every invocation holds a database advisory lock for that owner/repository/visibility/provider connection. Writes use existing WikiService revision checks and content reads. If both copies changed since the baseline, reconciliation returns a conflict without overwriting them. Equal copies acknowledge replay. A file write whose receipt was lost reuses its immutable intent and acknowledges the exact desired bytes. An interrupted or ambiguous Notion write blocks; it is never automatically repeated.

The host reads unknown receipts with `WikiSyncDeliveries` and invokes `ResolveWikiSyncDelivery` with the expected claim token, action (`sent`, `skip`, `retry`) and evidence. Only the connection owner with current write access can resolve. Resolutions retain an audit array on the existing delivery; a retry accepts duplicate risk and uses a new claim token. Skipping one version permits later deliveries. These are host ports; the app has no connection or resolution controls yet.

Local acceptance uses isolated PostgreSQL and temporary folders only. Smithers-Ops is untouched. #2122 remains open for app resolution controls, git provenance and credentialed Notion acceptance.

UI acceptance after connection: public/private same-path isolation; folder/tag/search navigation; wikilink aliases/headings and embeds; edit, rename, historical download, delete; visible save conflicts; instant background acknowledgment and completion-driven toast. Existing Cloud refresh receipts, freshness and failures stay in the Stack wiki row.


## Verification

Use a disposable local PostgreSQL server with permission to create databases. The test fixture creates and drops isolated databases and applies the actual product migrations. Set `SMITHERS_REQUIRE_DATABASE_TESTS=1` so unavailable PostgreSQL is a failure rather than a skip. `SMITHERS_WIKI_TEST_FFI` must point to a built `libsmithers_ffi` to exercise real native Yjs and history; without it those two native integration cases skip.

```bash
cd packages/backend
export SMITHERS_TEST_DATABASE_URL='postgres://localhost:5432/postgres?sslmode=disable'
export SMITHERS_REQUIRE_DATABASE_TESTS=1
export SMITHERS_WIKI_TEST_FFI='/absolute/path/to/libsmithers_ffi.dylib'
go test ./internal/services ./internal/routes ./internal/db ./db/product ./internal/compose -run 'Wiki|wiki' -count=1
go test -race ./internal/services -run 'WikiProduct|WikiCollaboration_Postgres' -count=1
```

The suites cover same-path public/private isolation, collaborator permissions, private webhooks/history-sidecar exclusion, links/backlinks and rename history, digest verification, attachment versions after deletion, filesystem restart, pure event folding, SQL rebuild including Yjs state, commit-ordered cursors and permission revocation during blob reads. The assembled HTTP router test exercises real tokens, binary uploads, collection-route/page-slug coexistence and untrusted download headers. These are local backend receipts, not Cloud publication or browser acceptance.

The importer plan is [wiki-import.md](./wiki-import.md). Shared sync acceptance remains [#2122](https://github.com/smithersai/smithers/issues/2122), app connection [#1922](https://github.com/smithersai/smithers/issues/1922), deployed refresh [#1923](https://github.com/smithersai/smithers/issues/1923), review reuse [#1971](https://github.com/smithersai/smithers/issues/1971).

Local verification on 2026-09-26 used Go 1.26.8 (Darwin arm64), PostgreSQL 18.6, and native `libsmithers_ffi` with SHA-256 `fc8a178ce0906ea58e46104e8de9af1f695254ac34a3f96dbd0ea536113ce98f`. The focused suite passed 108 test/subtest cases across five packages; the full product migration suite passed 38; the race-enabled subset passed 9. None skipped. The native artifact was already built locally; these receipts do not establish a clean native rebuild.

SQL bindings were generated from the product migrations and queries. Full-tree SQL regeneration currently emits model types that collide with handwritten `*_ext.go` definitions ([#2123](https://github.com/smithersai/smithers/issues/2123)); this change retains only the generated wiki bindings/types.
