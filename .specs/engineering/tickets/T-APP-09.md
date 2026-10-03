# T-APP-09 Actor adapter: participants and "for Ben" (§14.6a, M-34)

Stage S1 · Size S · Depends on T-ACC-04, T-UI-01, T-APP-19 · Unblocks T-AGT-03, T-APP-10, T-REL-02 · Issue: [#3503](https://github.com/smithersai/smithers/issues/3503)
Spec: spec.md §2 (actor notation), §5.3, §6.4, §9.3.2, §12.3, §14.6a, §14.6a.1, §15.1 · Delta: delta.md §2 (Add actor `via` on audit events, activity, presence, todo_events), §9 (Modify: actor rendering with `via` badges) · Product: mvp.md J6.3, §6.13 Attribution, M-21, M-34, Appendix A closing paragraph

## Goal
Every card, toast and line that names who acted renders the §14.6a participant one way: a person ("Ben"); an agent with its own avatar and "for Ben" when it acts for a person ("Smithers for Ben", "Claude Code for Ben", "Coding agent for Ben", "Reviewer for Ben"); a person's channel ("Maya via SSH", "Ben's terminal", "Ben via CLI"); the system ("Smithers"); a GitHub user ("@login"); and an outside write ("changed outside Smithers").

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `ActorChip`, with the CSS, in T-UI-01. This ticket builds no View, CSS or editor presentation. It owns the wire actor schema, the participant adapter and the one name function ([card-kinds.md §1](../card-kinds.md)). The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope

- M-34 participants have id, agent kind, avatar, run/session and optional `for_member`. Smithers, Coding agent, Claude Code, Codex and Reviewer each have their own avatar and show for Ben. The broker registers agent process lifetime; ordinary terminal commands remain person-channel activity. Adapt historical `via` actors. Participant ids grant no authorization rights. Checks: C-J3-04, C-J3-10.

In:
- One wire schema, `ProductActor`, for §2's actor notation as stored: `{person, via?, session?}`, `{agent: "coding", run, todo?}`, `{system: <unit>}` with an optional requester, `{github: login}` for a GitHub user that maps to no member (§12.3), and `{outside: true}` (§9.3.1).
- The adapter `toActor(wire, roster, runs)` returns the §14.6a.1 participant, the view model's `Actor` (ui-components.md shared types). A `via` of `smithers` becomes Smithers acting for the person (`kind: system`, `for`). A `via` of `claude-code`, `codex` or any other agent name becomes an agent participant with its own stable id, `for` set to the person (spec `for_member`). A `via` of `ssh`, `terminal` or `cli` stays a person channel. The coding agent becomes the coding participant with its run id and `for` set to the TODO's owner; a reviewer run becomes the reviewer participant. A system write keeps the system actor, with `for` when it has a requester, and never becomes an agent. The adapter sets `color_index`: the member's stable index 0 to 5, the same index for an agent or Smithers acting for that member, 6 for an agent acting for nobody, 7 for GitHub users and outside writes. Authorization doesn't change (§14.6a.1).
- `actorName(actor)`: the §14.6a text, the one source of actor names for Views, toasts, browser notifications and CLI output.
- Adopt it in the S1 adapters that name actors: Home rows (owner), TODO (owner, answerer, amendment and steer authors), Confirm (`asked_by`), Members, entry authors (T-APP-16) and timeline lines (T-APP-07).

Out:
- Minting delegated credentials, the `Smithers-Via` header and recording `via` (T-ACC-04).
- Participant presence (T-COL-06), activity (T-COL-04), agent terminals (T-TRM-05) and line-flag data (T-APP-14), which call `toActor`.
- Branch and Terminal cards adopt it in T-APP-10 and T-APP-12.

## Changes
- `packages/rpc/src/ProductActor.ts` (new): the wire schema, `toActor` and `actorName`, exported as `@smthrs/rpc/ProductActor`.
- The S1 adapters in Scope call `toActor`; this is a no-op where those tickets already do.
- `apps/app/lint/conformance/Rules.ts` (existing): card, adapter and toast source never builds " via " or ", for " by hand; every actor string comes from `actorName`.

## Tests
- Unit (`ProductActor.test.ts`): `toActor` and `actorName` for each wire shape and each known `via`: "Smithers for Ben", "Claude Code for Ben", "Codex for Ben", "Ben via SSH", "Ben's terminal", "Ben via CLI", "Coding agent for Ben", "Reviewer for Ben", "Smithers", "Smithers for Ben" for a system write with a requester, "@login" and "changed outside Smithers". An unknown agent `via` becomes an agent participant named verbatim. A removed member keeps their login (§5.6).
- Unit, same file: a `session` credential's actor never becomes an agent participant, even when the request carried `Smithers-Via` (§6.4); a system write never becomes an agent participant.
- Unit, same file: one agent acting for two people yields one participant id per session with each person's `for` and `color_index`; an agent acting for nobody gets index 6.
- Unit (conformance): a card, adapter or toast that formats " via " or ", for " itself fails the lint.
- e2e: the C-J6-01 script shows the Claude Code participant "for Ben" on the TODO Claude Code placed and on the answer it gave.
- The chip's avatar, badge and lane colours are T-UI-01's.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J6-01](../checks/C-J6-01.md): actions Claude Code takes from Ben's branch terminal show "Claude Code for Ben" on the cards that record them.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- M-34 replaces the "Ben via Smithers" badge with the agent's own avatar and "for Ben"; `via` stays on the wire, and only the rendering changes.
- Risk: the app's local `ActorSchema` (`state/AppState.ts:525`, `user|smithers|system`) names the Flux dispatcher's actor, not the product actor. Confusing the two is the likely bug; the new schema lives in `@smthrs/rpc` under a distinct name (`ProductActor`).
