# T-APP-12 Terminal card ownership UI

Stage S2 · Size S · Depends on T-TRM-01 · Unblocks — · Issue: to file
Spec: spec.md §2 (Terminal), §3 (`terminals`), §7.1, §7.5, §8.6.1, §8.11, §14.3 (Terminal), §14.6a, §15.1.5; overview.md E-05 · Delta: delta.md §5 (Modify [S2] owner-only input, read-only for others) · Product: mvp.md J3.3, J6.1, J6.5, §3.1, §6.8 Terminals, M-18, Appendix A `/terminal`

## Goal
A member's terminal card shows whose session it is and who watches it; the owner types, every other member on the branch watches read-only, and no watcher's keystroke leaves their browser.

## Scope
In:
- Terminal card on the terminal stream plus `branch:<id>`: the title (`terminals.title`, §3), branch chip, the owner (T-APP-09 actor, so "Ben via Smithers" when Ben's app agent opened it for him), watchers with a watching mark, the running command, and the output with ring replay after a reload (§8.11.3).
- Owner: the card takes keyboard input and the control-focus spotlight. A session the owner's own agent runs (`via` of the same person) is still the owner's to type into (mock `cards/Terminal.tsx:19-20`).
- Watcher: the card shows "Watching", never takes keyboard focus for input, and sends no input frames. The server drops any that arrive anyway (§7.5).
- The coding agent's terminal (T-TRM-05) renders with owner "Agent" and is read-only for every member (§8.11.2a): one Terminal card, whoever runs the command (mvp.md §3.1).
- Temporary home: when the terminal model's `temporary_home` is true (§14.3, T-MCH-11), the owner's header shows "temporary home until next wake" (mvp.md §6.8). Watchers don't see it.
- Transport: the card reads and writes through T-TRM-01's live-channel terminal client (binary kinds 3–5, §7.5). This ticket opens no socket of its own.
- `/terminal [branch]` opens the member's own terminal on the branch (`POST /api/terminals`). From the app agent it is A✓: the agent posts a one-click Confirm card that the prompt's author presses, and the terminal opens from that session (§15.1.5, Appendix B.2).

Out:
- Unix users, the live-channel transport, owner-only input on the server and the drop counter (T-TRM-01, T-MCH-11); terminal sign-in and the skill (T-TRM-02).
- [D] "Let others type", Ask to type, Allow and revoke (§8.11.2), all drawn in the mock.
- **Add to machine image**: an in-card control on Settings and on a failed step that names a missing tool (§8.6.1), not on the Terminal card. The mock's terminal offer (`Terminal.tsx:42-47`) isn't built.

## Changes
- `apps/app/src/mainview/cards/TerminalCard.tsx` (new) and test, replacing the terminal facet of the deleted `WorkspaceCard.tsx` (T-APP-10) and reusing `tabs/TerminalView.tsx` and `@smthrs/ui/adapters/terminal`.
- `packages/rpc/src/Cards.ts`: kind `terminal {id}`. `packages/rpc/src/Terminal.ts` (new): owner, watchers, running command, title.
- `apps/app/src/mainview/flows/entries/box.ts`: `box.terminal` and `box.sessions` become `/terminal` (Appendix B.2).
- `apps/app/e2e/playwright/citc.spec.ts`: terminal assertions move to the new card.

## Tests
- Unit (`TerminalCard.test.tsx`): owner versus watcher rendering; the watcher's key events produce no `input` call on the client; the owner's own agent session accepts input; the coding agent's terminal renders "Agent" and accepts no input from anyone.
- Unit: after a reload the card shows the ring replay before live output, with no duplicate lines.
- Unit (conformance): no Ask to type, Allow or "Let others type" control exists in the card source.
- e2e: the C-J3-02 script.

## Acceptance
- [C-J3-02](../checks/C-J3-02.md): a member's terminal runs as that member; others watch read-only, and their keystrokes are dropped.

## Risks and notes
- Risk: a watcher's card takes keyboard focus through the control-focus spotlight and swallows shortcuts meant for the composer. Falsified if, with a watched terminal focused, ⌘K still opens the palette and no key event reaches the terminal client.
- Risk: the running command shown for a terminal goes stale after the command exits. Falsified if the field clears within 1 s of the command's exit in the C-J3-02 recording.
