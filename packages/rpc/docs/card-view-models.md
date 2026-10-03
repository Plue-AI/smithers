---
title: "Card view models"
description: "Typed card data and catalog actions shared by Smithers Views and Containers."
---

## Data contracts

Each card module exports a zod schema and its inferred TypeScript type.
The fields follow engineering spec §14.3 and `ui-components.md`. Field names use
snake_case. Runtime objects strip unknown fields, and enums reject unknown
values. Contract tests separately reject unexpected fixture fields. These schemas describe projections; callbacks and clients are separate
from the data and are never persisted with it.

Import a single module, such as `@smthrs/rpc/TodoCard`. The existing persisted `CardSchema` in `Cards` still decodes
recorded cards; view models do not replace that history decoder.

| Module             | Schema and inferred type                     | Data                                                                         |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------- |
| ConfirmCard        | ConfirmCardSchema, ConfirmCard               | Confirmation kind, action, revision, waiting person and receipt              |
| TodoCard           | TodoCardSchema, TodoCard                     | Nine TODO states, steps, merge wait, questions, evidence and PR              |
| DraftCard          | DraftCardSchema, DraftCard                   | Title, prompt, issue, placement, seed and commit receipt                     |
| HomeCard           | HomeCardSchema, HomeCard                     | Main sync, stack items, counts, machines and background runs                 |
| SetupCard          | SetupCardSchema, SetupCard                   | Address, install steps, this Mac, repository and model access                |
| SettingsCard       | SettingsCardSchema, SettingsCard             | Setup fields plus capacity, parallel and laptop sign-in                      |
| MembersCard        | MembersCardSchema, MembersCard               | People, roles, access and suspension                                         |
| FlowCard           | FlowCardSchema, FlowCard                     | Source, versions, agents and merge-wait signals                              |
| FileCard           | FileCardSchema, FileCard                     | Text, diagnostics, gone state, external snapshot and optional co-edit fields |
| DiffCard           | DiffCardSchema, DiffCard                     | Base and diff hunks                                                          |
| BranchCard         | BranchCardSchema, BranchCard                 | Machine, presence, terminals, activity and changed files                     |
| TerminalCard       | TerminalCardSchema, TerminalCard             | Owner, watchers and command                                                  |
| SecretsCard        | SecretsCardSchema, SecretsCard               | Secret names and scopes; no secret values                                    |
| AgentCard          | AgentCardSchema, AgentCard                   | Instructions, model choices and participating runs                           |
| ProposalCard       | ProposalCardSchema, ProposalCard             | Evidence, references and proposal state                                      |
| MonitorCard        | MonitorCardSchema, MonitorCard               | Attempts, graphs, phases, cells, waits and actual usage                      |
| CommandsCard       | CommandsCardSchema, CommandsCard             | Command groups and catalog tags                                              |
| ActorChipCard      | ActorChipCardSchema, ActorChipCard           | Actor and chip size                                                          |
| ContextLineCard    | ContextLineCardSchema, ContextLineCard       | Context count, items and expansion                                           |
| BranchTreeNodeCard | BranchTreeNodeCardSchema, BranchTreeNodeCard | Recursive branch tree and presence                                           |
| TimelineEntryCard  | TimelineEntryCardSchema, TimelineEntryCard   | Author, title, summary, tone, nullable TODO state and action                 |
| ToastCard          | ToastCardSchema, ToastCard                   | Event kind, tone, conversation entry and action                              |

Shared actor, person, state and tone schemas live in `CardPrimitives`. Links use
the existing HTTP URL validator; fixture avatars use a bundled placeholder. Counts and durations are nonnegative; install
progress is between zero and 100. Evidence names its revision and may retain
the previous revision while a review runs. TODO, Home and Confirm share one
merge shape. Monitor attempts own their phases, cells and steps; titles and
labels render before optional model summaries arrive. A TODO's special `merge` step carries `kind:
"wait"` and `held`, while ordinary steps carry a label and execution state.

## Actions and callbacks

`CardAction` exports `ActionSchema`, `Action`, `FormFieldSchema`, `CardProps` and
`CardCallbacks`. Each actionable card exports a `*CardCallbacks` mapping from
its command tags to `(input) => void`, using `CardCommandInput`.

`catalog/index` exports the temporary catalog tag union: Appendix A plus the
Appendix B controls the cards need. T-CAT-01 replaces the placeholder at that
same module path and derives command inputs from catalog payload schemas.
No command is registered by these data modules.

A Container gives the app's `flows/cardActions` helper viewer-filtered action
definitions and their typed command inputs. The helper preserves order and
returns props-only `actions` and `onAction`, bound through `flowAction`.
Definitions may supply an input resolver for forms. Repeated tags on separate
rows use `forScope(rowId)`, which keeps each row's input and callback together.
`actionProps(tag)` retains the dispatch arguments for hover preloading.
Unknown or disabled actions report a typed failure without dispatching; supplied
form values require a resolver.

A View control renders `data-flow={action.tag}` and invokes
`onAction(action.tag)`, optionally with form values. The View never owns a
client, subscription or permission decision. `onView(patch)` changes per-member
card presentation; local React state and DOM focus handle transient gestures.
Views and Containers belong to
their separate component tickets.

## Fixtures and checks

Fixtures live at `packages/rpc/test/fixtures/<Card>.ts`, exported as
`@smthrs/rpc/fixtures/<Card>`, and expose a named `fixtures` record. They cover every listed state, both confirmation kinds,
waiting and receipts, and the shell variants. `test/cards/*Card.test.ts` suites
parse fixtures and mutate required fields, unknown keys and enums at nested
paths enumerated with `z.toJSONSchema`. Design's field review checks the field
inventory; unit tests never read the product spec. Retained card schemas in
`Cards` and `Changes` have committed JSON Schema snapshots. The app architecture
and flow parity tests enforce the View and Container seam.

```bash
pnpm --filter @smthrs/rpc test
bun test apps/app/src/mainview/Architecture.test.ts
bun test apps/app/src/mainview/flows/cardActions.test.ts apps/app/src/mainview/flows/parity.test.ts
```
