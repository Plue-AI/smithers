# T-FLW-07 Monitor: `/monitor`, cost, waits since, interrupted state, no fork filter

Stage S1 · Size M · Depends on T-COL-02, T-APP-22, T-CAT-01 · Unblocks T-AGT-04, T-APP-02, T-APP-07, T-APP-17, T-FLW-09, T-MNT-04, T-REL-02 · Issue: [#3514](https://github.com/smithersai/smithers/issues/3514)
Spec: spec.md §7.2 `run:<id>`, §11.6, §19.1 · Delta: delta.md §8 (monitor and runtime-event rows) · Product: mvp.md J11.1, §6.14 Monitor and Signals and approvals, Appendix A `/monitor`, `/run.inspect <id>`; AGENTS.md MVP scope (no fork or rewind controls)
Ready: 2026-10-03 smithers-8a sha256:7900c39b9b3f

## Goal
From any run card, Inspect opens a monitor that shows the graph with live step states, each step titled by what it did, each step's input, output and transcript, attempts and retries, every durable wait with when it began, tokens, time and cost per step, the raw event journal and the flow's custom view, with no fork or rewind control.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the monitor views: graph, step I/O, timeline, waits with since, tokens/time/cost, the collapsed Engine row, the scrubber. Engineering wires them: run event projections, Appendix C labels, `/monitor` and `run.inspect` commands. The seam is the card's view-model schema (spec §14.2.1, the consuming card ticket). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope

- The `run:<id>` projection follows T-FLW-07: `attempts[].steps[]` keyed per step instance, usage only for model calls, stable `phases[].cells[]` ids, and waits with `settled {by, at}`. Load journal on tab open; `replay {at, last}` projects a sequence with reads only. Render `presentation` in `custom`. Check: C-J11-04.

In:
- Registers monitor/inspect in T-CAT-01's one catalog and ships the app/live slice. T-CAT-01 owns generated CLI and skill doors; their parity qualifies at joint S1 exit under C-CAT-02 and C-CAT-03. No handwritten monitor CLI.
- Lands dark until T-COL-02: refuse monitor subscriptions and journal reads when authenticated run topics are unavailable; do not fall back to an unauthenticated event source. Check: C-J11-01.
- Lands dark until T-CAT-01: monitor/inspect and Retry refuse unavailable catalog authority; do not dispatch directly. Its generated CLI/skill doors stay unavailable until generation qualifies. Checks: C-J11-01, C-CAT-02, C-CAT-03.
- Lands dark until T-APP-22: refuse legacy monitor cards that cannot be decoded safely; never pass `forks` to the new filter action. Check: C-CUT-02.
- Lands dark until T-APP-07: show deterministic phase titles and cell labels without summaries; do not invoke a second summarizer. Check: C-J11-01.
- Lands dark until T-INS-02/T-FLW-01: Retry refuses an unavailable machine-only execution provider; inspection remains read-only. These are enablement preconditions, not direct code/schema dependencies. Check: C-J11-01.
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
- Engineering changes to Views, CSS and visual layout (smithers-06 owns them within this ticket), fork/rewind mutations, a second summarizer, a second trace route or projection, and evaluating repository code to render custom presentation.

## Changes
- Reuse (minimal-code synthesis, 2026-10-03, v2 reuse): the monitor is the existing RunTrace fold (`packages/smithers/gateway/src/RunTrace.ts`, re-exported by `apps/app/src/mainview/cards/RunTrace.ts:2`) plus `packages/backend/modelprice/prices.go` for cost. No second run projection, step model or price table.
- `apps/app/src/mainview/flows/entries/runs.ts` → add `/monitor` (Advanced group, a superset of `runs.list:39`) and `/run.inspect` (alias of `runs.trace.view:198`); register both in the one catalog (T-CAT-01).
- Labels: `packages/smithers/gateway/src/RunTrace.ts` → map each step's tag to its Appendix C rendering through a table generated from `actions.md` (the parser T-CAT-01 adds), and fold the bookkeeping tags into one `engine` group per run. A tag with no rendering shows its id, and T-CAT-01's allowlist test fails on it.
- Cost: `packages/backend/modelproxy/meter.go:41-51` (`Caller`) → add the run step id, sent by the coding host with each model call under the run credential. The `run:<id>` projection sums `modelprice` cost (`packages/backend/modelprice/prices.go`) per step from the usage rows `finishUsage` writes (`meter.go:213`).
- Data/action wiring → reshape `apps/app/src/mainview/cards/RunTraceCard.tsx` as the container, mounted only by `CardRenderers.tsx`. Extract its existing run-trace wire schema from `packages/rpc/src/Cards.ts` into `packages/rpc/src/RunCard.ts` (new subpath, not an existing file); retain one legacy decoder. View props are TypeScript types; zod validates HTTP/storage boundaries. Subscribe to `run:<id>` and bind actions through `cardActions` → `flowAction`. Mount smithers-06's Run View in the same commit, replacing legacy RunTraceCard rendering and duplicate monitor rendering in `RunsCards.tsx` while preserving its retained run-list. No separate Container or fixture layer. `RunTraceSteps.tsx:21-28` is the existing `stepFacts` precedent. Check: C-UI-13.
- Waits: fold wait-opened and wait-settled events into `packages/smithers/gateway/src/RunTrace.ts`, then map since and settler through `RunTraceCard.tsx` to the View. `apps/app/src/mainview/cards/RunTraceSummary.tsx:31-35` is the old renderer, not a visual edit target for this ticket.
- Journal and custom view: the Container loads the journal on tab open and re-projects recorded state for scrubber changes with reads only. Pass the custom presentation as a rendered slot to T-FLW-07. smithers-38 and smithers-3f approve the serializable presentation/renderer contract before start; repository JS/TS is never imported or evaluated by the host or browser to render it. Today's `packages/smithers/agent/registry/src/Descriptor.ts:696-742` defines call presentation metadata, not a custom-view component API.
- Interrupted: adapt the recorded interrupted state to the monitor model and bind Retry through the existing authorized catalog action. `apps/app/src/mainview/cards/RunTraceStatus.ts` is the current state-folding precedent; T-FLW-07 renders the state and control.
- Delete `forks`: `packages/smithers/gateway/src/RunTrace.ts:2025-2026,2036,2050,2060,2078`; `packages/rpc/src/Cards.ts:1160`; `apps/app/src/mainview/flows/entries/runs.ts:167-177`; the expectations at `apps/app/src/mainview/cards/RunTraceCard.test.tsx:327` and `RunTrace.test.ts:324`; `packages/smithers/gateway/test/RunTrace.test.ts`; `packages/smithers/gateway/docs/api.md`. Keep `span.kind === "fork"` decoding (`apps/app/src/mainview/cards/TraceSteps.ts:59`). A persisted card whose filter is `forks` decodes as `all`.
- Docs: gateway `docs/` updated; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers/gateway:docs`.

## Tests

- Landing integration, `packages/backend/internal/services/run_thrash_integration_test.go` (new): deliver literal event journals through the production authenticated run-event ingest and read the served `/api/live` `run:<id>` and `todo:<n>` topics. Extend `apps/app/e2e/real/run-inspection.spec.ts` through the real `/monitor` and `run.inspect` dispatcher and RunTraceCard. Assert refusal with each unavailable dependency named in Scope, and authorized operation once its provider is present. Check waits, fixed cost totals, summaries blocked/failed, thrash clearing, legacy cards and read-only scrub requests. Checks: C-J11-01, C-J11-04, C-UI-13.
- Labels, timestamps, normalized signatures and cost totals are committed literal oracles. Tests never parse spec files or generate expected labels, prices or projections through the code under test. Build-time generation of the Appendix C rendering table remains allowed.

- C-CUT-02: pinned `run-trace` rows decode live; map legacy `forks` filter to `all` (card-kinds.md L4).

- Unit, `packages/smithers/gateway/test/RunTrace.test.ts` (extend): phase titles and cell labels are a pure function of the event sequence. A journal replayed twice gives identical strings with no model call; a check phase with 2 failures is titled "Ran checks · 2 failed". Check: C-J11-01.

- Unit, `packages/backend/internal/services/run_thrash_test.go` (new, beside `run_thrash.go`): a table over event sequences. The same test id failing 3× with no edit gives thrash; an edit to a named file between failures resets the count; 3 different test ids give none; error signatures differing only in paths or line numbers count as the same; 3 failures split across two attempts give none; a passing run clears the indicator. A property test asserts the detector is a pure function of the event sequence. (C-J11-04)
- Unit, `packages/smithers/gateway/test/RunTrace.test.ts` (extend): no `forks` in `TRACE_FILTER_IDS` or `traceFiltersFor`; a journal with a fork span still folds; waits fold with `since` and settler from fixture events.
- Unit, same file: a fixture `todo` journal titles `coding/edit-atom` "Edited the files" and `coding/check-command` "Ran checks"; `<seal-step>`, `<boundary:name>` and `agent/trace/checkpoint` appear only inside one Engine group.
- Unit, `packages/smithers/gateway/test/RunTrace.test.ts` (extend): fixed cost totals, absent usage for a step without model calls, and one Engine group. Reuse the existing fold tests; no second run model. smithers-06 owns View appearance tests.
- Unit, `apps/app/src/mainview/cards/RunTraceCard.test.tsx` (extend): legacy `forks` maps to `all`, custom presentation supplies a slot only when declared, and scrubber changes issue reads only. C-J11-01 checks the composed DOM for no fork/rewind controls; smithers-06 owns visual tests.
- Integration (real PostgreSQL), `packages/backend/modelproxy/proxy_integration_test.go` (extend through the production proxy handler): two calls in one step and one in another yield committed literal expected costs and totals from fixed usage fixtures. Do not call `modelprice` to compute the test oracle; rate changes require reviewed fixture updates.
- e2e, `apps/app/e2e/real/run-inspection.spec.ts` (extend), for [C-J11-01](../checks/C-J11-01.md).

## Acceptance

- [C-J11-02](../checks/C-J11-02.md): a flow's custom view and a draft-version run's graph live in the monitor. S2/S3 qualification does not block S1 completion; S1 landing integration must already prove inspection and replay do not execute repository code.

- [C-J11-01](../checks/C-J11-01.md): Inspect shows the graph with Appendix C labels and one Engine row, step I/O, transcript, retries, waits with since, and tokens, time and cost per step, with no fork filter.
- [C-J11-04](../checks/C-J11-04.md): Thrashing: the same failing check 3× in one attempt with no edit in between shows on the TODO card and the Inspect phase; an edit clears it
- [C-UI-13](../checks/C-UI-13.md): the Run View is reached from `CardRenderers.tsx` and its duplicate legacy rendering is deleted. This ticket's dispatcher/live tests prove authorization, data and actions.

## Risks and notes
- Risk: model calls made by a coding agent CLI (Claude Code, Codex) through the proxy may not carry a step id. Confirmed if cost rows have an empty step. Attribute them to the innermost active step from `mythical_items.current_step` (§4.1.2) at call time.
- Risk: removing `forks` from the `Cards.ts` enum breaks decoding of saved conversations (AGENTS.md: old sessions stay readable). Confirmed by a stored-card fixture failing to parse. The decoder maps unknown filters to `all`.
- Risk: tags built at runtime (`<cell-call:flow>`, `<quota-park>/<session>`) don't match a literal Appendix C id. Confirmed if a fixture journal shows a raw id. Match the angle-bracket rows by pattern.

## Ready checklist
1. Dependencies: T-COL-02 (live topics/client), T-CAT-01 (catalog descriptors/label parser) and T-APP-22 (legacy decoder) are direct code/schema contracts. Scope states fail-closed dark landing for each unavailable provider, summaries and machine-only Retry. T-APP-07 and T-INS-02/T-FLW-01 enable features without adding reverse or transitive dependency edges.
2. Exclusions: Out names transport, manual signals/triggers, DevTools, S2 reconcile semantics, engineering visual edits, fork/rewind writes, duplicate summarization/trace infrastructure and repository-code rendering.
3. Boundary tests: authenticated production event ingest → served live topics → catalog monitor/inspect → RunTraceCard; production model-proxy handler verifies metering. Literal journal/label/cost oracles never read specs or derive expectations from production code. Dark-provider refusals and read-only replay qualify at S1 landing; summary production and C-J11-02 qualify later.
4. Decisions: smithers-3f accepts metering attribution, ingest authentication and thrash normalization; smithers-38 accepts gateway folds and serializable presentation; smithers-b8 signs off command/public API and card wiring; smithers-06 accepts the View seam. Will through smithers-8a decides new user-visible labels or changed detector behavior. Existing recorded owner answers stand; remaining review is post hoc under Will's parallel-build directive.
5. Owner pre-review: smithers-3f: Can metering bind usage to the authorized run/step? Does ingest preserve attempt boundaries? Does Retry refuse a non-machine provider? smithers-38: Are folds and replay deterministic? Does presentation remain serialized data without repository-module evaluation? smithers-b8: Do monitor/inspect, Retry and scrub use catalog authority and served boundaries? Does the existing card mount one View and retain one legacy decoder? smithers-06: Does the seam supply costs, waits, optional summaries and the custom slot? Does cutover remove duplicate monitor rendering while retaining the run list? These are the pre-review questions; recorded answers stand and owners review post hoc under the directive.
6. Security: inspection and replay execute no repository code; machine-produced custom data uses install-shipped rendering code. Retry executes repository code only in machines as the unprivileged agent (M-29), failing closed without the authorized provider. This ticket adds no root step and supplies no repository input to root, so the root-input inventory is empty. Journals, presentation data and usage belong to the authorized run/repository; reject cross-repository reads and unrelated run/step attribution. smithers-3f reviews execution/authorization; smithers-38 reviews presentation safety. S1 C-J11-01 landing tests exercise read-only replay, unavailable Retry, cross-repository refusal and a repository-module canary that neither host nor browser evaluates; C-J11-02 later qualifies machine-produced custom presentation.
