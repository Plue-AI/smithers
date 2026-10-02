# C-UI-07 Answers are built from a stored preflight context

Proves: mvp.md §6.5 Context preflight · spec.md §15.1.2, §11.5a (`agent:fast`) · Layer: integration · Stage: S1 · Tickets: T-APP-17, T-UI-07
Automation: `apps/app/src/bun/ContextPreflight.test.ts` (new), plus one e2e assertion in `branch-conversation.spec.ts` · Runs in: CI

## Setup
`main`'s conversation seeded with 500 entries. A repository fixture with a known retry helper in `src/webhooks/retry.ts`. The model is a recording fake that captures each request.

## Steps
1. Prompt "where do we retry webhooks?".
2. Read the answer entry's `context[]`.
3. Read the recorded request sent to the answer step.
4. Open Inspect on the answer.

## Pass when
- `context[]` has at least one item, includes `src/webhooks/retry.ts`, and every item has kind, ref and reason.
- The answer-step request contains exactly the selected context items, the prompt and the last 3 entries' text. None of the other 497 entries' text appears.
- The total context stays within the configured budget (default 24k tokens).
- The preflight step's recorded model is the owner's `agent:fast` setting.
- The answer shows a Context line with one chip per item.
- Inspect lists preflight as step 1, with candidates and choices.

## Fail when
- The full transcript (or any window of it beyond 3 entries) reaches the answer step.
- The stored list differs from what the model saw.
- The Context line is prose rather than chips.

## Evidence
`.artifacts/checks/C-UI-07/<ts>/`: the recorded model requests, the entry JSON, an Inspect screenshot and the commit.
