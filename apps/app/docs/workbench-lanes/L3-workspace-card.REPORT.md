# Lane L3 — REPORT (2026-09-02)

Brief: `L3-workspace-card.md`. ADR: `../decisions/0002-citc-sandbox-kinds.md`.
Prior state: `citc.REPORT.md`.

Everything in the brief shipped except the Egress facet on an **agent-session
card**, because no agent-session card exists in this app (§"Not built"). The
route is implemented, tested and reachable as `/egress.session`.

## Files changed

| File | What |
| --- | --- |
| `packages/rpc/src/Cards.ts` | New exported schemas `WorkspaceHeadSchema`, `WorkspaceEnvironmentSchema`, `WorkspaceFileEntrySchema`, `WorkspaceServiceSchema`, `SandboxEgressRowSchema`. The `workspace` card payload grew `workspaceKind`, `head`, `ahead`, `behind`, `startedAt`, `environment`, `persistence`, `sshHost`, `files`, `filesPath`, `services`, `egress`, `egressCursor`, `egressProxyUnavailable`, and the facet enum grew `egress`. Every new field is `.nullable().optional()` so a card persisted before this lane still parses. |
| `apps/app/src/mainview/state/AppState.ts` | `CloudWorkspaceRowSchema` grew `kind`, `head`, `ahead`, `behind`, `startedAt`, `environment`, `persistence`, `sshHost` (all nullable+optional); `CloudWorkspaceInput` picks them; the new shared schemas/types are re-exported. |
| `apps/app/src/mainview/state/seams/EgressSeam.ts` | **New.** `parseEgressRow`, `nextEgressCursor`, `loadEgressPage`, `workspaceEgressPath`, `agentSessionEgressPath`, `egressLine`, and `createEgressSeam` (the agent-session act). |
| `apps/app/src/mainview/state/seams/EgressSeam.test.ts` | **New.** 18 tests. |
| `apps/app/src/mainview/state/seams/WorkspaceSeam.ts` | DTO parsers for plue#446's fields; `parseFileEntry`/`parseService`; `loadFiles`/`loadServices`; `renderFiles`/`renderServices`/`renderEgress`; new acts `listFiles`, `readFile`, `listServices`, `listEgress`; `setFacet` now reads the files/services/egress routes; refusals now carry plue's `code` beside its `message` so `egress_proxy_unavailable` reaches the card. |
| `apps/app/src/mainview/state/seams/WorkspaceSeam.test.ts` | Live-sample fixture `WS_LIVE` + 16 new tests. |
| `apps/app/src/mainview/cards/WorkspaceCard.tsx` | Header facts line, ssh-host copy line, Files facet (imports `FileListCardBody`), Services facet, Egress facet with "Load older", the `egress_proxy_unavailable` line. Exports `uptimeLabel` and `headerFacts` as pure helpers. |
| `apps/app/src/mainview/cards/WorkspaceCard.test.tsx` | 14 new tests (22 total in the file). |
| `apps/app/src/mainview/flows/Flows.ts` | `box.files`, `box.file`, `box.services`, `box.egress`, `egress.session`; `box.facet` accepts `egress`. |
| `apps/app/src/mainview/flows/SlashPayload.ts` | Parsers for the five new flows. |
| `apps/app/src/mainview/state/AppController.ts` | `createEgressSeam` wired; five new actions on both action tables. |
| `apps/app/src/mainview/flows/registry.test.ts` | The five new flow names pinned. |
| `apps/app/src/mainview/flows/parity.test.ts` | `WorkspaceCard.tsx` handler count 13 → 15 (ssh Copy, Egress "Load older"). |

Not changed: `styles/cards.css`. Every new row reuses the existing
`world-card-list` / `world-card-row` / `world-card-path` / `world-card-empty`
classes, so no new CSS was needed and none was invented.
`APP_SCHEMA_VERSION` was not bumped: every new field is nullable + optional,
so a persisted row or card from before this lane still validates.

## Tests added

`src/mainview/state/seams/WorkspaceSeam.test.ts` (16 new, 50 in the file):

