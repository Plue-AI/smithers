# T-APP-17 Context preflight: selection step, Context line, Inspect

Stage S1 · Size M · Depends on T-APP-16, T-UI-07, T-FLW-07, T-INS-06, T-STK-12, T-FLW-08, T-FLW-07 · Unblocks T-FLW-10, T-REL-02 · Issue: [#3504](https://github.com/smithersai/smithers/issues/3504)
Spec: spec.md §15.1.2, §11.5a (`agent:fast`) · Delta: delta.md §9 · Product: mvp.md §6.5 Context preflight, J9, Appendix A (`memory`, `recall`: "Pick context … The Context line")

## Goal
Every app-agent answer is built from a stored, inspectable context list that a preflight step chose on the host, never from the whole conversation, and the same selector serves the TODO planner's wiki citations.

## Scope
In:
- A preflight step at the start of every app-agent turn, inside T-APP-16's host turn runner (§15.1.4). It runs on the host, outside every machine, and survives its author closing the tab.
- Inputs (§15.1.2): the prompt, the author, the branch, the titles and summaries of recent shared entries, and the branch's state. Candidates: files, wiki pages, TODOs and runs.
- Reuse first, in this order:
  1. Selection: the existing `recall` flow (`packages/smithers/agent/memory/src/Flows.ts:39`, `Source.ts`), which mvp.md Appendix A already maps to the Context line. Add TODO and run sources to it only where it lacks them.
  2. Stored items: CardPrimitives' `ContextItemSchema` (`packages/rpc/src/CardPrimitives.ts:304`) extended with `reason`. No second context-item shape.
  3. Answer input: `composeAgentInstructions` (`packages/rpc/src/AgentContext.ts:559`) renders the selected items into the answer step's instructions.
  A new Go selector is written only if `recall` cannot rank TODOs and runs within the budget; the ticket records that evidence in #3504 first.
- The stored list sits on the answer entry within a token budget (default 24k tokens, an owner setting). Only the selected items, the prompt and the last 3 shared entries' text enter the answer step. Every read applies `SharedEntries` (T-APP-16): the author's own private entries are excluded too.
- Model: one call on `agent:fast` (§11.5a), recorded like any step. Without a fast-model key it falls back to the coding model and records which it used.
- File candidates are data from the host repository store, never a machine: S1 uses mirrored `main` (T-INS-06) or the item snapshot (T-STK-12); S2 uses the branch's last captured head (§8.4.4). Record the revision per file; a missing snapshot gives no candidate and never wakes a machine. Recent entries without summaries keep their titles; preflight does not wait for T-APP-07.
- The Context line: one item per `context[]` entry with the command that opens its card; T-UI-07's `ContextLine.tsx` renders it. Inspect shows preflight as step 1 with candidates and choices (T-FLW-07).
- §13.4 reuses the same selection restricted to wiki pages (T-FLW-10).

Out:
- Jev command selection (`POST /api/commands/select`), kept as built.
- Changes to memory recall policy; the planner's citations (T-FLW-10); the coding agent's own context; the host runner (T-APP-16).
- Repository flow or plugin execution, shell or LSP tools, live machine reads, machine wake, private context.

## Changes
- `packages/smithers/agent/memory/src/Flows.ts` and `Source.ts`: TODO and run sources for `recall` if absent, with no policy change.
- `packages/backend/internal/chat/runtime.go` (T-APP-16): run preflight as step 1, store `context[]` on the answer entry, and build the answer input with `composeAgentInstructions`. This replaces the browser transcript assembly at `apps/app/src/mainview/state/controller/turns.ts:181`, deleted with T-APP-16's cutover.
- `install_settings` reads `agent:fast` and the budget (§11.5a; the Agent card is T-FLW-08).
- The conversation surface (T-APP-16's card file) maps `context[]` to `ContextLine.tsx` props.

## Tests
Folded from C-UI-07. `main`'s conversation seeded with 500 shared entries, then Ben's own uncommitted Draft containing `canary-B`, a pending Confirm for Alice containing `canary-C`, and, newest, Alice's uncommitted Draft containing `canary-D` and naming `src/webhooks/retry.ts`. The repository fixture has a retry helper in `src/webhooks/retry.ts`; the model is a recording fake.
- Integration (`packages/backend/internal/chat/preflight_integration_test.go`, real PostgreSQL, production router and runner): Ben prompts "where do we retry webhooks?" through `POST /api/conversations/{b}/prompt`. `context[]` has at least one item and includes `src/webhooks/retry.ts`; each item parses with `ContextItemSchema.extend({reason: z.string()})`; an item missing `label` or `reason` fails to decode. The answer request holds exactly the selected items, the prompt and the last 3 shared entries' text, and none of the other 497. No recorded request, `context[]` or Inspect payload contains `canary-B`, `canary-C` or `canary-D`. Total context stays within 24k tokens. The preflight step's recorded model is the owner's `agent:fast`. Expected refs, revisions and texts are literals.
- Integration: with the branch asleep, preflight selects a file and creates no the runtime admission queue row; a repository search-plugin canary never runs on the host.
- Integration: without a fast-model key, preflight runs on the coding model and records it.
- Unit: the budget cap drops the lowest-ranked items first; the stored `context[]` equals what entered the answer step; wiki-only selection returns only `{slug, revision}` items.
- e2e (`apps/app/e2e/playwright/branch-conversation.spec.ts`): the answer shows a Context line with one chip per item; clicking a chip opens its card; Inspect lists preflight first with candidates and choices.
- Perf hook: preflight time is recorded per turn for C-PERF-01.

## Acceptance
- [C-UI-07](../checks/C-UI-07.md): passes for this ticket’s phase at its stated layer.
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-UI-13](../checks/C-UI-13.md): `ContextLine` is reachable from `CardRenderers`; the browser transcript assembly in `turns.ts` is deleted.

## Risks and notes
- Risk: preflight adds a model round trip that breaks the 1.5 s first-token target. Confirmed by C-PERF-01. Mitigation: a faster preflight model or fewer candidates. Escalate to the tech lead before relaxing the target.
- Risk: `recall` ranks memory rows, not TODOs and runs. Falsified by the integration test above passing on `recall`; only a failure there justifies a new Go selector.
- Security: preflight reads snapshots as data with shipped host code; it imports no repository module and never wakes a machine (§1.3, M-29). smithers-3f reviews snapshot confinement and audience filtering before start.
