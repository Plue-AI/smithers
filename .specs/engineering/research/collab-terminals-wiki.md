# Live collaboration, terminals, wiki — current state (main, 2026-10-02)

Repo at `c04637a6f790`. Paths are relative to `/Users/williamcory/smithers`. "inferred" marks conclusions not read directly from code.

## Summary (≤8 lines)

- The wiki "Yjs collaboration" is not a realtime Yjs provider. It is HTTP: `GET .../document`, `POST .../updates` (base64 Yjs v1 delta), and a per-page SSE stream that only signals "refetch". No y-websocket, no hocuspocus, no awareness. The server merges with Yrs (Rust, via FFI) and stores state in Postgres.
- The doc lives on the API (Go + FFI), not in a workspace VM. Binding code files means a second document host that sits next to the VM's disk. Nothing exists for it.
- Presence: Pair's `POST /api/pair-sessions/{id}/presence` was a keep-awake heartbeat storing opaque JSON per member. It had no where-am-I model and no fan-out. Restoring it does not give the §6.8 presence row.
- File watching: none. The VM runs one bash loop (`smithers-workspace-head`) that polls jj op-heads every 2 s and runs `jj log` (a snapshot) every 30 s. No inotify/fanotify; no writer attribution.
- Terminals: one PTY per workspace session over SSH or runtime terminal, many WebSocket viewers with a 512 KiB replay ring. Every viewer's keystrokes go to stdin. The shell runs as the single guest user `developer` (`/home/developer`), so there are no per-person homes and no watch/ask-to-type gate.
- Wiki: store is Postgres + a blob store (not a filesystem vault). Obsidian sync is a host-configured folder importer. "Vault is a git repo members clone" is not served anywhere. Planning reads generated pages from `wikiOutput/current.json`, not authored pages, and cites source revision plus input digests, not wiki page revisions.

## Inventory

