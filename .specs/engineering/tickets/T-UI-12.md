# T-UI-12 Run monitor and Inspect

Stage S1 · Size M · Depends on T-UI-01 · Unblocks T-APP-17, T-FLW-07, T-REL-02 · Issue: [#3549](https://github.com/smithersai/smithers/issues/3549)
Spec: spec.md §14.2.1, §11.6, Appendix C labels · Delta: delta.md §9 · Product: mvp.md J11.1 · Props: [ui-components.md § T-UI-12](../ui-components.md)

## Goal

The existing Run card shows phases, waits and cost per attempt, and Inspect is that card maximized. No new `RunView` (minimal-code synthesis v1 §2).

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns the visuals. Engineering supplies the data in T-FLW-07.

## Scope

In:
- Reshape `apps/app/src/mainview/cards/RunTraceCard.tsx` (785 lines) and `RunTracePhaseStrip.tsx` (316) in place:
  - every attempt's graph through the existing `FlowRunGraph.tsx`, earlier attempts dimmed; steps through the existing `RunTraceSteps.tsx` with input, output, agent and time, plus tokens and cost for steps with model calls;
  - phases and cells by stable id with their deterministic title or label; a supplied phase summary or cell explanation renders marked as a model summary, and an absent one leaves the title alone with no placeholder;
  - the selected cell's detail through `onView({selected})`;
  - waits with since and, once settled, who settled them and when;
  - tokens, time and cost totals; the collapsed Engine row; the journal tab; the read-only replay scrubber through `onView({at})`; the flow's custom view slot;
  - the Inspect preflight cell first when T-APP-17 supplies it.
- Fold the run list of `cards/RunsCards.tsx` (`RunListCardBody`, the `run-list` kind) into the same Run card (pair: Run ↔ `RunTraceCard` + `RunsCards`; v1 §2).
- Props are TypeScript types. `@smthrs/rpc/MonitorCard`'s zod becomes a type in T-APP-19's rework.

Out:
- Event projection, phase boundaries and labels, thrashing detection, model summaries, journal loading and replay projection (T-FLW-07, from the existing RunTrace fold and `packages/backend/modelprice`); context selection (T-APP-17); custom presentation loading. Fork, rewind and manual signals are excluded. No new graph model.

## Changes

- Reshape `RunTraceCard.tsx` and `RunTracePhaseStrip.tsx` as above, reusing `RunTraceSteps.tsx` and `FlowRunGraph.tsx`.
- Move `RunListCardBody` and the `run-list` kind into `RunTraceCard.tsx`. `ApprovalsInboxCardBody` in the same file is not a run view; it moves with the confirmation card in T-APP-04. Delete `RunsCards.tsx` and update `cards/CardRenderers.tsx`.
- New code: none. Considered a new `RunView`; rejected because `RunTraceCard` already renders the trace, phases, journal and replay.

## Tests

The Run card tests (`RunTraceCard` cases) cover:
- two attempts with a retried step: distinct step keys, the earlier graph dimmed;
- usage and cost only on model steps; literal totals;
- a held wait with since; a settled wait with its literal actor and time;
- summaries marked as summaries when present; labels alone when absent;
- the literal `{selected}` and `{at}` patches; replay sends no `onAction` and executes no content;
- Engine collapsed by default; the supplied custom slot placed, never a repository module;
- hostile journal, output and summary text renders inert.

## Acceptance

- The tests above pass in CI at the landed SHA.
- [C-UI-13](../checks/C-UI-13.md): the Run card is reachable from `CardRenderers`; `RunsCards.tsx` is deleted.

## Risks and notes

- `RunTraceCard.tsx` is large. Reshape in place; do not split it into a View and a container.
