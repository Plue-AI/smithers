# T-MNT-05 Ship the day-seven maintainer upgrade and journey

Stage M · Size S · Depends on T-MNT-03, T-MNT-04, T-INS-07, T-REL-01, T-DOC-03, T-DOC-01, T-SEC-01, T-MCH-11 · Unblocks — · Issue: [#3597](https://github.com/smithersai/smithers/issues/3597)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings

## Goal

A launch-day install upgrades in place to stage M seven calendar days after the recorded MVP launch, preserving in-flight work and exposing only §14 additions.

## Scope

In:
- Release artifact and quickstart/reference additions for Incoming, issue evidence, draft approval and outside-PR review.
- Launch-to-M upgrade, backup/restore, persisted hidden histories and active TODO/approval recovery on the reference host.
- Real browser/CLI/API parity and role checks, light/dark and keyboard access, honest background state and reload recovery.
- Build against each unlanded dependency’s specified contract and land dark: keep M catalog entries and Incoming/evidence/draft/outside-review surfaces disabled until T-MNT-03/04 and their admission, confirmation, machine and runtime prerequisites are available. Refuse missing providers before drafting, execution or writes. Keep upgrade/publication disabled until T-INS-07, launch security and release evidence are available; keep doc additions unpublished until T-DOC-01/03 are available. C-MNT-05 tests these gates; no clock unlocks them.

Out:
- A new upgrade mechanism, timer-based feature unlock, Cloud, TUI, Linux hosts, triggers or any §16 feature.
- Automatic triage, replies or review; issue sweeps, auto-labels/closure, review-thread replies, stack Merge on outside PRs, a second review engine, new root helpers or changes to root privileges. Feature implementations remain with T-MNT-01..04.

## Changes

- Reuse T-INS-07 upgrade and release packaging. Qualify its port of `distribution/upgrade.sh:10–34` and `distribution/upgrade_recovery_test.go` through the production host commands in `packages/smithers/src/internal/backend/Commands.ts` (today only host status is mounted at line 32), native migration startup in `packages/backend/native/native.go:23–41`, and recovery guidance in `packages/backend/docs/upgrade-recovery.md`. Do not add another upgrader or recovery harness. Reuse the M slices’ compatible migrations/projections; reshape existing fields only when needed. No new table is required here. Extend T-DOC-01’s quickstart/reference content rather than creating a second docs source.
- Record launch UTC, target release UTC = launch UTC + seven days, actual artifact availability, release versions and check links. Keep old launch binaries gated; the M artifact enables its reviewed catalog.
- Update engineering stage/index documentation and docs; retain launch security evidence and add the M journey. Release notes state the maintainer actions required.
- Require C-MNT-01..06 and C-REL-03 evidence before publication. Do not mark shipped from a build or schedule alone.

## Tests

C-MNT-05 (folded steps and assertions):

Run against the released install on the reference host and a real scratch GitHub repository. Invoke the production `smthrs host upgrade`, `backup` and `restore` commands and their real quiesce routes; browser handlers use catalog dispatch, and CLI/direct API requests use the same production authorizer. Do not invoke service helpers as substitutes. Keep expected states, denial codes, counts, fixture bytes and seven-day arithmetic literal in test source; pre-upgrade data digests are observations, not runtime-derived behavior expectations. No assertion reads spec Markdown, catalog descriptors or implementation code to generate its expected result. Reuse the ported upgrade recovery tests and existing journey evidence helpers; the existing journey runner’s Markdown criteria cannot serve as this check’s oracle.
1. Run smthrs host upgrade to the M artifact using the owner command; exercise the C-REL-03 failure/recovery and restore cases.
2. Compare identities, rows and retained history before/after. Resume the in-flight TODO through person-approved merge.
3. Receive a new outsider issue, open Incoming, authorize triage, inspect duplicates and measured reproduction, edit and approve a draft reply. Read the exact comment on GitHub.
4. Receive a fork PR, authorize review and inspect findings/links without a stack Merge action.
5. Repeat browser interactions in light/dark, keyboard-only, through CLI/API where applicable; reload during unresolved launch and running work.
6. Verify release manifest, publication availability and date receipts against recorded launch UTC + seven days.
7. C-MNT-05 dark landing: with each declared admission, confirmation, execution, upgrade or docs provider unavailable, exercise its production door. Assert the M surface remains gated, mutating requests fail closed, and no draft, run, machine request or outbound write is created. Restore providers and run steps 1–6 on the enabled artifact.
8. Re-run T-SEC-01’s C-SEC-02 root validation tests on the M artifact, including restored machine disks; retain C-COL-04 and C-MCH-06 no-sudo/broker receipts and C-MNT-06 host-execution and credential-canary evidence. Missing root-input validation blocks enablement and publication.

Pass when:
- Upgrade and recovery preserve all listed identities, active work, pinned versions, approvals and old readable history; C-REL-03 passes for the M artifact.
- Complete §14 journey works against real GitHub; no event starts work before the maintainer action, reply bytes match approval and outside PR remains outside the stack.
- Home Incoming, Issue evidence/draft and Outside PR review are accessible in both themes. Chat stays usable, duplicate requests coalesce, reload recovers durable state, and completion follows the actual receipt.
- Publication evidence names the exact tested M artifact available on day seven. A draft or target date alone does not satisfy shipment.
- No setup jobs, dispatcher screen, issue-sweep, triggers, Cloud or other §16 surfaces return.

Fail when:
- Any data loss, false completion, missing §14 slice, unapproved write, restored cut surface or absent day-seven publication receipt.


- E2E: C-MNT-05 upgrades a populated launch install with work in flight and completes the maintainer journey against real GitHub.
- Re-run C-REL-03 on that artifact and retain the current launch C-SEC-03 receipt. C-MNT-06 is the security gate on the M artifact.

## Acceptance

- [C-MNT-05](../checks/C-MNT-05.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows, CLI/API and containers, smithers-3f Go services, security and infrastructure, smithers-38 package contracts and runtime composition. Record answers to the Ready checklist questions; existing recorded answers stand. Owners review post hoc under the parallel-build directive; an untouched boundary is recorded as such.

## Risks and notes

Who decides: smithers-8a accepts engineering evidence and any ADR; smithers-06 accepts the UI journey and copy; smithers-b8 accepts public command/API and container seams; smithers-3f accepts migration compatibility, upgrade/recovery and root-input security; smithers-38 accepts package contracts and runtime composition. The requesting maintainer approves reproduction inputs, reply bytes and outside-review admission; the approving person authorizes merge. Will records the launch date and decides release publication and any missed-date response. The launch date is not specified yet, so record relative day seven until launch occurs. No scope is added to fill the week. Check C-MNT-05 proves upgrade and product boundaries.

## Security preconditions

Repository flows, reproduction fixtures, dependency hooks and PR-head tests execute only as unprivileged users inside machines (M-29). The host never loads repository flow code. No personal login seed, repository/main-only secret or GitHub write credential enters an outsider machine. T-MCH-11 provides no-sudo/user isolation; T-SEC-01 provides privileged input validation. smithers-3f reviews their receipts on the exact M artifact. C-SEC-03 remains a launch prerequisite; C-MNT-06 gates M enablement and publication.

This ticket adds no root step. Upgrade, backup, restore, Homebrew and migrations run as the install owner, without sudo. The reused guest root steps consume the following inputs; the complete R1–R3 inventory in T-SEC-01 remains binding:

- R1 helper installation: helper bytes/digest, fixed destination/install script from trusted main in the release bundle; msb path, child environment/PATH/HOME, machine id/deadlines, pinned image/OCI metadata/blobs from install-controlled configuration and registry; base tools/interpreters/search/import paths and helper/temporary ancestors from the trusted image. Retained layers, snapshots, cache/environment and filesystem entries can be branch/member-derived. `TestGuestHelperInstallPinsInterpreterAndEnv` (C-SEC-02) validates provenance, environment and replacement resistance before root use.
- R2 account/home setup: setup argv, fixed home/cache/Go settings and helper source from main; login/UID/GID allocations from the install roster, passwd/group records, useradd/shell and account/home state from the image/install. env.json keys/values and toolchain selection, cache/home names, bytes, metadata and ancestor/leaf symlinks can be branch/member-derived; filesystem syscall responses come from the guest kernel. `TestRootSetupNeverFollowsMemberSymlinks` (C-SEC-02) validates bounded keys, fixed identities and no-follow writes, including replacement races. C-COL-04 and C-MCH-06 qualify the S2 broker and no-sudo image.
- R3 exec/file supervision, cleanup and relay: request/exec/session ids, fixed UID/GID/group binding, protected request directories, cgroup subtree and bridge/port settings from main/install; env.json, interpreter environment and account/directory state as R1/R2. Request JSON/ownership/mode, argv/env/cwd/root/user/stdin, file-operation paths/bytes/modes/limits, symlinks, descriptors, terminal size/signals, capture/results and relay/network bytes can be branch/member-derived. Cgroup entries/process population and fork/wait/signal/exit/filesystem/network observations come from the kernel, influenced by those processes. `TestRootPreflightParsesOnlyEnvelope` (C-SEC-02) validates bounded envelopes, protected paths and fixed identity before dropping groups/GID/UID; payload resolution/execution occurs only after the drop. C-COL-04 and C-MNT-06 must prove the same confinement on the released broker.

Branch-sourced data reaching root blocks enablement/publication until its named validation test passes on the artifact. Root must never install, load or execute branch-built scripts, binaries, interpreters, imports or toolchains; a matching digest does not waive this rule.

## Ready checklist

1. Dependencies: T-MNT-03/04 cover the maintainer slices and transitive admission/confirmation/runtime contracts; T-INS-07 covers upgrade/recovery, T-REL-01 reference-host qualification, T-DOC-01/03 shared docs, T-SEC-01 root validation and T-MCH-11 user isolation. Unlanded providers build against contracts and land dark under Scope and C-MNT-05 step 7.
2. Exclusions: Out names deferred surfaces, automatic contributor actions, extra upgrade/review/recovery mechanisms and root changes; Changes reuses T-INS-07 and the M slices instead of duplicating them.
3. Boundary tests: C-MNT-05 drives released host commands, real browser catalog handlers and authorized CLI/API doors against real GitHub; C-REL-03 proves upgrade/recovery and C-MNT-06 proves confinement. Expected behavior is literal in tests, never derived from specs or code.
4. Decisions: Risks and notes assigns engineering/ADR acceptance to smithers-8a, UI to smithers-06, public app/CLI/API seams to smithers-b8, migration/security/infra to smithers-3f, library contracts to smithers-38, individual admissions/approvals to the maintainer and publication/date decisions to Will.
5. Owner pre-review questions (recorded answers stand; review is post hoc): smithers-06: Do all three M surfaces preserve keyboard/theme access and honest recovery copy? smithers-b8: Do browser, CLI/API and docs use the existing catalog/confirmation and content seams? Do unavailable providers fail closed before effects? smithers-3f: Does upgrade/restore preserve identities, pins, approvals and security on retained disks? Do all root inputs retain their named validation and trusted executable provenance? smithers-38: Are runtime pins and card contracts reused without a second implementation? Are test expectations independent of runtime descriptors and spec files?
6. Security: Security preconditions names smithers-3f, machine-only unprivileged execution, no-sudo/credential restrictions, every reused root step’s inputs and sources, named validation tests and the branch-input blocker; C-SEC-03 gates launch and C-MNT-06 plus root receipts gate M enablement/publication.
