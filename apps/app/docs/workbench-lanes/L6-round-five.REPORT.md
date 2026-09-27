# Lane L6 — plue's round-five routes and fields — REPORT (2026-09-03)

Brief: `L6-round-five.md`, including its **Addendum (plue api `be298a4fc7bb`):
desktop facet** and the coordinator's mid-lane **round-seven update** (plue api
`9e84d76dc59c`: the desktop session POST answers `503 desktop_not_ready` with
`Retry-After`, not 500). Prior state: `L1-change-facets.REPORT.md`,
`L3-workspace-card.REPORT.md`, `L3b-desktop.REPORT.md`,
`L5-sync-live.REPORT.md`.

## How each shape was established

**What was observed on the wire** (read-only GETs, 2026-09-03):

The app's local origin needs the page's `x-smithers-local-session` header,
which only a running app mints, and the lane must not launch the app; the
Bun keychain PAT is not reachable here and both environment tokens 401. So
**no response BODY was observed**, and every field-level fixture below is
`unverified` in the brief's sense — source-verified at the exact deployed
commit, proved against route doubles, never seen on a live wire. Where a
route's EXISTENCE was proved by a 401, the table says so.

## Rows

| # | Field / route | Fixture | Shipped |
| --- | --- | --- | --- |
| #484 | `actor_login` on `turn`; `user_login` on comments; `type` on `ChangeReviewResponse` | **unverified** (source: `services/landing.go:137,110`, `services/change.go:222`) | Header reads `turn: <login> · <party>` and never the numeric actor id; a turn naming no login falls back to the party alone. Thread rows read `path:line · <author> · rev N` (ADR 0004's `· will ·`). The Review facet's verdict row states plue's `type` when it differs from `verdict` — the agent's `lgtm · approve` — and the strip reads `agent lgtm at rev 2 (low confidence)`. |
| #485 | `landing_request_number` beside `landing_request_id` | **unverified** (source: `services/change.go:105-111,246`, `db/changes.sql.go:125`) | `stack.landingNumber` comes off the change GET's own `stack.landing_request_number`; the landings list is the fallback. `landingNumberOf` — every thread transition, review request and unrequest — now addresses the landing from the change GET, so the 100-row list read happens only in the card's re-read afterwards. The History facet's landed row reads `landing #42 · by will · …` from `landed.landing_request_number`. |
| #486 | comments carry `state` (lifecycle) and `anchor_state` | **unverified** (source: `services/landing.go:105-115`) | `state` is parsed as the lifecycle directly and `anchor_state` as the anchor. The pre-#486 derivation survives as a FALLBACK only: a row spelling no lifecycle falls back to `done_at`/`resolved_at`, and a row spelling no `anchor_state` falls back to an anchor word in `state`. A row stating neither leaves both null, so the card renders no glyph and offers no transition. |
| #487 | `POST …/findings/{id}/feedback`, `POST …/findings/{id}/dispatch` | **unverified** (source: `routes/jj_vcs.go:515,565`, `services/change.go:1164,1202`) | `findings.not-useful` POSTs `{ useful: false }` (no note invented) and the re-read dims the row and reads plue's own recorded word. **Defect fixed on the way:** `feedback` is an OBJECT on the wire (`services.FindingFeedbackResponse`), not a word — the old `str(value.feedback)` parse silently dropped every recorded feedback. `findings.please-fix` (confirm) POSTs the dispatch, and the 202's `AgentSessionResponse` renders as the existing card kind: when it names a `workspace_id` (RFD-004) the workspace card is rendered through the seam the controller lends; when it does not, the line names the session and nothing is invented. |
| #488 | `POST/DELETE …/landings/{n}/review-requests`; `review_requests[]` on the landing DTO | **unverified** (source: `router.go:1201-1202`, `routes/landings.go:285,316`, `services/landing.go:122-131,177,1959`) | `review.request <changeId> <login\|agent:name>` (confirm) — plue refuses a body naming both a reviewer and an agent, so exactly one is sent and `agent:` is the one spelling that asks a named agent. `review.unrequest <changeId> <requestId>` (confirm) DELETEs. The Review facet gained the Request review picker: one row per `review_requests[]` entry (login or `agent <name>`, plue's state word, who asked) with Unrequest on a request still `requested`; the Suggested reviewers slot is now one click each, and the Owners facet's `missing · ask` row carries a Request review button per candidate (ADR 0004 row 10). |
| #489 | `POST …/changes/{id}/split` | **unverified** (source: `router.go:1186`, `routes/jj_vcs.go:661`, `services/change.go:202-209`, `repohost/client.go:151`) | `change.split <changeId> <path…>` (confirm). **Deviation, stated plainly:** the brief shows `change.split <changeId>`, but plue's route splits BY PATH and refuses an empty `paths` with 400 `paths must not be empty`. So the act names its paths, the card offers it on the Diff facet's file rows — the only place the paths are — and the gate is the brief's: only while `stack.landable_prefix < stack.size`. The 200's `{ original, split }` renders BOTH returned changes as change cards. |
| #490 | `POST /repos/{o}/{r}/github/reconcile` for writers | **unverified** body (source: `router.go:1170`, `routes/git_mirror_sync.go:63`) | `github.reconcile [repo]` now posts the per-repository route for everyone; the admin route is gone from the app. No `/admin.*` flow used it, so none was kept and none was invented. **This closed the one row in `parity-hosts.test.ts`'s `KNOWN_UNPROXIED`:** the Worker allowlists no `/api/admin/` prefix, so `/github.reconcile` used to 404 on the web and now works there. |
| #482/#483 | `failure_code`/`failure_message` on workspace rows + SSE; `port`/`url` on services | **unverified** (source: `services/workspace.go:186-187,348-350`, `workspace_facets.go:66-71`, `workspace_exec.go:330`) | **These were NOT already parsed — L3 read plue at a commit that predated both.** Now: `failure_code`/`failure_message` parse off the per-repo DTO, the per-user switcher row, and the status stream (a failed event carries the reason; a later status-only event leaves it standing), and the card prints `<code> — <message>`, absent when the platform recorded none. Services parse `port`/`url` (both `omitempty`, so an absent port is absence, never a zero) and the card shows `port 5432` and the url. |