| Component | Path:line | What it does today | Spec row it serves |
| --- | --- | --- | --- |
| Browser Yjs codec | `apps/app/package.json:62` (`yjs 13.6.32`); `apps/app/src/mainview/wiki/CloudWiki.ts:3,148-196` | Builds `Y.Doc`, splices the changed UTF-16 range into `Y.Text("markdown")`, encodes deltas. Pending updates persist in the `worldDocuments` TanStack DB collection (no y-indexeddb). | §6.11 Pages and editing; M-02 (wiki half) |
| Client protocol spec | `apps/app/docs/workbench-lanes/wiki-collaboration.md:56-110` | `GET /document`, `POST /updates` (one outstanding per page, UUID idempotency), SSE `GET /stream?page_id&after`; stream event triggers a bootstrap refresh; 2 s reconnect backoff; reload needs explicit Refresh. | §6.11 |
| Server routes | `packages/backend/internal/routes/wiki_collaboration.go:22-30,42,62,118,159`; `packages/backend/internal/compose/router.go:444-462` | `Document`, `Apply`, `Updates`, `Stream`. SSE sits outside the JSON timeout group; auth = session/sse-ticket + repo read scope + revocation watch. | §6.11 |
| Server service | `packages/backend/internal/services/wiki_collaboration.go:20-31,60-70,135+` | `GetWikiDocument`/`ApplyWikiUpdate`: seeds state from body, merges outside Postgres, revision-checked write of state + rendered body, 8 retries on conflict. One revision per update. | §6.11 |
| Yrs merge engine | `crates/smithers-ffi/src/wiki_document.rs:1-60` (`yrs =0.27.4`, `Cargo.toml:35`); `packages/backend/internal/repohostserver/wiki_document.go:15-27` | Stateless `seed`/`apply`/`replace` over base64 state. Limits: 1 MiB markdown, 1 MiB update, 8 MiB state. | §6.11 |
| Broker fan-out | `routes/wiki_collaboration.go:196` (`Broker.Subscribe("wiki_page_<id>")`); `apps/server/docs/wiki-collaboration.md` | Shared SSE broker; Worker proxy forwards `/updates` with a 2 MiB cap. | §6.11 |
| Wiki store/API | `packages/backend/docs/wiki.md:1-120` | `wiki_pages` + `wiki_page_revisions`; blob store keyed by SHA-256 for Markdown and attachments; `GET /wiki/navigation/index` returns folders, tags, headings, links, backlinks; commit-ordered event replay. | §6.11; J8 |
| Wiki outline/backlinks UI | `apps/app/src/mainview/wiki/CloudWiki.ts:65-76,226`; `wiki/VaultAdapter.ts:1-30`; `cards/WikiCards.tsx` | Renders the navigation index; local `VaultAdapter` resolves `[[links]]` from `worldDocuments`. | §6.11 |
| Obsidian folder sync | `packages/backend/internal/services/wiki_sync.go`, `wiki_sync_obsidian.go`, `wiki_sync_host.go`; `docs/wiki.md:88-110` | Host config `wiki_sync.obsidian[]` (owner, repo, login, visibility, folder), default 60 s interval, per worker process. Preserves bytes/frontmatter/attachments, detects renames by inode. | §6.11 Obsidian |
| "Git adapter" | `services/wiki_sync_git.go:19-66` | Only a provenance reader: records `source_commit` when the synced folder's HEAD holds the imported bytes. It does not serve a git remote. | §6.11 Obsidian |
| Repo-host wiki history sidecar | `packages/backend/internal/repohostserver/wiki_document.go:30-50`; `router.go:480,1150` (`WikiRepoPath`) | A bare git repo per repository records revisions (`ProjectWikiRevision`). No smart-HTTP or SSH route clones it (inferred: `internal/ssh` has no wiki path). | §6.11 Obsidian |
| Generated pages | `packages/backend/internal/services/mythical_wiki.go:35,54,525-600`; `flows/coding/planning-wiki.ts:56-125`; `flows/wiki/` | After each fold the stack runs `coding/RefreshWiki`, then writes `generated-<id>` pages via `CreateWikiPage`/`UpdateWikiPage`, skipping pages a person edited. Catalog = `.smithers/coding-project.json` `pages` (1-30 specs, `flows/coding/project-config.ts:25,102-113`). Refresh fails if not started in 15 min or not finished in 3 h; retries 30 s, 2 min, 10 min. | §6.11 Generated; §11.10 |
| Planning reads wiki | `flows/coding/planning-memory.ts:88-140`; `flows/coding/planning-wiki.md` | `wikiMemory` uses stack-published pages or a host snapshot (`wikiOutput/current.json`, re-verified), only pages whose `inputDigest` is fresh. Digest of `{id, inputDigest, body}`. No call to `GET /wiki/{slug}` and no wiki page revision number in the citation. | §6.9; J8.4 |
| Pair presence (removed) | `jj file show -r 2753d2e3d2- packages/backend/internal/routes/pair_sessions.go:136,782-798`; `services/pair_session.go:1798-1818`; `docs/api/openapi/pair-sessions.yaml:765` | `POST /api/pair-sessions/{id}/presence {presence: <json>}` → `Heartbeat` → `UpdatePairSessionMemberPresence`. Section titled "Presence (keep-awake)". Plus members, invites, share links, prompt queue, shared draft, `pair_state` + `pg_notify('pair_room_*')`. | §6.8 Presence (missing) |
| Head reporter (VM) | `packages/backend/internal/services/workspace_head.go:23-35,52-171` | Bash loop `/usr/local/bin/smithers-workspace-head`: poll 2 s (`SMITHERS_WORKSPACE_HEAD_POLL_SECONDS`), snapshot tick 30 s (`..._TICK_SECONDS`), compares `.jj/repo/op_heads/heads`, pushes `refs/smithers/workspaces/<id>/head`, POSTs `{change_id, commit_id, ahead, behind}`. | §6.8 External changes (partial) |
| Head → app stream | `services/workspace_head.go:696,771`; `router.go:545,784-785`; `routes/workspace.go:41-45,1113` | Report emits `{status, head, ahead, behind}` on channel `workspace_status_<id>`; SSE `GET /workspaces/{id}/stream` (and `/workspace/sessions/{id}/stream`). | §6.8 Live updates (partial) |
| In-VM agent | `packages/backend/microsandbox/guest/smithers-guest.py:1-40,93-99,123-136` | Python helper reached through `msb exec`: `exec` (own cgroup, `drop_to(user)`), `fs read/write/list/remove` as the workspace user, `relay`, `bridge`, `setup USER UID`. No watcher, no long-lived socket. | §6.8 (host of any watcher) |
| File read/write API | `services/workspace_facets.go:187,244`; `router.go:1427-1430` | `GET/PUT /workspaces/{id}/files/content`: bounded whole-file read and write; no version/etag, no author. | M-02 (disk side) |
| Terminal WebSocket | `routes/workspace_terminal.go:174,335,637-665`; `routes/terminal_session_manager.go:22-31,379-500,609-621` | One PTY per workspace session id; many sinks per session; ring replay on attach; sink queue 256 frames, slow sinks evicted; idle 15 min; stdin from any sink is written to the PTY. | §6.8 Terminals (partial) |
| Terminal identity | `services/workspace.go:33-35`; `services/workspace_ssh.go:25-37`; `routes/workspace_terminal.go:453` | SSH user = `<vmID>+<username>`; username is `developer` (`/home/developer`) or `root`. `workspace_sessions.user_id` records who opened it but is not a unix identity. | M-18 |
| SSH front door | `packages/backend/internal/ssh/server.go:120-200` | gliderlabs server; public-key auth against stored keys; PTY only for workspace principals; sftp relayed to the guest; 24 h max, 30 s keepalive. | M-24 |
| App terminal client | `apps/app/src/mainview/state/CloudTerminalClient.ts:1-30`; `tabs/TerminalView.tsx` | WebSocket per session via `/api/cloud-ws/`; binary = stdin/stdout, text JSON = resize. | §6.8 Terminals |
| Design model | `.specs/design/mock/src/world.ts:75-175` | `Presence{who, where: terminal/file/step/branch, watching}`, `Activity{kind:"change", files, command}`, `Terminal{owner, watchers, shared, asks}`, `FileDoc{editors, overwrite, gone}`. None of these exist in the backend. | §6.8 |

