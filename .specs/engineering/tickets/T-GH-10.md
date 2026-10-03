# T-GH-10 App manifest prerequisites by stage

Stage W0, S1 · Size S · Depends on T-GH-01 · Unblocks T-REL-02 · Issue: [#3616](https://github.com/smithersai/smithers/issues/3616)
Spec: spec.md §5.1.0, §12.1, §16.2 steps 1–2 · Delta: delta.md §7 · Product: mvp.md J1.2, §6.3 "GitHub App setup", M-03

## Goal

Verify the staged prerequisite clarification after the frozen T-GH-01 lane completes. Its current header and index already agree: W0 has no prerequisite; S1 depends on T-INS-02.

## Scope

In:
- Review the completed T-GH-01 header against its index row. Preserve `W0: — · S1: T-INS-02` and its current Unblocks list. C-GH-01 supplies the existing W0 and S1 behavior checks.

Out:
- Setup-session authentication, server-derived installation ids and their security tests. Those are KEEP-EXCEPTION edits for T-GH-01, subject to override review.

## Changes

- After T-GH-01 completes, record that its current header and index both state `W0: — · S1: T-INS-02`. Do not edit the frozen ticket.
- This ticket and C-GH-01 ownership records already exist; preserve them.

## Tests

- Documentation review: compare T-GH-01's current header with its index row and record that W0 has no prerequisite and S1 depends on T-INS-02.
- Reuse the existing C-GH-01 W0 and S1 receipts. This prerequisite clarification adds no runtime test that reads `.specs/*.md`.

## Acceptance

- The documentation review receipt confirms the matching staged prerequisites in the current header and index.
- [C-GH-01](../checks/C-GH-01.md): the existing W0 and S1 manifest checks remain the behavior evidence.

## Risks and notes

- Record this verification only after T-GH-01 completes. smithers-8a accepts the documentation receipt; Will decides any product exception. The stage split does not authorize delaying the three security exceptions.
- This follow-up is filed as #3616; T-GH-01 is #3440.

## Ready checklist

1. Runtime prerequisites: T-GH-01 must complete before this metadata verification; no runtime change is introduced.
2. Exclusions: no frozen-ticket rewrite, setup authentication, installation-id validation, manifest implementation or setup UI.
3. Boundary tests: the documentation receipt verifies metadata; existing C-GH-01 production-route receipts prove runtime behavior. Runtime tests use literal fixtures, never spec-derived or code-derived expectations.
4. Decisions: smithers-8a accepts the metadata receipt; Will decides product exceptions.
5. Owner pre-review before start: smithers-3f: answered 18:2x, ok. The adopted verdict confirms all three security exceptions: state digest, constant-time comparison, 10 min TTL and atomic consume; required origin-bound setup session with HttpOnly SameSite=Lax cookie; server-derived installation id. smithers-b8 reviews the launcher prerequisite against its shipped contract. Write the verification receipt only after T-GH-01 lands.
6. Security: this ticket executes no repository code. smithers-3f verifies that the documentation receipt does not waive T-GH-01 security gates or M-29 machine isolation.
