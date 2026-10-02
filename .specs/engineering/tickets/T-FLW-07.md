# T-FLW-07 Monitor: `/monitor`, cost, waits since, interrupted state, no fork filter

Stage S1 · Size M · Depends on T-COL-02, T-UI-12, T-APP-19 · Unblocks — · Issue: to file
Spec: spec.md §7.2 `run:<id>`, §11.6, §19.1 · Delta: delta.md §8 (monitor and runtime-event rows) · Product: mvp.md J11.1, §6.14 Monitor and Signals and approvals, Appendix A `/monitor`, `/run.inspect <id>`; AGENTS.md MVP scope (no fork or rewind controls)

## Goal
From any run card, Inspect opens a monitor that shows the graph with live step states, each step titled by what it did, each step's input, output and transcript, attempts and retries, every durable wait with when it began, tokens, time and cost per step, the raw event journal and the flow's custom view, with no fork or rewind control.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the monitor views: graph, step I/O, timeline, waits with since, tokens/time/cost, the collapsed Engine row, the scrubber. Engineering wires them: run event projections, Appendix C labels, `/monitor` and `run.inspect` commands. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- Stage 1. T-COL-02 builds the base `run:<id>` topic (run summary and steps) in S1. This ticket adds cost, waits, labels, the Engine row, the journal, the custom view and the interrupted state to it.
- `/monitor` lists every run, background runs included, each with its state and its Inspect door. `/run.inspect <id>` opens one run's monitor. Both are `agent: run` (Appendix B.2).
- Step labels (§11.6.2): each step's title comes from its Appendix C row's Inspect rendering (`.specs/product/actions.md`, for example "Planned the change", "Edited retry.ts"). Engine bookkeeping tags (quota parking, sealed steps, boundaries, output counts, `agent/trace/checkpoint`, `agent/send` stamps; Appendix C.23) collapse into one "Engine" row per run and never show as steps.
- Cost per step, priced by the host where model calls are metered.
- A durable-waits list: kind (question, approval, pause, sleep, signal, external job), since, and who or what settled it and when.
- The run's raw event journal, read-only (§11.6.2).
- The flow's declared custom view (the descriptor's `presentation`), shown when one exists (§11.6.2).
- The `interrupted` run state (§19.1) in the list and the trace, with Retry. The engine reports it today; T-FLW-09 (S2) adds the reconcile cases that produce it for push, GitHub write and shell steps.
- Delete the user-facing `forks` trace filter. Old journals with fork spans still decode and render.
- All monitor data arrives on the `run:<id>` topic of the live channel.
- Phases and cells (§11.6.3): group events per step instance into phases with deterministic titles (the step's Appendix C label plus its recorded outcome, "Ran checks · 2 failed") and give each cell its deterministic label ("Read retry.ts"); map agent actions to cell kinds by their B.3 / Appendix C row; per-attempt graphs; the `held` state for the trailing wait for merge. Phase summaries and cell explanations come from T-APP-07's summarizer through `run_summaries`; the monitor renders them as model summaries and shows the title or label alone while they are absent. Check: C-J11-01.
- The thrashing detector (§11.6.4): deterministic host code over run events (failing-check signature, file edits), projected to the phase tone and the `todo:<n>` indicator. C-J11-04.

Out:
- The base `run:<id>` projection and its transport (T-COL-02).
- Sending typed signals by hand, and triggers ([D] spec §0, §11.7).
- The DevTools view: unchanged (#2931 is do-not-implement; delta.md §11).
- The interrupted state's semantics and Retry (T-FLW-09).

## Changes
- `apps/app/src/mainview/flows/entries/runs.ts` → add `/monitor` (Advanced group, a superset of `runs.list:47`) and `/run.inspect` (alias of `runs.trace.view:228`); register both in the one catalog (T-CAT-01).
- Labels: `packages/smithers/gateway/src/RunTrace.ts` → map each step's tag to its Appendix C rendering through a table generated from `actions.md` (the parser T-CAT-01 adds), and fold the bookkeeping tags into one `engine` group per run. A tag with no rendering shows its id, and T-CAT-01's allowlist test fails on it.
- Cost: `packages/backend/modelproxy/meter.go:41-51` (`Caller`) → add the run step id, sent by the coding host with each model call under the run credential. The `run:<id>` projection sums `modelprice` cost (`packages/backend/modelprice/prices.go`) per step from the usage rows `finishUsage` writes (`meter.go:213`).
- `apps/app/src/mainview/cards/RunTraceSteps.tsx:21-28` → a cost column and a total in `stepFacts` (`12 steps · 3 min · 12.4k tok · $0.41`); the collapsed Engine row.
- Waits: runtime wait-opened and wait-settled events (§11.6.1) fold into the trace model (`RunTrace.ts`); `apps/app/src/mainview/cards/RunTraceSummary.tsx:31-35` gains a waits list with "since" and the settler.
- Journal and custom view: a journal tab over the run's ordered events, and the descriptor's `presentation` rendered when present.
- Interrupted: `apps/app/src/mainview/cards/RunTraceStatus.ts` and the `/monitor` rows show "Interrupted" with Retry.
- Delete `forks`: `packages/smithers/gateway/src/RunTrace.ts:2025-2026,2036,2050,2060,2078`; `packages/rpc/src/Cards.ts:1139`; `apps/app/src/mainview/flows/entries/runs.ts:177-183`; the expectations at `apps/app/src/mainview/cards/RunTraceCard.test.tsx:348` and `RunTrace.test.ts:324`; `packages/smithers/gateway/test/RunTrace.test.ts`; `packages/smithers/gateway/docs/api.md`. Keep `span.kind === "fork"` decoding (`apps/app/src/mainview/cards/TraceSteps.ts:59`). A persisted card whose filter is `forks` decodes as `all`.
- Docs: gateway `docs/` updated; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers/gateway:docs`.

## Tests
- Unit, `packages/smithers/gateway/test/RunTrace.test.ts` (extend): phase titles and cell labels are a pure function of the event sequence. A journal replayed twice gives identical strings with no model call; a check phase with 2 failures is titled "Ran checks · 2 failed". Check: C-J11-01.

- Unit, `packages/backend/internal/services/run_thrash_test.go` (new, beside `run_thrash.go`): a table over event sequences. The same test id failing 3× with no edit gives thrash; an edit to a named file between failures resets the count; 3 different test ids give none; error signatures differing only in paths or line numbers count as the same; 3 failures split across two attempts give none; a passing run clears the indicator. A property test asserts the detector is a pure function of the event sequence. (C-J11-04)
- Unit, `packages/smithers/gateway/test/RunTrace.test.ts` (extend): no `forks` in `TRACE_FILTER_IDS` or `traceFiltersFor`; a journal with a fork span still folds; waits fold with `since` and settler from fixture events.
- Unit, same file: a fixture `todo` journal titles `coding/edit-atom` "Edited the files" and `coding/check-command` "Ran checks"; `<seal-step>`, `<boundary:name>` and `agent/trace/checkpoint` appear only inside one Engine group.
- Unit, `apps/app/src/mainview/cards/RunTraceSteps.test.ts` (extend): cost column and total; a step with no model call shows no cost, not zero; the Engine row renders collapsed.
- Unit, `apps/app/src/mainview/cards/RunTraceCard.test.tsx` (extend): no fork or rewind button in the DOM; a stored card with `filter: "forks"` renders as `all`; a descriptor with `presentation` renders its view, and one without shows none.
- Integration (real PostgreSQL), `packages/backend/modelproxy/meter_step_test.go` (new): two calls in one step and one in another sum per step to the recorded usage times `modelprice`.
- e2e, `apps/app/e2e/real/run-inspection.spec.ts` (extend), for [C-J11-01](../checks/C-J11-01.md).

## Acceptance
- [C-J11-02](../checks/C-J11-02.md): a flow's custom view and a draft-version run's graph live in the monitor.

- [C-J11-01](../checks/C-J11-01.md): Inspect shows the graph with Appendix C labels and one Engine row, step I/O, transcript, retries, waits with since, and tokens, time and cost per step, with no fork filter.
- [C-J11-04](../checks/C-J11-04.md): Thrashing: the same failing check 3× in one attempt with no edit in between shows on the TODO card and the Inspect phase; an edit clears it

## Risks and notes
- Risk: model calls made by a coding agent CLI (Claude Code, Codex) through the proxy may not carry a step id. Confirmed if cost rows have an empty step. Attribute them to the innermost active step from `todos.current_step` (§4.1.2) at call time.
- Risk: removing `forks` from the `Cards.ts` enum breaks decoding of saved conversations (AGENTS.md: old sessions stay readable). Confirmed by a stored-card fixture failing to parse. The decoder maps unknown filters to `all`.
- Risk: tags built at runtime (`<cell-call:flow>`, `<quota-park>/<session>`) don't match a literal Appendix C id. Confirmed if a fixture journal shows a raw id. Match the angle-bracket rows by pattern.
