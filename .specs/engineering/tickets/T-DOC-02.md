# T-DOC-02 ADR 0002: Mac install, multi-member, microVM-only, origin-agnostic

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3442](https://github.com/smithersai/smithers/issues/3442)
Spec: spec.md §0, §1.1–§1.4, §5.1.0, §5.3, §8.1, §8.2.1, §16.1.0, §16.1.2, §16.3, §17 · Delta: delta.md §1 (Docs row), §11 (ADR 0001 row) · Product: mvp.md M-10, M-17, M-28, M-29, M-30, §6.1; overview.md E-01, E-02, E-03, E-09, E-13, E-17

## Goal
The repository holds an accepted ADR stating that the Mac install is multi-member, runs repository code only in microVMs and serves on owner-configured origins, and ADR 0001 points to it for that assembly.

## Scope
In:
- `docs/architecture/0002-mac-install.md` (new): context; decisions with reasons and rejected alternatives, taken from overview.md:
  - E-01: Homebrew tap and a launchd daemon running as the installing user; no Electrobun app; the Docker self-host image is deleted (§16.1.0);
  - E-02: repository code runs only in machines; no `trusted_process` execution on the Mac install;
  - E-03: one machine per branch, shared by members and the agent; branch locks deleted;
  - E-09: only a browser `session` credential approves or merges; agents hold `delegated` credentials;
  - M-17: a multi-member roster with GitHub write access replaces the single owner of #1667;
  - E-13 and M-28: origin-agnostic serving, loopback always plus an optional owner-set bind address and public origins, no secure-context dependency, no certificate authority; a one-time setup token claims the install (§5.1.0); HTTPS comes from whatever the team puts in front, and no code depends on it; rejected: Tailscale-only serving and an install CA (E-13);
  - E-17 (spec §8.2.1): every limit derives from the detected host profile, never a Mac model;
  - consequences; what stays in ADR 0001 (Plue assembly, PostgreSQL authority, one Flow model).
- ADR 0001 (`docs/architecture/0001-shared-product.md`): the status line (`:3`) adds "Superseded for the Mac install by ADR 0002"; the single-owner and `trusted_process` paragraph (`:9`) and the native-app paragraph (`:11`) are marked superseded for that assembly. Nothing else changes.
- `docs/architecture/self-host-implementation.md`: single-owner statements (`:12-13`, `:28`) and the `native-own` and `native-plue` WebView rows (`:23-24`) give way to one Mac install row (microVM, multi-member, launchd); the roadmap rows that name the single-owner edition (`:40`, `:45`, `:47`) point to ADR 0002.
- ADR 0001's container topology is marked superseded for the Mac install; T-INS-05 deletes the image.

Out: public docs (T-DOC-01); `docs/mvp/` (T-DOC-03); code; overview.md and spec.md edits (tech lead).

## Changes
- The three files above. `pnpm docs:check` must still pass (the root `docs/` tree is not synced into a site, but the gate runs on every docs change).

## Tests
- unit `scripts/mvp-docs.test.mjs` (new, shared with C-REL-01): ADR 0002 exists with `Status: accepted`; ADR 0001's status line links it; every relative link in the three files resolves; `self-host-implementation.md` has no `native-own` row.

## Acceptance
- [C-REL-01](../checks/C-REL-01.md): ADR 0002 accepted and linked from ADR 0001 and `self-host-implementation.md`; docs gates pass.

## Risks and notes
- E-02 and E-09 are hard to reverse (overview.md). The ADR stays "proposed" until Will accepts it; the check requires "accepted".
