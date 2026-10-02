# C-ACC-01 Every permission-matrix cell is enforced server-side for every credential kind

Proves: mvp.md §6.15 "Roles", M-05, §2 rule 6, Appendix B.5 · spec.md §5.2, §5.2.1, §5.3, §5.4, §6.2.3, §15.1.4, §17.2 · Layer: integration · Stage: S1 · Tickets: T-ACC-03, T-ACC-04
Automation: `packages/backend/internal/compose/access_matrix_integration_test.go` (new) · Runs in: CI

## Setup
- The backend at the commit under test, composed in install mode. Real PostgreSQL through `packages/backend/testkit/postgresfixture`, migrated to head.
- A fake GitHub (`httptest`) that answers `push` for every member login, and records merge calls.
- Members: O (owner), M (maintainer), E (member).
- Credentials, each minted through the real path, never inserted by hand:
  - a session cookie for each of O, M and E;
  - a delegated token (`via=cli`) for each of O, M and E;
  - one run token for the `todo` run of T1 (branch b1);
  - one machine token for branch b1.
- Fixture data: T1 (first in order, `in_review`, PR head `h1`, branch b1) and T2 (`needs_you{kind: conflict}`, the run token's own wait), plus secret `S`.

## Steps
1. Load the expected table from the test file. It is a literal transcription of spec §5.2: 7 rows (merge and approve tested separately) × 8 credential columns (session-O, session-M, session-E, delegated-O, delegated-M, delegated-E, run, machine). It is not derived from `access/` code.
2. Map each row to one representative served route:

   | Row | Route |
   | --- | --- |
   | install settings | `PUT /api/install` setting, `PUT /api/agents/implementer/model` |
   | merge | `POST /api/todos/1/merge {reviewed_head_sha: h1}` |
   | approve | approval of T1 at `h1` |
   | members, roles, secrets write | `POST /api/members`, `PUT` secret `S` |
   | flow merge | merge of a TODO touching `flows/` |
   | TODO ops | `POST /api/todos`, and answer on T2 |
   | join or run | `POST /api/terminals {branch: b1}`, `POST /api/flows` run |
   | read secret values | every secrets route |

3. For each cell, send the request once with a fresh `Idempotency-Key` and record status, `class` and `fix`.
4. For the run column, also send the scoped cases:
   - answer on T2 (its own conflict) vs answer on a `question` wait;
   - a join on b1 vs on another branch b2.
5. Compose the install router and list every served `/api` route with its declared action.

## Pass when
- Every cell matches the expected table: an allowed cell returns 2xx, and a refused cell returns 403 with `class: "permission"`.
  - A delegated token on a person-only row its member's role allows (install settings for O; merge, approve, members and secrets write for O and M) returns 403 with `fix.kind = "confirmation"`; delegated-E gets 403 with no `fix`.
- `run` succeeds only on the two scoped cases, its own conflict and its own branch.
- `machine` is refused on every row (§5.2: it has no row).
- No refused cell causes a side effect. The fake GitHub has zero merge calls from refused cells, and no row changed in `members`, `secrets` or `todos`.
- No secrets route returns a value field.
- Every served `/api` route has exactly one declared action, so the unmapped list is empty.
- Routes whose ticket has not landed are reported as "pending route" with that ticket ID. They are not counted as passes. Final acceptance requires zero pending rows.

## Fail when
- A delegated token of an owner or maintainer merges, approves or writes members or secrets.
- A Member session merges or writes secrets.
- A cell is allowed because the UI hides the button, and the server never checks.
- A new route ships without an action.
- The run token acts on another TODO's branch.
- A refusal comes back as 404 or 500 instead of a typed 403.

## Evidence
Written to `.artifacts/checks/C-ACC-01/<UTC timestamp>/`:
- `matrix.json`: expected cell, actual status, class, fix and request id for each cell;
- `unmapped-routes.txt` and the fake GitHub call log;
- `go test -json` output, the commit SHA and `smithers-backend --version`.
