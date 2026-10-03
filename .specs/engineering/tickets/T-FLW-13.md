# T-FLW-13 Review a member's PR in a background machine

Stage S1 · Size M · Depends on T-FLW-01, T-FLW-03, T-FLW-04, T-ACC-02, T-APP-04 (confirmations), T-APP-16, T-CAT-01 · Unblocks T-REL-02 · Issue: [#3612](https://github.com/smithersai/smithers/issues/3612)
Spec: spec.md §11.1, §12.3, §15.1.5, §17.5 · Delta: delta.md §8 (row 1) · Product: mvp.md §6.3 "A teammate pushes their own branch or opens their own PR", §8, Appendix A `/review`

## Goal

Run the Active `review` flow on a member's PR in an ephemeral background machine at the PR head, return findings to the requester, and make no GitHub write.

## Scope

In:
- `/review <pr>` uses the Active `review` closure in an ephemeral background machine at the selected PR head, returns findings to the requester's conversation and writes nothing to GitHub. It creates no TODO, persistent branch or stack item. Check: C-J10-09 S1 steps 1–3.
- Check the PR author's active membership before requesting a machine. A non-member's PR returns class `permission`; outsider text never admits work on its own. Check: C-J10-09 step 5.
- App-agent and external-agent review requests follow the catalog's `confirm` policy and start only after the requesting person's session approves. Check: C-J10-09 step 4, C-ACC-02.

Out:
- Flow catalog/reserved names and baseline host isolation (T-FLW-01), activation (T-FLW-03) and the shared closure restore mechanism (T-FLW-04).
- S2 admission ordering/capacity (T-MCH-06); S1 uses the existing isolated runtime and typed capacity refusal.
- Non-member PR review, automatic review on GitHub events, GitHub comments/reviews/status writes, TODO creation, using a TODO's machine and new findings-card visuals.

## Changes

- The review command dispatcher checks that the PR author is a member and refuses a non-member's PR with class `permission` before requesting a machine. Check: C-J10-09 step 5.
- `apps/app/src/mainview/flows/entries/prs.ts:98-107` (`prs.triage`, `/review`) and `state/controller/issueFlows.ts:105-124` are the existing door, which launches `pr-triage` today. Wire the door to the host's authorized review dispatcher, not the browser's old working-copy launch. Pin the Active `review` digest and selected GitHub PR head on admission; fetch and restore its closure through T-FLW-03/T-FLW-04 in a fresh ephemeral machine through `packages/backend/flowhost/workspace_launcher.go:24-35`. Deliver findings using the retained `change` card schema (`packages/rpc/src/Changes.ts`) and shared conversation projection (T-APP-16). Check: C-J10-09 steps 1–3.
- Route an app-agent review request through the person's Confirm card before starting the run (§15.1.5). Check: C-J10-09 step 4.
- Move C-J10-09's S1 ownership from T-FLW-01 to this ticket in both indexes and the check header. T-MCH-06 retains S2 capacity ownership.

## Tests

- Boundary integration, `packages/backend/internal/compose/review_dispatch_integration_test.go` (new): run `/review` through the production catalog/API dispatcher on the install composition with real PostgreSQL and fake GitHub. Test person dispatch, eligible delegated confirmation, another person's approval, revoked membership, repeated idempotency keys and non-member PR refusal before any runtime allocation. Use C-J10-09's reference-host real-microVM variant for head/digest, findings and zero GitHub writes; service calls and process runtimes alone do not qualify.
- Pin literal PR/author fixtures, head SHAs, finding locations and typed refusal envelopes. Change the remote PR head after admission and activate a newer review version while the run starts: the selected head/digest must stay unchanged. No test reads spec files or derives expected membership, closure identity or findings from the implementation under test. Checks: C-J10-09, C-ACC-02.

- Run C-J10-09 S1 steps 1–5 on the reference host. Record the selected flow version, PR head, machine request, findings card and GitHub write log.
- Confirm that a member's PR uses an ephemeral background machine at its head and creates no TODO or stack item; the GitHub write log stays empty.
- Confirm that the app agent starts only after the person's Confirm and that a non-member's PR creates no machine request.

## Acceptance

- [C-J10-09](../checks/C-J10-09.md): `/review` on a teammate's PR.
- C-J10-09 steps 1–5 prove the S1 behavior. T-MCH-06 owns the S2 capacity assertions.

## Risks and notes

- T-FLW-01 owns baseline C-SEC-02 isolation. This ticket adds `/review` admission-boundary coverage with a real microVM and no host fallback.
- A PR head can change before execution. Record the run's selected head and check that the machine uses that head; C-J10-09 step 2 detects a mismatch.
- This follow-up's issue is linked in the header; T-FLW-01's frozen issue remains unchanged.

## Ready checklist
1. Dependencies: T-FLW-03 supplies Active review versions; T-FLW-04 supplies verified closure restoration; T-ACC-02 supplies membership; T-APP-04/T-APP-04 supply person confirmation and its card; T-APP-16 supplies host agent dispatch and findings delivery; T-CAT-01 supplies the external CLI door and transitively T-CAT-01; T-FLW-01 supplies machine-only dispatch. T-INS-02's launcher is inherited through T-FLW-03/T-FLW-11.
2. Exclusions: Out explicitly excludes outsiders, automatic event-triggered review, GitHub writes, TODO/persistent branch creation, TODO-machine reuse, new findings visuals, baseline isolation implementation and S2 scheduling.
3. Boundary tests: production prs.triage/review catalog/API dispatcher → confirmation → real microVM launcher → retained findings card/conversation, with literal PR/head/author oracles and zero-write evidence (C-J10-09/C-ACC-02).
4. Decisions: smithers-3f accepts membership/head/digest admission, credential scope and ephemeral cleanup; smithers-38 accepts review payload and closure restoration; smithers-b8 signs off the review command/API and retained findings handoff. smithers-8a accepts the S1/S2 qualification split; Will decides any expansion to outsider or automatic review.
5. Owner pre-review before start: smithers-3f: Are membership and confirmation checked before allocation, and is the selected head/digest fixed? Does terminal completion retire the ephemeral machine without admitting a GitHub write? smithers-38: Can the Active review closure consume the PR fixture through the existing review payload? smithers-b8: Do app/CLI requests reach the same dispatcher and retained findings card without a new visual seam?
6. Security: T-INS-02/T-FLW-01 must enforce microVM-only execution before this command lands. Repository review code, imports and checks run only in the ephemeral machine; the host handles source/context as data. No provider key or GitHub write authority is delivered to the review run; PR text is untrusted context, never autonomous admission. smithers-3f reviews; C-J10-09 and C-SEC-02 boundary coverage qualify.