## Gaps vs mvp.md

| Spec ref | Missing | Where the change goes | Size |
| --- | --- | --- | --- |
| §6.8 Presence | Any presence store/stream. Pair's heartbeat held opaque JSON and a pg_notify; it has no `where`. | New `branch_presence` projection on the API: TTL rows keyed (workspace, principal, session) with `Where`, fanned out on the existing `workspace_status_<id>` SSE channel. Reuse the broker. Restoring Pair (#3401) is blocked; build new. | M |
| M-02 live co-edit, code | Yjs doc per code file; server-side host; reconcile disk writes; gutter name flags; sub-1 s delivery. The current protocol is POST + SSE-refetch (revision per update, 2 s reconnect). | Option A (recommended, inferred): host `Y.Doc` in the API next to the wiki service, keyed (workspace, path); persist state in Postgres; flush debounced (e.g. 300-500 ms) to the VM via `PUT /files/content` (`WriteWorkspaceFile`). Needs an `{update, awareness}` push channel: extend the SSE stream to carry the update bytes. Awareness is new. Option B: a Yjs doc in an in-VM daemon, giving local-disk latency and a place for the watcher, but a new long-running process and a new transport. | L |
| M-02 "saves continuously", "Saved to the machine" | `WriteWorkspaceFile` has no precondition. A write cannot detect that disk changed since the doc last read it. | Add `base_digest`/mtime precondition to the file write; the doc host stores the last-seen disk digest. | S |
| M-02 / §6.8 No silent overwrite | Detect a stale out-of-band save, flag it with Restore, snapshot on every write. Only the 30 s jj snapshot exists. | Watcher (below) emits per-file events with the pre-image digest; the doc host compares against the last doc state; "Restore" re-applies the doc text. Snapshot-per-write = `jj` snapshot triggered by the watcher event, debounced. | M |
| §6.8 External changes, M-27 | Per-file watcher, ignored-path filtering, grouped bursts, command/author, Undo, moved-off-item detection, file deleted/renamed. | Replace/augment the head-reporter script with a Go or Rust watcher in the guest (inotify recursive, `.gitignore` filter via jj/`git check-ignore`), posting batched change events to a new `POST /workspaces/{id}/changes`. `fs.watch` events do not carry a PID; attribution needs fanotify (root, kernel feature, `FAN_REPORT_PIDFD`) or an exec wrapper (below). Undo = `jj op restore` to the pre-burst operation. "Moved off item" = compare `@` ancestry to the item's stack parent, already a head-report field. | L |
| §6.8 Live updates | Cards update only on commit-level head change. | New `changes` event on the existing workspace SSE (or the broker) with `{paths, author, command, burst_id}`; File/Diff/Branch cards subscribe. | M |
| §6.8 Terminals / M-18 per-person homes | All terminals run as `developer` with `/home/developer`. Tool logins are shared by construction. | Create a unix user per member at first terminal open (`smithers-guest.py setup USER UID` already creates users and `drop_to`); SSH username becomes `<vmID>+<login>`; the jj/git author and credential helper become per-user (the head reporter's cached credential at `defaultWorkspaceHome/.cache/...` is `developer`-owned, so give it a group-readable path). Shared working copy needs a common group and umask 002 (inferred). | L |
| M-18 watch / Ask to type | No input gate. Any attached sink writes stdin (`workspace_terminal.go:659`). `loadWorkspaceSessionWithAccess` grants read access to workspace readers. | In `TerminalSessionManager`, add per-sink `canType`: owner = `workspace_sessions.user_id`; non-owners attach read-only (drop binary frames); `ask` text frame → broker event to owner; `allow`/`revoke` text frames from the owner. Persist the grant in memory only (expires with the session). | M |
| M-18 "Allow states watcher can use signed-in tools" | Copy only; no data model. | Allow event carries the warning string; app renders the toast. | S |
| M-24 SSH attribution | SSH `developer`/`root` only; GitHub keys → user lookup exists in `ssh/server.go` (public key handler) but the guest user is not per person. | Same per-person user change as M-18; sshd in guest must accept the per-person user. The control-plane SSH proxy already knows the person. | M (with M-18) |
| §6.8 Shared agent activity / Activity entries | No branch activity feed. `Activity{kind:"change"}` has no backend. | A `branch_activity` table fed by the change events, steers and agent steps. | M |
| §6.11 Obsidian ("members clone it") | The vault is not served as git. Folder sync is a host-local importer; the sidecar history repo is not cloneable. | Serve the per-repo wiki repo over the existing smart-HTTP/SSH git path (`WikiRepoPath`), and add an inbound `git push` → `SyncWiki` import. | L |
| §6.9 / J8.4 "cites page revisions" | Planning cites generated page `inputDigest`s and source revision, not `wiki_pages` revision numbers; authored pages are not read. | `wikiMemory` should call `GET /wiki/{slug}` / `history` and record `{slug, revision, content_digest}` in the plan receipt. | M |
| §6.11 Generated pages / §11.10 | Default page declaration for a fresh repository. | Generate a default `pages` catalog when `.smithers/coding-project.json` is absent; the config is stored in the install, not committed. | M |
| §6.11 live co-edit parity | No awareness/cursors on wiki pages (the spec cuts carets for code; the wiki is unspecified). | None required by the spec; name flags are a code-file concern. | S |

## Existing tests

- Wiki collaboration: `packages/backend/internal/routes/wiki_collaboration_test.go` (2), `wiki_collaboration_startup_revocation_test.go` (4); `services/wiki_collaboration_integration_test.go` (4; native FFI + Postgres, gated on `SMITHERS_WIKI_TEST_FFI` and `SMITHERS_REQUIRE_DATABASE_TESTS`); `crates/smithers-ffi/tests/wiki-yjs-interop.ts` (Yjs 13 vs Yrs). Client: `apps/app/src/mainview/wiki/CloudWiki.test.ts`, `state/controller/cloud-wiki*.test.ts`, `e2e/playwright/wiki*.spec.ts`. Wiki sync: `services/wiki_sync_*_test.go`, `internal/config/wiki_sync_test.go`. `docs/wiki.md` records 108 cases passing on 2026-09-26 with a locally built FFI (not a clean rebuild).
- Terminals: `routes/terminal_session_manager*_test.go` (16 across 3 files), `terminal_ring_buffer*_test.go`, `workspace_terminal*_test.go` (host-key pinning, active cap, open rate), `apps/app/src/mainview/state/CloudTerminalClient.test.ts`, `tabs/TerminalView.test.tsx`. No test for two viewers with different owners or an input gate.
- Head reporter: `services/workspace_head_test.go` (8). No test of the bash loop's timing (inferred: script is a string constant).
- Pair presence tests were deleted with the cut (`internal/db/pair*_test.go`, `routes/pair_sessions*_test.go`, `services/pair_session*_test.go`).
- No test, doc or code for per-file watching, write attribution, or Yjs on code files (`rg inotify|fsnotify|fanotify` finds only `go.mod` indirect `fsnotify v1.10.1` and the build-cli `Watch.ts`, which is the local `smthrs watch` command, not a workspace feature).

## Configured/measured numbers

| Value | Number | Source |
| --- | --- | --- |
| Head poll (op-heads) | 2 s (`SMITHERS_WORKSPACE_HEAD_POLL_SECONDS`) | `workspace_head.go:71` |
| jj snapshot tick | 30 s (`SMITHERS_WORKSPACE_HEAD_TICK_SECONDS`) | `workspace_head.go:70` |
| Head token TTL / install timeout | 7 d / 60 s | `workspace_head.go:30-36` |
| Head POST timeout | 20 s curl | `workspace_head.go:~158` |
| Terminal ring buffer | 512 KiB | `terminal_session_manager.go:23` |
| Terminal idle timeout (no sinks) | 15 min | `:24` |
| Sink queue / write timeout | 256 frames / 10 s | `:30,26` |
| Startup watch / retry delay | 2 s / 3 s | `:27-28` |
| Terminal WS message cap / ping / activity refresh | 64 KiB / 30 s / 30 s | `workspace_terminal.go:34,41,48` |
| Terminal session idle (DB default) | 1800 s | `0001_product_baseline.sql:6550` |
| SSH max connection / keepalive | 24 h / 30 s | `ssh/server.go:139,147` |
| Wiki client SSE reconnect | 2 s | `wiki-collaboration.md:100` |
| Wiki limits | 1 MiB markdown, 1 MiB update, 8 MiB state; proxy 2 MiB envelope | `wiki_document.rs:10-12`; `apps/server/docs/wiki-collaboration.md` |
| Wiki Obsidian sync interval | 60 s default, max 1 day | `docs/wiki.md:84` |
| Wiki refresh deadlines | start 15 min, finish 3 h; retries 30 s, 2 min, 10 min | `docs/wiki.md:12-14` |
| End-to-end keystroke latency (Yjs wiki) | Not measured. Path is POST then SSE then GET, so expect over 1 s (inferred). | no benchmark found |

## Related GitHub issues

Open, from `gh issue list -R smithersai/smithers` on 2026-10-02. None names Yjs-on-code, file watching or per-person terminal homes (searched multiplayer, file watch, attribution, per-person, ask to type, SSH, Branch card).

- #3401 DO NOT MERGE / IMPLEMENT: restore Pair multiplayer after MVP. Blocked pending Will; prior code at `ce7fbc112f`.
- #3385 MVP scope cuts umbrella; contains the Pair/second-round removal record.
- #2122 Wiki: enable Obsidian/Notion adapters on the shared sync mechanism. Backend port done; app connection controls and deployed acceptance open.
- #1922 Show the explained, citation-verified wiki in the app from one generator. Open.
- #1923 Refresh the wiki on landed source changes through Smithers Cloud. Open.
- #1651 Repository wiki: explained, citation-verified, refreshed on change. Open epic.
- #3113 Diagnose runtime OPFS write failure after Wiki retries. Open.
- #3246 Wiki second-note editor loses keyboard focus and drops typed input. Open.
- #3298 Wiki automatic page read can overwrite a newer tree selection. Open.
- #3294 Wiki: classify signed-out creation as a permission refusal. Open.
- #2130 Workspace commands: run past the 30 s request timeout. Open.
- #2924 burndown Lane B: Cloud user workspaces and scoped sandbox provider. Open.
- #1968 Cloud workspaces: check out a user's pushed refs/users and bound storage. Open.
- #3425 Preview a branch's running app as a card. Open; adjacent to Branch card.

## Risks and unknowns

| Risk (falsifiable) | What would confirm |
| --- | --- |
| The POST+SSE-refetch wiki protocol cannot meet "under 1 s to all viewers" for code keystrokes (inferred: one outstanding POST per page, a revision row and Postgres write per update, then a refetch). | Instrument keystroke to remote render on `wiki.spec.ts` with two browsers; if p95 is over 1 s, a push of update bytes is required. |
| Hosting the code doc in the API cannot see local disk changes quickly, so disk-to-doc reconcile lags the watcher path. | Measure inotify event to `PUT /files/content` round trip through `msb exec` (`guest.py fs write` spawns a process per call). If over 200 ms per write, an in-VM daemon is needed. |
| `msb exec` per file operation will not scale to debounced writes at keystroke cadence (inferred: each `fs read/write` is a process spawn). | Time 100 sequential `WriteWorkspaceFile` calls on a real VM. |
| Per-file attribution is not obtainable from inotify. | Show a PID on an inotify event (it carries none); fanotify with `FAN_REPORT_PIDFD` requires CAP_SYS_ADMIN and a recent kernel; check the NixOS guest kernel version and whether the guest is Linux-only (the README says microsandbox may use other runtimes). |
| Per-person unix users plus one shared checkout breaks jj/git (ownership, `safe.directory`, lock files, the head reporter's credential cache owned by `developer`). | Create two users in a guest, run `jj st` and `pnpm install` alternately; look for permission errors. |
| Ask-to-type is bypassable: stdin gating in the WebSocket handler does not stop a member who opens their own SSH session as the same user. | Not an issue once each person has their own user; until then, confirm by two sessions under `developer` writing to each other's tty (`/dev/pts`). |
| Pair's presence cannot be restored as is (it is membership-bound and cut). | Compare `pair_session_members` presence column to the `Presence` shape in `world.ts`; `Where` has no field. |
| The head reporter's `jj log -r @` every 30 s is the only snapshot trigger. A burst of writes within 30 s followed by `git checkout` could lose pre-image for Undo. | Run a write burst, then `jj op log`; check no operation exists between. |
| "Vault is a git repo members can clone" is false today (inferred from absence of a wiki route in `internal/ssh` and the router). | `git ls-remote` a wiki remote against a dev stack; `rg "wiki" packages/backend/internal/ssh` returns nothing. |
| J8.4 "plan cites the page revision" fails: planning cites generated digests only. | Inspect a plan receipt for `slug`/`revision` of any authored page; `rg "revision" flows/coding/planning-memory.ts` shows only stale-revision errors. |
| The spec's "Snapshots exist every 30 s" depends on the head reporter being installed on every start; a reporter install failure only logs (`workspace_head.go:445,672`). | Kill the reporter in a guest and check the app still shows a live head. |
