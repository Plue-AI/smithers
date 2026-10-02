# C-ACC-04 Sign-in is refused off the roster or without write access, with the reason

Proves: mvp.md J1.1, J1.2, J1.8, §6.2 "Team sign-in", §3 "Member", M-05, M-17, M-28 · spec.md §1.4, §5.1.0, §5.1.1, §5.1.2, §5.1.4, §16.2 step 3 · Layer: integration · Stage: S1 · Tickets: T-ACC-01, T-ACC-02
Automation: `packages/backend/internal/compose/signin_gate_integration_test.go` (new) · Runs in: CI

## Setup
- The backend at the commit under test, in install mode, with real PostgreSQL migrated to head and no `members` rows.
- Sealed GitHub App credentials (T-GH-01 fixture).
- A fake GitHub covering the OAuth web flow, `GET /user` and `GET /repos/{o}/{r}/collaborators/{login}/permission`.
- Fake GitHub logins and permissions:
  - `own`: admin;
  - `ben`: `maintain`, with `role_name: maintain`;
  - `alice`: write;
  - `carol`: read;
  - `dave`: write, not on the roster.
- Two listeners (§1.4): loopback `http://localhost:4000`, and a bind on a second test address with the public origin `http://studio-mini.local:4000`.
- The setup token `T` captured from the backend's start output (§5.1.0).

## Steps
1. Before any owner exists, `dave` signs in on the LAN origin without a token, then `own` signs in on loopback with a wrong token.
2. `own` signs in on the LAN origin carrying `T`.
3. `alice` signs in on loopback carrying `T` again.
4. `own` adds `ben`, `alice` and `carol` through `POST /api/members`.
5. Each of `ben`, `alice` and `dave` signs in on the LAN origin.
6. The fake GitHub raises `carol` to write and `own` adds her, then lowers her to read, and `carol` signs in.
7. The fake GitHub returns 502 for `alice`'s permission, then `alice` signs in.
8. `POST /api/auth/local/login`, `/bootstrap` and `/token` with any body.

## Pass when
- Step 1 is refused twice, and no owner is created.
- Step 2 creates exactly one `members` row with `role = owner`, and the setup token's digest is gone from `install_settings`.
- Step 3 is refused with "not a member", and the owner is unchanged.
- In step 4, `ben` → maintainer and `alice` → member. Adding `carol` is refused with "needs access on GitHub ↗", and no row is stored for her.
- In step 5, `ben` and `alice` get sessions; `dave` is refused with `not a member`.
- Step 6 is refused with the typed reason `needs access on GitHub` and a link to the repository's access page.
- Step 7 is refused with `class: "github"`. No session is created, and `alice`'s row is unchanged (fail closed).
- Step 8 returns 404 for every route.
- Every refusal response has `{code, class, message}` and sets no cookie.

## Fail when
- Any request claims the owner without the setup token, or the token works twice.
- `maintain` seeds as Member because only the legacy `permission` field was read.
- A transient GitHub error admits the person.
- A refusal returns a session cookie anyway.
- Any local-password route still answers.

## Evidence
Written to `.artifacts/checks/C-ACC-04/<UTC timestamp>/`:
- `signins.jsonl`: login, listener, status, body and `Set-Cookie` presence;
- the fake GitHub request log;
- the `members` and `install_settings` rows after each step (token digest redacted);
- `go test -json` output and the commit SHA.
