# T-CAT-03 Reject replaced flow tags after the TODO composition lands

Stage S1 · Size S · Depends on T-CAT-01, T-FLW-11 · Unblocks T-REL-02 · Issue: [#3505](https://github.com/smithersai/smithers/issues/3505)
Spec: spec.md §6.1.1–§6.1.4 (incl. §6.1.2a–c), §14.2, §15.1.4, §15.1.5, §15.3 · Delta: delta.md §9 (Add one catalog source; Hide/Delete every command not in Appendix A) · Product: mvp.md §2 rule 1, §6.4 "Commands", §6.13, §6.14 (Advanced group), §8 (CLI and skill), §11 stage 1 item 8, M-21, Appendix A, Appendix B (B.1, B.2, B.4, B.6), Appendix C (`actions.md`)

## Goal

Reject Appendix C tags marked Replaced once T-FLW-11 lands.

## Scope

In:
  - Flow tags: every `Flow.make`, `Action.make` and `AgentAction.make` tag registered in shipped flows and std tools has an Appendix C row (`.specs/product/actions.md`, 386 rows), and none is marked Cut or, from T-FLW-11's change on, Replaced. Defer and Internal ops rows pass. A ticket that adds a tag adds its row in the same change.

Out:
- The landed scope of T-CAT-01, command descriptors, CLI and skill generation, composition implementation (T-FLW-11), and public library API changes.

## Changes

- Extend `packages/rpc/src/catalog/AppendixC.test.ts` with the conditional Replaced rejection from the scope.

## Tests

- Unit: C-CAT-01 step 8 builds the production host-flow and coding-host registries, rejects `coding/Request`, `coding/Vibe`, `coding/Verify` and `review/change`, and retains Cut-tag rejection. Reviewed literal Appendix C fixtures supply expected tags, statuses and runtimes; tests never read spec/product Markdown or derive expected policy from runtime code. Register each forbidden tag in a negative fixture and assert rejection at registry construction; the shipped registries pass. Do not start a repository flow to inspect its tags.

## Acceptance

- [C-CAT-01](../checks/C-CAT-01.md): step 8 rejects Replaced tags once T-FLW-11 lands.

## Risks and notes

- Gate Replaced rejection on T-FLW-11; do not reject the composition it replaces before that change lands. Enable the assertion in the same landing as T-FLW-11 or after it; no runtime spec parser, feature flag or source-code probe chooses the policy. smithers-8a accepts the cutover; smithers-38 signs off any TypeScript public-API diff.

## Ready checklist

1. Dependencies: T-CAT-01 supplies the registry check; T-FLW-11 removes the Replaced entry points before rejection lands (S1; no reverse dependency in the index).
2. Exclusions: catalog generation, CLI/skill work, composition implementation and public API changes are out of scope.
3. Boundary: C-CAT-01 checks both production registries against reviewed literal fixtures, including forbidden-tag refusal; no runtime Markdown expectations.
4. Decisions: smithers-8a accepts cutover timing; smithers-38 approves any public TypeScript API diff under §21.1.
5. Owner pre-review before start: smithers-38 asks: Does the literal fixture cover both shipped registries? Does rejection require a public API change? smithers-b8 asks: Does the host registry inspection avoid loading repository-provided modules?
6. Security: registry inspection loads only shipped modules and inert fixture declarations; repository code runs only in machines under M-29. smithers-b8 reviews the host inspection boundary; smithers-3f reviews any machine-execution seam before start. C-CAT-01 must not execute repository flows on the host.

