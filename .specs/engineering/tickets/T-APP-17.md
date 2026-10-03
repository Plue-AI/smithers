# T-APP-17 Context preflight: selection step, Context line, Inspect

Stage S1 · Size M · Depends on T-APP-23, T-UI-07, T-APP-19, T-UI-12, T-INS-06, T-STK-12, T-FLW-08, T-FLW-07, T-APP-19b · Unblocks T-FLW-10, T-REL-02 · Issue: [#3504](https://github.com/smithersai/smithers/issues/3504)
Spec: spec.md §15.1.2, §11.5a (`agent:fast`) · Delta: delta.md §9 · Product: mvp.md §6.5 Context preflight, J9

## Goal
Every app-agent answer is built from a stored, inspectable context list that a preflight step chose on the host, never from the whole conversation, and the same selector serves the TODO planner's wiki citations.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the Context line chips and the preflight cell in Inspect, with the CSS, in T-UI-07 and T-UI-12. This ticket builds no View, CSS or editor presentation. It owns the preflight step, its budget, the stored `context[]` and the Context line items in the entry adapter. The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope
In:
- A preflight step at the start of every app-agent turn, inside T-APP-23's host turn runner (§15.1.4). The turn, including preflight, runs on the host, outside every machine, and survives its author closing the tab.
- Inputs (§15.1.2): the prompt, the author, the branch, the titles and summaries of the conversation's recent entries, and the branch's state. Candidates: files, wiki pages, TODOs and runs.
- Output `context[]` items use CardPrimitives’ `ContextItemSchema.extend({reason: z.string()})` via T-APP-19b (#3601), preserving `kind`, `label`, `ref` and optional `revision`. Store the selected list on the answer entry within a token budget (default 24k tokens, an owner setting). Do not define a second context-item shape. Check: C-UI-07.
- Only the selected items, the prompt and the last 3 shared entries' text enter the answer step. Every conversation read in preflight and the answer step applies the audience filter (§15.1.2a): shared entries only, the author's own private entries excluded too.
- Model: one call on the install's fast model (`agent:fast`, §11.5a), recorded like any step. Without a fast-model key it falls back to the coding model, and the step records which model it used.
- File candidates are read as data from the host repository store, never a machine: S1 uses mirrored `main` (T-INS-06) or the item snapshot pushed by T-STK-12 (§10.4.4); S2 uses the branch's last captured head (§8.4.4). Record the chosen revision with each file candidate and do not substitute a live working copy. A missing host snapshot supplies no file candidate and never triggers a wake. Recent entries without summaries keep their titles; preflight does not wait for T-APP-07's summarizer.
- The answer entry's Context line data: one item per `context[]` entry, each with the command that opens its card. T-UI-07 renders the chips.
- The turn's run record holds preflight as step 1 with its candidates and choices, so Inspect shows it first (T-UI-12 renders it).
- One selector, `SelectContext(input, kinds, budget)`. §13.4 reuses it restricted to wiki pages with the TODO's prompt as input (T-FLW-10).

Out:
- A second context-item schema or memory recall implementation. Extend the shared ContextItemSchema via T-APP-19b (#3601); keep the existing memory library and its recall policy unchanged.

- Jev command selection, which is kept as built (`POST /api/commands/select`).
- The planner's wiki citations themselves (T-FLW-10) and the coding agent's own context.
- The host turn runner and credential (T-APP-23).
- Repository flow/module execution, repository-configured search plugins, shell/LSP tools, live machine reads, automatic machine wake, private conversation context and changes to the memory library's recall policy.

## Changes
- `packages/backend/internal/services/app_agent_preflight.go` (new): `SelectContext`, with tool access to code search over the host store, wiki search, the TODO list and runs. Typed output validated with a schema. The budget is enforced by a token estimate before the answer step.
- `packages/backend/internal/chat/runtime.go` (T-APP-23) consumes preflight output + prompt + the last 3 shared entries. Replace today’s transcript assembly at `apps/app/src/mainview/state/controller/turns.ts:181` and its initial, retry and tool-continuation callers at `:599`, `:605` and `:676` during the host cutover. Check: C-PERF-01, C-UI-07.
- `flow_config` reads `agent:fast` and the budget setting (§11.5a; the Agent card is T-FLW-08).
- `packages/rpc/src/ConversationEntry.ts` and its `topics/Conversation.ts` consumer (T-APP-16, via T-APP-19b (#3601)): answer `context` is an array of CardPrimitives’ `ContextItemSchema` extended with `reason`, including the existing `label`. `apps/app/src/mainview/cards/containers/entryModel.ts` (T-APP-16) consumes those same items for T-UI-07’s `ContextLine`. Check: C-UI-07.
- The turn's run events record preflight as step 1 with candidates and choices, so `run:<id>` (T-FLW-07) carries it to Inspect.
- Memory recall in `packages/smithers/agent/src/StandardFlows.ts` and `agent/memory/src/Source.ts` selects memory-bank rows and is not reusable for app-agent files/wiki/TODOs/runs. The Go host `SelectContext` is the one app-agent selector and is not a second memory recall. Record this adopted caller/contract comparison in the issue; leave memory recall policy unchanged. Check: C-UI-07.

## Tests
- RPC context fixtures (C-UI-07, via T-APP-19b (#3601)): parse stored answer items with `ContextItemSchema.extend({reason: z.string()})`, including literal kind, label, ref, optional revision and reason. Missing label or reason fails decoding. The answer topic, Context line and Inspect retain the same selected refs/revisions and literal labels/reasons; no second context shape or memory recall invocation is used.

- Boundary (C-UI-07, `packages/backend/internal/chat/preflight_integration_test.go`, new): submit through `POST /api/conversations/{b}/prompt` on the production authenticated router, run T-APP-23's actual queue/model host, record provider requests, and read the stored answer and Inspect through `conversation:<branch>` and `run:<id>`. Fake the model endpoint, not the runner, selector or audience filter. A checked-in 500-entry fixture fixes the selected file/revision, last-three shared texts and private canaries; assert literal request contents and token-budget bounds without reading spec files or calling production assembly/token-estimate functions for expected values.
- Security (C-UI-07): before Machine ready, mirrored-main file candidates work with no machine request. For S1 item snapshots and S2 captured snapshots, code search reads the pinned host revision only. A repository search-plugin/flow canary never executes on the host; unavailable snapshots create no wake or live-file read.
- Integration: on a conversation with 500 entries, the answer step's model input contains only the selected context, the prompt and the last 3 entries, asserted on the recorded model request.
- Integration: with the branch asleep, preflight selects a file and causes no `machine_requests` row.
- Integration: without a fast-model key, preflight runs on the coding model and records it.
- Unit: the budget cap drops the lowest-ranked items first. The stored `context[]` equals what entered the answer step.
- Unit: `SelectContext` with `kinds = [wiki]` returns only wiki pages with `{slug, revision}`.
- Integration: with Alice's private Draft as the newest entry and Ben's own private Draft before it, Ben's turn's preflight input, last-3 window and `context[]` contain neither (C-UI-07).
- Unit (`entryModel.test.ts`): an answer with three `context[]` items yields three Context line items, each with its opening command, in `context[]` order.
- e2e: J9 "where do we retry webhooks?" shows a Context line with at least one file through T-UI-07's `ContextLine`. Clicking a chip opens its card, and Inspect shows preflight first.
- Perf hook: preflight time is recorded per turn, so C-PERF-01 (T-REL-01) measures the first-token budget with preflight included, the clock starting at submit.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-UI-07](../checks/C-UI-07.md): stored context, Context line, preflight first in Inspect, only selected context and shared entries reach the answer.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Risk: preflight adds a model round trip that breaks the 1.5 s first-token target. Confirmed by C-PERF-01. Mitigation: a faster preflight model or a smaller candidate list. Escalate to the tech lead before relaxing the target.
- Risk: the fallback to the coding model makes preflight slower and costlier on installs without a fast key. Confirmed by C-PERF-01 run once without the key; setup asks for the fast key (§16.2 step 5).

## Ready checklist
1. Runtime preconditions: T-APP-23 supplies host turns and private-read restrictions; T-INS-06 supplies mirrored source and model access; T-STK-12 supplies S1 item snapshots; T-FLW-08 supplies model-role configuration; T-FLW-07 supplies run/Inspect projection; T-APP-19 and T-UI-07/12 supply schemas and Views. Absent summaries do not block preflight; S2 capture is qualification, not an S1 dependency.
2. Exclusions: Out names Jev selection, planner citations, coding context, host runner, repository execution/plugins, shell/LSP, machine wake, private context and memory-policy changes.
3. Boundary tests: C-UI-07 submits to the production prompt route and actual runner, observes recorded provider input, stored conversation context and Inspect topics with fixed file/revision, shared texts, private canaries and independent budget expectations.
4. Decisions: smithers-3f accepts candidate access, budget/ranking and typed selection failure behavior; smithers-38 accepts reuse/public contract changes under §21.1; smithers-b8 accepts Context actions and Inspect wiring; smithers-06 accepts Context/Inspect props. smithers-8a decides performance mitigations within the budget; Will alone approves a product target/default-budget change.
5. Before start: smithers-3f: are snapshots pinned, private entries excluded from every read and the 24k budget independently provable? smithers-38: can existing shipped recall code serve the real selector callers without a second abstraction or policy change? smithers-b8: do Context chip commands and Inspect step 1 traverse production wiring? smithers-06: do context items and recorded candidates/choices fit both agreed Views? smithers-3f: answered 18:2x, ok. smithers-b8: answered 18:23, ok. smithers-06: answered 18:3x, ok. Design condition: "ok. The ContextLine chip shows counts plus short item labels; the Inspect preflight cell lists candidates and choices." smithers-38: answered, changes applied (tech lead adopts).
6. Security: preflight searches repository snapshots as data using shipped host code; it imports no repository module, runs no flow/plugin/shell and never wakes a machine (§1.3, M-29). smithers-3f reviews snapshot/path confinement and audience filtering before start; C-UI-07 proves no host execution, wake or private canary in requests, stored context or Inspect.
