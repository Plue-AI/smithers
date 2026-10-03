# T-APP-12 Terminal card ownership UI

Stage S2 · Size S · Depends on T-TRM-01, T-UI-17 · Unblocks T-APP-10, T-REL-02 · Issue: [#3557](https://github.com/smithersai/smithers/issues/3557)
Spec: spec.md §2 (Terminal), §3 (`terminals`), §7.1, §7.5, §8.6.1, §8.11, §14.3 (Terminal), §14.6a, §15.1.5; overview.md E-05 · Delta: delta.md §5 (Modify [S2] owner-only input, read-only for others) · Product: mvp.md J3.3, J6.1, J6.5, §3.1, §6.8 Terminals, M-18, Appendix A `/terminal`

## Goal
A member's terminal card shows whose session it is and who watches it; the owner types, every other member on the branch watches read-only, and no watcher's keystroke leaves their browser.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `TerminalView`, with the CSS, in T-UI-17. This ticket builds no View, CSS or editor presentation. It owns the Terminal card file, which maps the stream and metadata to `TerminalView` props, and the commands in Changes (minimal-code synthesis v1 §2).

## Scope
In:
- Terminal card on the terminal stream plus `branch:<id>`: the title (`terminals.title`, §3), branch chip, the owner (T-APP-09 actor, so "Smithers for Ben" when Ben's app agent opened it for him), watchers with a watching mark, the running command, and the output with ring replay after a reload (§8.11.3).
- Owner: the card takes keyboard input and the control-focus spotlight. A session the owner's own agent runs (`via` of the same person) is still the owner's to type into (mock `cards/Terminal.tsx:19-20`).
- Watcher: the card shows "Watching", never takes keyboard focus for input, and sends no input frames. The server drops any that arrive anyway (§7.5).
- The coding agent's terminal (T-TRM-05) renders with owner "Agent" and is read-only for every member (§8.11.2a): one Terminal card, whoever runs the command (mvp.md §3.1).
- Transport: the card reads and writes through T-TRM-01's live-channel terminal client (binary kinds 3–5, §7.5). This ticket opens no socket of its own.
- `/terminal [branch]` opens the requesting member’s own terminal with `agent: run`; the agent never types in it. The card file follows the catalog descriptor without posting a Confirm card (§5.2.1, §15.1.5). Check: C-ACC-01.

Out:
- Unix users, the live-channel transport, owner-only input on the server and the drop counter (T-TRM-01, T-MCH-11); terminal sign-in and the skill (T-TRM-02).
- [D] "Let others type", Ask to type, Allow and revoke (§8.11.2), all drawn in the mock.
- **Add to machine image**: an in-card control on Settings and on a failed step that names a missing tool (§8.6.1), not on the Terminal card. The mock's terminal offer (`Terminal.tsx:42-47`) isn't built.

## Changes
- `apps/app/src/mainview/cards/TerminalCard.tsx`: the terminal facet of `cards/WorkspaceCard.tsx` (`:87`, `:288`) moves here and becomes the Terminal card file, the only mount point through `CardRenderers.tsx`. No terminal card exists today; the facet is the existing code it reshapes. It maps the owner through `toActor` (the coding participant for the agent's terminal), watchers, the running command, `frozen` while a rebase freezes it (§9.4.2), and `viewer_is_owner`, which is true for the owner, also on a session the owner's own agent runs, and false for every member on the coding agent's terminal. It passes the stream prop `{onData, write?}` from T-TRM-01's live-channel terminal client; `write` is present only when `viewer_is_owner`, so a watcher's keys produce no input frame. It renders `TerminalView` (T-UI-17), which reuses `tabs/TerminalView.tsx` and `@smthrs/ui/adapters/terminal`, and opens no socket of its own. Deletes the `terminal` facet of `WorkspaceCard.tsx` (pair: TerminalView ↔ the `WorkspaceCard` terminal facet); T-APP-10 deletes the rest of that file.
- `packages/rpc/src/TerminalCard.ts` (T-UI-17 adds back the props type): zod only for the terminal metadata on `branch:<id>` (title, owner, watchers, running command), which crosses the live socket.
- `packages/rpc/src/Cards.ts`: kind `terminal {id}`. T-APP-10 moves `workspace` to `LEGACY_CARD_KINDS`.
- `apps/app/src/mainview/flows/entries/box.ts`: `box.terminal` and `box.sessions` become `/terminal` (Appendix B.2).
- `apps/app/e2e/playwright/citc.spec.ts`: terminal assertions move to the new card.

## Tests
- Unit (`TerminalCard.test.tsx`, literal metadata payloads): owner versus watcher; the owner's own agent session is the owner's; the coding agent's terminal accepts input from nobody.
- Unit, same file (fake stream): a watcher's key events produce no `input` call; after a reload the ring replay arrives before live output with no duplicate lines; the running command clears within 1 s of the command's exit.
- Unit (conformance): no Ask to type, Allow or "Let others type" action exists in the catalog or the card file.
- Unit: every `Action.label` and `disabled.reason` the card file emits passes T-CAT-01's `lintText` (engineering's copy; the View's copy is T-UI-17's).
- e2e: the C-J3-02 script through `TerminalView`.
- Focus behaviour (a watched terminal never takes input focus, and ⌘K still opens the palette) is T-UI-17's.

## Acceptance
- [C-J3-02](../checks/C-J3-02.md): a member's terminal runs as that member; others watch read-only, and their keystrokes are dropped.
- [C-UI-13](../checks/C-UI-13.md): `TerminalView` is reachable from `CardRenderers`; the `terminal` facet of `WorkspaceCard.tsx` is deleted.

## Risks and notes
- Risk: the running command shown for a terminal goes stale after the command exits. The `TerminalCard` test falsifies it, and the C-J3-02 recording confirms it end to end.
