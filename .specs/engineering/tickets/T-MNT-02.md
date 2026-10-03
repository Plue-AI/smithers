# T-MNT-02 Triage issues with duplicate and reproduction evidence

Stage M · Size M · Depends on T-MNT-01, T-FLW-03, T-FLW-04, T-MCH-06, T-MCH-11, T-UI-19 · Unblocks T-MNT-03 · Issue: [#3594](https://github.com/smithersai/smithers/issues/3594)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings

## Goal

A maintainer-requested triage returns classification, cited duplicate candidates and measured reproduction evidence on the Issue card.

## Scope

In:
- Reuse repository research, Jev duplicate judgments, reproduction proposal, review and observation retention from flows/repository/jobs.ts.
- Capture a bounded candidate list from synced issues with their revisions. A duplicate judgment links evidence; it never closes or relabels an issue.
- Bug reproduction runs on the captured trusted base in an ephemeral background machine under existing capacity admission. Proposals are data until the requesting maintainer approves the exact fixture, argv and source digest.
- Issue evidence section records expected/actual behavior, command, exit status, source revision and reproduced/needs-author/not-applicable. Infrastructure failure is failed, never evidence that a report is invalid.

Out:
- Fixing code, creating TODOs automatically, automatic labels/closure, author-supplied scripts on the host, or a separate reproduction service.

## Changes

- Compose retained investigation steps using the shared Flow runtime and pinning. Adapt execute-repro to the machine executor; remove any host execution path used by this slice.
- Correct host-execution wording in jobs.ts for this action. Validate argv and fixture paths, store approval digest, and mount only captured source and fixture inside the machine.
- Use the existing budget, machine request, run and evidence stores. Release the machine at terminal state and while waiting for a person when safely idle.
- Add Issue evidence view/contract/container and monitor receipts. No GitHub write credential, personal login seed or repository secret enters a triage machine (C-MNT-02, C-MNT-06).

## Tests

C-MNT-02 (folded steps and assertions):
1. Request triage as a maintainer. Observe queued state, free capacity and let research/duplicate steps finish.
2. Inspect proposed reproduction, then reject it. Request another, change its fixture after approval, then attempt execution.
3. Approve a fresh fixture/argv/base digest and execute it inside a real microVM.
4. Run the passing control, a missing-evidence bug and the question. Inject executor/model failure and exhaust the budget.
5. Restart during execution and inspect evidence and machine release. Open the Issue card from a second laptop.

Pass when:
- Duplicate results cite the captured candidate IDs/revisions and distinguish the unrelated candidate; no labels or closures are written.
- Denied and changed proposals execute zero commands. The approved fixture runs only inside a machine on the recorded source; measured command, exit, expected/actual behavior and reproduction judgment have matching receipts.
- Missing evidence requests specific input; questions have not-applicable reproduction; infrastructure/model errors show failed and never reproduced or invalid report.
- Capacity is respected, terminal states release the slot, restart retains one attempt identity and evidence, and the card shows the same measured result.
- No personal credential seed, repository secret, main-only secret or GitHub token reaches the machine.

Fail when:
- A proposed command is reported as executed, a host process runs it, a duplicate closes an issue, or failure fabricates reproduction evidence.


- Unit: schema validation and evidence/status consistency.
- Integration: durable duplicate judgments and failed-step receipts through the real composition.
- E2E: C-MNT-02 executes a real failing reproduction in a microVM and covers denied, expired and changed proposals; C-MNT-06 covers malicious input.

## Acceptance

- [C-MNT-02](../checks/C-MNT-02.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: smithers-06 reviews UI and copy, smithers-b8 app flows and containers, smithers-3f Go services and infrastructure, smithers-38 package contracts and runtime composition. Each signs off the touched boundary before implementation; an untouched boundary is recorded as such.

## Risks and notes

Who decides: the maintainer authorizes triage and reproduction. Jev supplies duplicate and reproduction judgments with receipts; the maintainer decides disposition. Existing legacy prompts and adapters are evidence to reuse, not permission to execute on the host. Check C-MNT-02 proves actual execution.