- view parses the live DTO's kind, head, ahead/behind, environment, persistence and ssh host onto the row and the card
- a DTO that answers none of them carries none of them: empty strings and an empty head are absence
- a started workspace carries its start time; the per-user row keeps the facts but drops the uptime once it stops running
- the Files facet reads the workspace's own route and keeps the path it listed
- a subdirectory listing replaces the previous path's rows, and the facet re-reads the path the card holds
- a refused listing shows the server's own words and never an empty directory
- box.file reads the workspace's copy into a file card; base64 is stated as binary
- the Services facet lists what plue answered — a name and a state, because that is all the DTO carries
- a workspace that declares no services says so
- the Egress facet reads a page, keeps plue's cursor, and never renders a secret's value
- a cursor loads the older page and appends it; a page with no next link exhausts the cursor
- an audit page Smithers cannot read is an error, never an empty audit
- a computer that called nothing says so
- a creation the worker refused for the missing egress proxy names plue's code exactly
- the same refusal on an act with a card puts the code on the card beside the server's words
- a refusal with any other code stays the server's message alone

`src/mainview/state/seams/EgressSeam.test.ts` (18, all new):

- plue's row reads as the call it was, with the secret NAMES and no value
- a blocked call keeps its status and reads as blocked
- no swapped secrets is an empty list whether plue writes [], null, or nothing
- a row missing a fact it would have to state drops rather than inventing one
- an empty path is a real call to the host's root, not a malformed row
- the rel="next" link's cursor is the next page's position
- a last page (first link only) exhausts the cursor
- a next link that leaves the route it paginates is not followed
- the page asks for plue's own limit and reads the rows and the cursor
- a cursor rides the query
- a refusal is the server's own message, verbatim
- rows Smithers cannot read are an error — an empty audit would be the one lie that matters here
- the two resources share one path shape
- a signed-out session refuses with the sign-in step; a degraded one with the enable wording
- the agent session's audit answers as a transcript listing, secret names and all
- a page with more behind it names the cursor the next call takes
- a session that called nothing says so
- a line never carries a secret's value — only the binding's name

`src/mainview/cards/WorkspaceCard.test.tsx` (14 new, 22 in the file):

- the header names the repo, the bookmark, and the bookmark's head — labeled, distinct from the workspace's own
- the header states the kind, the workspace's own head, ahead/behind, the environment and the persistence
- every header fact the payload does not carry renders nothing at all
- a zero ahead and a zero behind are facts the wire stated, so they render
- uptime reads from started_at, and a workspace that never started has none
- a running workspace shows its uptime on the card
- the ssh host is a copyable line; without one there is no line and no button
- the Files facet lists the workspace's own copy; a directory and a file each open through the workspace routes
- a Files facet the card has not read renders nothing rather than an empty directory
- the Services facet lists the name and state plue answered — there is no port and none is shown
- the Egress facet names the call and the secret NAMES, never a value, and offers the older page
- an exhausted audit offers no older page, and an empty one says the computer called nothing
- the egress facet is reachable from the facet strip
- a creation the worker refused for the missing egress proxy names plue's code, exactly

## Routes and field mismatches (plue)

**How these were verified.** The app must not be launched or relaunched in
this lane, and the local origin's bridge needs the page's
`x-smithers-local-session` header, which only a running app mints — so no live
HTTP status was observed. Every route path, method, envelope and field below
was read from the deployed server's own source at `~/plue`
(`cmd/server/router.go`, `internal/routes/*`, `internal/services/*`). Where a
status is quoted it is the status that code writes, not one this lane saw on
the wire. Nothing was inferred from a doc.

