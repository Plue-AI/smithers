# T-GH-13 Complete manual App credential fallback on either setup origin

Stage W0, S1 · Size S · Depends on W0: T-GH-01 · S1: T-GH-01, T-GH-11, T-GH-12 · Unblocks T-APP-03, T-INS-06, T-REL-02 · Issue: [#3619](https://github.com/smithersai/smithers/issues/3619)
Spec: spec.md §5.1.0–5.1.1, §6.3, §12.1, §16.2, §16.3.3 · Delta: delta.md §7 · Product: mvp.md J1.2, M-03, M-28

## Goal
A recorded redirect refusal on either origin has a complete validated, sealed fallback with the same claim and installation sequence.

## Scope
In:
- After a recorded localhost or LAN manifest refusal, provide the same complete manual fallback for that origin.
- Obtain App id, slug, PEM, client id/secret, webhook secret and callback registration without shell credentials; validate with App JWT GET /app.
- Seal all sensitive credentials and preserve the same setup phases, origin/session gates and singleton semantics as the manifest path.
Out:
- Reopening frozen T-GH-01, polling/caching/budget (T-GH-02), outbound recovery (T-GH-09), setup card Views, general setup-step engine (T-INS-06), and claim policy (T-ACC-01).

## Changes

- The manual-App route inherits T-GH-11/T-GH-12’s durable setup-session and claim gates. Do not authorize it with the transitional X-Smithers-Setup-Token header. Check: C-J1-02.
- Explain the exact GitHub settings fields to supply. Take PEM, client secret and webhook secret as secret inputs; obtain canonical App id/slug from authenticated GET /app and reject mismatches.
- Require the literal permission set and inactive webhook from T-GH-12. Manual `POST /api/install/setup/app` accepts `{app_id, slug, pem, client_id, client_secret, webhook_secret, callbacks_confirmed[]}`. Declare this schema in `docs/api/openapi/install.yaml`. `callbacks_confirmed` must equal the URL set reported by `GET /api/install`, each origin plus `/api/auth/github/callback`. The installer registers URLs manually; GitHub provides no callback-registration API. Missing fields or URLs return HTTP 400, class `user`, with the missing field or URL named and no secret echoed. Never mark the App step done before validation. Checks: C-GH-01, C-J1-02.
- Update C-GH-01 fallback variant for either origin and remove its manifest-only no-copy assertion for that recorded fallback branch. Record which branch and origin passed; never claim manifest success from fallback evidence.

## Tests

- C-GH-01 posts literal manual payloads through the sole `/api/install/setup/app` route. Missing each field, missing or extra callback URLs and wrong App identity refuse before completion; error messages name missing fields or URLs and contain no secret. The `/api/install/setup/github_app` alias is absent.
- Submit the manual variant through `POST /api/install/setup/app` with production setup-session, origin and CSRF middleware, real PostgreSQL and githubfake; read completion through `GET /api/install`. Reject incomplete credentials, wrong App identity, bad PEM, missing callbacks or incorrect permissions before app=done. Complete fallback claims through `/api/auth/github/callback` before repository installation, verifies installation through the production repository setup handler, and mints installation tokens after restart.
- Test localhost-refused and LAN-refused fixtures independently. Scan request/application logs, responses, environment and pg_dump for PEM, client secret and webhook secret; require none in persisted plaintext or echoed output. Replay/second save cannot overwrite the singleton App.
- Use literal test fixtures and independent request logs. Never read spec files or derive expectations from production code at runtime.

## Acceptance
- [C-GH-01](../checks/C-GH-01.md), with [C-J1-02](../checks/C-J1-02.md) for the complete setup journey: A recorded redirect refusal on either origin has a complete validated, sealed fallback with the same claim and installation sequence.

## Risks and notes
- W0 reviews the recorded spike and contract; S1 implements this follow-up after T-GH-01. Do not change its in-flight scope.
- smithers-3f approves Go/store/route seams; smithers-b8 approves launcher-facing contracts; smithers-8a accepts setup ordering and fixtures. Will decides product exceptions. Record owner pre-review before Ready.
- Issue #3619 is filed. smithers-8a accepts the recorded GitHub redirect refusal and fallback evidence for each origin; Will decides any change to the fallback trigger or credential requirements. Record owner pre-review before start.

## Ready checklist

1. Runtime prerequisites: W0 uses GH-01 spike evidence; S1 requires GH-01 sealed credential/security adapters, GH-11 claim ordering and GH-12 durable app-step/manifest contract. Their closure supplies Address, effective origin, claim authorization and projection storage.
2. Exclusions: Scope names frozen GH-01 edits, polling, outbound recovery, Views, the general setup engine and claim policy; no shell credential bootstrap, callback-registration API or second credential store.
3. Boundary tests: C-GH-01 drives manual input through the production setup/OAuth/repository handlers for separate localhost and LAN refusal fixtures; C-J1-02 proves the complete browser sequence. Literal fixtures and independent logs supply expectations.
4. Decisions: smithers-3f approves credential validation and security; smithers-b8 approves manual-input API/error contracts; smithers-8a accepts refusal/fallback receipts and fixtures; Will decides product exceptions.
5. Owner pre-review before start: smithers-3f answers whether GET /app validates identity/permissions before saving, whether all secret inputs stay sealed and absent from responses/logs, and whether retry/replay preserves singleton and claim gates; smithers-b8 answers whether the manual variant carries all required fields and callback confirmation through the existing setup API. smithers-3f: answered 18:2x, ok. smithers-b8: answered, BLOCKING edits applied (tech lead adopts).
6. Security: smithers-3f reviews setup-session, origin/CSRF, singleton save, callback confirmation and secret sealing/scans (C-GH-01, C-SEC-04). Only shipped validation code executes on the host; downstream repository execution stays in INS-02 machines (M-29, C-SEC-02).
