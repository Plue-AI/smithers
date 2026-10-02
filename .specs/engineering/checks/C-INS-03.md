# C-INS-03 Bind address and public origins are owner settings, applied without a restart and reflected in CORS, cookies and the SSH line

Proves: mvp.md §6.1 Reaching the install, M-28 · spec.md §1.4, §3 (`install_settings`), §5.1.0, §6.3, §8.10.5, §16.3.1, §16.3.3 · Layer: integration · Stage: S1 · Tickets: T-INS-04
Automation: `packages/backend/internal/routes/install_serving_test.go` (new) · Runs in: CI (macOS and Linux runners)

## Setup
- Real PostgreSQL 18, migrated; the backend started in-process with the loopback listener on a free port; an owner session, a member session, a delegated credential; a fake GitHub App client that records callback URL updates.
- Initial settings: bind loopback, origins empty.

## Steps
1. As the member and as the delegated credential, `PUT /api/install` with a new bind and origin.
2. As the owner, `PUT` invalid values: a relative origin, an origin with a path, `ftp://h`, an unparsable bind.
3. As the owner, `PUT` bind `0.0.0.0` and origins `http://lan-a:4000`, `https://box.example`. Record the backend process id.
4. Without restarting: send a CORS preflight and a WebSocket upgrade to `/api/live` with `Origin` set to each configured origin, to `http://localhost:4000`, and to `http://evil.example`.
5. Sign in through a request whose host matches each origin; read `Set-Cookie`.
6. Read the Branch card model for any branch (or the SSH line field of `GET /api/install`).
7. Connect to port 4000 (and 2222 when the SSH gateway exists) through the runner's non-loopback interface address and through loopback, once before step 3 and once after.
8. `PUT` origins `https://box.example` only; repeat step 4 for `http://lan-a:4000`.
9. Restart the backend; `GET /api/install`.
10. On a second, empty database with bind `0.0.0.0` seeded the way `smthrs host start --bind` seeds it and no owner: `GET /api/install` through the interface address without the setup token, then with it.

## Pass when
- Step 1: 403 for both; settings unchanged.
- Step 2: each returns a typed `user` error naming the field; settings unchanged.
- Step 3: 200; one `install_settings` change and one `projection_events` row on `install` per write; the process id never changes during steps 3 to 8.
- Step 4: the two configured origins and `localhost` are accepted; `evil.example` gets 403 on both paths.
- Step 5: `Secure` on the https origin; no `Secure` on the http origins.
- Step 6: the SSH line is `ssh -p 2222 <branch>@lan-a` (the first origin's host); with origins empty it uses `localhost`.
- Step 7: the interface address answers; loopback still answers. Before step 3 the interface address was refused.
- Step 8: `http://lan-a:4000` is refused on the next request.
- The fake App client received callback URLs equal to the configured origins plus `http://localhost:4000` after steps 3 and 8.
- Step 9: settings survive the restart.
- Step 10: 403 without the token; 200 with it, on the interface address as on loopback (§5.1.0).

## Fail when
- A change needs a restart to reach CORS, cookies or the SSH line.
- The cookie scheme follows a client header (`X-Forwarded-Proto`) instead of the configured origin.
- The loopback listener closes when another bind is set, locking the owner out on the Mac.
- A removed origin keeps working for an open WebSocket beyond its next reconnect.

## Evidence
`.artifacts/checks/C-INS-03/<UTC timestamp>/`: test output, request and response transcripts per step, the `install_settings` and `projection_events` rows, callback URL calls, commit.
