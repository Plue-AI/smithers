# T-AGT-03 Read-only external conversations in shared chat

Stage S2 · Size M · Depends on T-AGT-02, T-APP-09, T-APP-16, T-UI-07, T-UI-01 · Unblocks — · Issue: [#3623](https://github.com/smithersai/smithers/issues/3623)
Spec: spec.md §14.2.1, §14.5.5, §14.6a · Delta: delta.md §9 · Product: mvp.md M-38, M-34
Ready: 2026-10-03 smithers-8a sha256:ee2088b0987c

## Goal

Show external agents in the branch conversation through shared chat components and their own participant avatars.

## Ownership

smithers-b8 decides app binding and decoder placement; smithers-06 decides the S2 chat presentation and avatar seam. smithers-3f decides backend refusal and security seams. smithers-38 signs off any public TypeScript library API diff under §21.1. Name these owners for pre-review before start; recorded owner answers stand and review follows the parallel-build directive post hoc.

## Scope

In:
- External entry/event decoding, shared chat data binding, read-only action filtering and reconnect snapshots.
- Land dark against the specified contracts of T-AGT-02, T-APP-09, T-APP-16, T-UI-07 and T-UI-01. Until each unavailable dependency is integrated and C-AGT-02 passes, keep external entries out of the live presentation and refuse imported mutations. Missing origin, version, session, participant or read-only metadata fails closed; never fall back to executable Smithers entries. Ordinary Smithers chat remains usable. C-AGT-02 covers unavailable-provider and incomplete-metadata cases.

Out:
- Transcript discovery, tailing, semantic adapters and backend ingestion or mutation enforcement (T-AGT-01/02); new raw-transcript endpoints.
- External-agent launch or control, imported edit/resend/answer/approve/retry/stop/steer actions, person-to-person chat, and the internal `/ceo` flow.
- New Views, card kinds, chat renderers, actor-label modules, daemon/root steps or repository-code execution on the host.

## Changes

- Reshape `apps/app/src/mainview/App.tsx`, its existing conversation binding and decoder, and `apps/app/src/mainview/EntryRow.tsx`; reuse `packages/smithers/ui/src/chat/ChatMessage.tsx` and existing tool/error presentation. Today `App.tsx:543` mounts `TranscriptMessage.tsx`, which imports ChatMessage at line 2. Follow T-APP-16's shared-shell cutover; do not restore the TranscriptMessage markup it deletes. Design builds the presentation; engineering supplies data and filtered actions. No second decoder or renderer. Prefer existing props and userland composition; any new public export names the caller and rejected reuse under §21.1.
- Add the ui-components.md S2 origin/version/session/participant contract and fixtures to the shared decoder. Public library exports meet §21.1 review.
- Render prompts as their owner and assistant/tool events as Claude Code for Ben or Codex for Ben. Preserve separate participants for simultaneous sessions.
- Omit imported-message mutation controls and test backend refusal. Copy, disclosure and navigation remain available. The ordinary branch composer continues to address Smithers; imported prompts never queue its turns.

## Tests

C-AGT-02 is folded into T-AGT-02's tests; this ticket owns the browser assertions below in the same end-to-end run.
- Through the production authenticated router, `/api/live` topic `conversation:<branch>` and the app's mounted branch conversation, run T-AGT-02's real Claude Code and Codex sessions as Ben and observe as Ben and Maya. Assert literal prompt owner names, "Claude Code for Ben" and "Codex for Ben", distinct session participants, ordered tool pending/result/error parts and visible import errors. Render both formats in light/dark at 1280 and 390 px; reload and reconnect without duplicate entries or lost correlation.
- For each imported identity, attempt edit, resend, answer, approve, retry, stop and steer through the mounted UI and the production backend mutation routes that T-AGT-02 protects. Controls are absent; crafted requests are refused with no queued turn, command execution or state change. Exercise T-APP-16's production prompt/queue/stop dispatcher with imported identities as well. Copy, disclosure and navigation work. Sending an ordinary prompt still queues exactly one Smithers turn.
- Supply unavailable dependency providers and entries missing each required metadata field at the production delivery/decoder boundary. External presentation stays dark, mutations refuse and ordinary chat stays usable. Tool text containing a command and executable-looking Markdown never dispatch a flow or run repository code. Run agents only inside branch machines as their terminal owner, without sudo.
- Use committed, sanitized real-format fixtures and literal expected labels, identities, ordering and action outcomes. Do not read spec files or production code to generate expectations. Reuse T-AGT-02's real dependencies; isolated component renders do not replace the mounted-app and router assertions.

## Acceptance

- [C-AGT-02](../checks/C-AGT-02.md): C-AGT-02 passes end to end.

## Risks and notes

- No new View, card kind or T-UI ID. T-UI-07 receives an S2 extension outside J1/J2 completion gates.
- Security: smithers-3f reviews the boundary. Imported records are untrusted data, never executable runs, credentials or commands. M-29 keeps repository code and the real-agent test processes inside machines; host decoding stays data-only. Reuse T-AGT-02's owner-uid reads, revocation and backend refusal. This ticket adds no root step and consumes no root inputs from main or a branch; daemon planting and privileged setup remain in their dependency tickets. C-AGT-02 proves malicious imported content cannot execute and imported mutations have no side effects.

## Ready checklist

1. Dependencies: the listed S1/S2 contracts cover ingestion/refusal (T-AGT-02), actors (T-APP-09), storage/topics/composer (T-APP-16) and presentation/avatars (T-UI-07/01); transitive dependencies supply authorization and machine isolation. Scope defines fail-closed dark landing for every listed unavailable contract.
2. Exclusions: Scope explicitly excludes ingestion/adapters, raw-file access, agent control, imported mutations, person chat, `/ceo`, duplicate rendering and root/host execution.
3. Tests: C-AGT-02 runs real sessions through the authenticated router, `/api/live`, mounted conversation and production mutation/queue dispatcher; committed fixtures and literal expectations are independent of spec/code at runtime.
4. Decisions: smithers-b8 decides binding/decoder placement, smithers-06 presentation, smithers-3f backend/security, and smithers-38 public-library API approval under §21.1.
5. Owner pre-review: smithers-b8: does binding use the shared decoder and preserve the ordinary composer? smithers-06: does the S2 extension reuse the cutover shell and keep avatars separate? smithers-3f: do all imported-identity mutation routes refuse without side effects, and does dark landing preserve isolation? smithers-38: can existing library props/types serve this caller, and does any public API diff meet §21.1? Recorded answers stand; review is post hoc under the parallel-build directive.
6. Security: smithers-3f reviews untrusted data-only import, machine-only agent execution and mutation refusal, proved by C-AGT-02. This ticket has no root step or root-consumed input; it does not change dependency-owned privileged setup.
