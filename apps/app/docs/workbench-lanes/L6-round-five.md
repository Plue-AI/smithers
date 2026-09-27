# Lane L6 — light up plue's round-five routes (live 2026-09-02 06:20 UTC, api 852b97574cc5)

plue closed the gaps the L1/L3/L5 REPORTs named. Every "refuses honestly" and
"renders the id" stub below becomes the real thing. Read the three REPORTs
first (`L1-change-facets.REPORT.md`, `L3-workspace-card.REPORT.md`,
`L5-sync-live.REPORT.md`) for where each stub lives. Laws as always
(apps/app/AGENTS.md, apps/DESIGN.md): NO INVENTION, no useEffect, collections
via the dispatcher, every act a flow with data-flow, consequential acts confirm,
server errors verbatim. Production routes may be verified READ-ONLY through
the shapes below; nothing is created, landed, split, or dispatched against
production from this lane.

| # | Now on the wire | App change |
| --- | --- | --- |
| #484 | `actor_login` on landing `turn`; `user_login` on comments; `type` on ChangeReviewResponse | render logins instead of ids on the turn line, threads, and review rows |
| #485 | `landing_request_number` beside `landing_request_id` on stack/change/revert/provenance rows | stack rows and Land use the number; drop the id-as-number workaround |
| #486 | landing comments carry `state` (thread lifecycle: open/done/resolved) and `anchor_state` explicitly | parse `state` directly; keep the `done_at`/`resolved_at` derivation only as a fallback when `state` is absent |
| #487 | `POST …/findings/{id}/feedback`, `POST …/findings/{id}/dispatch` | `findings.not-useful` posts feedback (row dims, reads `not useful`); `findings.please-fix` (confirm) posts dispatch and renders the returned run/session reference as the existing card kind |
| #488 | `POST/DELETE …/landings/{n}/review-requests`; `review_requests[]` on the landing DTO | `review.request <changeId> <login>` (user + button; agent via confirm) and `review.unrequest` (confirm); the Request review picker lists `review_requests[]` and the Suggested reviewers slot |
| #489 | `POST …/changes/{id}/split` | `change.split <changeId>` (confirm) on a stack whose `landable_prefix` < size; render the returned changes |
| #490 | `POST /repos/{o}/{r}/github/reconcile` for writers | `github.reconcile [repo]` uses it for everyone; the admin route stays only for `/admin.*` |
| #482/#483 | `failure_code` / `failure_message` on workspace rows + SSE; `port` / `url` on services rows | already parsed by L3: confirm the card renders them from a live fixture |

Also live: agent-kind workspaces boot (jj config dir fix), so the RFD-004
rows from L3b can be verified live.

## Method

Per row: seam parser test with a fixture shaped from the live response
(mark `verified` with the route and status you observed, or `unverified`),
card test for present/absent, then the minimal implementation. Fixtures
observed read-only through the app's local origin need the page's
`x-smithers-local-session` header and the app's cloud PAT session; if the
orchestrator has not signed the app into Smithers Cloud, say so and keep the
fixtures `unverified`.

## Files

## Verification

`cd apps/app && bun x tsc --noEmit -p . && bun test src/mainview/cards src/mainview/state/seams src/mainview/flows`, then the full `bun test src/mainview` once. Write `L6-round-five.REPORT.md` with the verified/unverified column per row and any remaining mismatch for plue.

## Addendum (plue api be298a4fc7bb): desktop facet

- `POST …/workspaces` reuses an existing workspace only when `kind` matches:
  a vm and a desktop on one bookmark are two rows. The card lists both; no
  DTO change.
- plue #496 (rolling next): the desktop session POST answers 500 until NixOS
  activation finishes, about 30 s after `running`. Until it rolls, the
  Desktop facet renders the 500 body verbatim with a `Retry` button
  (`box.desktop` again, no confirm on retry); never a spinner that
  hides the server's answer, never an invented "still starting" line.
- plue #497/#498 are backend (empty clone for fresh repos; no egress env in
  workspace terminals): nothing to build, but a Files facet that shows only
  `.git` renders exactly that.