| Route | Expected (brief) | Observed (plue source) | What shipped |
| --- | --- | --- | --- |
| `GET /api/repos/{o}/{r}/workspaces/{id}` | kind, head{change_id,commit_id}, ahead, behind, environment{source,revision,closure_hash}, persistence, ssh_host, started_at | **Matches.** `services.WorkspaceResponse` (`internal/services/workspace.go:155`) carries all of them, `started_at` as `*time.Time` (null when never started). | Parsed onto the row and the card; empty strings and an empty head read as absence. |
| `GET …/workspaces/{id}/services` | rows with `name`, `state`, **`port`/`url` as returned** | **MISMATCH.** `services.WorkspaceManagedService` (`internal/services/workspace_facets.go:63`) is `{name, state}` only. There is no port and no url in the DTO, the service, or the route. | The facet shows the name and the state. No port column exists and none was invented. |
| `GET …/workspaces/{id}/files?path=` | rendered with the local file card's listing component | **PARTIAL MISMATCH.** Entries are `{name, path, type, size}` with `type` ∈ `file` \| `dir` \| **`symlink`** (`workspace_facets.go:42`). The shared `file-list` entry schema (`packages/rpc/src/Cards.ts`) admits only `file` \| `dir`. | `FileListCardBody` is imported, not copied; a `symlink` renders as a file row. The workspace payload keeps plue's `type` verbatim so the mapping lives only at the render. |
| `GET …/workspaces/{id}/files/content?path=` | "reads the file through the workspace route and renders the file card" | `services.WorkspaceFileContent` = `{name, path, type, encoding, content, size}`; `encoding` is `utf-8`, or `base64` when the bytes are not valid UTF-8 (`workspace_facets.go:355`). Capped at 1 MiB (413 above it). | `encoding: "base64"` sets the file card's `binary: true`, so the card states the file is binary instead of printing bytes. Markdown goes through the editor via the existing `isMarkdownPath` path. |
| `GET …/workspaces/{id}/egress` and `GET …/agent-sessions/{id}/egress` | cursor paginated rows `{occurred_at, host, method, path, status, allowed, swapped_secret_names[]}` | **Matches.** `router.go:1460` and `router.go:1387`; both served by `serveSandboxEgressAudit`. Body is a **bare JSON array** (never an envelope). Pagination: `?limit=` (default 30, max 100) + opaque base64 `?cursor=`; `Link` carries `rel="first"` always and `rel="next"` only when a page follows; `X-Per-Page` is set and **`X-Total-Count` is not**. | One page loader shared by both resources; the card keeps the cursor and appends on "Load older"; invalid JSON, a non-array body, or a nonempty page whose rows do not parse returns an error and preserves the loaded rows and cursor. Only a valid empty array reports no recorded calls. |
| `POST /api/repos/{o}/{r}/workspaces` refused with `egress_proxy_unavailable` | "says exactly that on the card" | **NOT REACHABLE TODAY.** The code is written by the microsandbox worker as `503 {"error":{"code":"egress_proxy_unavailable",…}}` (`internal/microsandbox/worker/server.go:935`) and passed through by the controller (`control/controller.go:2031`), but the API turns it into a `sandbox.StatusError` and **no code in `internal/services` maps it to an `APIError{Code: "egress_proxy_unavailable"}`**. Worse, the browser create route is asynchronous (`CreateWorkspaceAsync`, `workspace_provisioning.go:516`): the POST answers a `pending` row and the provisioning failure only drives `status=failed` — `markWorkspaceProvisionFailed` records no reason and `provisioning_stage` never carries the code. | The seam now reads `code` **as well as** `message` on every refusal, because `routes/auth.go writeRouteError` sanitizes a 5xx message to the status text but **keeps `Code`** — reading only `message` (what the shared `readErrorMessage` does) would lose it. When the code arrives the act answers `egress_proxy_unavailable — <server message>` and the card prints the code on its own line. Proven with a route double, not against production. **plue bug to file: the sandbox provider's contract code does not survive into the workspace API's error, and an async provisioning failure records no reason at all.** |
| `GET /api/user/workspaces` | live on plue; Worker 404 until deploy | **Confirmed.** `apps/server/src/index.ts` `PLATFORM_PROXY_RULES` gained `{ prefix: "/api/user/workspaces", methods: ["GET"] }` in this tree and is not deployed. Rows are `services.UserWorkspaceRow` = `{workspace_id, repository_id, repository_owner, repository_name, workspace_title, state, last_accessed_at, last_activity_at, created_at, sort_timestamp}`. | The per-repo list stays the source; the per-user parser reads **that** row shape and never the per-repo DTO. The switcher row carries none of plue#446's facts, so the merge keeps what the collection already knows and drops `startedAt` when the status leaves `running` (an uptime for a computer that is no longer up would be a lie). |
| `GET /api/user/workspaces` pagination | — | **Pre-existing plue defect, re-confirmed (lane citc filed it).** The route writes legacy `page`/`per_page` links while its own parser (`parseUserWorkspacesPagination`) reads only `cursor`/`limit`, so its `rel="next"` links are unfollowable as written. | Unchanged: the seam re-issues the next page as the offset cursor `(page − 1) × per_page`, which both list routes accept. |

