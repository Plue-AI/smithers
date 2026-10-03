# T-GH-14 Expose canonical App identity for outbound attribution

Stage W0, S1 · Size S · Depends on W0: T-GH-01 · S1: T-GH-01 · Unblocks T-REL-02 · Issue: [#3620](https://github.com/smithersai/smithers/issues/3620)
Spec: spec.md §5.1.0–5.1.1, §6.3, §12.1, §16.2, §16.3.3 · Delta: delta.md §7 · Product: mvp.md J1.2, M-03, M-28

## Goal
Outbound callers receive canonical App identity from the same credential adapter used for authentication.

## Scope
In:
- Extend the shared credential seam with non-secret canonical App id and slug usable by outbound event attribution.
- Define attribution from authenticated GitHub App identity, not a requester login, display name or callback parameter.
- Keep fault hooks and actor-bearing event fixtures in T-GH-09.
Out:
- Reopening frozen T-GH-01, polling/caching/budget (T-GH-02), outbound recovery (T-GH-09), setup card Views, general setup-step engine (T-INS-06), and claim policy (T-ACC-01).

## Changes
- Add AppID() to the credential interface and both store/env adapters. Read the store App id obtained from conversion or authenticated GET /app; require the Plue env adapter to provide its validated App id. Do not add a second credential store.
- Hand canonical App id/slug to GH-09 so it can identify events by GitHub-provided App identity. GitHub actor normalization belongs to GH-09; no invented bot-user-id formula is part of this contract.

## Tests
- Real install composition with poisoned shell App id/slug still exposes stored identity after restart. Plue composition exposes its explicit env identity.
- GH-09 integration uses App-attributed and human-attributed event fixtures, including a human quoting the Smithers marker; only the App's event can settle an unknown write. A lost response followed by human reversal does not trigger a repeat write. Check: C-GH-09.
- Use literal test fixtures and independent request logs. Never read spec files or derive expectations from production code at runtime.

## Acceptance
- [C-GH-09](../checks/C-GH-09.md), with [C-GH-01](../checks/C-GH-01.md) for sealed identity/restart: Outbound callers receive canonical App identity from the same credential adapter used for authentication.

## Risks and notes
- W0 reviews the recorded spike and contract; S1 implements this follow-up after T-GH-01. Do not change its in-flight scope.
- smithers-3f approves Go/store/route seams; smithers-b8 approves launcher-facing contracts; smithers-8a accepts setup ordering and fixtures. Will decides product exceptions. Record owner pre-review before Ready.
- This is a draft, not Ready. File its issue, record actual runtime prerequisites exposed during pre-review, and gate dependent acceptance on this follow-up before stamping.
