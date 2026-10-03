# T-GH-10 App manifest prerequisites by stage

Stage W0, S1 · Size S · Depends on T-GH-01 · Unblocks T-REL-02 · Issue: [#3616](https://github.com/smithersai/smithers/issues/3616)
Spec: spec.md §5.1.0, §12.1, §16.2 steps 1–2 · Delta: delta.md §7 · Product: mvp.md J1.2, §6.3 "GitHub App setup", M-03

## Goal

Apply the staged prerequisite clarification after the frozen T-GH-01 lane completes. Its W0 spike has no prerequisite; its S1 implementation depends on T-INS-02.

## Scope

In:
- The exact proposed header replacement from INT-DOCS.edits[43], reproduced below. Review the ticket against its index row; C-GH-01 supplies the existing W0 and S1 behavior checks.

```text
Stage W0, S1 · Size M · Depends on W0: — · S1: T-INS-02 · Unblocks T-INS-06, T-GH-02 · Issue: [#3440](https://github.com/smithersai/smithers/issues/3440)
Spec: spec.md §3 (`github_app`), §5.1.0, §5.1.1, §6.3 (`/api/install`), §12.1, §16.2 steps 1–2, §16.3.3, §17.4 · Delta: delta.md §1 (App credentials are not launcher settings), §7 · Product: mvp.md J1.2, §6.3 "GitHub App setup", M-03, §11 item 7
```

Out:
- Setup-session authentication, server-derived installation ids and their security tests. Those are KEEP-EXCEPTION edits for T-GH-01, subject to override review.

## Changes

- After T-GH-01 completes, apply the header replacement reproduced in Scope to that ticket. Its index row already states `W0: — · S1: T-INS-02`.
- Add this ticket to the ticket index and C-GH-01 ownership records.

## Tests

- Documentation review: compare T-GH-01's revised header with its index row and record that W0 has no prerequisite and S1 depends on T-INS-02.
- Reuse the existing C-GH-01 W0 and S1 receipts. This prerequisite clarification adds no runtime test that reads `.specs/*.md`.

## Acceptance

- The documentation review receipt confirms the exact replacement in Scope and matching prerequisites in the index.
- [C-GH-01](../checks/C-GH-01.md): the existing W0 and S1 manifest checks remain the behavior evidence.

## Risks and notes

- Apply this metadata change only after T-GH-01 completes. The stage split does not authorize delaying the three security exceptions.
- File and link this follow-up's GitHub issue before scheduling the lane; T-GH-01's existing issue is [#3440](https://github.com/smithersai/smithers/issues/3440).