## Not built, and why

- **The Egress facet on the agent-session card.** There is no agent-session
  card in this app: grepping `agent-session` / `agentSession` across
  `apps/app/src` and `packages/rpc/src` finds only `agentSessionId` on
  `ChangeRevisionSchema` (`packages/rpc/src/Changes.ts:27`). Inventing a card
  to hold a facet would be an unbriefed user-visible surface. Instead the
  route is real and tested end to end in the seam, and reachable as
  `/egress.session <sessionId> [owner/repo] [cursor]`, which answers the same
  rows as a transcript listing (the idiom `box.list` already uses) and
  names the cursor for the next page. When an agent-session card lands, the
  facet is `loadEgressPage(ctx, agentSessionEgressPath(...))` and the same row
  markup.
- **Service actions** (`POST …/workspaces/{id}/services/{name}/{action}`) and
  **workspace file writes** (`PUT …/files/content`) exist on plue but are not
  in the brief, so no button and no flow was added for either.
- **No environment or image picker** — ADR 0002's standing default; the
  environment reference is stated, never chosen.

## Gates

`cd apps/app && bun x tsc --noEmit -p .` — clean for every file this lane
touched. The only errors in the project are three in
`src/mainview/cards/ChangeCards.tsx`, lane L1's in-flight work.

`bun test src/mainview/cards/WorkspaceCard.test.tsx
src/mainview/state/seams/WorkspaceSeam.test.ts
src/mainview/state/CloudTerminalClient.test.ts` — **90 pass, 0 fail.**
Adding `src/mainview/state/seams/EgressSeam.test.ts`: **108 pass, 0 fail.**

`bun test src` — **1636 pass, 17 fail, 6 errors** across 173 files. None of
the failures is in a file this lane touched:

- **3** — the pre-existing `src/bun/TargetGraph.integration.test.ts` fixture
  failures (`~/artsy/force`), untouched as briefed.
- **8 fail + all 6 errors** — `src/bun/Main.test.ts`. Every one is the 5 s
  default per-test timeout while several lanes run suites at once; the file
  spawns the real native entrypoint per scenario. `bun test --timeout 30000
  src/bun/Main.test.ts` → **10 pass, 0 fail**, and running the probe by hand
  (`bun e2e/native/MainProcess.ts`) answers a full report in 1.5 s. Load, not
  a defect.
- **6** — lane L1's in-flight `ChangeCards.tsx`: 4 change-card tests plus the
  2 `parity.test.ts` assertions that name `ChangeCards.tsx` (handler count
  8 → 16 and ten unregistered `data-flow` names). This lane's own parity pin
  (`WorkspaceCard.tsx: 15`) and registry pin (the five new flow names) both
  pass.

## Incident: the working copy was reset mid-lane

At **20:36:35** another session ran `jj new 4c97e9b7a94e` on the shared
colocated repo, which moved the working copy onto an empty commit and removed
every uncommitted file in the tree — 78 files across six lanes, ~10 300 lines,
this lane's work included. The previous working-copy commit
`oskxxrxuvlrz` / `d21ed26ebc55` still held all of it, and its parent differs
from the new parent only in `packages/smithers/gateway` and `docs/` (nothing under
`apps/`), so `jj restore --from d21ed26ebc55 <the 78 paths>` returned the tree
exactly. The coordinator squashed the same commit back independently; both
recoveries produce identical content and every file was re-verified afterwards
(`tsc` clean, the lane's suites green). Nothing was lost. Recorded here
because it is the third instance of the shared-jj-tree hazard
(`gotcha_commit_while_campaign_lanes_write_the_tree`): a lane must never run
`jj new` while other lanes hold uncommitted work.
