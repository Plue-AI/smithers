# T-GH-08 Follow `main` by default; sync health and Retry

Stage S1 · Size S · Depends on T-GH-02, T-UI-06, T-APP-19 · Unblocks — · Issue: [#3453](https://github.com/smithersai/smithers/issues/3453)
Spec: spec.md §4.4, §6.3 (`/api/github/sync`), §7.2 (`home`), §7.2.1, §12.2.3, §12.3 (`main` moved row), §12.6, §14.3 (Home `main`) · Delta: delta.md §7 "`mirror: pull` is the default…", "Health model…" · Product: mvp.md J10.4, J10.6, §6.3 "`main` moves", "Sync status", Appendix A `/github`, Appendix B.2 (`github.app`, `github.reconcile`)

## Goal
The install's repository follows GitHub's `main` with no declaration, and the Home card's `main` row reads "synced 40 s ago", turns gold past twice the target with Retry, and names the cause when GitHub refuses. Any member, or an agent acting for one, can press Retry.

## Scope
In:
- The install always follows `main`: only `mirror: pull` is supported for the install's repository (§12.2.3). A repository with no `.smithers/factory.json`, or one that declares no or another `github.mirror` value, is followed.
- Health per §4.4 and §12.2.3, over the required streams (refs, pulls, `pr-state`) against a 60 s target: `fresh` while the oldest one's `last_success_at` is within 2 × target; `stale` past it (gold); `refused` on a permission or not-installed error, naming the cause and linking the Settings card; `limited` on a rate limit, with `retry_at`. When several hold, `refused` > `limited` > `stale` > `fresh`.
- The stale transition is published when its time arrives, not at the next poll.
- `GET /api/github/sync` → `{state, last_success_at, cause?, retry_at?}` (§12.6). The client computes "synced N s ago" from `last_success_at`, so no delta is sent each second.
- `POST /api/github/sync` → Retry, which forces every stream now (§12.6) through the T-GH-02 hook. Any member may press it, and it is `agent: run` (§12.6, §15.1.5).
- The `home` topic's `main {sha, title, last_success_at, health, cause?, retry_at?}` (§14.3) updates on every `main` move and every health change, within the §7.2.1 budget.
- `/github` (Appendix A) reads and retries through this resource; `github.app` and `github.reconcile` are renamed to it (Appendix B.2).

Out: the Home card's rendering, including the client-side age (T-APP-01); the Settings card's fix links (T-APP-03); streams and budget (T-GH-02); rebases after a move (T-STK-08, T-STK-11); force-push handling (T-GH-07); the catalog row for `/github` (T-CAT-01).

## Changes
- `packages/backend/internal/services/github_main_pull.go:782-800` (`readGitHubMirrorPolicy`) and `:503-506`, `:580-582` → the install's repository is always `pull`; it is never `skipped`.
- `packages/backend/internal/services/github_sync_health.go` (new) → the §4.4 evaluator over `github_sync` rows, with a timer for the next stale boundary.
- `packages/backend/internal/routes/github_sync.go` (new) → `GET` and `POST /api/github/sync`. Authorization: any member's session or delegated credential (§5.2 join-branch level). OpenAPI rows in `docs/api/openapi/github.yaml`; re-bundle `docs/api/openapi.yaml` (`pnpm exec smithers-build run '//:openapiBundle'`).
- Projection: write a `projection_events` row for `home` in the same transaction as the `github_sync` change (§3.1). The row's `last_success_at` is the oldest required stream's, so it changes at most once per poll of that stream.
- Delete the per-repository status routes `GET` and `POST /api/repos/{owner}/{repo}/github/main-pull` (`packages/backend/internal/compose/router.go:1109-1112`, `packages/backend/internal/routes/github_main_pull.go`). They have no OpenAPI row today.
- `apps/app/src/mainview/flows/entries/github.ts:21` (`github.app`) and `:52` (`github.reconcile`) → renamed `/github` on the new resource; delete the `GitHubSeam.ts` calls only they used.
- `packages/backend/docs/github-sync.md` → "Health and Retry" section; docs gates as in T-GH-02.

## Tests
- Unit, `github_sync_health_test.go` (new): `fresh` at 119 s and `stale` at 121 s after the last success; `refused` for `permission` and `not_installed` with the cause; `limited` carries `retry_at`; with `refused` and `limited` both true the state is `refused`.
- Integration, real PostgreSQL + real git + `githubfake` (`github_main_pull_test.go`, existing): a repository with no factory file, and one declaring `github.mirror: none`, both reach state `synced`, never `skipped`; a fast-forward on the fake remote moves the mirror.
- Integration: `POST /api/github/sync` from a member's session, and from a member's delegated credential, starts a fetch of every stream within 1 s; a health change publishes one `home` delta; an idle fresh minute publishes at most one delta per poll of the oldest required stream, never one per second.
- Integration: the fake server answers 403 "Resource not accessible by integration" → `refused` with that cause; 429 with `Retry-After: 120` → `limited` with `retry_at` 120 s out.
- e2e: [C-J10-06](../checks/C-J10-06.md).

## Acceptance
- [C-J10-06](../checks/C-J10-06.md): the `main` row shows "synced Ns ago" computed from `last_success_at`, turns gold past 120 s after network loss, and Retry recovers it.

## Risks and notes
- Risk: a client clock skewed from the host's makes "synced N s ago" wrong. Observation: C-J10-06's computed age differs from the row by more than 2 s on a browser with a skewed clock. Then the snapshot also carries the server time, and the client offsets by it.
- Appendix B.2 lists `github.app` for the owner; §12.6 opens Retry to every member. The status and Retry follow §12.6; App management stays in Settings for the owner.
