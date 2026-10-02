# C-MNT-02 Duplicate and reproduction evidence is measured in a machine

Proves: mvp.md §14, M-05, M-26, M-29 · spec.md §6.1.2b, §10.2.1, §12.4, §16.4, §17.3, §17.5 · Layer: e2e · Stage: M · Tickets: T-MNT-02
Automation: apps/app/e2e/real/maintainer-triage.spec.ts (new) · Runs in: reference Apple Silicon host, real install and microVMs, second-laptop browser, scratch GitHub repository

## Setup

A trusted base containing a known bug and passing control; two possible duplicate issues with citations, one unrelated issue and one question. Real machine capacity full before admission; separate machine users hold canary personal credentials.

## Steps

1. Request triage as a maintainer. Observe queued state, free capacity and let research/duplicate steps finish.
2. Inspect proposed reproduction, then reject it. Request another, change its fixture after approval, then attempt execution.
3. Approve a fresh fixture/argv/base digest and execute it inside a real microVM.
4. Run the passing control, a missing-evidence bug and the question. Inject executor/model failure and exhaust the budget.
5. Restart during execution and inspect evidence and machine release. Open the Issue card from a second laptop.

## Pass when

- Duplicate results cite the captured candidate IDs/revisions and distinguish the unrelated candidate; no labels or closures are written.
- Denied and changed proposals execute zero commands. The approved fixture runs only inside a machine on the recorded source; measured command, exit, expected/actual behavior and reproduction judgment have matching receipts.
- Missing evidence requests specific input; questions have not-applicable reproduction; infrastructure/model errors show failed and never reproduced or invalid report.
- Capacity is respected, terminal states release the slot, restart retains one attempt identity and evidence, and the card shows the same measured result.
- No personal credential seed, repository secret, main-only secret or GitHub token reaches the machine.

## Fail when

- A proposed command is reported as executed, a host process runs it, a duplicate closes an issue, or failure fabricates reproduction evidence.

## Evidence

`.artifacts/checks/C-MNT-02/<UTC>/`: exact commit and install versions, detected host profile when machines run, per-step requests and receipts, database counter deltas, recorded inputs and output digests, logs and browser recordings where applicable. Redact credentials; retain denial and recovery receipts. An unexecuted check is pending.
