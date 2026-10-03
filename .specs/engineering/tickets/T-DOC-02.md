# T-DOC-02 ADR 0002: Mac install, multi-member, microVM-only, origin-agnostic

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3442](https://github.com/smithersai/smithers/issues/3442)
Spec: spec.md §0, §1.1–§1.4, §5.1.0, §5.3, §8.1, §8.2.1, §16.1.0, §16.1.2, §16.3, §17 · Delta: delta.md §10 (Reuse [S1] architecture row), §11 (ADR 0001 row) · Product: mvp.md M-10, M-17, M-28, M-29, M-30, §6.1; overview.md E-01, E-02, E-03, E-09, E-13, E-17

## Goal
The repository holds an accepted ADR stating that the Mac install is multi-member, runs repository code only in microVMs and serves on owner-configured origins, and ADR 0001 points to it for that assembly.

## Scope
In:
- `docs/architecture/0002-mac-install.md` (existing, Status: proposed): review the current record against the cited normative sections, correct drift, and record Will's approval before changing it to accepted. Preserve context, reasons and rejected alternatives from overview.md:
  - E-01: Homebrew tap and launchd supervision as the installing user; T-INS-02 owns the S1 launcher, T-INS-08 owns the per-user LaunchAgent under `gui/<uid>`, and T-INS-05 owns release distribution and Docker image deletion. S1 assumes the installing user is logged in and uses no privilege escalation (§16.1.2). T-INS-03 supplies release evidence, not an S1 daemon prerequisite. Remove claims of proven before-login daemon support; record only measured release support;
  - E-02: repository code runs only in machines; the host runs shipped install code, refuses missing microVM isolation and never falls back to trusted_process. No member or agent has sudo. Homes and tool logins are per-machine; tokens, history, caches and databases never copy between machines (§8.7.1–§8.7.3). The synced member credential store is deferred (§8.7.3a, product §16). smithers-3f pre-reviews these security statements (M-29/M-30);
  - E-03: one machine per branch, shared by members and the agent; branch locks deleted;
  - E-09: only a browser `session` credential approves or merges; agents hold `delegated` credentials;
  - M-17: a multi-member roster with GitHub write access replaces the single owner of #1667;
  - E-13 and M-28: origin-agnostic serving, loopback always plus an optional owner-set bind address and public origins, core app use on plain HTTP with optional browser notifications requiring a secure origin (§14.6), no certificate authority; a one-time setup token claims the install (§5.1.0); HTTPS comes from whatever the team puts in front, and no code depends on it; rejected: Tailscale-only serving and an install CA (E-13);
  - E-17 (spec §8.2.1): every limit derives from the detected host profile, never a Mac model;
  - consequences; what stays in ADR 0001 (Plue assembly, PostgreSQL authority, one Flow model).
- ADR 0001 (`docs/architecture/0001-shared-product.md`): preserve the existing supersession link in the status line (:3) and supersession markers on the container/trusted_process (:9) and native-app (:11) paragraphs. Plue and shared-product authority remain in ADR 0001.
- `docs/architecture/self-host-implementation.md`: preserve its existing ADR 0002 link (:5), correct its daemon claim (:10) to the S1 LaunchAgent contract (§16.1.2), and retain the security boundary (:12–15), mac-install/web-plue matrix (:21–22) and updated roadmap (:38–50). No native-own/native-plue row remains; the ledger records required proof, not completed implementation.
- ADR 0001's container topology is marked superseded for the Mac install; T-INS-05 deletes the image.
- This documentation/test-only change calls no new ticket-owned code or schema and needs no runtime integration. Unlanded implementation tickets do not gate landing. Their contracts remain required proof in the ledger, never claims of working runtime support. ADR 0002 remains proposed until Will's approval receipt exists; the acceptance assertion fails closed without it (C-REL-01, T-DOC-01 Tests step 6).

Out: public docs (T-DOC-01); docs/mvp/ (T-DOC-03); runtime code and implementation of the launcher, tap, isolation, identity, credential sync or origin handling; other ADRs; overview.md and spec.md edits (tech lead). Documentation acceptance does not certify the runtime implementation.

## Changes
- Review the three existing documents above and extend scripts/mvp-docs.test.mjs and its existing //scripts:mvpDocs target only as needed for these assertions. pnpm docs:check remains the production docs gate; its success alone does not run the architecture-specific acceptance check.

## Tests
- Unit: existing `scripts/mvp-docs.test.mjs`, run through the declared `smthrs test //scripts:mvpDocs` boundary (C-REL-01 S1 part), reads the real architecture documents. Pin literal assertions for machine-only execution/no host fallback, person-session approval, per-machine homes without token copying, the logged-in per-user LaunchAgent without privilege escalation, origin-agnostic core app, host-derived limits and supersession links. Resolve relative links as actual document data; do not derive behavioral expectations from spec files or generated runtime code.
- Approval gate: the current test at :109 requires proposed. It remains valid during drafting; after Will approves the MVP engineering spec, smithers-8a records the approval reference/date in ADR 0002 and updates this assertion to require accepted plus that receipt. A proposed record cannot satisfy this ticket's acceptance. Never set accepted merely to make the test pass.
- Docs gate: `pnpm docs:check` passes through the existing package script. It complements the architecture test and does not replace human approval or runtime isolation tests.

## Acceptance
- [C-REL-01](../checks/C-REL-01.md), folded into T-DOC-01 Tests step 6 (S1): `smthrs test //scripts:mvpDocs` and `pnpm docs:check` pass; ADR 0002 is accepted with Will's approval reference/date and linked from ADR 0001 and `self-host-implementation.md`. Later public-docs assertions belong to T-DOC-01 and do not gate this S1 slice.

## Risks and notes
- E-02 and E-09 are hard to reverse (overview.md). Will accepts ADR 0002 by approving the MVP engineering spec; smithers-8a records the approval reference/date and changes Status only afterward. smithers-3f approves deployment/security feasibility, the S1 LaunchAgent contract and any T-INS-03 release claims; smithers-b8 approves the documented public install/CLI contract; smithers-38 approves the packaged-host versus repository-flow boundary. Conflicts with product go to Will; smithers-8a resolves spec/ADR drift before acceptance.

## Ready checklist
1. Dependencies: Depends on remains empty because this change calls no new ticket-owned code or schema. Scope keeps unlanded runtime contracts as required proof and withholds ADR acceptance until Will's receipt exists; T-INS-03 is release evidence only (C-REL-01, T-DOC-01 Tests step 6).
2. Exclusions: public docs, docs/mvp, runtime implementation, other ADRs and normative-spec edits are explicit. Synced tool credentials and proven before-login daemon support are excluded; reuse the three existing documents and existing test target.
3. Tests: `smthrs test //scripts:mvpDocs` reads the real documents with committed literal expectations; `pnpm docs:check` is the separate production docs gate. Neither derives behavioral expectations from spec files or implementation code. C-REL-01's S1 architecture assertions are T-DOC-01 Tests step 6; human approval is a separate receipt.
4. Decisions: Will accepts the ADR/engineering spec; smithers-8a records approval and resolves drift; smithers-3f approves deployment/security claims, smithers-b8 approves public install/CLI claims and smithers-38 approves flow execution boundaries. Product conflicts go to Will.
5. Owner pre-review: smithers-3f: Does the ADR enforce isolation refusal and machine-only execution? Do tool credentials remain in per-machine homes without copying? Does it state the logged-in S1 LaunchAgent contract and limit release claims to evidence? smithers-b8: Do install/CLI and origin claims match the contract? Is plain-HTTP core use distinguished from secure-origin notifications? smithers-38: Does the host load only packaged code? Do all overridable repository flows remain machine-only? Record answers in this checklist; owners review post hoc under the 2026-10-03 directive.
6. Security: no runtime execution or root step is added; root inputs and their sources are therefore none. Repository tests and docs commands run as an ordinary user inside a machine (M-29); no sudo or host-process fallback is introduced. smithers-3f reviews isolation, privileges and credential separation; smithers-38 reviews the packaged-host/repository-flow boundary (§1.3, §17). C-REL-01's S1 assertions verify the documented boundary, not runtime isolation.
