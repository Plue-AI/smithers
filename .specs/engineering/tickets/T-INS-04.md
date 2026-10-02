# T-INS-04 Origin-agnostic serving: configurable bind and public origins; no secure-context dependency

Stage S1 · Size M · Depends on T-INS-02 · Unblocks T-INS-06, T-TRM-03 · Issue: to file
Spec: spec.md §0 (Tailscale is not part of the product), §1.4, §3 (`install_settings`), §5.1.0, §5.3, §6.3 (`/api/install`), §7.1, §8.10.5, §12.1.2, §16.3.1–§16.3.4, §17.5a · Delta: delta.md §1 (Modify [S1] origin-agnostic serving) · Product: mvp.md §6.1 Reaching the install, J1.8, M-28, M-03

## Goal
The install serves on loopback by default and on any bind address and public origins the owner sets (http or https, any host), changes apply without a restart, and every app feature works in an insecure context.

## Scope
In:
- Owner settings in `install_settings` (spec §3): bind address (default none: loopback only) and one or more public origins (http or https, any host), set through `PUT /api/install` (owner, §6.3), or at install time with `smthrs host start --bind <addr> --origin <url>` (§1.4; T-INS-05 owns the flags). Applied without a restart: the host opens the new listener, then closes the old one (§16.3.1).
- HTTP (4000) and SSH (2222) listen on loopback always, plus the bind address when one is set (§1.4), so `http://localhost:4000` always works on the Mac. PostgreSQL stays on loopback. T-TRM-03 constructs the SSH server; this ticket owns the setting and the rebind.
- The setup URL is printed for each listener, and the setup token works on any of them, so setup can finish from a LAN laptop (§5.1.0; T-ACC-01 owns the claim).
- CORS and WebSocket origin checks accept exactly the configured origins plus `localhost` (§16.3.3). The live channel is `ws://` or `wss://` matching the page's origin (§7.1).
- Cookies are `Secure` when the request's origin is https and not otherwise (§16.3.3). The scheme comes from the configured origin that matches the request host, never from a client-supplied header.
- GitHub App callback URLs are the configured origins plus `http://localhost:4000`. Adding an origin later updates the App's callback URLs through the API when the App permits it, otherwise it returns the one-line fix (§16.3.3; T-GH-01 owns the App client).
- The Branch card SSH line uses the host name of the first public origin, or `localhost` when none is set (§8.10.5); absolute links use the first public origin.
- No secure-context API in the browser app (§16.3.2):
  - one UUID helper on `crypto.getRandomValues` replaces `crypto.randomUUID()` in the 34 files that call it (29 outside tests, 62 calls under `apps/app/src`), with a lint ban;
  - the single `crypto.subtle` use, `apps/app/src/mainview/wiki/CloudWiki.ts:127`, moves to the synchronous SHA-256 of `@smthrs/crypto` (`packages/smithers/flows/crypto/src/Sha256.ts`);
  - the clipboard falls back to a hidden textarea and `document.execCommand("copy")`;
  - no service worker or push.
- `GET /api/install` reports each origin with its scheme, so Settings can mark an http origin "unencrypted" (§17.5a; T-APP-03 renders it).

Out:
- Any Tailscale check, `tailscale serve` call or TLS code (§0, §16.3.4). Tailscale serve and Caddy appear only in the quickstart (T-DOC-01).
- A LAN certificate authority, `smthrs connect` or mDNS: never built (no CA exists anywhere, §17.4).
- Webhooks through a public URL (§12.2.4, optional). The SSH gateway itself (T-TRM-03). Setup steps (T-INS-06). The Settings card (T-APP-03).

