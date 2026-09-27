# Lane `piper` — REPORT

Brief: `piper.md`. ADR: `../decisions/0001-piper-one-truth.md`. Status: all
seven steps shipped and green. The code landed as `555ff93f ✨ feat(ui):
replace watched repositories with a loaded repository inventory` (the lane
cannot be split: the shared schema rename breaks `apps/server` the moment it
changes); the docs updates in this report's commit are the only remainder.

## What shipped, per step

1. **Cloud proxy.** `/api/cloud/*` on the Bun origin forwards to
   `SMITHERS_CLOUD_API` (default `https://api.jjhub.tech`): Host/Origin follow
   upstream, `content-length` and the local session header drop, Set-Cookie
   re-scopes, `Authorization: Bearer` attaches from the Bun-side credential,
   offline answers 501, the bootstrap advertises `cloud`. Tests in
   `src/bun/server.test.ts`.
1b. **Cloud sign-in.** `POST /api/cloud-auth/start` (loopback `/callback`
   listener, `${api}/api/auth/github/cli?callback_port=` URL), `GET
   /api/cloud-auth/session` (`{ state, username, expiresAt }`, never the
   token), `POST /api/cloud-auth/sign-out`. Token in the macOS keychain
   (`smithers-cloud`, account = api host) plus Bun memory;
   `SMITHERS_CLOUD_TOKEN` read first; five-minute wait; the post-sign-in
   probe (`GET /api/user/workspaces` → 403 insufficient-scope) sets
   `scopes: "degraded"` on the session row for later lanes. `cloud.sign-in` /
   `cloud.sign-out` are user-only flows in the `cloud` namespace. Tests in
   `src/bun/CloudAuth.test.ts`.
