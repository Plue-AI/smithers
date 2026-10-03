# C-INS-03 Bind address and public origins are owner settings, applied without a restart; one effective origin per request sets cookies, Origin checks, the OAuth callback and the SSH line

Proves: mvp.md §6.1 Reaching the install, M-28 · spec.md §1.4, §3 (`install_settings`), §5.1.0, §6.3, §8.10.5, §16.3.1, §16.3.3, §17.6a · Layer: integration · Stage: S1 · Tickets: T-INS-04
Automation: `packages/backend/internal/routes/install_serving_test.go` (new) · Runs in: CI (macOS and Linux runners)

## Setup
- Real PostgreSQL 18, migrated; the backend started in-process with the loopback listener on a free port; an owner session, a member session, a delegated credential; a fake GitHub with OAuth and an App whose callback URLs were recorded at creation as the loopback origin only.
- Initial settings: bind loopback, origins empty.

## Steps
1. As the member and as the delegated credential, `PUT /api/install` with a new bind and origin.
2. As the owner, `PUT` invalid values: a relative origin, an origin with a path, `ftp://h`, an unparsable bind, and the pair `http://box` and `https://box`.
3. As the owner, `PUT` bind `0.0.0.0` and origins `http://lan-a:4000`, `https://box.example`. Record the backend process id.
4. Without restarting, for each known origin O (`http://lan-a:4000`, `https://box.example` and the loopback origin): send a cookie-authenticated `POST` and a WebSocket upgrade to `/api/live` with `Host` and `Origin` from O. Then send: `Host` from `http://lan-a:4000` with `Origin: https://box.example`; `Origin: http://evil.example`; `Host: evil.example`; the loopback `Host` from the non-loopback interface; `X-Forwarded-Host: box.example` from a loopback client; and `Host: lan-a:4000` with `X-Forwarded-Host: box.example` and `X-Forwarded-Proto: https` from a non-loopback client.
5. At each known origin: start GitHub sign-in and read `redirect_uri`, finish the callback, refresh the session, open and reconnect `/api/live`, and sign out, reading every `Set-Cookie`. Then start sign-in at `http://127.0.0.1:<port>`, and finish a callback whose state cookie was set on another origin.
6. Read the Branch card model for any branch (or the SSH line field of `GET /api/install`).
7. Connect to port 4000 (and 2222 when the SSH gateway exists) through the runner's non-loopback interface address and through loopback, once before step 3 and once after.
8. `PUT` origins `https://box.example` only; repeat step 4 for `http://lan-a:4000`.
9. Restart the backend; `GET /api/install`.
10. On a second, empty database with bind `0.0.0.0` and origin `http://lan-a:4000` seeded the way `smthrs host start --bind --origin` seeds them, and no owner: `GET /api/install` at `http://lan-a:4000` without a setup session, then after exchanging the token there.

## Pass when

- Pin Address {listen: mac|network, bind, origins: string[]} and scheme derived from origin strings. Assert Origin and CSRF refusals are 403 permission/origin and permission/csrf with no mutation.
- Step 1: 403 for both; settings unchanged.
- Step 2: each returns a typed `user` error naming the field; settings unchanged.
- Step 3: 200; one `install_settings` change and one `projection_events` row on `install` per write; the process id never changes during steps 3 to 8.
- Step 4: each matched request is accepted. The mismatched `Origin` and `evil.example` get 403; `Host: evil.example` and the loopback `Host` from the interface get 421 `unknown_origin`; the loopback client's `X-Forwarded-Host` resolves to `https://box.example`; the non-loopback client's forwarding headers are ignored, so its effective origin stays `http://lan-a:4000`.
- Step 5: `redirect_uri` is `<O>/api/auth/github/callback` at each origin, and the `127.0.0.1` start first redirects to the `localhost` origin. Every cookie is host-only and `SameSite=Lax`, with `Secure` on `https://box.example` only. Sign-in, refresh, reconnect and sign-out succeed at each origin; the cross-origin callback is refused.
- Step 6: the SSH line is `ssh -p 2222 <branch>@lan-a` (the first origin's host); with origins empty it uses `localhost`.
- Step 7: the interface address answers; loopback still answers. Before step 3 the interface address was refused.
- Step 8: `http://lan-a:4000` is refused on the next request.
- After step 3, `GET /api/install` carries the one-line fix for each configured origin missing from the App's recorded callback URLs, and for no other origin.
- Step 9: settings survive the restart.
- Step 10: 403 without a setup session; 200 with it, on the LAN origin as on loopback (§5.1.0).

## Fail when
- A change needs a restart to reach CORS, cookies or the SSH line.
- The cookie scheme follows a client header (`X-Forwarded-Proto`) instead of the configured origin, or a non-loopback peer sets the host through `X-Forwarded-Host`.
- The loopback listener closes when another bind is set, locking the owner out on the Mac.
- A removed origin keeps working for an open WebSocket beyond its next reconnect.

## Evidence
`.artifacts/checks/C-INS-03/<UTC timestamp>/`: test output, request and response transcripts per step, the `install_settings` and `projection_events` rows, callback URL calls, commit.
