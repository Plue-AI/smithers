# T-GH-13 Complete manual App credential fallback on either setup origin

Stage W0, S1 · Size S · Depends on W0: T-GH-01 · S1: T-GH-01, T-GH-11, T-GH-12 · Unblocks T-REL-02 · Issue: [#3619](https://github.com/smithersai/smithers/issues/3619)
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
- Explain the exact GitHub settings fields to supply. Take PEM, client secret and webhook secret as secret inputs; obtain canonical App id/slug from authenticated GET /app and reject mismatches.
- Require the literal permission set and inactive webhook from T-GH-12. Register/confirm each /api/auth/github/callback URL before owner sign-in. Never mark app done with incomplete credentials or unknown callback registration.
- Update C-GH-01 fallback variant for either origin and remove its manifest-only no-copy assertion for that recorded fallback branch. Record which branch and origin passed; never claim manifest success from fallback evidence.

## Tests
- Real backend routes, PostgreSQL and githubfake reject incomplete credentials, wrong App identity, bad PEM, missing callbacks or incorrect permissions. Complete fallback can perform OAuth claim before repository installation and mint installation tokens after restart.
- Test localhost-refused and LAN-refused fixtures independently. Scan request/application logs, responses, environment and pg_dump for PEM, client secret and webhook secret; require none in persisted plaintext or echoed output. Replay/second save cannot overwrite the singleton App.
- Use literal test fixtures and independent request logs. Never read spec files or derive expectations from production code at runtime.

## Acceptance
- [C-GH-01](../checks/C-GH-01.md), with [C-J1-02](../checks/C-J1-02.md) for the complete setup journey: A recorded redirect refusal on either origin has a complete validated, sealed fallback with the same claim and installation sequence.

## Risks and notes
- W0 reviews the recorded spike and contract; S1 implements this follow-up after T-GH-01. Do not change its in-flight scope.
- smithers-3f approves Go/store/route seams; smithers-b8 approves launcher-facing contracts; smithers-8a accepts setup ordering and fixtures. Will decides product exceptions. Record owner pre-review before Ready.
- This is a draft, not Ready. File its issue, record actual runtime prerequisites exposed during pre-review, and gate dependent acceptance on this follow-up before stamping.
