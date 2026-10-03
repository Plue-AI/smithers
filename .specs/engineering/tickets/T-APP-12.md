# T-APP-12 Terminal card ownership UI

Stage S2 · Size S · Depends on T-TRM-01, T-UI-17, T-APP-09, T-COL-02, T-CAT-01 · Unblocks T-APP-10, T-REL-02 · Issue: [#3557](https://github.com/smithersai/smithers/issues/3557)
Spec: spec.md §2 (Terminal), §3 (`terminals`), §7.1, §7.5, §8.6.1, §8.11, §14.3 (Terminal), §14.6a, §15.1.5; overview.md E-05 · Delta: delta.md §5 (Modify [S2] owner-only input, read-only for others) · Product: mvp.md J3.3, J6.1, J6.5, §3.1, §6.8 Terminals, M-18, Appendix A `/terminal`
Ready: 2026-10-03 smithers-8a sha256:84caa534a027

## Goal
A member's terminal card shows whose session it is and who watches it; the owner types, every other member on the branch watches read-only, and no watcher's keystroke leaves their browser.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `TerminalView`, with the CSS, in T-UI-17. This ticket builds no View, CSS or editor presentation. It owns the Terminal card file, which maps the stream and metadata to `TerminalView` props, and the commands in Changes (minimal-code synthesis v1 §2). smithers-b8 decides app wiring and command behavior; smithers-06 decides View props and focus behavior; smithers-38 approves the public RPC API under §21.1; smithers-3f approves the execution and authorization seam. smithers-8a resolves spec conflicts before activation. Owner review is post hoc under the 2026-10-03 parallel-build directive; recorded owner answers stand.

## Scope
In:
- Terminal card on the terminal stream plus `branch:<id>`: the title (`terminals.title`, §3), branch chip, the owner (T-APP-09 actor, so "Smithers for Ben" when Ben's app agent opened it for him), watchers with a watching mark, the running command, and the output with ring replay after a reload (§8.11.3).
- Owner: the card takes keyboard input and the control-focus spotlight. A session the owner's own agent runs (`via` of the same person) is still the owner's to type into (mock `cards/Terminal.tsx:19-20`).
- Watcher: the card shows "Watching", never takes keyboard focus for input, and sends no input frames. The server drops any that arrive anyway (§7.5).
- The coding agent's terminal (T-TRM-05) uses T-APP-09's coding participant and is read-only for every member (§8.11.2a, §14.6a): one Terminal card, whoever runs the command (mvp.md §3.1).
- Transport: reuse T-TRM-01's `state/CloudTerminalClient.ts` for bytes on the existing terminal WebSocket (§7.5); use T-COL-02's client for metadata on `branch:<id>`. This ticket opens no socket of its own. Checks: C-J3-02, C-UI-13.
- `/terminal [branch]` opens the requesting member’s own terminal with `agent: run`; the agent never types in it. The card file follows the catalog descriptor without posting a Confirm card (§5.2.1, §15.1.5). Check: C-ACC-01.
- Lands dark until T-TRM-01: refuse terminal open, attach and input until the production provider enforces machine-only execution, owner-only input and revocation. Never fall back to host execution or the shared-user path. T-INS-02 isolation and T-MCH-11 member users/no-sudo are activation preconditions, not direct code dependencies. smithers-3f reviews this boundary. Check: C-J3-02.
- Lands dark until T-UI-17: leave the Terminal View pending in C-UI-13 and expose no replacement terminal renderer until its props contract is available; do not retain a second live terminal renderer when wiring it.
- Lands dark until T-APP-09 and T-COL-02: refuse attach/input when authenticated owner identity or branch metadata is unavailable; never infer ownership from an actor label or grant input from shared `viewer_is_owner` data. Derive it from the authenticated viewer and terminal owner, with coding sessions always false. Check: C-J3-02.
- Lands dark until T-CAT-01 and T-ACC-03: do not expose or execute `/terminal` without the catalog descriptor and production authorizer. Missing authority refuses before session creation; no local permission fallback. Check: C-ACC-01.
- Lands dark until T-TRM-05: do not synthesize coding-agent sessions from tool output; render only registered sessions once its provider is available. Check: C-J3-02.
- Root steps: none. This ticket installs no guest helper, builds no image and runs no root command. Repository shell commands execute only as the member or `agent` inside a branch machine, never on the host or as root (M-29). Checks: C-J3-02, C-ACC-01.

Out:
- Unix users, homes, credentials, guest/root helpers, image recipes, session supervision, terminal transport, owner-only input on the server and the drop counter (T-TRM-01, T-MCH-11); terminal sign-in and the skill (T-TRM-02). No host PTY, new terminal broker or transport, SSH gateway, coding-agent bash implementation (T-TRM-05), or external-agent transcript ingestion (T-AGT-01–03).
- [D] "Let others type", Ask to type, Allow and revoke (§8.11.2), all drawn in the mock.
- **Add to machine image**: an in-card control on Settings and on a failed step that names a missing tool (§8.6.1), not on the Terminal card. The mock's terminal offer (`Terminal.tsx:42-47`) isn't built.

## Changes
- `apps/app/src/mainview/cards/WorkspaceCard.tsx:87,288`: reshape its existing terminal facet into `apps/app/src/mainview/cards/TerminalCard.tsx` (new file because Terminal becomes a separate card kind; reuse the facet rather than build another terminal renderer). The facet moves here and becomes the Terminal card file, the only mount point through `CardRenderers.tsx`. No terminal card exists today; the facet is the existing code it reshapes. It maps the owner through `toActor` (the coding participant for the agent's terminal), watchers, the running command, `frozen` while a rebase freezes it (§9.4.2), and `viewer_is_owner`, which is true for the owner, also on a session the owner's own agent runs, and false for every member on the coding agent's terminal. It adapts T-TRM-01's existing terminal client to the stream prop `{onData, write?}` agreed with T-UI-17; `write` is present only when `viewer_is_owner`, so a watcher's keys produce no input frame. It renders `TerminalView` (T-UI-17), which reuses `tabs/TerminalView.tsx` and `@smthrs/ui/adapters/terminal`, and opens no socket of its own. Deletes the `terminal` facet of `WorkspaceCard.tsx` (pair: TerminalView ↔ the `WorkspaceCard` terminal facet); T-APP-10 deletes the rest of that file.
- `packages/rpc/src/TerminalCard.ts` (exists today; restore its type if the delta §11 cut removes it before S2): reshape the existing contract with T-UI-17. Keep zod only for serialized terminal metadata on `branch:<id>`; callback and stream props remain TypeScript types. Reuse the existing schema and preserve old-record decoding; add no duplicate model. smithers-38 signs off the public API under §21.1.
- `packages/rpc/src/Cards.ts`: kind `terminal {id}`. T-APP-10 moves `workspace` to `LEGACY_CARD_KINDS`.
- `apps/app/src/mainview/flows/entries/box.ts`: `box.terminal` and `box.sessions` become `/terminal` (Appendix B.2).
- `apps/app/e2e/playwright/citc.spec.ts`: move terminal assertions to the new card. Its fake Cloud upstream is wiring evidence only; C-J3-02 uses the real install in `apps/app/e2e/real/terminal-ownership.spec.ts`.

## Tests
- Unit (`TerminalCard.test.tsx`, literal metadata payloads): owner versus watcher; the owner's own agent session is the owner's; the coding agent's terminal accepts input from nobody.
- Unit, same file (fake stream): a watcher's key events produce no `input` call; after a reload the ring replay arrives before live output with no duplicate lines; the running command clears within 1 s of the command's exit.
- Unit (conformance): no Ask to type, Allow or "Let others type" action exists in the catalog or the card file.
- Unit: every `Action.label` and `disabled.reason` the card file emits passes T-CAT-01's `lintText` (engineering's copy; the View's copy is T-UI-17's).
- Unit (`CardRenderers.test.tsx`): dispatch literal `terminal {id}` cards through the production registry to `TerminalView`; unavailable View, metadata, owner and terminal-provider cases expose no input handler. Assertions use fixed payloads and literal expected actors and states, never spec files or production-derived expectations. C-UI-13 checks reachability and deletion of the terminal facet, not deletion of the whole Workspace card before T-APP-10.
- e2e (`apps/app/e2e/real/terminal-ownership.spec.ts`, C-J3-02): use the real `/terminal` dispatcher, `POST /api/terminals`, card registry and existing terminal WebSocket on a real install with machines. Open as Ben and watch as Alice; verify owner identity, no watcher input or resize frames, raw watcher-input rejection and drop count, ring replay before live output, revocation, and a registered coding-agent session that neither member can type into. Inject raw watcher bytes on the terminal WebSocket, not `/api/live`, as required by normative §7.5. Use fixed commands, output and file assertions.
- Authorization (C-ACC-01): through the production command dispatcher and `POST /api/terminals`, an app-agent credential opens only its prompter's terminal without confirmation; external-agent, run and machine credentials refuse before creating a session. Missing catalog/authorizer/provider cases create no session and send no input. No test reads `.specs/` or computes expected permissions from the implementation.
- Focus behaviour (a watched terminal never takes input focus, and ⌘K still opens the palette) is T-UI-17's.

## Acceptance
- [C-J3-02](../checks/C-J3-02.md): a member's terminal runs as that member; others watch read-only, and their keystrokes are dropped.
- [C-UI-13](../checks/C-UI-13.md): `TerminalView` is reachable from `CardRenderers`; the `terminal` facet of `WorkspaceCard.tsx` is deleted.
- [C-ACC-01](../checks/C-ACC-01.md): `/terminal` enforces trusted actor eligibility through the production dispatcher and route, including unavailable-authority refusal.

## Risks and notes
- Risk: the running command shown for a terminal goes stale after the command exits. The `TerminalCard` test falsifies it, and the C-J3-02 recording confirms it end to end.

## Ready checklist
1. Dependencies name called code/contracts: T-TRM-01 terminal client, T-UI-17 View/props, T-APP-09 actor adapter, T-COL-02 branch-topic client and T-CAT-01 catalog/lintText. Scope names fail-closed activation for each unavailable dependency and execution/authority provider; unlanded contracts do not block Ready.
2. Out excludes transport/brokers, host/root execution, image building, user/credential setup, SSH, coding bash, transcript ingestion, shared typing and the terminal image-add control.
3. C-J3-02 exercises the real dispatcher, terminal route, registry and terminal WebSocket; C-ACC-01 proves authorization; literal registry tests and C-UI-13 prove mounting and legacy removal. Expected values never come from spec files or production code at runtime.
4. smithers-b8 decides command/wiring behavior, smithers-06 View/focus props, smithers-38 the public RPC API, smithers-3f execution/authorization, and smithers-8a normative conflicts. No new ADR or table is required.
5. Owner pre-review questions, reviewed post hoc under the parallel-build directive; recorded answers stand: smithers-06: does the stream prop preserve read-only focus and frozen behavior? smithers-b8: does every terminal door use the shared dispatcher, and does the old facet disappear at activation? smithers-38: does the RPC diff keep serialized metadata separate from callbacks and preserve old decoding? smithers-3f: does the terminal provider refuse unavailable isolation/identity/authority, and does raw watcher input remain blocked on the retained socket?
6. Scope requires branch-machine-only, non-root shell execution with no host fallback and names smithers-3f as security reviewer. This ticket has no root step and consumes no root inputs; guest provisioning remains outside scope. C-J3-02 and C-ACC-01 prove execution identity, watcher rejection and credential refusal.
