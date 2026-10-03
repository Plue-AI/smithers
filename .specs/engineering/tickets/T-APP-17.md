# T-APP-17 Context preflight: selection step, Context line, Inspect

Stage S1 · Size M · Depends on T-APP-23, T-UI-07, T-APP-19, T-UI-12 · Unblocks T-FLW-10, T-REL-02 · Issue: [#3504](https://github.com/smithersai/smithers/issues/3504)
Spec: spec.md §15.1.2, §11.5a (`agent:fast`) · Delta: delta.md §9 · Product: mvp.md §6.5 Context preflight, J9

## Goal
Every app-agent answer is built from a stored, inspectable context list that a preflight step chose on the host, never from the whole conversation, and the same selector serves the TODO planner's wiki citations.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the Context line chips and the preflight cell in Inspect, with the CSS, in T-UI-07 and T-UI-12. This ticket builds no View, CSS or editor presentation. It owns the preflight step, its budget, the stored `context[]` and the Context line items in the entry adapter. The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope
In:
- A preflight step at the start of every app-agent turn, inside T-APP-23's host turn runner (§15.1.4). The turn, including preflight, runs on the host, outside every machine, and survives its author closing the tab.
- Inputs (§15.1.2): the prompt, the author, the branch, the titles and summaries of the conversation's recent entries, and the branch's state. Candidates: files, wiki pages, TODOs and runs.
- Output `context[] = {kind, ref, revision?, reason}` within a token budget (default 24k tokens, an owner setting), stored on the answer entry.
- Only the selected items, the prompt and the last 3 shared entries' text enter the answer step. Every conversation read in preflight and the answer step applies the audience filter (§15.1.2a): shared entries only, the author's own private entries excluded too.
- Model: one call on the install's fast model (`agent:fast`, §11.5a), recorded like any step. Without a fast-model key it falls back to the coding model, and the step records which model it used.
- File candidates are read from the host repository store at the branch's last captured head, so preflight never wakes a machine (§8.4.4).
- The answer entry's Context line data: one item per `context[]` entry, each with the command that opens its card. T-UI-07 renders the chips.
- The turn's run record holds preflight as step 1 with its candidates and choices, so Inspect shows it first (T-UI-12 renders it).
- One selector, `SelectContext(input, kinds, budget)`. §13.4 reuses it restricted to wiki pages with the TODO's prompt as input (T-FLW-10).

Out:
- Jev command selection, which is kept as built (`POST /api/commands/select`).
- The planner's wiki citations themselves (T-FLW-10) and the coding agent's own context.
- The host turn runner and credential (T-APP-16).

## Changes
- `packages/backend/internal/services/app_agent_preflight.go` (new): `SelectContext`, with tool access to code search over the host store, wiki search, the TODO list and runs. Typed output validated with a schema. The budget is enforced by a token estimate before the answer step.
- `packages/backend/internal/chat/runtime.go` (T-APP-23): prompt assembly becomes preflight output + prompt + the last 3 shared entries' text. Delete the transcript-window assembly in the same change; confirm where it lives today with `rg "systemPrompt|messages" apps/app/src packages/backend/internal`.
- `flow_config` reads `agent:fast` and the budget setting (§11.5a; the Agent card is T-FLW-08).
- `packages/rpc/src/topics/Conversation.ts` (T-APP-16): `context` on answer entries. `apps/app/src/mainview/cards/containers/entryModel.ts` (T-APP-16): the Context line items for T-UI-07's `ContextLine`.
- The turn's run events record preflight as step 1 with candidates and choices, so `run:<id>` (T-FLW-07) carries it to Inspect.
- If an existing context-selection step is found (`rg -i "recall|select.*context" apps/app/src packages/smithers/agent packages/backend/internal/services`), extend it rather than adding a second one, and record that in the issue.

## Tests
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
- Risk: the fallback to the coding model makes preflight slower and costlier on installs without a fast key. Confirmed by C-PERF-01 run once without the key; setup asks for the fast key (§16.2 step 4).
