# T-FLW-13 Review a member's PR in a background machine

Stage S1 · Size M · Depends on T-FLW-01 · Unblocks T-REL-02 · Issue: [#3612](https://github.com/smithersai/smithers/issues/3612)
Spec: spec.md §11.1, §12.3, §15.1.5, §17.5 · Delta: delta.md §8 (row 1) · Product: mvp.md §6.3 "A teammate pushes their own branch or opens their own PR", §8, Appendix A `/review`

## Goal

Run the Active `review` flow on a member's PR in an ephemeral background machine at the PR head, return findings to the requester, and make no GitHub write.

## Scope

In:
- The refused Scope and Acceptance replacements from INT-DOCS.edits[67] and [68], reproduced verbatim below. Check: C-J10-09, S1 steps 1–5.

```markdown
## Scope
- `/review <pr>` on a member's PR (§12.3) runs the Active `review` flow in an ephemeral background machine checked out at the PR head, posts the findings card to the requester's conversation and writes nothing to GitHub. A PR whose author is not a member is refused with class `permission` (§17.5; mvp.md §8 defers outside-PR review to the maintainer release). Check: C-J10-09.

In:
```

```markdown
## Acceptance
- [C-J10-09](../checks/C-J10-09.md): `/review` on a teammate's PR.

- [C-SEC-02](../checks/C-SEC-02.md): the host never loads or executes repository flow code during a TODO run and a `/flow.run`, and a system-named repository flow is refused.
```

Out:
- The existing catalog, host isolation and reserved-name work in T-FLW-01. C-SEC-02's unchanged line in the reproduced replacement is context; T-FLW-01 retains ownership.
- S2 capacity and admission ordering in T-MCH-06, exercised by C-J10-09 step 6.
- Review of a non-member's PR, deferred by mvp.md §8 and §14.

## Changes

- The review command dispatcher checks that the PR author is a member and refuses a non-member's PR with class `permission` before requesting a machine. Check: C-J10-09 step 5.
- Resolve the Active `review` flow and run it in an ephemeral background machine at the PR head. Deliver the findings card to the requester's conversation. Check: C-J10-09 steps 1–3.
- Route an app-agent review request through the person's Confirm card before starting the run (§15.1.5). Check: C-J10-09 step 4.
- Move C-J10-09's S1 ownership from T-FLW-01 to this ticket in both indexes and the check header. T-MCH-06 retains S2 capacity ownership.

## Tests

- Run C-J10-09 S1 steps 1–5 on the reference host. Record the selected flow version, PR head, machine request, findings card and GitHub write log.
- Confirm that a member's PR uses an ephemeral background machine at its head and creates no TODO or stack item; the GitHub write log stays empty.
- Confirm that the app agent starts only after the person's Confirm and that a non-member's PR creates no machine request.

## Acceptance



- [C-J10-09](../checks/C-J10-09.md): `/review` on a teammate's PR.
- C-J10-09 steps 1–5 prove the S1 behavior. T-MCH-06 owns the S2 capacity assertions.

## Risks and notes

- The full refused replacements are preserved in Scope. Their existing C-SEC-02 acceptance line adds no isolation work to this ticket.
- A PR head can change before execution. Record the run's selected head and check that the machine uses that head; C-J10-09 step 2 detects a mismatch.
- File and link this follow-up's GitHub issue before scheduling the lane; T-FLW-01's existing issue is [#3438](https://github.com/smithersai/smithers/issues/3438).
