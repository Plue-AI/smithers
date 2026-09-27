# Lane `change` — REPORT

Brief: `change.md`. ADR: `../decisions/0003-change-unit.md`. Status: all four
steps shipped and green; the lane's gates pass, and the only failures in the
tree are the three pre-existing TargetGraph integration tests (the
`~/artsy/force` fixture). Two concurrent-lane breaks found mid-lane were
completed mechanically, below.

## What shipped, per step

1. **Shared schemas** (`packages/rpc/src/Changes.ts`, `Cards.ts`): the
   `change` card payload — repo, changeId, description, commitId, currentSeq
   / revisionCount (null until plue#450), revisions[], authorName, timestamp,
   repos[] with stat, the parent → current diff, checks, findings, reviews,
   threads, conflicts[], the stack position row, the changeset (ADR 0003's
   live DTO: id, organization, changeId, state pending|landing|landed|failed,
   failureReason, targetBookmark, members[]), facet, error — and the `diff`
   card payload (repo, changeId, from, to, the revision pin
   `{ changeId, seq, commitId }`, files with `patch` inline or `patchLines`
   by reference past 400 lines, `conflicted`). The `file` card's `readAt`
   gains an optional `seq`. `ChangesetState` carries the changeset's own
   `changeId` so a change matches its changeset by id or by member.
   Deviation: the `search-results` card kind does not exist (piper
   established `file` only), so the pin went on `file` alone.
2. **Model + seam.** `changes` collection (`app-changes`, registered in
   `SchemaVersion.ts`), keyed `${repoId}#${changeId}`; `change.loaded`
   upserts from the wire DTO (one commit, no revisions — currentSeq /
   revisionCount stay null, never invented). `state/seams/ChangeSeam.ts`
   covers every live plue route — the change, its diff, its conflicts, the
   landings list (stack position from `change_ids`), landing reviews and
   comments, commit statuses (newest per context by `created_at`, never
   last-write-wins), the org changesets — and refuses honestly where no
   route exists: rev-pinned views (plue#450), interdiffs (#451), split-ready
   (#452), agent resolve (#455), revert (#456). `change.land` lands the
   carrying landing request (queued, never "merged") or the changeset
   through its own atomic route (a 409 re-reads so `failure_reason`
   renders). Revert is gated on landed: the landing's `merged` or the
   changeset's `landed` (plue's landing states verified in
   `internal/services/landing.go`: open, closed, merged, draft, queued,
   landing, failed). A bare act resolves the repo from the changes
   collection, else the app's target repo — never a guess. Signed-out
   refuses with the sign-in step; a degraded session reads freely, and
   dispatching the resolve agent refuses with the exact "sign in again to
   enable" wording. 22 seam tests against route doubles.
3. **The `change` and `diff` cards** (`cards/ChangeCards.tsx`, registered in
   `ChatCards.tsx`, pill "done" as a settled read). The change card's header
   names `repo · changeId · shortCommit · author`, never `rev N of M`. Five
   facets: Diff (file rows, each opening `/change.diff <id> parent current
   <path>`), Findings (the plue#454 wording), Checks (one row per context),
   Review (verdicts and threads; no stale/moved tokens until plue#453 — the
   wording says so), History (the plue#450 wording; a revisions list when
   the backend carries them). A conflicted change names its files and offers
   Resolve; a landed one offers Revert; a changeset's failure renders
   verbatim with Retry land; a changeset's change offers Split ready. The
   diff card renders `from → to` pinned at the change's commit, conflicted
   files leading, binary files named, oversized hunks by reference with the
   re-read command. 17 card tests.
4. **Flows + origin chip.** `change.view|diff|land|split-ready|resolve|
   revert` (confirm per the ADR's table: "land the change", "split the ready
   members into a new change", "dispatch an agent to resolve the conflict",
   "revert the landed change") plus hidden `change.facet`; slash payloads
   with honest refusals; the `change` namespace in `registry.ts`;
   registry/parity pins updated. The composer's origin chip carries the
   probed checkout's pin `~/smithers · qupxosqw · a03f5f` (`changeId#seq`
   only when the changes collection knows a sequence — never from a commit
   comparison alone), beside piper's `N ahead of main`; `rev N exists ·
   view` renders only when BOTH seqs are known and runs `/change.view`.
   2 new chip tests.

## Exit gate

- Seam tests: 22, doubles for every route, including the degraded session
  (view reads, resolve refuses with the enable wording) and the absent-
  answer-is-absent-field rule.
- Card tests: 17, per facet and per degraded state (history, findings,
  stale/moved, conflicted, landed, failed changeset, oversized hunk).
- T1 (`e2e/playwright/change.spec.ts`, 4 tests): a fixture landing request's
  change end to end (DTO, stat, stack position, checks, the plue#450 History
  wording, never `rev 1 of`), the pinned diff card, the rev-pinned refusal,
  the degraded read-free/refuse-dispatch split. Org changeset reads route
  through the double; the canary org was not needed.
- Gates: `tsc --noEmit` clean; `bun test src` 1428 pass / 3 fail — exactly
  the pre-existing TargetGraph integration failures; packages/rpc 130 pass;
  apps/server 402 pass; playwright 4 pass.

## Concurrent-lane completions (not this lane's scope, kept green)

A concurrent lane edited `WorkspaceSeam.ts` mid-flight (typed-name delete
gate, paginated list routes, card-from-collection rendering) leaving call
sites and tests stale. Completed mechanically, no behavior invented:
`box.delete` flow/slash parser/card button pass the typed name; the
list route doubles gained `?limit=100`; the open test's status expectation
follows the card's freshest row (the watch's first poll).

## Never faked

Revisions and `rev N of M` (#450), interdiffs (#451), landable prefix /
blocked_by (#452), verdict commit ids and thread anchor state (#453),
findings per revision (#454), agent resolve (#455), revert (#456),
per-change operations (#457). Each renders the ADR's wording or refuses
with it; the routes that exist are the only ones called.

## Review fixes (2026-09-02)

Source: the read-only Kimi review (14 findings). Backend facts re-verified
in plue for the fixes below: `LandLandingRequest` lands a request only from
`open` or `failed` (landing.go:1052); `normalizeChangeIDs` keeps the
request's own order and sorts nothing (landing.go:3325); a changeset's
`superproject` and each member's `repository` are spelled `org/name`
(changeset.go:763, 786) — the app's repo id. The new routes (#450–#457)
are still not wired; every degraded wording stands.

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| 1 (HIGH) | `change.land` on a mid-stack change PUT the whole landing request without saying so. | `ChangeSeam.landChange`: when the change is not the request's top (position < size, positions known), refuse with the blast radius and the way out (`lands its whole stack together (1 → N: ids) — X is n of N by request order … /change.land <top> lands all N`), zero PUTs. On the top change the outcome line names the scope (`it lands 1 → N together (ids)` / `X alone`). The card's Land reads `Land 1 → N` (aria `Land the change: lands 1 → N together`), and a mid-stack card's Land is disabled with the reason naming the top change and plue#452. The static `confirm` (registry contract: a string) now names the unit: "land the change — the whole landing request 1 → N, or the whole changeset". `stack.changeIds` rides the payload so the card can name the top. | seam: "change.land on a mid-stack change refuses, names the whole-request scope and the top, and PUTs nothing"; "change.land queues the carrying landing request and re-reads" (asserts the scope line). card: "a landing request's Land names its scope, and only its top change may land". |
| 2 (HIGH) | `null` checks/reviews/threads rendered as "No checks recorded" / "No review is recorded". | Card: `null` renders `checks not read (reason)`, `reviews not read (reason)`, `threads not read (reason)`, `diff of X not read (reason)`, `conflicts not read (reason)`; the "No … recorded" sentences render only for a read, empty list. The reason is the payload's new `unread` record (Cards.ts), filled by the seam from the platform's error. | card: "an unread checks list says so with its reason — never 'No checks recorded'"; "unread reviews and threads say so with their reasons — never 'No review is recorded'"; "unread conflicts render as unread, never as a clean change". seam: "change.view leaves an absent answer as an absent field, with its reason, when an auxiliary 404s". shared: "an unread auxiliary is null and `unread` names why". |
| 3 (MEDIUM) | Changeset member rows were not rendered. | Card renders one row per member, `repository · path`, under the changeset line and before the footer. | card: "a changeset lists its members as repository · path before the Land confirm". |
| 4 (MEDIUM) | Changeset matching was repo-unscoped. | `changesetFor(changesets, repoId, changeId)`: a match is `superproject === repoId && change_id` or `member.repository === repoId && member.change_id`. `ChangesetStateSchema` gains `superproject`; the parser reads it. | seam: "a changeset attaches only when its superproject or a member is THIS repository's change" (the foreign changeset is not attached and Land goes to the landing request, never `POST …/changesets/7/land`); "a changeset attaches through a member row in this repository". |
| 5 (MEDIUM) | Land enabled in every changeset state; no blocking reason ever rendered. | `landAct` in the card: changeset `landing` → disabled "landing…", `landed` → disabled "landed", `failed` → "Retry land" enabled under the verbatim `failure_reason`. Landing request: `queued`/`landing` → disabled "queued…"/"landing…", `merged` → "landed", `closed`/`draft` → disabled "… plue lands a request only while it is open or failed", `failed` → "Retry land 1 → N". The seam refuses a non-open/failed request before any PUT. `conflict_status: conflicted` renders on the stack line (plue does not gate the land call on it, so neither does the card). | card: "Land is disabled with the reason while a changeset is landing or landed"; "Land is disabled with the state while a landing request is queued, landing, merged, or closed; failed re-lands". seam: "change.land on a queued landing request refuses without a PUT". |
| 6 | The assertion `startsWith("PUT /repos/")` could never fail. | Asserts `startsWith("PUT api/repos/")` (the harness's key format) and `startsWith("PUT ")`, with a comment naming the format. | seam: "change.land lands the changeset through its own route when one carries the change". |
| 7 | Resolve bound only the first conflict, from the footer. | The conflict line is a list, one row per conflicted file (`Conflicted: path · state`) with its own Resolve dispatching `change.resolve <changeId> <path>`; the footer Resolve is gone. | card: "every conflicted file carries its own Resolve". |
| 8 | "Split ready" rendered for a landed changeset. | Renders only while `changeset.state !== "landed"`. | card: "a changeset's change offers Split ready; a plain one doesn't" (landed case added). |
| 9 | Failed/closed landing requests wore the pending pill. | `landingPill`: `merged` → done, `failed` → failed, `closed` → the cancelled (neutral) tint with the label "Closed" (the shared table tints "closed" green), else pending. | card: "the landing pill: merged is done, failed is failed, closed is neutral with plue's own word". |
| 12 | Conflicts/diff/stack survived a failed re-read while checks/reviews/threads were nulled. | One rule, stated in `surfaceChange`: every auxiliary is written from this read's own answer — the value, or null plus its reason in `unread` — and nothing prior survives; only a no-read act (`change.facet`) or a one-panel picker (`change.pins` / `change.checks`, which read their own route and nothing else) keeps the prior payload. `conflicts` became nullable. Reviews/threads are `[]` (a fact) when the landing list was read and no request carries the change, unread when the list was. | seam: "a failed re-read nulls every auxiliary with its reason — nothing from the earlier read survives"; "reviews and threads are [] — a fact — once the landing list was read and no request carries the change". |
| 13 | Stack position inferred from `change_ids` order with no label. | Kept; `loadLanding` documents the inference (request order, plue keeps it unsorted) and the card reads `position n of m by request order` until #450's `stack.position` is read. The e2e assertion follows. | card: "the stack line labels the position as inferred by request order"; e2e T1 asserts the new line. |

Skipped as instructed: 10 (the Full diff footer button), 11 (the degraded
resolve wording, pinned by e2e), 14 (the repo-resolution test title).

Also: `change.land`, `split-ready`, and `revert` refuse when the org's
changesets could not be read ("The changesets X might belong to weren't
read (reason) — nothing was landed"), since an unread list cannot clear a
change of an atomic changeset (seam: "change.land refuses when the org's
changesets weren't read").

Red before, green after: with HEAD's `ChangeSeam.ts` and `ChangeCards.tsx`
swapped in, the two suites fail 27 of 56 (every new test among them); with
the fixes, 56 of 56 pass. Gates from `apps/app`: `tsc --noEmit` clean;
`bun test src` 1515 pass / 4 fail — the three pre-existing TargetGraph
integration failures plus the sync lane's in-flight `LiteralPin` failure on
`e2e/playwright/sync.spec.ts` card-id prefixes; `packages/rpc` `bun test`
131 pass.
