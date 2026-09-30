# Lane `change` — the change card, diff, and revision pins

Brief: `../decisions/0003-change-unit.md` §1, §3, §5. Laws as every lane.
Depends on: lane `piper` (cloud proxy, repositories collection, header pin).
Changeset routes are LIVE in prod (ADR 0003 last section); the T1 spec
may render org `canary-changesets-e2e` read-only through the proxy.

Scope, in order:
1. Shared schemas (`packages/rpc/src/Cards.ts`, `packages/rpc/src/Changes.ts`):
   `change` card payload (id, currentSeq, revisions[], description, repos[]
   with stat, checks summary, findings summary, review summary, conflicts[],
   stack position, landing state), `diff` card payload (from, to, files,
   hunks by reference past 400 lines), the revision pin `{ changeId, seq,
   commitId }` on `file` and `search-results`.
2. `ChangeSeam` over `/api/cloud/…/changes/{id}`, `…/diff`, landing
   requests; a `changes` collection; the `change` card with the Diff,
   Findings, Checks, Review, History facets exactly as §1, stale tokens as
   "How stale reads"; the `diff` card with the two revision pickers.
3. Flows `change.view|diff|land|split|resolve|revert` with confirm per
   the table; slash payloads; registry/parity tests.
4. Origin chip pin `qupxosqw#5`; `rev N exists · view` line on pinned cards.

Facet selection uses the repository and change ID together. When two repositories
contain the same change ID, selecting a facet updates only the named card.

Exit: seam tests with doubles for every route (including a 403 degraded
session); card tests per facet and per stale/moved state; T1 spec viewing a
fixture landing request end to end. Never fake a route the backend lacks:
render the facet empty with the ADR's wording.
