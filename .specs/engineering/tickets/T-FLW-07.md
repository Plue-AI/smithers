# T-FLW-07 Monitor: `/monitor`, cost, waits since, interrupted state, no fork filter

Stage S1 · Size M · Depends on T-COL-02, T-APP-22, T-CAT-01 · Unblocks T-APP-02, T-APP-07, T-APP-17, T-REL-02 · Issue: [#3514](https://github.com/smithersai/smithers/issues/3514)
Spec: spec.md §7.2 `run:<id>`, §11.6, §19.1 · Delta: delta.md §8 (monitor and runtime-event rows) · Product: mvp.md J11.1, §6.14 Monitor and Signals and approvals, Appendix A `/monitor`, `/run.inspect <id>`; AGENTS.md MVP scope (no fork or rewind controls)

## Goal
From any run card, Inspect opens a monitor that shows the graph with live step states, each step titled by what it did, each step's input, output and transcript, attempts and retries, every durable wait with when it began, tokens, time and cost per step, the raw event journal and the flow's custom view, with no fork or rewind control.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the monitor views: graph, step I/O, timeline, waits with since, tokens/time/cost, the collapsed Engine row, the scrubber. Engineering wires them: run event projections, Appendix C labels, `/monitor` and `run.inspect` commands. The seam is the card's view-model schema (spec §14.2.1, the consuming card ticket). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope

- The `run:<id>` projection follows T-FLW-07: `attempts[].steps[]` keyed per step instance, usage only for model calls, stable `phases[].cells[]` ids, and waits with `settled {by, at}`. Load journal on tab open; `replay {at, last}` projects a sequence with reads only. Render `presentation` in `custom`. Check: C-J11-04.

In:
- Lands before the CLI/skill phase of T-CAT-01, which absorbed T-CAT-01 (tech lead 2026-10-02, edge cut): FLW-07 registers monitor/inspect in the real CAT-01 authority and ships its real app/HTTP/live slice. CAT-02 independently generates the CLI and skill from those descriptors. Keep CLI/skill parity as a joint S1 exit check; no handwritten second monitor CLI.; its integration test with that phase runs after it lands and gates C-CAT-02 and C-CAT-03 (joint S1 monitor/inspect CLI/skill parity exit).
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
- Phases and cells (§11.6.3): group events per step instance into phases with deterministic titles (the step's Appendix C label plus its recorded outcome, "Ran checks · 2 failed") and give each cell its deterministic label ("Read retry.ts"); map agent actions to cell kinds by their B.3 / Appendix C row; per-attempt graphs; the `held` state for the trailing wait for merge. Phase summaries and cell explanations come from T-APP-07's summarizer through `run_summaries`; the monitor renders them as model summaries and shows the title or label alone while they are absent. This ticket lands safely with summaries absent. T-APP-07 depends on this ticket's phase/cell contract and owns enabling summary production; the summary-producing C-J11-01 assertions qualify at S1 exit after T-APP-07, not at this ticket's landing. Check: C-J11-01.
- The thrashing detector (§11.6.4): deterministic host code over run events (failing-check signature, file edits), projected to the phase tone and the `todo:<n>` indicator. C-J11-04.

Out:
- The base `run:<id>` projection and its transport (T-COL-02).
- Sending typed signals by hand, and triggers ([D] spec §0, §11.7).
- The DevTools view: unchanged (#2931 is do-not-implement; delta.md §11).
- The interrupted state's S2 reconcile semantics (T-FLW-09); this ticket only wires the recorded state and existing Retry action.
- Views, CSS and visual layout (T-FLW-07), fork/rewind mutations, a second summarizer and evaluating repository code to render custom presentation.

## Changes
- Reuse (minimal-code synthesis, 2026-10-03, v2 reuse): the monitor is the existing RunTrace fold (`packages/smithers/gateway/src/RunTrace.ts`, re-exported by `apps/app/src/mainview/cards/RunTrace.ts:2`) plus `packages/backend/modelprice/prices.go` for cost. No second run projection, step model or price table.
- `apps/app/src/mainview/flows/entries/runs.ts` → add `/monitor` (Advanced group, a superset of `runs.list:47`) and `/run.inspect` (alias of `runs.trace.view:228`); register both in the one catalog (T-CAT-01).
- Labels: `packages/smithers/gateway/src/RunTrace.ts` → map each step's tag to its Appendix C rendering through a table generated from `actions.md` (the parser T-CAT-01 adds), and fold the bookkeeping tags into one `engine` group per run. A tag with no rendering shows its id, and T-CAT-01's allowlist test fails on it.
- Cost: `packages/backend/modelproxy/meter.go:41-51` (`Caller`) → add the run step id, sent by the coding host with each model call under the run credential. The `run:<id>` projection sums `modelprice` cost (`packages/backend/modelprice/prices.go`) per step from the usage rows `finishUsage` writes (`meter.go:213`).
- Data/action wiring → the existing `apps/app/src/mainview/cards/RunTraceCard.tsx`. Consume the existing `packages/rpc/src/RunCard.ts` and fixture subpath, subscribe to `run:<id>`, and bind actions through `cardActions` → `flowAction`. Supply step costs, totals and Engine grouping to T-FLW-07's View. `RunTraceSteps.tsx:21-28` is the existing `stepFacts` precedent; engineering does not change its visual rendering.
- Waits: fold wait-opened and wait-settled events into `packages/smithers/gateway/src/RunTrace.ts`, then map since and settler through `RunTraceCard.tsx` to the View. `apps/app/src/mainview/cards/RunTraceSummary.tsx:31-35` is the old renderer, not a visual edit target for this ticket.
- Journal and custom view: the Container loads the journal on tab open and re-projects recorded state for scrubber changes with reads only. Pass the custom presentation as a rendered slot to T-FLW-07. smithers-38 and smithers-3f approve the serializable presentation/renderer contract before start; repository JS/TS is never imported or evaluated by the host or browser to render it. Today's `Descriptor.ts:696-742` defines call presentation metadata, not a custom-view component API.
- Interrupted: adapt the recorded interrupted state to the monitor model and bind Retry through the existing authorized catalog action. `apps/app/src/mainview/cards/RunTraceStatus.ts` is the current state-folding precedent; T-FLW-07 renders the state and control.
- Delete `forks`: `packages/smithers/gateway/src/RunTrace.ts:2025-2026,2036,2050,2060,2078`; `packages/rpc/src/Cards.ts:1139`; `apps/app/src/mainview/flows/entries/runs.ts:177-183`; the expectations at `apps/app/src/mainview/cards/RunTraceCard.test.tsx:348` and `RunTrace.test.ts:324`; `packages/smithers/gateway/test/RunTrace.test.ts`; `packages/smithers/gateway/docs/api.md`. Keep `span.kind === "fork"` decoding (`apps/app/src/mainview/cards/TraceSteps.ts:59`). A persisted card whose filter is `forks` decodes as `all`.
- Docs: gateway `docs/` updated; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers/gateway:docs`.

## Tests

- Landing integration, `packages/backend/internal/services/run_thrash_integration_test.go` (new): deliver literal event journals through the production authenticated run-event ingest and read the served `/api/runs/{id}/trace` plus `/api/live` `run:<id>` and `todo:<n>` topics. Extend `apps/app/e2e/real/run-inspection.spec.ts` through the real `/monitor` and `run.inspect` dispatcher and RunTraceCard. Check waits, fixed cost totals, summaries blocked/failed, thrash clearing, legacy cards and read-only scrub requests. Checks: C-J11-01, C-J11-04, C-UI-13.
- Labels, timestamps, normalized signatures and cost totals are committed literal oracles. Tests never parse spec files or generate expected labels, prices or projections through the code under test. Build-time generation of the Appendix C rendering table remains allowed.

- C-CUT-02: pinned `run-trace` rows decode live; map legacy `forks` filter to `all` (card-kinds.md L4).

- Unit, `packages/smithers/gateway/test/RunTrace.test.ts` (extend): phase titles and cell labels are a pure function of the event sequence. A journal replayed twice gives identical strings with no model call; a check phase with 2 failures is titled "Ran checks · 2 failed". Check: C-J11-01.

- Unit, `packages/backend/internal/services/run_thrash_test.go` (new, beside `run_thrash.go`): a table over event sequences. The same test id failing 3× with no edit gives thrash; an edit to a named file between failures resets the count; 3 different test ids give none; error signatures differing only in paths or line numbers count as the same; 3 failures split across two attempts give none; a passing run clears the indicator. A property test asserts the detector is a pure function of the event sequence. (C-J11-04)
- Unit, `packages/smithers/gateway/test/RunTrace.test.ts` (extend): no `forks` in `TRACE_FILTER_IDS` or `traceFiltersFor`; a journal with a fork span still folds; waits fold with `since` and settler from fixture events.
- Unit, same file: a fixture `todo` journal titles `coding/edit-atom` "Edited the files" and `coding/check-command` "Ran checks"; `<seal-step>`, `<boundary:name>` and `agent/trace/checkpoint` appear only inside one Engine group.
- Unit, `apps/app/src/mainview/cards/containers/runModel.test.ts` (new): fixed cost totals, absent usage for a step without model calls, and one Engine group. View appearance tests belong to T-FLW-07.
- Unit, `apps/app/src/mainview/cards/containers/RunTraceCard.test.tsx` (new): legacy `forks` maps to `all`, custom presentation supplies a slot only when declared, and scrubber changes issue reads only. C-J11-01 checks the composed DOM for no fork/rewind controls; T-FLW-07 owns visual tests.
- Integration (real PostgreSQL), `packages/backend/modelproxy/meter_step_test.go` (new): two calls in one step and one in another yield committed literal expected costs and totals from fixed usage fixtures. Do not call `modelprice` to compute the test oracle; rate changes require reviewed fixture updates.
- e2e, `apps/app/e2e/real/run-inspection.spec.ts` (extend), for [C-J11-01](../checks/C-J11-01.md).

## Acceptance

- [C-J11-02](../checks/C-J11-02.md): S2, S3 qualification; does not block S1 completion.

- [C-J11-02](../checks/C-J11-02.md): a flow's custom view and a draft-version run's graph live in the monitor.

- [C-J11-01](../checks/C-J11-01.md): Inspect shows the graph with Appendix C labels and one Engine row, step I/O, transcript, retries, waits with since, and tokens, time and cost per step, with no fork filter.
- [C-J11-04](../checks/C-J11-04.md): Thrashing: the same failing check 3× in one attempt with no edit in between shows on the TODO card and the Inspect phase; an edit clears it
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Risk: model calls made by a coding agent CLI (Claude Code, Codex) through the proxy may not carry a step id. Confirmed if cost rows have an empty step. Attribute them to the innermost active step from `mythical_items.current_step` (§4.1.2) at call time.
- Risk: removing `forks` from the `Cards.ts` enum breaks decoding of saved conversations (AGENTS.md: old sessions stay readable). Confirmed by a stored-card fixture failing to parse. The decoder maps unknown filters to `all`.
- Risk: tags built at runtime (`<cell-call:flow>`, `<quota-park>/<session>`) don't match a literal Appendix C id. Confirmed if a fixture journal shows a raw id. Match the angle-bracket rows by pattern.

## Ready checklist
1. Dependencies: T-COL-02 supplies live run topics and transitively the authorizer; T-CAT-01 supplies monitor/inspect registration; this ticket owns the mounted card and schema; T-APP-22 supplies legacy decoding. T-APP-07 consumes this ticket and qualifies summary production later; missing summaries are a supported label-only landing state (§11.6.3), so it is not a safe-landing precondition. Landing condition for the T-CAT-01 edge cut: FLW-07 registers monitor/inspect in the real CAT-01 authority and ships its real app/HTTP/live slice. CAT-02 independently generates the CLI and skill from those descriptors. Keep CLI/skill parity as a joint S1 exit check; no handwritten second monitor CLI.; its integration test with that phase runs after it lands and gates C-CAT-02 and C-CAT-03 (joint S1 monitor/inspect CLI/skill parity exit).
2. Exclusions: Out excludes transport, manual signals/triggers, DevTools changes, S2 reconcile semantics, Views/CSS, fork/rewind writes, a second summarizer and repository-code rendering.
3. Boundary tests: authenticated production event ingest → served trace/live topics → catalog monitor/inspect → Container, with literal journal/label/cost oracles (C-J11-01/C-J11-04/C-UI-13). No runtime spec or pricing/projection-derived expectations.
4. Decisions: smithers-3f accepts metering attribution, ingest authentication and thrash normalization; smithers-38 accepts gateway folds and serializable presentation; smithers-b8 signs off command/API and Container wiring; smithers-06 accepts the View seam. Will through smithers-8a decides new user-visible labels or changed detector behavior.
5. Owner pre-review before start: smithers-3f: Can usage be attributed to the real step without trusting a caller-supplied unrelated run ID? Does authenticated ingest preserve attempt boundaries for thrash? smithers-38: Are labels/replay deterministic and custom presentation data rendered without repository-code evaluation? smithers-b8: Do monitor/inspect and read-only scrub use the production catalog and served routes? smithers-06: Does RunTraceCard provide the View's costs, waits, summaries and custom slot without engineering visual edits?
6. Security: this ticket reads events and renders data, and admits no repository execution during inspection or replay. Existing execution remains machine-only under T-INS-02/T-FLW-01; custom presentation never evaluates repository modules on the host or browser. Model-proxy attribution and journal reads are authorized to the run/repository. smithers-3f reviews, with smithers-38 reviewing presentation safety; C-J11-01's read-only requests and C-J11-02's execution boundary qualify.

