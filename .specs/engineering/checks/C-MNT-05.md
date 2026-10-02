# C-MNT-05 Launch install upgrades to the complete day-seven journey

Proves: mvp.md §14, M-05, M-26, M-29 · spec.md §6.1.2b, §10.2.1, §12.4, §16.4, §17.3, §17.5 · Layer: e2e · Stage: M · Tickets: T-MNT-05
Automation: apps/app/e2e/real/maintainer-upgrade.spec.ts (new) · Runs in: reference Apple Silicon host, real install and microVMs, second-laptop browser, scratch GitHub repository

## Setup

Populated launch release on the reference host, second laptop, real scratch GitHub repository and outsider fork. Keep a working TODO, queued machine request, pending approval, wiki revision, flow version and retained hidden issue/review history. Record launch UTC and M artifact target UTC.

## Steps

1. Run smthrs host upgrade to the M artifact using the owner command; exercise the C-REL-03 failure/recovery and restore cases.
2. Compare identities, rows and retained history before/after. Resume the in-flight TODO through person-approved merge.
3. Receive a new outsider issue, open Incoming, authorize triage, inspect duplicates and measured reproduction, edit and approve a draft reply. Read the exact comment on GitHub.
4. Receive a fork PR, authorize review and inspect findings/links without a stack Merge action.
5. Repeat browser interactions in light/dark, keyboard-only, through CLI/API where applicable; reload during unresolved launch and running work.
6. Verify release manifest, publication availability and date receipts against recorded launch UTC + seven days.

## Pass when

- Upgrade and recovery preserve all listed identities, active work, pinned versions, approvals and old readable history; C-REL-03 passes for the M artifact.
- Complete §14 journey works against real GitHub; no event starts work before the maintainer action, reply bytes match approval and outside PR remains outside the stack.
- Home Incoming, Issue evidence/draft and Outside PR review are accessible in both themes. Chat stays usable, duplicate requests coalesce, reload recovers durable state, and completion follows the actual receipt.
- Publication evidence names the exact tested M artifact available on day seven. A draft or target date alone does not satisfy shipment.
- No setup jobs, dispatcher screen, issue-sweep, triggers, Cloud or other §16 surfaces return.

## Fail when

- Any data loss, false completion, missing §14 slice, unapproved write, restored cut surface or absent day-seven publication receipt.

## Evidence

`.artifacts/checks/C-MNT-05/<UTC>/`: exact commit and install versions, detected host profile when machines run, per-step requests and receipts, database counter deltas, recorded inputs and output digests, logs and browser recordings where applicable. Redact credentials; retain denial and recovery receipts. An unexecuted check is pending.
