# T-APP-17 Context preflight: selection step, Context line, Inspect

Stage S1 · Size M · Depends on T-APP-16, T-UI-07, T-APP-19 · Unblocks T-FLW-10 · Issue: to file
Spec: spec.md §15.1.2, §11.5a (`agent:fast`) · Delta: delta.md §9 · Product: mvp.md §6.5 Context preflight, J9

## Goal
Every app-agent answer is built from a stored, inspectable context list that a preflight step chose on the host, never from the whole conversation, and the same selector serves the TODO planner's wiki citations.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the Context line chips and the preflight cell in Inspect. Engineering wires them: the preflight step, its budget and the stored `context[]`. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- A preflight step at the start of every app-agent turn, inside T-APP-16's host turn runner (§15.1.4). The turn, including preflight, runs on the host, outside every machine, and survives its author closing the tab.
- Inputs (§15.1.2): the prompt, the author, the branch, the titles and summaries of the conversation's recent entries, and the branch's state. Candidates: files, wiki pages, TODOs and runs.
- Output `context[] = {kind, ref, revision?, reason}` within a token budget (default 24k tokens, an owner setting), stored on the answer entry.
- Only the selected items, the prompt and the last 3 entries' text enter the answer step.
- Model: one call on the install's fast model (`agent:fast`, §11.5a), recorded like any step. Without a fast-model key it falls back to the coding model, and the step records which model it used.
- File candidates are read from the host repository store at the branch's last captured head, so preflight never wakes a machine (§8.4.4).
- A compact "Context" line on answers, one chip per item, each opening its card.
- Inspect on an answer shows preflight as the turn's first step, with candidates and choices.
- One selector, `SelectContext(input, kinds, budget)`. §13.4 reuses it restricted to wiki pages with the TODO's prompt as input (T-FLW-10).

Out:
- Jev command selection, which is kept as built (`POST /api/commands/select`).
- The planner's wiki citations themselves (T-FLW-10) and the coding agent's own context.
- The host turn runner and credential (T-APP-16).

## Changes
- `packages/backend/internal/services/app_agent_preflight.go` (new): `SelectContext`, with tool access to code search over the host store, wiki search, the TODO list and runs. Typed output validated with a schema. The budget is enforced by a token estimate before the answer step.
- `packages/backend/internal/services/app_agent_turns.go` (T-APP-16): prompt assembly becomes preflight output + prompt + the last 3 entries' text. Delete the transcript-window assembly in the same change; confirm where it lives today with `rg "systemPrompt|messages" apps/app/src packages/backend/internal/services`.
- `flow_config` reads `agent:fast` and the budget setting (§11.5a; the Agent card is T-FLW-08).
- `packages/rpc/src/Cards.ts`: `context` on answer entries. The answer card renders the Context line as chips (MINIMAL TEXT: no sentence).
- `RunTraceCard.tsx`: the turn trace shows the preflight step first.
- If an existing context-selection step is found (`rg -i "recall|select.*context" apps/app/src packages/smithers/agent packages/backend/internal/services`), extend it rather than adding a second one, and record that in the issue.

## Tests
- Integration: on a conversation with 500 entries, the answer step's model input contains only the selected context, the prompt and the last 3 entries, asserted on the recorded model request.
- Integration: with the branch asleep, preflight selects a file and causes no `machine_requests` row.
- Integration: without a fast-model key, preflight runs on the coding model and records it.
- Unit: the budget cap drops the lowest-ranked items first. The stored `context[]` equals what entered the answer step.
- Unit: `SelectContext` with `kinds = [wiki]` returns only wiki pages with `{slug, revision}`.
- e2e: J9 "where do we retry webhooks?" shows a Context line with at least one file. Clicking a chip opens its card, and Inspect shows preflight first.
- Perf hook: preflight time is recorded per turn, so C-PERF-01 (T-REL-01) measures the first-token budget with preflight included, the clock starting at submit.

## Acceptance
- [C-UI-07](../checks/C-UI-07.md): stored context, Context line, preflight first in Inspect, only selected context reaches the answer.

## Risks and notes
- Risk: preflight adds a model round trip that breaks the 1.5 s first-token target. Confirmed by C-PERF-01. Mitigation: a faster preflight model or a smaller candidate list. Escalate to the tech lead before relaxing the target.
- Risk: the fallback to the coding model makes preflight slower and costlier on installs without a fast key. Confirmed by C-PERF-01 run once without the key; setup asks for the fast key (§16.2 step 4).
