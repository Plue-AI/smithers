# T-FM-02 Smithers fast-model gateway: per-install auth, metering and a card-free daily quota

Stage S2 · Size M · Depends on — · Unblocks —
Spec: spec.md §11.5b.2, §11.5b.3, §17.4a · Product: mvp.md §12 item 5, Models row (Will 2026-10-03, cdbc5a646f)

Added 2026-10-06 by smithers-8a. Stage S2: the team-key path alone passes J1 in stage 1 (8a staging ruling).

## Goal
Smithers hosts the fast-model gateway from the existing `modelproxy` and `credits` packages: it authenticates each install, forwards to Cerebras with the platform key, meters tokens per install and enforces a free daily quota with no card.

## Scope
In: per-install credential issuance at the Smithers sign-in and its verification; forwarding to Cerebras; per-install token metering; a daily quota with a typed `capacity` refusal and reset time; counts-only storage; the hosted composition (Plue).
Out: billing, cards, plans and entitlements beyond the quota (pending Will); the install side (T-FM-01); coding-model or Decisions traffic.

## Changes
- Reuse `packages/backend/modelproxy` and `packages/backend/credits` (public); Plue composes and hosts them (design/hosting.md, gateway-only metering).
- No prompt or completion content is persisted; metering rows hold install, tokens and time.

## Decisions and pre-review
- smithers-3f owns the gateway and security review; smithers-98 sets the quota number; Will rules on any card step.

## Tests

C-FM-02:
1. A valid install credential gets a completion; an unknown, revoked or other-install credential gets 401 or 403 with zero upstream calls.
2. Exceed the daily quota: typed `capacity` with the reset time; the counter resets at the boundary.
3. Inspect storage after 100 calls: counts only, no prompt or completion bytes.
4. The platform key never appears in any response, log or metering row.

Pass when:
- Steps 1-4 hold with literal fixtures against a fake upstream.

## Acceptance
- [C-FM-02](../checks/C-FM-02.md)

## Risks and notes
- Quota size is a cost decision; until 98 sets it, use a conservative default in config and record it.