## Changes
- `packages/backend/internal/services/serving.go` (new): settings validation (absolute origin, no path, http or https), read and write of the `bind` and `origins` keys in `install_settings` (table from the first migration that needs it, after `packages/backend/db/product/migrations/0103_retire_chat_provider_dispatch.sql`), the added listener for 4000 and 2222 at start and on change, and a `projection_events` row on the `install` topic per change (§3.1, §7.2).
- `packages/backend/internal/routes/install.go` (new; T-INS-06 extends it): `GET /api/install` `address {bind, origins[{origin, scheme}]}` (the §14.3 Setup/Settings field) and `PUT /api/install` for settings (owner).
- `packages/backend/internal/config/config.go:244-251` → `AllowedOrigins` read from the serving settings at request time for the native install; delete the comment about LAN and native-webview origins.
- Session cookie writer (behavior asserted in `packages/backend/internal/routes/auth_helpers_test.go:67-125`) → `Secure` per request scheme; the launcher no longer forces `SMITHERS_AUTH_COOKIE_SECURE`.
- WebSocket upgrade origin check on the same set, for `ws://` and `wss://` (T-COL-02 consumes it).
- `apps/app/src/mainview/randomId.ts` (new): RFC 4122 version 4 from `getRandomValues`; every `crypto.randomUUID()` under `apps/app/src` moves to it.
- `apps/app/src/mainview/wiki/CloudWiki.ts:127` → `@smthrs/crypto`; the slug output is unchanged.
- `packages/smithers/ui/src/internal/copyToClipboard.ts` → the `execCommand` fallback; `apps/app/src/mainview/flows/entries/chat.ts:128-138` and `apps/app/src/mainview/flows/CommandGesture.ts:48-56` call it.
- Lint ban: `apps/app/lint/conformance/SecureContext.test.ts` (new) fails on `crypto.randomUUID`, `crypto.subtle`, `navigator.serviceWorker` or a direct `navigator.clipboard` in `apps/app/src/mainview/**` and `packages/smithers/ui/src/**` outside the two helpers. `eslint.config.js:7` opts both trees out of ESLint, so the conformance suite is their lint.
- `docs/api/openapi/install.yaml` (new), referenced from `docs/api/openapi/_root.yaml`; `packages/backend/internal/compose/openapi_conformance_test.go:220` passes; regenerate `packages/backend/apiclient/client.gen.go`.

## Tests
- unit `apps/app/src/mainview/randomId.test.ts`: version and variant bits; 10^5 ids without collision; works with `crypto.randomUUID` removed from the global.
- unit: `wikiAttachmentSlug` returns the same slugs as the old `crypto.subtle` path for fixed inputs (golden values).
- unit `copyToClipboard`: no `navigator.clipboard` → `execCommand` path; both refused → `clipboard-unavailable`.
- unit `apps/app/lint/conformance/SecureContext.test.ts`: the ban, plus a fixture with one planted violation of each kind.
- integration (Go, real PostgreSQL): origin validation; CORS preflight and WebSocket upgrade accepted from each configured origin and `localhost`, refused (403) from any other; `Secure` present on an https origin and absent on http; a `PUT` takes effect on the next request with no restart; a bind change serves on the new address before the old listener closes, and the loopback listener never closes; callback URL update called with the new origin set.
- e2e: C-INS-01. Integration: C-INS-03.

## Acceptance
- [C-INS-01](../checks/C-INS-01.md): the app works on localhost, on a plain-HTTP LAN origin and behind an HTTPS proxy, with no secure-context API.
- [C-INS-03](../checks/C-INS-03.md): bind address and public origins are owner settings, applied without a restart and reflected in CORS, cookies and the SSH line.

## Risks and notes
- A third-party module in the bundle may still call a secure-context API. Observation that confirms it: an exception or a dead control on the plain-HTTP origin in C-INS-01. The conformance ban covers our sources only, so C-INS-01 is the gate.
- `document.execCommand("copy")` is deprecated. Observation: the fallback fails in one of Chrome, Safari or Firefox in C-INS-01.
- A non-loopback bind exposes the API and SSH on that network. Through the API the setting is owner-only; before an owner exists, only `smthrs host start` on the Mac sets it. A proxy placed in front of loopback before setup cannot claim the install, because the claim needs the setup token (§5.1.0, T-ACC-01).
- GitHub may refuse callback URL edits for a manifest-created App. Observation: the API returns 4xx when an origin is added; the one-line fix path then carries the change. T-GH-01 confirms with C-GH-01.
