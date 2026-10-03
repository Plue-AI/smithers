# T-MNT-05 Ship the day-seven maintainer upgrade and journey

Stage M · Size S · Depends on T-MNT-03, T-MNT-04, T-INS-07, T-REL-01, T-DOC-03 · Unblocks — · Issue: [#3597](https://github.com/smithersai/smithers/issues/3597)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings

## Goal

A launch-day install upgrades in place to stage M seven calendar days after the recorded MVP launch, preserving in-flight work and exposing only §14 additions.

## Scope

In:
- Release artifact and quickstart/reference additions for Incoming, issue evidence, draft approval and outside-PR review.
- Launch-to-M upgrade, backup/restore, persisted hidden histories and active TODO/approval recovery on the reference host.
- Real browser/CLI/API parity and role checks, light/dark and keyboard access, honest background state and reload recovery.

Out:
- A new upgrade mechanism, timer-based feature unlock, Cloud, TUI, Linux hosts, triggers or any §16 feature.

## Changes

- Reuse T-INS-07 upgrade and release packaging. Extend compatible migrations/projections only where the M slices need fields.
- Record launch UTC, target release UTC = launch UTC + seven days, actual artifact availability, release versions and check links. Keep old launch binaries gated; the M artifact enables its reviewed catalog.
- Update engineering stage/index documentation and docs; retain launch security evidence and add the M journey. Release notes state the maintainer actions required.
- Require C-MNT-01..06 and C-REL-03 evidence before publication. Do not mark shipped from a build or schedule alone.

## Tests

C-MNT-05 (folded steps and assertions):
1. Run smthrs host upgrade to the M artifact using the owner command; exercise the C-REL-03 failure/recovery and restore cases.
2. Compare identities, rows and retained history before/after. Resume the in-flight TODO through person-approved merge.
3. Receive a new outsider issue, open Incoming, authorize triage, inspect duplicates and measured reproduction, edit and approve a draft reply. Read the exact comment on GitHub.
4. Receive a fork PR, authorize review and inspect findings/links without a stack Merge action.
5. Repeat browser interactions in light/dark, keyboard-only, through CLI/API where applicable; reload during unresolved launch and running work.
6. Verify release manifest, publication availability and date receipts against recorded launch UTC + seven days.

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
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows and containers, smithers-3f Go services and infrastructure, smithers-38 package contracts and runtime composition. Each signs off the touched boundary before implementation; an untouched boundary is recorded as such.

## Risks and notes

Who decides: smithers-8a accepts engineering evidence; 06 accepts the UI journey; Will decides release publication and any missed-date response. The launch date is not specified yet, so record relative day seven until launch occurs. No scope is added to fill the week. Check C-MNT-05 proves upgrade and product boundaries.
