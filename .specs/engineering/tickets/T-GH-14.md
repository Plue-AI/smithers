# T-GH-14 Expose canonical App identity for outbound attribution

Stage W0, S1 · Size S · Depends on W0: T-GH-01 · S1: T-GH-01 · Unblocks T-GH-09, T-REL-02 · Issue: [#3620](https://github.com/smithersai/smithers/issues/3620)
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
- Add AppID() to the credential interface and both store/env adapters. Read the store App id obtained from conversion or authenticated GET /app; require the Plue env adapter to provide its explicit App id and validate its id/slug with authenticated GET /app; refuse a mismatch or absent identity. Do not add a second credential store.
- Hand canonical App id/slug to GH-09 so it can identify events by GitHub-provided App identity. GitHub actor normalization belongs to GH-09; no invented bot-user-id formula is part of this contract.

## Tests
- In `github_app_credentials_integration_test.go` (new, GH-01), create the App through the production App begin and conversion routes, with real PostgreSQL and fixed githubfake responses. Restart the production install composition with poisoned shell App id/slug; exercise the production installation lookup/token-mint caller. Capture the selected credential adapter's AppID()/Slug() at that caller and assert literal fixture values; verify the outgoing JWT issuer matches the literal App id. No direct adapter-only acceptance. Plue's production credential composition must expose its explicitly configured id and authenticated GET /app slug; wrong or absent identity fails closed.
- Later caller integration, owned by GH-09 after this seam lands: use App-attributed and human-attributed event fixtures, including a human quoting the Smithers marker; only the App's event can settle an unknown write. A lost response followed by human reversal does not trigger a repeat write. Check: C-GH-09. This consumer receipt is not a prerequisite for landing the identity adapter.
- Use literal test fixtures and independent request logs. Never read spec files or derive expectations from production code at runtime.

## Acceptance
- [C-GH-01](../checks/C-GH-01.md): production composition selects the stored canonical identity at the authenticated installation caller after restart; Plue selects its validated env adapter.
- [C-GH-09](../checks/C-GH-09.md): joint consumer evidence after GH-09 integrates this seam, not an identity-adapter landing gate.

## Risks and notes
- W0 reviews the recorded spike and contract; S1 implements this follow-up after T-GH-01. Do not change its in-flight scope.
- smithers-3f approves Go/store/route seams; smithers-b8 approves launcher-facing contracts; smithers-8a accepts setup ordering and fixtures. Will decides product exceptions. Record owner pre-review before Ready.
- Issue #3620 is filed. smithers-3f signs off AppID()/Slug() and Plue adapter validation; smithers-8a accepts literal identity fixtures. Record owner pre-review before start.

## Ready checklist

1. Runtime prerequisites: W0 uses GH-01 spike evidence; S1 requires GH-01's shared credential interface, sealed singleton store and composition-selected adapters. GH-09 consumes this seam after it lands; its later recovery check is separate.
2. Exclusions: Scope names frozen GH-01 edits, polling, outbound recovery, Views, setup sequencing and claim policy; no second credential store, actor-normalization algorithm or bot-user-id formula.
3. Boundary tests: C-GH-01 drives production setup/conversion and installation credential callers across restart, with literal App identity and JWT-issuer fixtures. GH-09 later proves attribution at its dispatcher. No runtime spec/code oracle.
4. Decisions: smithers-3f signs off the Go credential API and Plue validation; smithers-b8 approves launcher-facing contract effects; smithers-8a accepts fixtures; Will decides product exceptions.
5. Owner pre-review before start: smithers-3f answers whether identity comes from authenticated conversion/GET /app, whether store and Plue adapters preserve authentication identity across restart, and whether unknown/mismatched identity fails closed; smithers-b8 answers whether poisoned launcher environment can affect the install's selected identity.
6. Security: smithers-3f reviews trusted App attribution and host-only sealed PEM/client secrets (C-GH-01). Identity lookup executes shipped host code only; it neither loads repository flows nor starts repository work outside machines (M-29).
