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

| Module             | Schema and inferred type                     | Data                                                                      |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------- |
| ActorChipCard      | ActorChipCardSchema, ActorChipCard           | Actor, chip size and whether the agent is working now                     |
| SetupCard          | SetupCardSchema, SetupCard                   | Address, the seven setup steps, this Mac, GitHub, repository and models   |
| SettingsCard       | SettingsCardSchema, SettingsCard             | Setup fields plus capacity, parallel, laptop lines, health and Obsidian   |
| EntryRowCard       | EntryRowCardSchema, EntryRowCard             | Author, title, summary, tone, TODO state, context and action              |
| ContextLineCard    | ContextLineCardSchema, ContextLineCard       | Context count, items and expansion                                        |
| BranchTreeNodeCard | BranchTreeNodeCardSchema, BranchTreeNodeCard | Recursive open-branch tree and presence                                   |
| HomeCard           | HomeCardSchema, HomeCard                     | Main sync, attention, stack items, counts, machines and background runs   |
| FileCard           | FileCardSchema, FileCard                     | Content, mode, diagnostics, hover, reveal, gone, outside and co-edit data |
| DiffCard           | DiffCardSchema, DiffCard                     | Comparison base, change kind, binary sizes and hunks                      |
| DraftCard          | DraftCardSchema, DraftCard                   | Title, prompt, acceptance, placement, issue, seed and commit receipt      |
| TodoCard           | TodoCardSchema, TodoCard                     | Nine TODO states, steps, open waits, steers, rebase, evidence and PR      |
| ToastCard          | ToastCardSchema, ToastStackCardSchema, ...   | Toasts, the toast stack, the edge map and per-member shell view state     |
| TimelineCard       | TimelineCardSchema, TimelineCard             | One line per entry and the on-screen band                                 |
| ConfirmCard        | ConfirmCardSchema, ConfirmCard               | Kind, action, summary, subject, who asked, review and receipt             |
| MembersCard        | MembersCardSchema, MembersCard               | People, colours, roles, access, suspension and row actions                |
| CommandsCard       | CommandsCardSchema, CommandsCard             | Command groups with synopsis, description and agent policy                |
| FlowCard           | FlowCardSchema, FlowCard                     | Source, versions, step agents and merge-wait signals                      |
| MonitorCard        | MonitorCardSchema, MonitorCard               | Attempts, step instances, phases, cells, waits, journal and replay        |
| AgentCard          | AgentCardSchema, AgentCard                   | Instructions, model role and choices, and runs it took part in            |
| BranchCard         | BranchCardSchema, BranchCard                 | Machine, item or scratch, rebase, presence, terminals and activity        |
| TerminalCard       | TerminalCardSchema, TerminalCard             | Owner, agents, watchers, command and frozen state                         |
| SecretsCard        | SecretsCardSchema, SecretsCard               | Secret names, scopes, bound hosts and row actions; no values              |
| DocsCard           | DocsCardSchema, DocsCard                     | Bundled table of contents, page, anchor and not-found state               |
| DebugApiCard       | DebugApiCardSchema, DebugApiCard             | API operations, the selection, a pending mutation and the exchange        |
| ProposalCard       | ProposalCardSchema, ProposalCard             | Evidence, references, state and the TODO it became                        |

Each module also exports its View's props type, such as `TodoViewProps` or
`CodeEditorViewProps`, and any card-specific view state, such as `FileView`,
`RunView` or `DebugApiView`.

Shared actor, person, state, tone, machine, merge and evidence schemas live in
`CardPrimitives`. Every agent doing work, Smithers included (`agent:
"smithers"`), is a participant with a stable `id`, its own `avatar_url`, an
optional session or run id and an optional `for_member`, which confers no
authorization (M-34). Claude Code and Codex are agents, never a person's `via`.
The system actor is a bare install event. `color_index` 0–5 is a member's
colour, also taken by work done for that member; 6 is work for nobody; 7 is
neutral for GitHub users, outside writes and install events. A TODO lists each open wait with its own id and
actions, plus its steers. Evidence items are typed: the diff stat, machine and
GitHub checks, the review summary, usage, the flow version and the model access.
Each names its revision and may keep the previous revision's review. TODO, Home
and Confirm share one merge shape. Run (MonitorCard) attempts own their phases, cells and step
instances; titles and labels render before optional model summaries arrive.
Links use the existing HTTP URL validator; fixture avatars use a bundled
placeholder.

## Actions and callbacks

`CardAction` exports `ActionSchema`, `Action`, `FormFieldSchema`, `BaseView`,
`CardProps` and `CardCallbacks`. An action's `args` are bound by the Container;
the View passes them back unchanged with its form input. `CardProps<Model, View,
Gesture>` adds the card's own view fields to `BaseView` and names its non-button
gestures. Each actionable card exports a `*CardCallbacks` mapping from its
command tags to `(input) => void`, using `CardCommandInput`. Three commands also
export zod inputs: `DraftDiscardInputSchema` (`{draft}`),
`ConfirmCancelInputSchema` (`{confirmation, revision}`; the server refuses a
stale revision as `stale`) and `SettingsModelSetInputSchema` (`{role, model}`,
with the shared model role enum and a catalog model id). Who may run each is
catalog policy, not an input field.

`catalog/index` exports the temporary catalog tag union: Appendix A plus the
Appendix B controls the cards need. T-CAT-01 replaces the placeholder at that
same module path and derives command inputs from catalog payload schemas.
No command is registered by these data modules.

A Container gives the app's `flows/cardActions` helper viewer-filtered action
definitions and their typed command inputs. The helper preserves order and
returns props-only `actions`, named `gestures` and `onAction`, bound through
`flowAction`. Definitions may supply an input resolver for forms. Repeated tags
on separate rows use `forScope(rowId)`, which keeps each row's input and callback
together. `actionProps(tag)` preloads with the command's canonical `flowArgs`
line; an action with a secret field or a secret-bearing command preloads by tag
only, so a secret never reaches a DOM attribute.
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
`@smthrs/rpc/fixtures/<Card>`, and expose a named `fixtures` record of stories:
`{name, model, actions, gestures, view, expect}`, where `expect` lists strings
the View must show, each carried by the model or its actions (C-UI-12). They
cover the states T-APP-19 lists. `test/cards/*Card.test.ts` suites parse each
story's model and mutate required fields, unknown keys and enums at nested
paths enumerated with `z.toJSONSchema`; literal value lists check key enums
independently of the schemas. Design's field review checks the field
inventory; unit tests never read the product spec. Retained card schemas in
`Cards` and `Changes` have committed JSON Schema snapshots. The app architecture
and flow parity tests enforce the View and Container seam.

```bash
pnpm --filter @smthrs/rpc test
bun test apps/app/src/mainview/Architecture.test.ts
bun test apps/app/src/mainview/flows/cardActions.test.ts apps/app/src/mainview/flows/parity.test.ts
```

## TODO API resource

`@smthrs/rpc/Todo` decodes the REST `/api/todos` resource. `TodoCard` decodes
its display model. Both share `TodoStateSchema`, `QueueSchema` and
`NeedsYouKindSchema` from `CardPrimitives`. REST `ActorRefSchema` carries
`person {id, via?, session?}`, `agent {agent, run, todo?}` or `system {name}`,
discriminated by `kind`; cards resolve those ids to display identities.
