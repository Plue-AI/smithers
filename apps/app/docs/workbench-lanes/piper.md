# Lane `piper` — one truth, one address space

Brief: `../decisions/0001-piper-one-truth.md`. Laws: `apps/app/AGENTS.md`
(EMBED LAW, NO INVENTION, no `useEffect`, state in TanStack DB collections,
every act a flow). Tokens: `apps/app/src/mainview/styles/tokens.css`.

## Scope, in order (each step green before the next)

1. **Cloud proxy.** `/api/cloud/*` on the Bun local origin
   (`apps/app/src/bun/server.ts`) forwards to `SMITHERS_CLOUD_API`
   (default `https://api.jjhub.tech`), following `proxyIdentity`: Host and
   Origin follow the upstream, `content-length` and the local session header
   are dropped, Set-Cookie re-scoped, trail line logged. Adds
   `Authorization: Bearer $SMITHERS_CLOUD_TOKEN` when set. Offline mode
   answers 501 like the identity stub. Server tests.
   **1b. Cloud sign-in (browser login, the CLI's flow).** `POST
   /api/cloud-auth/start` on the local origin: Bun listens on
   `127.0.0.1:<random>` with `/callback`, answers `{ url }` =
   `${SMITHERS_CLOUD_API}/api/auth/github/cli?callback_port=<port>`; the
   renderer opens it through the native `openExternal` door (flow
   `cloud.sign-in`, user-only). The callback receives `{ token, username,
   email, expiresAt }`; store the token in the macOS keychain (`security
   add-generic-password -s smithers-cloud -a <api host>`), keep it in Bun
   memory, NEVER send it to the renderer; `GET /api/cloud-auth/session`
   answers `{ state, username, expiresAt }` only; `POST /api/cloud-auth/
   sign-out` deletes it. `SMITHERS_CLOUD_TOKEN` is a dev/CI override read
   first. Five-minute wait timeout. After sign-in, probe once with
   `GET /api/cloud/api/user/workspaces`: a 403 whose body says insufficient
   token scope sets `scopes: "degraded"` on the session answer; the renderer
   keeps a `cloudSession` row and workspace/agent/approval acts render "sign
   in again to enable" (no such acts exist in this lane yet; expose the state
   so later lanes read it). Tests with a fake upstream that posts to the
   callback and one that answers the probe 403.
2. **Model.** New `repositories` collection: rows `{ id: "org/repo", org,
   name, head: { bookmark, changeId, commitId } }` (NO mirror field: the
   backend has no mirror status yet; never fake it)
   and `workingCopies` rows `{ id, repoId, kind: "local"|"workspace", label,
   path?, workspaceId?, ahead?: number, state? }`. Fed by a
   `RepositoriesSeam`: `GET /api/cloud/api/user/repos` (rows have owner,
   name, full_name, default_bookmark, NO head), `GET /api/cloud/api/user/
   orgs` once to classify owners, and `GET /api/cloud/api/repos/{owner}/
   {repo}/bookmarks` per repo for the default bookmark's
   `{ target_change_id, target_commit_id }`. Shape the row so plue#445's
   `owner_type` and `default_bookmark_head` replace the per-repo call when
   they land. `RepoContext` resolves the active repository or box. The local
   inventory and its resolution helpers retired in #2239.
3. **Sidebar.** Replace the flat REPOS list with the tree in the ADR, minus
   the mirror glyph (see ADR "Settled with the backend").
   Selecting a repo row sets context; selecting a copy row sets the active
   copy (`repo.select` grammar: `org/repo` or `org/repo#copyId`).
4. **Origin chip.** `~/smithers · 3 ahead of main` or `head @ qupxosqw`.
5. **Card headers.** `file`, `file-list`, `search-results` payloads gain
   `address: "/org/repo/path"` and `readAt: { changeId, commitId }`; the header renders
   the change id; a `head-moved` line appears when the repo row's head
   COMMIT id differs from `readAt.commitId` (a change id survives a rebase). Shared schema in `packages/rpc/src/Cards.ts`, optional fields.
6. **Files flows** accept a global path: `/files.read /org/repo/README.md`.
7. **Docs.** Update `apps/app/docs/LOCAL-APP.md` (routes table, navigation)
   and `apps/app/docs/WORKBENCH-UX.md` §3.11 to match what shipped.

## Exit

`pnpm exec tsc --noEmit` and `bun test src` green in `apps/app`;
`bun test` green in `packages/rpc`; T1 spec `e2e/playwright/piper.spec.ts`
opens `~/smithers`, sees it under its repo in the tree, reads
`/files.read README.md`, and the card header shows the address and `readAt`.
Do not commit; leave the working tree for review.
