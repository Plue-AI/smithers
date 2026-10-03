# T-UI-17 Terminal view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-12 · Issue: [#3581](https://github.com/smithersai/smithers/issues/3581)
Spec: spec.md §14.2.1, §14.3 (Terminal) · Delta: delta.md §9 · Product: mvp.md J3.3, J6 · Props: written by this ticket when S2 starts
Ready: 2026-10-03 smithers-8a sha256:f2727ab48c0e

## Goal

`TerminalView` exists as a props-only View matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns visual and copy decisions and approves the story screenshots. smithers-b8 approves the app/stream seam; smithers-38 approves changes to packages/rpc or shared TypeScript primitives. smithers-8a decides additions to §14.3 before implementation. T-APP-12 owns production wiring. Owner review questions are recorded below; the parallel-build directive permits post hoc owner review.

## Scope

In:
- `TerminalView`: owner, agents working in it with their own avatars and "for Ben" (M-34), watchers, running command, the frozen "Rebasing…" state, and the Watching state for non-owners.
- Props: reshape the existing `packages/rpc/src/TerminalCard.ts` into a TypeScript metadata type, restoring it only if the S1 cut removed it. Keep React and stream callbacks in app-local props; reuse the adapter's stream type. T-APP-12 owns zod validation at the live socket boundary. Add the matching ui-components.md section for S2.
- Stories for every state the props allow, light and dark, desktop and 390 px.
- Dark landing: if T-UI-01 is unavailable, keep the change unmounted in production and use literal story props. Do not substitute actor or tone implementations. Coordinate the production View cutover with T-APP-12: it mounts through `CardRenderers.tsx` and deletes the replaced terminal facet in the same commit. Before that cutover, this ticket enables no terminal command, connection or input path. Checks: C-UI-12; T-APP-12 owns C-UI-13 and C-J3-02.

Out:
- Topic subscriptions, sockets, PTY creation, replay, command execution, Unix users, credentials and server authorization (T-TRM-01, T-TRM-02, T-TRM-07, T-MCH-11, T-APP-12).
- Ask to type, Allow, revoke, Let others type, Add to machine image, SSH controls and external-agent transcript ingestion. No new terminal emulator or transport.
- Action labels and permission decisions supplied by engineering; product copy rules remain §14.6b. No public library API addition.

## Changes

- Watched terminals never take input focus; ⌘K opens the palette. No Ask to type or Add to machine image.
- Reshape `apps/app/src/mainview/tabs/TerminalView.tsx:19` into the props-only terminal surface at `apps/app/src/mainview/cards/views/TerminalView.tsx`; reuse `packages/smithers/ui/src/adapters/terminal.tsx:88` for emulator, stream, resize, Paper themes and read-only rendering. T-APP-12 moves controller access into its card file and removes the old renderer at cutover. No second emulator or controller-backed View.
- Reuse T-UI-01 actor primitives and `apps/app/src/mainview/styles/cards.css`. The new card header composes the existing terminal surface because that surface lacks owner, agents, watchers, command and frozen metadata. Every action handler follows ui-components.md Rules; terminal byte and resize callbacks are supplied by the card file and carry no authority decision. Watcher or frozen props suppress input callbacks and input focus. Checks: C-UI-12, with production cutover covered by T-APP-12.

## Tests

- Unit (`apps/app/src/mainview/cards/views/Views.test.tsx`): render the production TerminalView and adapter with literal owner, watcher, coding-agent, delegated-agent and frozen props. Assert literal actor labels, "Watching" and "Rebasing…"; owner input reaches the supplied callback, watcher/frozen input does not, and watcher/frozen mounts never focus the input. No permission decision or transport is implemented in the test harness.
- Playwright (`apps/app/e2e/playwright/view-stories.spec.ts`, `/view-stories.html?story=TerminalView/<state>`): exercise that same View and the real adapter in light/dark at 1,440 and 390 px. Assert no overflow, no serious/critical axe-core violation, keyboard access and the literal excluded controls' absence. Literal cases and expected labels are authored in tests; no expectation is generated from production code, schemas or `.specs/`.
- Production focus regression: extend `apps/app/e2e/playwright/citc.spec.ts` at T-APP-12 cutover, opening the terminal through the app command dispatcher and rendering through `CardRenderers.tsx`. As owner, watcher and during rebase, press keys and ⌘K; assert only the unfrozen owner emits input, watchers never acquire input focus, and the app palette opens. Stories cannot prove the shell shortcut. T-APP-12 owns the real-machine C-J3-02 execution receipt.
- Copy: apply T-CAT-01's literal term-list lint to rendered labels when available; until then use explicit literal copy assertions above. No test reads `.specs/`.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks requires smithers-8a approval before implementation. smithers-06 decides the visual treatment within the approved model.
- Security: this ticket renders terminal bytes and supplied metadata; it runs no repository command, creates no process or socket, and adds no root step. Root input inventory: none. Repository execution stays inside machines under T-APP-12/T-TRM-01, with no member or agent sudo (M-29). smithers-b8 reviews the UI input seam; smithers-3f reviews any proposed change to execution or root handling before it enters scope. C-UI-12 proves input suppression; C-J3-02 remains the backend authorization check owned by the wiring ticket.

## Ready checklist

1. Dependencies: T-UI-01 supplies actor/tone primitives; no runtime execution provider is needed for this props-only slice. Scope keeps it dark if that dependency is unavailable; T-APP-12 owns the production cutover and execution prerequisites.
2. Exclusions: Scope names transport, execution, authorization, credentials, SSH, shared-input controls, image changes and transcript ingestion.
3. Tests: C-UI-12 cases render the production View/adapter with literal expectations; Playwright covers its browser boundary. The production dispatcher/CardRenderers focus regression lands with T-APP-12, which owns C-J3-02 and C-UI-13. No runtime-generated expectations or spec readers.
4. Decisions: smithers-06 approves visuals/copy; smithers-b8 approves the app/stream seam; smithers-38 approves private rpc/shared-library changes; smithers-8a approves model additions. No public API addition.
5. Owner pre-review questions (post hoc under the parallel-build directive): smithers-06: do all owner/watcher/agent/frozen states match the approved model and Paper layout at both widths? smithers-b8: does the reshaped View remain props-only, and does the production focus test use the dispatcher/CardRenderers boundary? smithers-38: does the private metadata type reuse existing actors and keep callbacks out of serialized rpc data without adding a public API?
6. Security: no repository execution, root step or root inputs; smithers-b8 reviews input suppression. Any execution/root scope change requires smithers-3f review and explicit machine/root-input preconditions before work; backend ownership enforcement stays in T-APP-12/T-TRM-01.
