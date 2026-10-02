# T-APP-09 Actor rendering with `via` badges

Stage S1 · Size S · Depends on T-ACC-04, T-UI-01, T-APP-19 · Unblocks T-APP-10 · Issue: to file
Spec: spec.md §2 (actor notation), §5.3, §6.4, §9.3.2, §12.3, §14.6a, §15.1 · Delta: delta.md §2 (Add actor `via` on audit events, activity, presence, todo_events), §9 (Modify: actor rendering with `via` badges) · Product: mvp.md J6.3, §6.13 Attribution, M-21, Appendix A closing paragraph

## Goal
Every card that names who acted renders the §2 actor one way (§14.6a): "Ben", "Ben via Smithers", "Ben via Claude Code", "Maya via SSH", "Ben's terminal" or "Agent", with the person's avatar, an agent badge for an agent `via`, and the coding agent's own avatar.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the actor chip: avatar, agent badge, "via" label, "Smithers" and GitHub-login variants. Engineering wires them: actor data on every event and entry (§2, §14.6a). The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- One wire schema for the §2 actor, shared by every projection the app reads: `{person, via?, session?}`, `{agent: "coding", run, todo?}`, `{system: <unit>}` (§9.3.2) and `{github: login}` for a GitHub user that maps to no member (§12.3).
- One component pair, `ActorAvatar` and `actorName`, used by every card:
  - a person: avatar with initials in their identity colour, first name;
  - a person with `via`: the same avatar with a badge (an agent glyph for `smithers`, `claude-code`, `codex` or another agent; a terminal glyph for `ssh`), and "Ben via Claude Code";
  - the coding agent: its own avatar, "Agent", with the TODO when ambiguous, breathing only while its run is live;
  - the system: "Smithers";
  - a GitHub user with no member: `@login` with the GitHub mark.
- Display names for `via` (§14.6a): `smithers` → "Ben via Smithers", `claude-code` → "Ben via Claude Code", `codex` → "Ben via Codex", `ssh` → "Ben via SSH", `terminal` → "Ben's terminal", `cli` → "Ben via CLI"; any other agent name verbatim.
- Adopt it in the S1 cards that name actors: Home rows (owner), TODO card (owner, answerer, amendment and steer authors), Confirm ("Merges as"), Members.
- The same component renders each prompt's author in the shared branch conversations (Will, 2026-10-02; T-APP-16 places it) and on timeline lines (T-APP-07).

Out:
- Minting delegated credentials, the `Smithers-Via` header and recording `via` (T-ACC-04).
- Terminal and SSH attribution on the machine (T-TRM-02, T-COL-04); presence (T-COL-06).
- Branch and Terminal cards adopt the component in T-APP-10 and T-APP-12.

## Changes
- `packages/rpc/src/Actor.ts` (new): the actor schema and the `via` display-name table.
- `apps/app/src/mainview/cards/Actor.tsx` (new) and `Actor.test.tsx` (new).
- `apps/app/src/mainview/cards/HomeCard.tsx`, `TodoCard.tsx`, `ConfirmCard.tsx`, `MembersCard.tsx`: render actors through the component. This is a no-op if those tickets already import it.
- `apps/app/src/mainview/styles/cards.css`: port the mock's `mvp-avatar*` rules (`parts.tsx:19-52`) onto Paper tokens and the six lane colours.
- `apps/app/lint/conformance/Rules.ts` (existing): a rule that card source never builds the string " via " by hand.

## Tests
- Unit (`Actor.test.tsx`): name and badge for each actor shape and each known `via`; an unknown `via` shows verbatim; a removed member keeps their login (history stays readable, §5.6).
- Unit: a `session` credential's actor never shows a `via`, even when the request carried `Smithers-Via` (§6.4).
- Unit (conformance): a card that formats "via" itself fails the lint.
- e2e: the C-J6-01 script shows "Ben via Claude Code" on the TODO Claude Code placed and on the answer it gave.

## Acceptance
- [C-J6-01](../checks/C-J6-01.md): actions Claude Code takes from Ben's branch terminal show "Ben via Claude Code" on the cards that record them.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- The mock says "Coding agent" (`parts.tsx:16`); §14.6a renders "Agent", and the card follows the spec.
- Risk: the app's local `ActorSchema` (`state/AppState.ts:525`, `user|smithers|system`) names the Flux dispatcher's actor, not the product actor. Confusing the two is the likely bug; the new schema lives in `@smthrs/rpc` under a distinct name (`ProductActor`).
