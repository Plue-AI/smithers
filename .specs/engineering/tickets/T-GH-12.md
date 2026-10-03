# T-GH-12 Durable App step and literal manifest boundary tests

Stage W0, S1 · Size S · Depends on W0: T-GH-01 · S1: T-GH-01, T-GH-11, T-INS-04 · Unblocks T-GH-13, T-REL-02 · Issue: [#3618](https://github.com/smithersai/smithers/issues/3618)
Spec: spec.md §5.1.0–5.1.1, §6.3, §12.1, §16.2, §16.3.3 · Delta: delta.md §7 · Product: mvp.md J1.2, M-03, M-28

## Goal
The app step is durable and single-start, and production-route manifest/callback tests use literal fixtures.

## Scope
In:
- Give the provisional GH-01 /api/install step the durable model id app; keep setup/github_app as the request alias already used by C-GH-01.
- Use shared compare-and-set, idempotency and transactional step/projection state for the app step; preserve converted App state across reload/restart.
- Pin manifest and OAuth callback URL contracts at production routes; correct the obsolete W0 T-GH-01a evidence reference.
Out:
- Reopening frozen T-GH-01, polling/caching/budget (T-GH-02), outbound recovery (T-GH-09), setup card Views, general setup-step engine (T-INS-06), and claim policy (T-ACC-01).

## Changes
- Integrate GH-01 app begin/conversion with install_settings setup.app and install projection_events. INS-06 adopts this state/handler instead of registering a second route or recreating the App. Repeated starts return current state; second conversion cannot overwrite credentials.
- Manifest redirect_url is <effective origin>/setup/github/callback; setup_url is <effective origin>/setup/github/installed. User-authorization callback entries are <configured origin>/api/auth/github/callback plus http://localhost:4000/api/auth/github/callback. Missing-origin fix add_url uses that OAuth path.
- Update C-GH-01 automation to the GH-01 disposable W0 form and S1 production-route browser test. Pin literal permissions {contents:write, workflows:write, pull_requests:write, issues:write, checks:read, statuses:read, administration:read, metadata:read, members:read} and inactive webhook in test fixtures. The W0 receipt records both localhost and LAN results.
- Before Ready, consume the T-GH-11 phase contract and INS-04 effective-origin implementation as S1 runtime prerequisites; do not depend on INS-06.

## Tests
- Invoke real backend routes with real PostgreSQL and githubfake. Two setup sessions start concurrently; only one App begin runs. Repeat an Idempotency-Key, reload and restart after conversion; GET retains app=done with one committed projection and one App. Claim does not remove durable app state.
- Assert fixed manifest permissions, requesting-origin URLs and OAuth callback paths at localhost, plain HTTP LAN and HTTPS; verify an added origin's exact settings/add URLs.
- Exercise replay, expired/foreign state, forged installation_id, unauthorized setup request on every listener, dump/log/env secret scans and token mint after restart. No bypass of middleware or direct service-only acceptance.
- Use literal test fixtures and independent request logs. Never read spec files or derive expectations from production code at runtime.

## Acceptance
- [C-GH-01](../checks/C-GH-01.md), with [C-J1-02](../checks/C-J1-02.md) for the complete setup journey: The app step is durable and single-start, and production-route manifest/callback tests use literal fixtures.

## Risks and notes
- W0 reviews the recorded spike and contract; S1 implements this follow-up after T-GH-01. Do not change its in-flight scope.
- smithers-3f approves Go/store/route seams; smithers-b8 approves launcher-facing contracts; smithers-8a accepts setup ordering and fixtures. Will decides product exceptions. Record owner pre-review before Ready.
- This is a draft, not Ready. File its issue, record actual runtime prerequisites exposed during pre-review, and gate dependent acceptance on this follow-up before stamping.
