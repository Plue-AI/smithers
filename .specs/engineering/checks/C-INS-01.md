# C-INS-01 The app works on localhost, on a plain-HTTP LAN origin and behind an HTTPS proxy; no secure-context API is required

Proves: mvp.md §6.1 Reaching the install, M-28 · spec.md §1.4, §7.1, §16.3.1–§16.3.4, §17.5a · Layer: e2e · Stage: S1 · Tickets: T-INS-04
Automation: `apps/app/e2e/real/install-origins.spec.ts` (new) and the listener probe `apps/app/e2e/real/support/listeners.ts` (new) · Runs in: reference host plus a second Mac on the same network

## Setup
- Install at commit X from the T-INS-01 bundle with `smthrs host start --bundle` (T-INS-08; stage R: the tap), owner claimed, setup through Source ready, a scratch repository from `smithers-mvp-canary/<date>`.
- Three origins:
  - L = `http://localhost:4000` on the Mac;
  - P = `http://<mac-lan-name>:4000`, after the owner sets bind `0.0.0.0` and adds P in Settings;
  - S = `https://<proxy-host>`, a Caddy reverse proxy on the second Mac B forwarding to P with a certificate B trusts and Caddy's default `Host` pass-through, added as an origin.
- Browsers: Playwright Chromium and WebKit on the Mac for L, on B for P and S. Clipboard permissions are not granted on P (insecure context).

## Steps
1. Default bind, before step 2's settings: on the Mac, list listeners of the install's process tree (launcher, backend, PostgreSQL, egress relay, model host, `msb`) with `lsof -nP -iTCP -sTCP:LISTEN`. From B, connect to `<mac-lan-ip>` on 4000, 2222 and the PostgreSQL port.
2. Set bind `0.0.0.0` and origins P and S. Repeat the listener list.
3. On each origin: sign in, evaluate `window.isSecureContext`, and run the journey slice: open the composer, ask a question and get file cards, open a TODO card, copy a TODO link and an SSH line with the Copy buttons, paste into a text field, attach a file to a wiki page (the slug path that used `crypto.subtle`), open `/api/live` (`ws://` on P, `wss://` on S).
4. Collect browser console errors and unhandled rejections during step 3.
5. Inspect the session `Set-Cookie` on each origin.
6. Grep the served JavaScript bundle for `randomUUID(`, `crypto.subtle` and `serviceWorker.register`.

## Pass when

- T-INS-04 consumes copyText exported by T-UI-01 (follow-up). On plain HTTP, exercise the production chat Copy command and CommandGesture with the native clipboard absent and with its write refused. Both pass their write as `onCopy` to the shared helper and reach its `execCommand` fallback. Assert one successful copy, awaited writes and `clipboard-unavailable` when both paths refuse. No caller implements a second fallback.
- Step 1: every listener is on `127.0.0.1` or `[::1]`; all connections from B are refused.
- Step 2: HTTP 4000 and SSH 2222 (when T-TRM-03 has landed) listen on loopback and on the configured bind; PostgreSQL stays on loopback.
- Step 3: `isSecureContext` is false on P and true on L and S; every action succeeds on all three origins in both browsers; pasted text equals the copied text; the live channel delivers a delta on each origin.
- Step 4: zero errors and zero unhandled rejections.
- Step 5: `Secure` present on S, absent on L and P; `HttpOnly` and `SameSite=Lax` everywhere.
- Step 6: zero matches in our modules (third-party matches are listed and each one proven unreachable on P by step 3).

## Fail when
- A control works only on L or S, or a copy silently does nothing on P.
- PostgreSQL or the egress relay follows the bind address, or the loopback listener closes after the bind change.
- The app passes on P only because the browser treats the host as secure (for example a `localhost` alias).
- A `Secure` cookie is set on P, so sign-in loops there.

## Evidence
`.artifacts/checks/C-INS-01/<UTC timestamp>/`: `lsof` before and after, connection transcripts from B, Playwright traces and videos per origin and browser, console logs, cookie dumps, the bundle grep, the Caddyfile, commit X and install version.
