---
title: "What replaced the 0.x umbrella"
description: "Every construct the smthrs facade exported in Smithers 0.x, and the 1.0 package and concept to rewrite it against. Nothing in the table is source compatible."
---

Smithers 0.x published `smthrs` as an umbrella facade over the JSX authoring
API, the React reconciler and renderer, and fourteen `@smthrs/*` packages.
Smithers 1.0 replaces that architecture with the `Flow`, `Action`, `Node`, and
Effect APIs.

Nothing below has a source-compatible replacement. Each row names the concept
to rewrite against, not a symbol to swap in.

| Removed from `smthrs`                                                       | Replacement in 1.0                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smthrs/jsx-runtime`, `smthrs/jsx-dev-runtime`, `jsxImportSource: "smthrs"` | No JSX authoring API. Author a flow in TypeScript with `Flow` and `Action` from [`@smthrs/flow`](/api/flow), or, with current discovery support, as `flows/<name>/flow.mdx`. The chosen TypeScript-entry/imported-MDX direction is not landed yet.                         |
| `Workflow` and `Task` components                                            | `Flow.make(tag, { payload, success, error, body })` and `Action.make` ([`@smthrs/flow`](/api/flow)). A model-backed step is `AgentAction.make` ([`@smthrs/agent`](/api/agent)). |
| `Sequence`, `Parallel`, `Branch` components                                 | `Node.andThen`, `Node.all`, and `Node.branch` ([`@smthrs/plan`](/api/plan)).                                                                                                    |
| `Loop`, `Ralph`, `ReviewLoop` components                                    | `ReviewLoop.run`, or `Recursion.recurse` with an explicit fuel, depth, and fanout envelope ([`@smthrs/patterns`](/api/smithers-patterns)).                                      |
| `SmithersRenderer`, `createSmithers`, `runWorkflow`, the React reconciler   | `FlowEngine` and `FlowProxy` ([`@smthrs/engine`](/api/engine)), composed through `@smthrs/flows/NodeRuntime`.                                                                   |
| `Approval`, `HumanTask`, `Wait`, `Signal` components                        | `DurableDeferred`, `HumanTask`, `WaitFor`, and `Sleep` ([`@smthrs/flow`](/api/flow)), with approvals and steering on the control plane ([`@smthrs/control`](/api/control)).     |
| Output accessors and workflow context hooks                                 | Journal projections and the run store ([`@smthrs/journal`](/api/journal), [`@smthrs/run-store`](/api/run-store)).                                                               |
| `mdx-plugin`, JSX workflow loaders and templates                            | Flow descriptor discovery ([`@smthrs/registry`](/api/registry)).                                                                                                                |
| Backend selection and direct database helpers                               | [`@smthrs/database`](/api/database) and [`@smthrs/engine-store`](/api/engine-store). SQLite and PostgreSQL adapters are shipped in the rc.1 source checkout; host composition determines which is available.                                        |
| The `smithers` binary published by `smthrs`                                 | [`@smthrs/cli`](/api/cli), which owns both the `smthrs` and `smithers` spellings of one executable.                                                                             |

Workflow files move with the API. `.smithers/workflows/pipelines/ci-fast.tsx`
becomes `flows/pipelines/ci-fast/flow.ts`, keeping its position, and
`smithers.config.ts` has no 1.0 equivalent.

## The mapping the tool applies is larger than this

The table above is the shape of the change. `smthrs migrate` carries the
construct-level mapping, hundreds of rows covering every export of the facade,
and records row by row in `.smithers-migrate/report.md` what it rewrote and
what it could not translate. A construct with no safe translation is left as a
`TODO(migrate-smithers-v1)` marker rather than an imitation. See
[`smthrs migrate`](/cli/migrate) and the [1.0 migration guide](/migration/1.0).

## Run state does not carry over

Smithers 1.0.0-rc.0 never loads, resumes, or migrates a 0.x run database.
Finish, archive, or discard every unfinished 0.x run with the 0.x CLI
(`bunx smthrs@0.35.0 ps`) before you upgrade; `smthrs migrate` refuses a
project whose `smithers.db` still holds runs that have not finished, and no
flag releases that refusal. The policy is frozen on the
[compatibility policy](/migration/compatibility) page.
