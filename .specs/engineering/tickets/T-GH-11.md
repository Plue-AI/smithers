# T-GH-11 App setup ordering: Address, account, claim, repository

Stage W0, S1 · Size S · Depends on W0: T-GH-01 · S1: T-GH-01, T-INS-04, T-ACC-01 · Unblocks T-GH-12, T-GH-13, T-REL-02 · Issue: [#3617](https://github.com/smithersai/smithers/issues/3617)
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
- Through served setup routes, attempt App begin before Address and require no GitHub request. Confirm Address, choose a user then organization in separate installs, and require the correct action URL.
- With the real backend, real PostgreSQL and fake GitHub, convert the App without repository or installation, perform served OAuth claim, observe owner_unverified on a non-setup route, then select/install/verify the repository. Restart between phases. C-J1-02 records the same sequence in the real browser.
- Use literal test fixtures and independent request logs. Never read spec files or derive expectations from production code at runtime.

## Acceptance
- [C-GH-01](../checks/C-GH-01.md), with [C-J1-02](../checks/C-J1-02.md) for the complete setup journey: Address precedes App creation; account choice precedes claim; repository selection and installation follow claim.

## Risks and notes
- W0 reviews the recorded spike and contract; S1 implements this follow-up after T-GH-01. Do not change its in-flight scope.
- smithers-3f approves Go/store/route seams; smithers-b8 approves launcher-facing contracts; smithers-8a accepts setup ordering and fixtures. Will decides product exceptions. Record owner pre-review before Ready.
- This is a draft, not Ready. File its issue, record actual runtime prerequisites exposed during pre-review, and gate dependent acceptance on this follow-up before stamping.
