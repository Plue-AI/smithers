# T-AGT-03 Read-only external conversations in shared chat

Stage S2 · Size M · Depends on T-AGT-02, T-APP-09, T-APP-16, T-UI-07, T-UI-01 · Unblocks T-REL-02 · Issue: [#3623](https://github.com/smithersai/smithers/issues/3623)
Spec: spec.md §14.2.1, §14.5.5, §14.6a · Delta: delta.md §9 · Product: mvp.md M-38, M-34

## Goal

Show external agents in the branch conversation through shared chat components and their own participant avatars.

## Ownership

smithers-b8 owns wiring; smithers-06 owns the S2 chat extension in T-UI-07 and avatars in T-UI-01.

## Scope

In:
- External entry/event decoding, shared chat data binding, read-only action filtering and reconnect snapshots.

Out:
- Product surfaces beyond M-38.

## Changes

- Reuse TranscriptMessage/ChatMessage and existing tool/error presentation. Design builds the presentation; engineering supplies data and filtered actions.
- Add the ui-components.md S2 origin/version/session/participant contract and fixtures to the shared decoder. Public library exports meet §21.1 review.
- Render prompts as their owner and assistant/tool events as Claude Code for Ben or Codex for Ben. Preserve separate participants for simultaneous sessions.
- Omit imported-message mutation controls and test backend refusal. Copy, disclosure and navigation remain available. The ordinary branch composer continues to address Smithers; imported prompts never queue its turns.

## Tests

- C-AGT-02 proves real topic to shared chat, reload/reconnect, avatars and controls. Render both format fixtures, tool pending/result/error and import errors in light/dark at 1280 and 390 px.

## Acceptance

- [C-AGT-02](../checks/C-AGT-02.md): C-AGT-02 passes end to end.

## Risks and notes

- No new View, card kind or T-UI ID. T-UI-07 receives an S2 extension outside J1/J2 completion gates.
