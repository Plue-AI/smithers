# T-GH-11 App setup ordering: Address, account, claim, repository

Stage W0, S1 · Size S · Depends on W0: T-GH-01 · S1: T-GH-01, T-INS-04, T-ACC-01 · Unblocks T-APP-03, T-GH-12, T-GH-13, T-REL-02 · Issue: [#3617](https://github.com/smithersai/smithers/issues/3617)
Spec: spec.md §5.1.0–5.1.1, §6.3, §12.1, §16.2, §16.3.3 · Delta: delta.md §7 · Product: mvp.md J1.2, M-03, M-28

## Goal
Address precedes App creation; account choice precedes claim; repository selection and installation follow claim.

## Scope
In:
- Consume confirmed Address from T-INS-04, not T-INS-06. S1 runtime landing additionally requires T-INS-04 and T-ACC-01; W0 review needs only GH-01 spike evidence.
- Before App creation ask only for the owning user or organization account. Select the repository only after owner claim.
- Make the stored OAuthClient usable when installation_id is absent; install/verify after claim. No installation token is required for sign-in.
Out:
- Reopening frozen T-GH-01, polling/caching/budget (T-GH-02), outbound recovery (T-GH-09), setup card Views, general setup-step engine (T-INS-06), and claim policy (T-ACC-01).

## Changes
- Gate the production App begin route on durable Address completion; return the setup-step refusal without conversion when Address is pending.
- Split account choice, App conversion, owner sign-in and repository installation. Retain user/org action URLs and the organization-owner handoff link.
- Wire T-ACC-01 OAuth to the sealed client before repository selection. GH-01 owns App internals; INS-06 consumes the resulting phases.

## Tests
- Through the production router, call `POST /api/install/setup/github_app` before durable Address completion and require no GitHub request. Confirm Address, choose a user then organization in separate installs, and assert literal user/org action URLs. Read phase state through `GET /api/install`; complete claim through `/api/auth/github/callback` with its production session, origin and state middleware.
- With the real backend, real PostgreSQL and fake GitHub, convert the App without repository or installation, perform served OAuth claim, observe owner_unverified on a non-setup route, then select/install/verify the repository. Restart between phases. C-J1-02 records the same sequence in the real browser.
- Use literal test fixtures and independent request logs. Never read spec files or derive expectations from production code at runtime.

## Acceptance
- [C-GH-01](../checks/C-GH-01.md), with [C-J1-02](../checks/C-J1-02.md) for the complete setup journey: Address precedes App creation; account choice precedes claim; repository selection and installation follow claim.

## Risks and notes
- W0 reviews the recorded spike and contract; S1 implements this follow-up after T-GH-01. Do not change its in-flight scope.
- smithers-3f approves Go/store/route seams; smithers-b8 approves launcher-facing contracts; smithers-8a accepts setup ordering and fixtures. Will decides product exceptions. Record owner pre-review before Ready.
- Issue #3617 is filed. Before start, record owner pre-review of the phase contract; implementation and acceptance use GH-01's single setup route registration.

## Ready checklist

1. Runtime prerequisites: W0 uses completed GH-01 spike evidence; S1 requires GH-01 credentials and setup-session gates, INS-04 durable Address/effective-origin serving and ACC-01 claim/provisional-owner authorization. INS-02 isolation is in the INS-04 prerequisite closure.
2. Exclusions: Scope explicitly excludes frozen GH-01 edits, polling, outbound recovery, setup Views, the general setup engine and claim policy; no new launcher, credential store or repository execution path.
3. Boundary tests: C-GH-01 exercises the production setup/OAuth routes with real PostgreSQL and literal GitHub fixtures; C-J1-02 exercises the browser journey after its setup/UI prerequisites. No runtime spec or production-code oracle.
4. Decisions: smithers-3f approves Go/store/route and security seams; smithers-b8 approves the public setup phase contract; smithers-8a accepts ordering fixtures; Will decides product exceptions.
5. Owner pre-review before start: smithers-3f answers whether Address gating and claim are durable across restart, whether the sealed OAuth client works before installation, and whether provisional authorization blocks every non-setup route; smithers-b8 answers whether the account/claim/repository phases fit the launcher and setup API contract.
6. Security: smithers-3f reviews setup-session, origin/CSRF and OAuth state enforcement, server-derived installation identity and host-only sealed credentials. These routes execute shipped host code only; any downstream repository work stays in INS-02-isolated machines (M-29, C-SEC-02); C-GH-01 and C-SEC-04 prove the setup gates.
