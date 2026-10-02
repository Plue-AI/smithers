# C-ACC-01 Every permission-matrix cell is enforced server-side for every credential kind

Proves: mvp.md §6.15 "Roles", M-05, §2 rule 6, Appendix B.5 · spec.md §5.2, §5.2.1, §5.3, §5.4, §6.2.3, §15.1.4, §17.2 · Layer: integration · Stage: S1 · Tickets: T-ACC-03, T-ACC-04, T-STK-15
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
- Fixture data: T1 (`needs_you{kind: conflict}`, branch b1, the run token’s own conflict), T2 (`in_review`, PR head `h2`, branch b2, first merge candidate), an unrelated question wait and secret `S`. Merge requests use T2 at `h2`; run conflict answers use T1.

## Steps
1. Load the literal `catalog.mvp.json` artifact, whose equality with product Appendices B and C is proved by C-CAT-01. Read actor eligibility, minimum role and agent policy for every retained command and in-card action. Never parse spec Markdown at runtime.
2. Exercise every catalog command through its served route and dispatch doors for session-O/M/E, delegated-O/M/E, run and machine. Give each command a valid subject and payload; do not collapse commands into one representative per §5.2 row. Record unimplemented commands as pending with their owner ticket.
3. For each cell, send the request once with a fresh `Idempotency-Key` and record status, `class` and `fix`.
4. For the run column, also send the scoped cases:
   - answer T1’s own conflict versus T2 or an unrelated question wait;
   - a join on b1 vs on another branch b2.
5. Compose the install router and list every served `/api` route with its declared action.

## Pass when
- `main.reset-to-github` succeeds only from the Owner's session; maintainer, member and every delegated credential are refused and post no confirmation. GitHub App changes require the Owner's session.
- Every cell follows §5.2.1: insufficient role or credential scope returns 403 `permission`; an eligible delegated `never` returns 403 `never`; eligible `run` executes; eligible `confirm` returns `202 {confirmation: id, state: "requested"}` without executing the command.
  - Explicit cases: `todo.amend` posts a one-click confirmation; `todo.steer`, move, stop, retry, terminal open, sleep and wake execute with no row. Member-delegated Discard returns 403 `permission` and posts nothing; maintainer-delegated Discard posts a confirmation approved only by that maintainer’s session. Settings, approvals, members and secrets never create confirmations.
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
- A refusal has the wrong status or class, or a confirmable request returns 403 with a confirmation fix instead of 202 with an id.

## Evidence
Written to `.artifacts/checks/C-ACC-01/<UTC timestamp>/`:
- `matrix.json`: expected cell, actual status, class, fix and request id for each cell;
- `unmapped-routes.txt` and the fake GitHub call log;
- `go test -json` output, the commit SHA and `smithers-backend --version`.