2. **Model.** `repositories` (`org/repo`, org, ownerKind, name,
   `head { bookmark, changeId, commitId } | null` — NO mirror field) and
   `workingCopies` (local | workspace, label, path?, workspaceId?, ahead?,
   state?) collections, plus the `cloudSessions` row. `RepositoriesSeam`
   reads `/user/repos` + `/user/orgs` + per-repo `/bookmarks`, shaped so
   plue#445's `owner_type`/`default_bookmark_head` short-circuit the
   per-repo call when they land. The local inventory and checkout probes
   described by this original lane retired in #2239; current copies are boxes.
   `repo.selected` takes `org/repo` or `org/repo#copyId` (pin keys retired
   in #2239). `RepoContext` resolves: explicit token → active selection →
   a single loaded repository → honest errors. 131 seam tests.
3. **Sidebar.** `ChromeBar` renders the tree `org/ → repo → working copies`
   (org headers, repo rows, copy rows `label · N ahead` / `label · state`;
   no mirror glyph). Local checkouts whose remote parses into the inventory
   nest under their repository; unknown checkouts stay standalone rows.
   `tabs.ts selectRepo` passes piper tokens straight to the reducer. Tests
   beside it (`the sidebar's piper tree`).
4. **Origin chip.** `~/smithers · 3 ahead of main` (jj probe), the branch
   when no probe ran, `head @ qupxosqw` at a repository's head, workspace
   copies `label · state`. The composer's selector lists the inventory with
   the same grammar and offers `cloud.sign-in` when signed out. Tests in
   `ComposerLayout.test.tsx`.
5. **Card headers.** `file` / `file-list` payloads gained optional `address`
   (`/org/repo/path`) and `readAt { changeId, commitId }` in
   `packages/rpc/src/Cards.ts`. The header renders the address and short
   change id, and a `head moved to <id> · refresh` line when the
   inventory's head COMMIT id differs from `readAt.commitId`. Nothing
   auto-refreshes. There is no `search-results` card kind anywhere in the
   tree, so no third payload changed — noted, not invented.
6. **Files flows.** `/files.list` and `/files.read` accept a global path as
   one token (`/files.read /org/repo/README.md`) when the two-segment prefix
   is a repository the app knows (inventory, working copy, or open local
   repo); a root-relative local path keeps its old meaning. Cloud reads
   stamp `readAt` from the inventory head, local reads from the jj probe.
7. **Docs.** `LOCAL-APP.md` (cloud routes table, cloud proxy paragraph,
   navigation) and `WORKBENCH-UX.md` §3.11 match what shipped.

**Deletion.** The `watchedRepos` collection, the `repos.watch*` flows, the
`repo-chooser` card kind, the first-run chooser (`openFirstRunRepos`,
`needsSelection`), and the `repos-selected` requirement are gone;
`APP_SCHEMA_VERSION` bumped 9 → 10 so persisted state with the dead
collection/card wipes clean. `flow.create` no longer requires
`repos-selected`; `flow.repo.choose` reads the loaded inventory. Chooser
tests whose subject was the retired behavior were deleted; setup-only
`watched.replaced` dispatches migrated to `repositories.loaded`.

## Decisions worth knowing

- **No `search-results` card** exists; step 5's third payload was skipped by
  evidence, not forgotten.
- **Connector rows left the sidebar.** Connectors that were never opened
  used to appear as repo rows; the tree shows repositories and working
  copies only (connectors remain for `connect` / `connector.add`).
- **A local read's card id keeps the checkout's name** while its `address`
  carries the global path — the card belongs to the copy that served it.
- **Standalone local groups render exactly like the old pin rows** (same
  test ids, unpin, `+`), so the unsigned-in local app is byte-identical.

## Gates

- `pnpm exec tsc --noEmit` (apps/app) — clean.
- `bun test src` (apps/app) — 1265 pass; 3 fail, all in
  `src/bun/TargetGraph.integration.test.ts` and pre-existing (they need the
  `~/artsy/force` fixture; they fail on a clean checkout).
- `bun test` (packages/rpc) — 119 pass.
- T1 `e2e/playwright/piper.spec.ts` — passes: opens `~/smithers`, sees it
  nested under `smithersai/smithers` in the tree, `/files.read README.md`,
  card header shows `/smithersai/smithers/README.md · kxyzqrpv`.

## Pre-existing e2e breakage (NOT this lane)

The full playwright run shows 8 failures; none are piper's:

- `frames.spec.ts` (2) expects a `kind: "repo"` card. The upsert was deleted
  in `b8af974334` (phase2 import) — verifiable: `git grep 'kind: "repo"'`
  finds no live upsert at `555ff93f~1` either.
- `repo-targets.spec.ts` (3) is fixture drift: `~/artsy/force` now answers
  `84 of 84` targets where the spec pins `82 of 82`.
- `target-graph*.spec.ts` (2) need the real force fixture/backend, the same
  reason the unit TargetGraph tests fail.
- `tabs.spec.ts` PTY keystrokes (1): PtyClient/TerminalView are untouched by
  the lane (`git diff 555ff93f~1 HEAD` empty for both); the failure era is
  the phase2 import.

The lane's own e2e surface (tabs, composer, piper) passes: 19 passed / 2
skipped outside those eight.

## Follow-ups (not this lane)

- `plue#445` (`owner_type`, `default_bookmark_head`): when it lands, the
  per-repo bookmarks call short-circuits — the seam already reads the wire
  fields.
- The stale e2e specs above need a wave of their own (or deletion) — they
  pin pre-import behavior.
- `scopes: "degraded"` is exposed on the cloud session row; no
  workspace/agent/approval acts exist yet to render "sign in again to
  enable".

## Review (Kimi K3, read-only, 2026-09-02) and what changed

Fixed in the working tree after the review: (1) CRITICAL `/api/cloud//evil.example/x` was scheme-relative and would have sent the bearer to an arbitrary host — the proxy now refuses a leading-slash or empty rest and asserts the constructed origin is the upstream's; (2) HIGH the identity session cookie was forwarded to the cloud API — `cookie` is stripped; (3) MEDIUM every local file card read "head moved" forever because a working copy's `@` is never the bookmark head — `readAt.source` distinguishes head reads from working-copy reads and the line renders only for the former; (5) MEDIUM the OAuth callback accepted any later POST — the first well-formed callback claims the attempt and later ones answer 409. Each has a test.

Open follow-ups from the same review: (4) `resolveTargetRepo` falls through a legacy selection whose repoId is not `owner/repo` to a single-repo guess; (6) the keychain write passes the secret on `security`'s argv and the entry's ACL is `security`'s default; (7) the 9→10 schema bump resets the whole OPFS store (transcript, world, tabs, pins) — quarantine exists only on the fallback backend; (8) sidebar copy rows read `name · N ahead` where ADR 0001 says `~/path · N ahead`, so two checkouts of one repo are indistinguishable; (9) the jj probe runs on the request path with no timeout; (10) a deleted upstream bookmark never clears a stale head (`head ?? existing.head`).