## Addendum rows

| item | Fixture | Shipped |
| --- | --- | --- |
| workspace reuse includes `kind` (plue#495) | **unverified** (source: commit `be298a4fc7bb`, `GetActiveWorkspaceForUserRepoKind`) | No DTO change, as the brief says. Proved by a list test: a vm and a desktop on ONE bookmark are two rows and both survive the same-bookmark collision, in the collection and in the tree copies. |
| desktop session while activation finishes (plue#496, **round seven**) | **unverified** body, but taken verbatim from plue's own route test | The 500 is gone: the POST answers `503 {"code":"desktop_not_ready","message":"service unavailable"}` with `Retry-After: 2`, and the DTO carries `desktop.ready`. `desktop.ready` is parsed. The facet renders the server's body **verbatim** with the code beside it — plue's `writeRouteError` sanitizes a 5xx MESSAGE to the status text and keeps `Code`, so without the code a person would be told only "service unavailable" — plus the `Retry-After` seconds it asked for, and a `Retry` button running `box.desktop` again. There is no spinner and no invented "still starting" line. Because the server asked to be retried, the seam retries **only** `desktop_not_ready`, waits exactly the `Retry-After` it named, gives up after `desktopSessionRetry.maxAttempts` (30 — a minute at plue's 2 s), and is superseded by a later mint, by leaving the facet, and by deleting the workspace. Any other failure renders verbatim with Retry and is answered once. |
| plue#497/#498 (backend) | — | Nothing to build. A Files facet that lists only `.git` renders exactly that, proved by a card test that also asserts no empty-repository copy appears. |

## Files changed

Schemas (`packages/rpc`): `src/Changes.ts` (`ChangeVerdict.type`, `ChangeTurn.actorLogin`,
`ChangeLanded.landingRequestNumber`, new `ChangeReviewRequestSchema`),
`src/Cards.ts` (change payload `reviewRequests` + its `unread` key; workspace
payload `failureCode`/`failureMessage`; `WorkspaceServiceSchema` `port`/`url`;
`WorkspaceDesktopSchema.ready`; `desktopRefusal` `code`/`retryAfterSeconds`;
sync-ops `behindRefs`/`failedRefs`/`opsCursor`). Every added field is
nullable + optional, so a card persisted before this lane still parses and
`APP_SCHEMA_VERSION` was not bumped.

Cards: `cards/ChangeCards.tsx`, `SyncCards.tsx`, `WorkspaceCard.tsx` (+ all
three tests).

Flows: `flows/Flows.ts` (four new flows), `flows/SlashPayload.ts` (their
grammar), `flows/registry.ts` (five namespace rows),
`state/AppController.ts` (four new actions on the interface and both action
tables — the change controller lives here, not under `state/controller/`).

Pins: `flows/registry.test.ts` (four new names), `flows/parity.test.ts`
(`ChangeCards.tsx` 16 → 21, `WorkspaceCard.tsx` 17 → 18),
`flows/parity-hosts.test.ts` (`KNOWN_UNPROXIED` is now empty — see #490).

**Not changed:** `state/seams/LandingsSeam.ts`. It was on the owned list for
#485, but it already addresses landings by `number` off the landing DTO's own
`number` field — there was no id-as-number workaround there to drop. Also not
changed, as instructed: `Commands.ts`, `App.tsx`, `ChromeBar.tsx`,
`Composer.tsx`, `FileCards.tsx`, `Instructions.ts`, `apps/server`,
`packages/smithers/ui`. The web-mode lane's `hosts` / `nativeOnly` / `absentDoor` /
`explainAbsent` and its two `app.*` flows are intact and were re-read before
each edit; my four flows declare `runtime: ["Smithers Cloud"]`, so they exist on both
hosts.

## New flows

| Flow | Args | Confirm | Note |
| --- | --- | --- | --- |
| `change.split` | `<changeId> <path> [path…]` | yes | plue#489 splits by path; the card offers it per diff file while `landable_prefix < size` |
| `review.request` | `<changeId> <login\|agent:name>` | yes | user and button run it; an agent invocation confirms first |
| `review.unrequest` | `<changeId> <requestId>` | yes | |
| `github.mirror.retry-ref` | `<ref> [owner/repo]` | — | the retry of a ref that already failed; the answer is a new run the card tracks |

Namespaces added to `registry.ts` (they were synthesized with `label = id` and
an empty summary, an L1 gap): `review`, `findings`, `workspace`, `egress`,
`agent`. Only `composer` remains synthesized and every `composer.*` flow is
hidden, so it never renders.

## Tests added, by name

`state/seams/ChangeSeam.test.ts` (71 in the file; 22 new, 5 reshaped):
findings.not-useful records useful:false on plue's own route and the re-read
dims the row (plue#487) · a feedback plue refuses reads its own sentence and
records nothing · findings.please-fix dispatches the agent and lends the run's
computer to the workspace seam (plue#487) · a dispatch that names no workspace
names its session and renders no computer · a dispatch plue already has
running reads its own 409, verbatim · a degraded sign-in dispatches nothing on
a finding, and neither act takes a finding id it cannot use · the landing's
review_requests ride the card, human and named agent alike (plue#488) · a
landing request that carries no review_requests[] key is unread, not empty ·
review.request posts the login on the landing the change GET numbered, then
re-reads the facet (plue#488) · review.request agent:&lt;name&gt; asks the named
agent, never a login · a review request plue refuses reads its own sentence ·
review.request without a reviewer, and on a change no landing carries, call
nothing · review.unrequest DELETEs the request the card listed, then re-reads
(plue#488) · review.unrequest without a request id calls nothing · the landing
number comes off the change GET, not the 100-row list (plue#485) · a change
GET that numbers no landing request falls back to the list · a comment row
that spells no lifecycle falls back to the timestamps (plue#486's fallback) ·
a comment row that states neither a lifecycle nor timestamps renders no state
at all · change.split moves the named paths and renders both returned changes
(plue#489) · change.split with no path calls nothing — plue refuses an empty
paths list · a split plue refuses reads its own sentence and renders no new
change · a split answer that names no changes says so rather than claiming
one. Reshaped: reviews ride the change GET with reviewer_kind, the verdict AND
plue#484's type, … · threads carry plue#486's own state and anchor_state,
plue#484's author, and resolved_in_revision · the turn … (actor_login) ·
findings ride with their revision, state, feedback, … (the object shape) ·
landed provenance rides the change GET (the request number).

`cards/ChangeCards.test.tsx` (42; 6 new, 5 reshaped): a turn that names no
login falls back to the party alone · the Request review picker lists the
landing's requests and unrequests the one still standing (plue#488) · a
landing whose review requests were not read says so; one that answered none
says nobody was asked · the Suggested reviewers slot asks each name with one
click (ADR 0004, plue#488) · the diff facet offers Split per file while the
landable prefix is shorter than the stack (plue#489) · a stack whose whole
prefix can land offers no Split, and neither does one that states no prefix.
Reshaped: the header reads rev N of M and the turn's LOGIN … · the review
strip (`agent lgtm`) · the review facet (the type word, the thread authors) ·
the owners facet (a Request review button per candidate) · the history facet
(`landing #42`).

`state/seams/GitHubSeam.test.ts` (25; 5 new, 3 reshaped): the repository's
behind_refs and failed_refs ride the card beside its mirror word (plue#491) ·
a repository DTO that names the word but no counts carries no count ·
retryMirrorRef posts the escaped ref and tracks the run plue answered
(plue#491) · a per-ref retry the platform refuses reads its own sentence and
starts no run · retryMirrorRef without a ref calls nothing. Reshaped:
reconcile posts the repository's own route, not the operator's (plue#490) ·
reconcile refused for the write scope … · parseMirrorRef … offers a retry only
on a failed ref.

`cards/SyncCards.test.tsx` (27; 4 new): a behind mirror reads plue#491's ref
counts, and a failed ref retries through the per-ref route · a mirror card
whose repository stated no counts shows the word alone · the connected state
connected card whose wire named no actor says nothing about one.

`state/seams/WorkspaceSeam.test.ts` (84; 9 new, 4 reshaped): a service that
publishes neither a port nor a url carries neither — an absent port is never a
zero · a vm and a desktop on ONE bookmark are two rows, and the list carries
both (plue#495) · a failed DTO carries plue's failure code and message onto
the row and the card (plue#482) · a workspace that failed with no recorded
reason states none — a blank is never filled in · a per-user switcher row
states its own failure too (plue#482) · a failed status EVENT carries its
reason; a later event that names none leaves the reason standing (plue#482) ·
a 503 desktop_not_ready reads plue's own body and code, and retries on the
Retry-After it named (plue#496) · a desktop_not_ready that never clears gives
up at the bound, with plue's words and code on the card · any other 5xx is
answered once — a code the server did not ask to be retried is not retried ·
leaving the Desktop facet supersedes a pending desktop_not_ready retry.
Reshaped: the Services facet lists the name, the state, and plue#483's port
and url · the DTO's desktop kind … (`ready`) · the 409 and the 400 refusal
shapes.

`cards/WorkspaceCard.test.tsx` (48; 6 new, 2 reshaped): a service that
publishes no port and no url shows neither — an absent field is absence · a
failed workspace names plue's failure code and message (plue#482) · a failed
workspace the platform gave no reason for states no reason · a Files facet
that lists only .git renders exactly that (plue#497) · a 503 desktop_not_ready
prints plue's code beside its sanitized message, and offers Retry (plue#496) ·
a desktop the DTO says is not ready still renders no frame and no invented
status line. Reshaped: a 400 reads the server's own words and offers no Resume
— only Retry.

## Gates

- `cd apps/app && bun x tsc --noEmit -p .` — **clean** (e2e is in the include, so the specs typecheck). `packages/rpc`, `apps/server` and `apps/review` also typecheck clean.
- `bun test src/mainview/cards src/mainview/state/seams src/mainview/flows` — **754 pass, 0 fail**, 3 208 expects across 40 files.
- `bun test src/mainview` (once) — **1 465 pass, 0 fail**, 6 096 expects across 139 files.
- `cd packages/rpc && bun test` — **142 pass, 0 fail**, 951 expects across 14 files.
- Out of lane, run for honesty: `bun test src/bun/Main.test.ts --timeout 30000` → **10 pass, 0 fail**. `bun test src/bun/TargetGraph.integration.test.ts` → **6 pass, 3 fail** — the three pre-existing `~/artsy/force` fixture failures the brief said not to chase, unchanged.
- Playwright was not run (the lane must not launch the app); `e2e/playwright/{change,sync}.spec.ts` typecheck and neither needed a route change — no spec doubles the routes this lane moved.

## Remaining mismatches for plue

1. **`reviews[].reviewer` is still an id for an agent.** #484 named logins on
   the turn and on comments, but `ListChangeReviews` still projects
   `COALESCE(agent_session_id::text, 'agent')` as the reviewer, so an agent
   review row renders a UUID. The turn's `actor_login` proves plue can resolve
   an agent session's display title; `reviews[]` should carry the same.
2. **A 5xx message is sanitized to the status text.** `writeRouteError` keeps
   `Code` and replaces `Message` with `strings.ToLower(http.StatusText(...))`,
   so `desktop_not_ready` reaches a person as "service unavailable" and the
   card has to print the code beside it to say anything at all. A short,
   contract-safe message on the retryable codes would read better than a
   status word.
3. **The reconcile's 202 is a mirror run and nothing renders it.** #490's
   `ReconcileGitHub` answers a whole `GitMirrorSyncRunResult`
   (`{ id, state, behind_refs, failed_refs, refs[] }`), but the brief's app
   change is only "use it for everyone", so the run is discarded. Either the
   route should answer the reconcile's own result, or a later lane should
   track that run on the mirror card.
4. **`GET /api/user/workspaces` still writes unfollowable pagination links**
   (legacy `page`/`per_page` written, `cursor`/`limit` parsed) — re-confirmed,
   unchanged since lane citc filed it. The seam still re-issues the next page
   as an offset cursor.
5. **No repository-scoped route gives an anonymous caller any signal.** The
   repo-context middleware answers `404 repository not found` before routing,
   so a missing route and a missing repo are indistinguishable without a
   credential. A 401 before the repo lookup would let a client prove a
   deployment without one.
6. **`landing_request_number` is on `stack` and `landed` but not on
   `ChangeRevertResponse`'s sibling paths in the app.** plue does carry it
   there (`services/change_revert.go:22`); it is unused only because this lane
   did not build revert (below).

## Left unbuilt, with the reason

## L6b — plue api `84fd689901f9` (2026-09-03)

Three items off this report's "Remaining mismatches": #1 (`reviews[].reviewer`
is an id for an agent) and #3 (the reconcile's 202 is a mirror run nothing
renders) are closed by plue#500 and plue#502; #4 (unfollowable per-user
pagination links) is closed by plue#503 and needed no app change, only a pin.

**The record used:** `~/plue` holds all three commits — `ffc697d38` (#500,
`feat(changes): add reviewer login`), `3c92968c8` (#502, `fix(github): return
reconcile run id`) and `84fd689901f9` (#503, `fix(workspaces): emit cursor
pagination links`). Every field and body below was read from that Go source
(`internal/services/{change,git_mirror_sync}.go`, `internal/routes/{git_mirror_sync,pagination,workspace}.go`)
and from plue's own route tests, which state the wire shapes verbatim.

**What was observed on the wire** (anonymous read-only GETs, 2026-09-03 — the
public Smithers Cloud mirror `roninjin10/smithers` does answer them):

| probe | code | reading |
| --- | --- | --- |
| `GET /api/health` | 200 | the API is up |
| `GET /api/repos/roninjin10/smithers` | 200 | `mirror_status: "unconfigured"`, and plue#491's `behind_refs` / `failed_refs` ARE present (both 0) — production is at or past #491 |
| `GET /api/repos/roninjin10/smithers/changes` | 200 | `Link: </api/repos/…/changes?limit=30>; rel="first", </api/repos/…/changes?cursor=30&limit=30>; rel="next"` — the cursor Link syntax the seam parses, on a route that already wrote it |
| `GET …/changes/{id}` × 6 | 200 | every change answers `reviews: []`, so **no review row exists to show `reviewer_login`** |
| `GET /api/user/workspaces` | 401 | still credential-gated; #503's own Link header could not be observed |

So `reviewer_login`, the reconcile's 202 and the per-user workspace Link
header are all **unverified** in the brief's sense: source-verified at the
exact commits, proved against route doubles, never seen on a live wire. The
reconcile is a POST and was never called against production.

### Rows

| # | Field / route | Fixture | Shipped |
| --- | --- | --- | --- |
| #500 | `reviewer_login` on `ChangeReviewResponse` | **unverified** (source: `services/change.go:229,824`, `resolveActorLoginWithCache`; plue's `jj_vcs_test.go` states `{"reviewer":"session-reviewer","reviewer_login":"Review agent"}`) | The verdict row on the Review facet, and the human row of the review strip, read `reviewerLogin` and never the id. plue writes the field WITHOUT `omitempty` and leaves it EMPTY when the identity lookup misses, so an empty string reads as absent and the row falls back to `reviewer` exactly as before — which is also what a server predating #500 gets. `reviewer` itself is untouched: it stays plue's stable value, and `review.since-mine` still matches on it (for a human the two words are the same). |
| #502 | `POST …/github/reconcile` answers 202 `{ run_id, id, state, behind_refs, failed_refs, started_at, finished_at, refs[] }` | **unverified** (source: `services/git_mirror_sync.go:78` `GitHubReconcileResult`, `routes/git_mirror_sync.go`; plue's cover test asserts the whole body) | `github.reconcile` now renders that run on the SAME `sync-ops-mirror-<repo>` card `github.mirror-sync` uses, through the same poll: the 202 already names `state` and `refs[]`, so the card states them before the first read, then `GET …/mirror-sync/{run_id}` follows it to `succeeded`/`failed` and the settled run re-reads the repository's own mirror word. The trigger line reads `reconcile started · run 91`. An answer naming no `run_id` (a server predating #502) keeps the old sentence and renders no run — nothing is invented from the `id` alias. A refused reconcile starts no run. The run is tracked even when the App-status re-read is refused: the status refusal is still returned verbatim, but a failing GET on another route is not a reason to drop the run plue already started. |
| #503 | cursor `Link` headers on the per-user workspace list | **unverified** (source: `routes/pagination.go` `setOffsetCursorPaginationHeaders`; `q.Encode()` sorts, so the link is `?cursor=2&limit=2`) | **No change — confirmed by test, as the brief expected.** `nextPageOf` already prefers a `cursor=` link over the legacy `page`/`per_page` form, re-issues it at the seam's own `limit=100`, and refuses a `next` that leaves the route. The new pin uses plue's exact spelling, including its `rel="first"` and `rel="prev"` siblings. |

### Files changed

Schema (`packages/rpc`): `src/Changes.ts` — `ChangeVerdictSchema.reviewerLogin`
(nullable + optional, so a card persisted before this lane still parses;
`APP_SCHEMA_VERSION` unchanged).

Seams: `state/seams/ChangeSeam.ts` (`parseReview` reads `reviewer_login`),
`state/seams/GitHubSeam.ts` (`beginRun`, shared by the mirror-sync trigger and
the reconcile; `reconcile` tracks the run its 202 names).

Card: `cards/ChangeCards.tsx` (the Verdicts row title and the strip's human
row). **`SyncCards.tsx` unchanged** — the sync-ops card already renders
`trigger`, `runState` and the per-ref rows verbatim, so the reconcile needed no
new label.

**Not changed, as instructed:** `Flows.ts`, `Commands.ts`, `registry.ts`,
`App.tsx`, `ChromeBar.tsx`, `WorkspaceSeam.ts` (its parser was already right),
and everything outside the files named. No new flows, no new buttons, so
`flows/parity.test.ts` and `flows/registry.test.ts` needed no re-pin.

### Tests added, by name

`state/seams/ChangeSeam.test.ts` (73; 1 new, 1 reshaped): a review row that
states no reviewer_login carries none — the card keeps the reviewer the wire
named (plue#500). Reshaped: reviews ride the change GET with reviewer_kind,
plue#500's reviewer_login, the verdict AND plue#484's type, … (the shared
CHANGE fixture now carries `reviewer_login`, the agent's being the session
title beside its id).

`cards/ChangeCards.test.tsx` (46; 2 new, 1 reshaped): a review row names the
reviewer's login, never the agent session's id (plue#500) · a review row that
names no login keeps the reviewer the wire gave (plue#500). Reshaped: the
`REVIEWS` fixture carries `reviewerLogin`.

`state/seams/GitHubSeam.test.ts` (27; 2 new, 2 reshaped): reconcile renders the
run its 202 names and polls it to settled (plue#502) · a reconcile whose status
re-read is refused still tracks the run plue started (plue#502). Reshaped:
reconcile posts the repository's own route … (its body is now labelled the
pre-#502 shape and it asserts that an answer naming no run id starts no run and
reads no mirror route) · reconcile refused for the write scope … (asserts no
mirror card is invented for a run that never started).

`state/seams/WorkspaceSeam.test.ts` (85; 1 new, no source change): the per-user
list follows plue#503's cursor Link header.

### Gates

- `cd apps/app && bun x tsc --noEmit -p .` — **clean**.
- `cd apps/app && bun test src/mainview/state/seams src/mainview/cards` — **623 pass, 0 fail**, 2 291 expects across 33 files (617 before this lane).
- `cd apps/app && bun test src/mainview` (once, for honesty) — **1 471 pass, 0 fail**, 6 118 expects across 139 files.
- `cd packages/rpc && bun test` — **142 pass, 0 fail**, 951 expects across 14 files.
- Not run: Playwright (the lane must not launch the app) and `TargetGraph.integration.test.ts` (its three fixture failures are pre-existing and out of lane).

### Remaining mismatches for plue, after L6b

1. ~~`reviews[].reviewer` is still an id for an agent~~ — closed by plue#500.
2. **A 5xx message is still sanitized to the status text.** `c579456ce`
   (`fix(api): preserve safe 5xx error messages`) landed in this same range and
   was NOT read by this lane; the desktop card still prints the code beside the
   message. Worth a lane of its own.
3. ~~The reconcile's 202 is a mirror run and nothing renders it~~ — closed by
   plue#502; the app now tracks it.
4. ~~`GET /api/user/workspaces` writes unfollowable pagination links~~ — closed
   by plue#503. The seam still re-issues the next page at its own `limit=100`
   rather than the link's limit, which is correct only because plue's cursor is
   an offset aligned to the limit the seam itself asked for.
5. **No repository-scoped route gives an ANONYMOUS caller a signal on a PRIVATE
   repo** — narrowed, not closed: a PUBLIC repo (`roninjin10/smithers`) answers
   its DTO, its changes list and its change GET to an anonymous caller, so the
   L6 report's "no repo-scoped route gives any signal" is too strong. The 404
   still hides the difference between a missing route and a private repo.
6. `landing_request_number` on `ChangeRevertResponse` is still unused (revert is
   still unbuilt, for the reason L6 gave).

### L6b addendum — plue#504 (api `36cc18157b82`), terminals gated on guest activation

**The record used:** `~/plue` holds `36cc18157` (`fix(workspaces): gate
terminals on guest activation`, Closes #504). Read: `pkg/errors/errors.go`
(`GuestNotReady`, `CodeGuestNotReady`, `RetryAfter: 3`),
`internal/routes/auth.go` (`writeRouteError` — it now sets `Retry-After` for
ANY `RetryAfter > 0`, not only a 429, and `isSafe5xxMessageCode` does NOT list
`guest_not_ready`, so the message a client sees is the status text),
`internal/routes/{workspace.go,workspace_terminal.go,terminal_session_manager.go}`,
`internal/services/{workspace_ssh.go,workspace_lifecycle.go}`, and plue's own
`workspace_terminal_test.go`, which states the wire body exactly:
`503 {"code":"guest_not_ready","message":"service unavailable"}` with
`Retry-After: 3`. The session POST reaches it through
`ensureWorkspaceRunning → waitForWorkspaceGuestActivation`; the close reason
comes from `terminalSession.markDead`'s `fmt.Errorf("session exited: %w", err)`
over an SSH `ExitError`, delivered as a NORMAL close (`markDead` uses
`websocket.StatusNormalClosure`).

**Unverified on the wire.** The session POST is credential-gated (the public
mirror answers `401`) and it is a write, so it was never called against
production. Source-verified at the exact commit, proved against route doubles
and a real local WebSocket server.

| item | Shipped |
| --- | --- |
| `503 guest_not_ready` on `POST …/workspace/sessions` | `openTerminal` answers it exactly as the Desktop facet answers `desktop_not_ready`: plue's body renders VERBATIM on the terminal facet — the code beside the sanitized message, because `writeRouteError` reduces the message to "service unavailable" and only the code says which boundary is not ready — with the `Retry-After` seconds it asked for and a Retry button. The auto-retry is the server's instruction: it runs ONLY for `guest_not_ready`, waits exactly the `Retry-After` the refusal named (`terminalSessionRetry.defaultDelayMs`, 3 s, only when the header is unreadable), gives up after `terminalSessionRetry.maxAttempts` (30 — 90 s at plue's own 3 s, its activation window), and is superseded by a later open on the same workspace. A POST that finally succeeds leaves no refusal behind. |
| any other refusal | Rendered verbatim on the same facet with Retry and NO auto-retry — a code the server did not ask to be retried is not retried. A refusal with no HTTP answer at all (the request never reached Smithers Cloud) keeps the old card-level error line: there is no status or code to print, and none is invented. A refusal coded `egress_proxy_unavailable` keeps its card-level marker and its prefixed sentence. |
| the exit-127 close | `CloudTerminalClient` owns it, because the reason reaches the app ONLY as a WebSocket close (plue's session DTO carries no exit field). A normal close (1000) whose reason names `status 127`, arriving within `earlyExitMs` (5 s — plue's own 2 s startup watch plus its 3 s retry delay) of the socket opening, is redialed exactly ONCE; plue removed the dead durable session, so that attach opens a NEW shell on the same session id. The second such close is final. **Deviation, stated plainly:** the brief says "a new session POST", and the retry here is one more attach, not a second `POST /workspace/sessions` — the close never reaches the seam that owns the POST, and wiring one there would mean editing `AppController.ts` / `TerminalView.tsx`, which are outside this lane's files. |
| the close reason itself | **Defect fixed on the way:** a 1000 close DROPPED plue's reason (the note read only "session closed", because the reason was appended for codes ≥ 4400 only). plue#504's whole account of what happened — `session exited: Process exited with status 127` — was therefore invisible. A normal close now reads `session closed: <plue's reason>`, the same grammar an unrecognized code always used; a 1000 with no reason still reads "session closed". |

**Files changed (addendum):** `packages/rpc/src/Cards.ts`
(`terminalRefusal` on the workspace payload — nullable + optional, the same
four facts as `desktopRefusal`), `apps/app/src/mainview/state/seams/WorkspaceSeam.ts`
(`GUEST_NOT_READY`, `terminalSessionRetry`, a module-level `retryAfterSecondsOf`,
`SeamRefusal` — every refused call now carries its status and `Retry-After`
beside its sentence and code — and `openTerminal`'s bounded retry),
`apps/app/src/mainview/state/CloudTerminalClient.ts` (`namesMissingShellExit`,
the `earlyExitMs` option, the single early-exit redial, the reason on a normal
close), `apps/app/src/mainview/cards/WorkspaceCard.tsx` (the terminal facet
renders the refusal; its one button reads Retry while a refusal stands, so no
second control is invented for the same flow).

**Tests added, by name (addendum):**

`state/seams/WorkspaceSeam.test.ts` (89; 4 new): a 503 guest_not_ready reads
plue's own body and code, and retries the session POST on the Retry-After it
named (plue#504) · a guest_not_ready that never clears gives up at the bound,
with plue's words and code on the terminal facet · any other session refusal is
answered once — a code the server did not ask to be retried is not retried · a
second terminal open supersedes a pending guest_not_ready retry.

`cards/WorkspaceCard.test.tsx` (50; 2 new): a 503 guest_not_ready prints plue's
code beside its sanitized message on the terminal facet, and offers Retry
(plue#504) · any other terminal refusal reads the server's own words with Retry
and no wait line.

`state/CloudTerminalClient.test.ts` (22; 3 new): an early exit-127 close redials
once, then reads plue's own reason (plue#504) · an exit-127 close after the
startup window is final: the reason still reads verbatim · a normal close
carrying another reason reads it verbatim and never redials.

**Gates (addendum):**

- `cd apps/app && bun x tsc --noEmit -p .` — **clean**.
- `cd apps/app && bun test src/mainview/state/seams src/mainview/cards` — **629 pass, 0 fail**, 2 314 expects across 33 files (623 before this addendum).
- `cd apps/app && bun test src/mainview/state/CloudTerminalClient.test.ts` — **22 pass, 0 fail** (real sockets).
- `cd apps/app && bun test src/mainview` — **1 480 pass, 0 fail**, 6 147 expects across 139 files.
- `cd packages/rpc && bun test` — **142 pass, 0 fail**, 951 expects across 14 files.

