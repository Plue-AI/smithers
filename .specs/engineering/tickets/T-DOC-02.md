# T-DOC-02 ADR 0002: Mac install, multi-member, microVM-only, origin-agnostic

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3442](https://github.com/smithersai/smithers/issues/3442)
Spec: spec.md §0, §1.1–§1.4, §5.1.0, §5.3, §8.1, §8.2.1, §16.1.0, §16.1.2, §16.3, §17 · Delta: delta.md §1 (Docs row), §11 (ADR 0001 row) · Product: mvp.md M-10, M-17, M-28, M-29, M-30, §6.1; overview.md E-01, E-02, E-03, E-09, E-13, E-17

## Goal
The repository holds an accepted ADR stating that the Mac install is multi-member, runs repository code only in microVMs and serves on owner-configured origins, and ADR 0001 points to it for that assembly.

## Scope
In:
- `docs/architecture/0002-mac-install.md` (existing, Status: proposed): review the current record against the cited normative sections, correct drift, and record Will's approval before changing it to accepted. Preserve context, reasons and rejected alternatives from overview.md:
  - E-01: Homebrew tap and a launchd daemon running as the installing user; T-INS-02 owns the S1 launcher, T-INS-05 owns release distribution and Docker image deletion. Record the T-INS-03 daemon evidence or the specified launchd-agent/automatic-login fallback without claiming unmeasured support (§16.1.2);
  - E-02: repository code runs only in machines; the host runs shipped install code, refuses missing microVM isolation and never falls back to trusted_process. No member or agent has sudo. Homes are per-machine; only allowlisted credential files carry through the member credential store (§5.5.4, §8.7.3). smithers-3f pre-reviews these security statements (M-29/M-30);
  - E-03: one machine per branch, shared by members and the agent; branch locks deleted;
  - E-09: only a browser `session` credential approves or merges; agents hold `delegated` credentials;
  - M-17: a multi-member roster with GitHub write access replaces the single owner of #1667;
  - E-13 and M-28: origin-agnostic serving, loopback always plus an optional owner-set bind address and public origins, core app use on plain HTTP with optional browser notifications requiring a secure origin (§14.6), no certificate authority; a one-time setup token claims the install (§5.1.0); HTTPS comes from whatever the team puts in front, and no code depends on it; rejected: Tailscale-only serving and an install CA (E-13);
  - E-17 (spec §8.2.1): every limit derives from the detected host profile, never a Mac model;
  - consequences; what stays in ADR 0001 (Plue assembly, PostgreSQL authority, one Flow model).
- ADR 0001 (`docs/architecture/0001-shared-product.md`): preserve the existing supersession link in the status line (:3) and supersession markers on the container/trusted_process (:9) and native-app (:11) paragraphs. Plue and shared-product authority remain in ADR 0001.
- `docs/architecture/self-host-implementation.md`: preserve its existing ADR 0002 link (:5), Mac deployment/security boundary (:10–15), mac-install/web-plue matrix (:22–23) and updated roadmap (:42–49). No native-own/native-plue row remains; the ledger records required proof, not completed implementation.
- ADR 0001's container topology is marked superseded for the Mac install; T-INS-05 deletes the image.

Out: public docs (T-DOC-01); docs/mvp/ (T-DOC-03); runtime code and implementation of the launcher, tap, isolation, identity, credential sync or origin handling; other ADRs; overview.md and spec.md edits (tech lead). Documentation acceptance does not certify the runtime implementation.

## Changes
- Review the three existing documents above and extend scripts/mvp-docs.test.mjs and its existing //scripts:mvpDocs target only as needed for these assertions. pnpm docs:check remains the production docs gate; its success alone does not run the architecture-specific acceptance check.

## Tests
- Unit: existing `scripts/mvp-docs.test.mjs`, run through the declared `smthrs test //scripts:mvpDocs` boundary (C-REL-01 S1 part), reads the real architecture documents. Pin literal assertions for machine-only execution/no host fallback, person-session approval, per-machine homes, origin-agnostic core app, host-derived limits and supersession links. Resolve relative links as actual document data; do not derive behavioral expectations from spec files or generated runtime code.
- Approval gate: the current test at :109 requires proposed. It remains valid during drafting; after Will approves the MVP engineering spec, smithers-8a records the approval reference/date in ADR 0002 and updates this assertion to require accepted plus that receipt. A proposed record cannot satisfy this ticket's acceptance. Never set accepted merely to make the test pass.
- Docs gate: `pnpm docs:check` passes through the existing package script. It complements the architecture test and does not replace human approval or runtime isolation tests.

## Acceptance
- [C-REL-01](../checks/C-REL-01.md): ADR 0002 accepted and linked from ADR 0001 and `self-host-implementation.md`; docs gates pass.

## Risks and notes
- E-02 and E-09 are hard to reverse (overview.md). Will accepts ADR 0002 by approving the MVP engineering spec; smithers-8a records the approval reference/date and changes Status only afterward. smithers-3f approves deployment/security feasibility and the T-INS-03 daemon-versus-fallback evidence; smithers-b8 approves the documented public install/CLI contract; smithers-38 approves the packaged-host versus repository-flow boundary. Conflicts with product go to Will; smithers-8a resolves spec/ADR drift before acceptance.

## Ready checklist
1. Dependencies: no runtime prerequisite is needed to land a documentation/test-only change, so Depends on remains empty. T-INS-03 evidence is required to claim the selected daemon path works; otherwise the ADR states its fallback/contingency. Implementation tickets retain their own runtime dependencies.
2. Exclusions: public docs, docs/mvp, runtime implementation, other ADRs and normative-spec edits are explicit; ADR acceptance does not certify a working install.
3. Tests: existing scripts/mvp-docs.test.mjs runs via //scripts:mvpDocs on the actual documents with pinned literal rules; pnpm docs:check runs the production docs gate. The human approval receipt is separate from automated content assertions (C-REL-01 S1 part).
4. Decisions: Will accepts the ADR/engineering spec; smithers-8a records approval and resolves drift; smithers-3f approves deployment/security evidence, smithers-b8 approves public install/CLI claims and smithers-38 approves flow execution boundaries.
5. Owner pre-review before start: smithers-3f: Does the ADR enforce startup refusal and machine-only execution? Are homes per-machine with only allowlisted credentials carried? Is daemon support evidenced or the fallback stated? smithers-b8: Do install/CLI and origin claims match the shipped contract? Is plain-HTTP core use distinguished from optional secure-origin notifications? smithers-38: Does the host load only packaged code? Do all overridable repository flows remain machine-only?
6. Security: no repository execution is added. The ADR requires working microVM isolation before startup, no host-process fallback, no sudo and person-only approval/merge; smithers-3f reviews those preconditions and smithers-38 reviews the repository-flow boundary (§1.3, §17).
