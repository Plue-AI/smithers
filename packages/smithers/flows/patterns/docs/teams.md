---
title: "Teams"
description: "Supervisor, Intervene, CheckSuite, Kanban, Runbook, and MergeQueue: the @smthrs/patterns shapes that coordinate several agents, gate the risky steps, and fix a landing order."
---

This page covers the six `@smthrs/patterns` modules that coordinate several agents as a team: `Supervisor`, `Intervene`, `CheckSuite`, `Kanban`, `Runbook`, and `MergeQueue`. They build on the composition primitives `Pattern`, `WithApproval`, and `MapReduce`, which are in [the API reference](./api.md).

Every module here follows the two-surface shape the package uses everywhere:

| Surface               | What it is                                                                                                    | When to use it                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `make(options)`       | A `Flow` whose body is a conservative plan-time topology over `@smthrs/flow` `Flow` and `@smthrs/plan` `Node` | Planning, graph inspection, step keys, cost estimates |
| `run(input, options)` | An `Effect` that performs the value-dependent branching                                                       | Execution                                             |

`make` declares a superset of any single execution: graph planning evaluates a `Node.bindPlanned` builder once against a symbolic value, so the plan carries every arm a real result could take. A decision on a real result is a `Node.branch`, so an executed declaration takes the same arm `run` takes. `test/Parity.test.ts` runs both surfaces on the same scripted members for every pattern and requires the same outcome and the same calls; the few documented exceptions are pinned there as known divergences.

Options that change behavior are declared through `Node.capture`, so two plans that differ only in a bound have different step identity.

A declared flow joins its members with `Node.andThen`, `Node.all`, and `Node.catch`. The first two do not continue past a failed member; `Node.catch` is the recovery arm that lets a declaration continue anyway. `CheckSuite`'s `continueOnFail`, `Kanban`'s per-item continuation, and `MergeQueue`'s `failurePolicy: "quarantine"` are declared through that arm, so the plan tolerates what `run` tolerates. `Runbook`'s `onDeny: "skip"` stays a `run` option and `make` refuses it: a denial and a step failure share one error channel, so an arm around the gated step would also declare that a runbook continues past a failed critical step. Each section below repeats this where it applies.

Every arm on this page isolates typed failures only, the rule [`Quarantine`](./api.md#quarantine) states. A member that throws raises a defect, and a defect is not a tolerated outcome: it fails the run and cancels the members beside it. Interruption propagates for the same reason. [`Sidecar`](./loops.md#sidecar) quarantines a shadow defect, because a shadow is an experiment rather than a member of the result.

## `Supervisor`

A boss plans the work, workers execute it in parallel, the boss reviews every outcome, and only the tasks the review names retriable run again.

```ts
import * as Supervisor from "@smthrs/patterns/Supervisor"

const supervisor = Supervisor.make({
  plan,
  workers: { coder, tester },
  review,
  finalize,
  maxRounds: 3,
  maxTasks: 20,
  concurrency: 2
})
```

### Declaration

The topology comes from the plan's task list, so the flow input carries it as `tasks`:

```ts
Graph.build(supervisor, { goal: "ship the feature", tasks: [{ id: "api", workerType: "coder" }] })
```

`make` builds one plan call, then `maxRounds` repetitions of "one call per task, then review", with a finalize call on each review's accepted arm. Each decision is a `Node.branch` on the real value, so an executed declaration makes the calls `run` makes and settles to the same `Completed` or `Exhausted` result: a typed worker failure is a `Failed` outcome, a later round calls only the tasks the review named retriable, and an exhausted supervision does not finalize. Each task is routed to the worker its `workerType` names, and the member is named by the task id. Worker calls are batched into `Node.all` groups of `concurrency` members, and the batches are sequenced, so the declared plan never admits more parallel worker calls than the bound. Every call carries a `phase` field (`"plan"`, `"work"`, `"review"`, `"finalize"`) so a built graph names what each node does.

Every round after the first passes the preceding review and its `retriable` ids to each worker call, so the graph shows which review a re-delegation depends on. A round-one worker call has no such reference.

Task ids such as `"__proto__"`, `"constructor"`, and `"toString"` are supported. Each remains an own member of its declared batch and the results passed to review and finalize.

`maxTasks` caps the task list. A plan comes from a model, and each task costs one worker call per round, so a longer list is refused before any call.

`make` throws a `PatternError` when `workers` is empty, or when `maxRounds`, `maxTasks`, or `concurrency` is not a positive safe integer. Building the flow throws when the input carries no `tasks` array, when it is empty or longer than `maxTasks`, when a task is missing a string `id` or `workerType`, when two tasks share an id, or when a `workerType` names no declared worker.

### Execution

`run` plans once, then per round:

1. Runs the pending tasks through `worker` with `Effect.forEach` at `concurrency`. A typed worker failure is captured as a `Failed` outcome rather than failing the supervision, so the review sees it. A worker defect is not an outcome: it fails the supervision and cancels the workers still in flight.
2. Calls `review` with every task's latest outcome.
3. Finalizes and returns `{ exhausted: false, rounds, final }` when the review is done, which means the review carries its own `allDone: true` or is the value `true`.
4. Otherwise re-delegates only the task ids listed in the review's own `retriable` array.

The supervision returns `{ exhausted: true, rounds, review }` and does not call `finalize` when the round bound is reached, or when an unaccepted review names no retriable task: nothing is left to re-delegate.

`run` fails with a `PatternError` `invalid_input` when the plan names more than `maxTasks` tasks, before any worker runs, and when the plan repeats a task id, because outcomes are keyed by task id and a repeated id would delegate twice and hand the review the same outcome twice.

| Export              | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `Task`              | `{ id, workerType }`, one unit of delegated work       |
| `Plan`              | `{ tasks }`, what the plan call must produce           |
| `Outcome<Out>`      | `Done` or `Failed` for one worker attempt in one round |
| `Completed<Final>`  | An accepted review, finalized                          |
| `Exhausted<Review>` | Rounds ran out, or nothing was retriable               |

## `Intervene`

Read a target, propose a change, apply it behind an optional approval, and report what happened. This is the reusable shape behind a code-intervention agent: the proposal is always produced, the write is always gated.

```ts
import * as Intervene from "@smthrs/patterns/Intervene"

const intervention = Intervene.make({
  read,
  propose,
  apply,
  report,
  dryRun: false,
  approval,
  reason: "rewrite the module"
})
```

### Declaration

`dryRun: true` removes the apply call from the declaration, so a dry-run plan cannot reach a writing step at all. It is not a runtime flag the apply step is expected to honor.

When `approval` is supplied, `make` wraps the apply flow with `WithApproval.withApproval`, so the built graph shows the approval call ahead of apply. The approval flow must declare its output as `WithApproval.Approved`, the literal `"approved"`, so a denial cannot decode and fails on the typed schema-error channel before apply starts. `make` throws when the supplied approval flow permits any other value.

### Execution

`run` reads, proposes, then either reports the proposal alone (`dryRun`) or decides the approval, applies, and reports what was written. `report` always receives `{ input, proposal, applied, dryRun }`; `applied` is `undefined` on a dry run.

`reason` defaults to `"apply the proposed intervention"`.

## `CheckSuite`

Run independent checks with bounded concurrency and reduce their rows to one verdict.

```ts
import * as CheckSuite from "@smthrs/patterns/CheckSuite"

const suite = CheckSuite.make({
  checks: { lint, test },
  strategy: "all-pass",
  concurrency: 2,
  continueOnFail: true
})
```

`checks` is a record keyed by check id, so two checks cannot share an id. The checks run in the record's key order, which is the order the keys were written unless an id looks like an array index: JavaScript orders those first.

### Verdict strategies

| Strategy   | Passes when                                         |
| ---------- | --------------------------------------------------- |
| `all-pass` | Every check passed, and there is at least one check |
| `majority` | More than half the checks passed                    |
| `any-pass` | At least one check passed                           |

An empty suite never passes under any strategy.

`CheckSuite.passed(row)` classifies one check's row: a missing row fails, an object row fails on `passed: false`, `ok: false`, `failed: true`, or an `error` other than `undefined`, `null`, or `false`, and anything else passes. An empty string in `error` is a failure. `CheckSuite.rows(values, ids, quarantineOutcomes)` classifies the record a batch of calls produces, in declaration order. `quarantineOutcomes` defaults to `false`: rows are treated as check output, without decoding quarantine envelopes. Pass `true` for a tolerant join:

```ts
const results = CheckSuite.rows(values, ids, true)
const verdict = CheckSuite.verdict(results, "all-pass")
```

`CheckSuite.verdict(results, strategy)` reduces classified results and is exported so a caller can re-decide a recorded suite under a different strategy.

### Declaration

`make` declares one call per check, batched into `Node.all` groups of `concurrency` members, then one pure verdict map. Each call is a `Node.all` member named by its check id. `continueOnFail` changes the topology and is captured as well, so a tolerant suite and a fail-fast suite have different step identity.

`continueOnFail` picks the join. A tolerant suite joins each batch with `Quarantine.all` under the `quarantine` policy, so every check settles as an explicit `Succeeded` or `Quarantined` envelope. `rows(values, ids, true)` unwraps successful rows and classifies quarantined failures, retaining their errors. `make` supplies this flag from `continueOnFail`. A fail-fast suite joins under `halt`, the plain `Node.all` that fails on the first failing member and interrupts the rest.

`make` throws a `PatternError` when the record is empty, when an id is the empty string, or when `concurrency` is not a positive safe integer.

### Execution

With `continueOnFail: false` the first failing check fails the suite and the remaining checks do not run. With `continueOnFail: true` every check runs and a failed one is listed in the verdict's `failed`. Its original error is retained in `errors[checkId]`, including falsy error values.

`continueOnFail` tolerates a typed check failure. A check that throws raises a defect, which fails the suite under either setting and cancels the checks still in flight.

A check that succeeds but returns a failure row is always listed in `failed`. It does not fail the suite, because the row is the check's answer, not an error. A row's `error` is retained when it is other than `undefined`, `null`, or `false`.

`CheckResult.error` is optional. `Verdict.errors` is a record keyed by check id, empty when no errors were retained. A failed check without an error has no entry. Errors do not change the verdict decision; a majority or any-pass verdict can pass while retaining failed checks' errors.

`run` takes the same record, with each value an `(input) => Effect` instead of a flow. It rejects the same suites `make` rejects, and it rejects them before any check runs: an empty record, an empty check id, and a `concurrency` that is not a positive safe integer each fail with a `PatternError`. An empty record fails rather than returning a false verdict, which would read like a failing suite rather than like a misconfigured one.

### Command checks

`CheckSuite` runs flows, not commands. A command check is a shell flow from [`@smthrs/std`](/api/std), `Bash` or `ShellCommand`, composed under `CheckSuite` with a row that carries `ok`, `passed`, or `error` so `CheckSuite.passed` can classify it. The timeout, the output capture, and the exit-code reading belong to that shell flow, and you configure them there. `CheckSuite` adds the concurrency bound, the declaration order, and the verdict.

## `Kanban`

Move every item through an ordered list of columns, with a concurrency bound applied inside each column.

```ts
import * as Kanban from "@smthrs/patterns/Kanban"

const board = Kanban.make({
  columns: [{ name: "triage", flow: triage }, { name: "build", flow: build }],
  items: [{ id: "a" }, { id: "b" }, { id: "c" }],
  concurrency: 2,
  onComplete: report
})
```

### Declaration

`make` declares one call per item per column. Calls inside a column are batched into `Node.all` groups of `concurrency` members and the batches are sequenced, so the plan never admits more parallel calls than the bound. Columns are sequenced too: a column's first call depends on the whole preceding column.

Every call receives `{ column, item, previous }`. `previous` refers to the same item's result in the preceding column, so a built graph shows a per-item chain across columns rather than one column-wide barrier value.

`make` throws a `PatternError` when there are no columns, no items, a duplicate item id, a duplicate column name, or a concurrency that is not a positive safe integer.

A column joins its batch with `Quarantine.all` under the `quarantine` policy: every card settles as a `Succeeded` or `Quarantined` envelope, so one rejected card does not interrupt the cards beside it. A later column's call for a card is the live arm of a `Node.branch` on the real set of rejected cards, so a rejected card makes no further call, as in `run`. A board's declared call count is an upper bound on the calls a pass makes. The declared flow settles to the same `{ board, completed, failed, iterations: 1 }` record one `run` pass returns; `onComplete` sees it and its own answer is discarded.

### Execution

`run(items, options)` returns `{ board, completed, failed, iterations }`.

| Field        | Contents                                                                             |
| ------------ | ------------------------------------------------------------------------------------ |
| `board`      | One row per item that cleared at least one column, keyed by item id then column name |
| `completed`  | Item ids that cleared every column, in declaration order                             |
| `failed`     | `{ id, column, error }` for each item a column rejected                              |
| `iterations` | Passes the board ran                                                                 |

A column rejects an item by failing on the typed channel. The item is dropped from the board and listed in `failed`; the other items keep moving, and the column that rejected it is named. A rejected item never reaches a later column, so `board` has no row for an item the first column rejected. A card that throws is not a rejection: the defect fails the pass and cancels the cards beside it.

`maxIterations` is the number of passes the board runs over the same items, and defaults to one. `until` stops the board early, after the pass whose result satisfies the predicate, and requires `maxIterations`, because a predicate that never holds would otherwise run forever. Each pass starts from an empty board, and the returned board is the last pass's.

`onComplete` runs exactly once after the final pass with `{ items, board }`. Its failure is the run's failure. `run` refuses the same empty item list and duplicate column names that `make` refuses.

## `Runbook`

An ordered list of steps where a step's risk decides whether an approval gates it, and a denial either stops the runbook or skips the step.

```ts
import * as Runbook from "@smthrs/patterns/Runbook"

const release = Runbook.make({
  steps: [
    { id: "backup", flow: backup, risk: "safe" },
    { id: "deploy", flow: deploy, risk: "risky" },
    { id: "migrate", flow: migrate, risk: "critical" }
  ],
  approval,
  onDeny: "fail"
})
```

### Risk

| Risk       | Approval                    | Request           |
| ---------- | --------------------------- | ----------------- |
| `safe`     | None. The step runs unasked | No request        |
| `risky`    | Required                    | `elevated: false` |
| `critical` | Required                    | `elevated: true`  |

`Runbook.gated(risk)` and `Runbook.elevated(risk)` are exported, so a caller can classify a recorded step without rebuilding the runbook.

### Declaration

`make` chains the steps in declaration order and wraps every non-safe step with `WithApproval.withApproval`. Each step is called with `{ step, risk, elevated, input, previous }`, and the approval that gates a step sees that same envelope, so a built graph names the step an approval belongs to and whether it is elevated. A safe step declares no approval call. The declared flow settles to the same `{ outputs, ran, skipped }` record `run` returns; every step it settles ran.

`onDeny: "skip"` is not declarable, and `make` refuses it rather than building a plan that halts where you asked it to skip. The gated step is one flow whose failure channel carries the denial and the step's own failures together, and a plan has no branch to select between them, so the recovery arm that would skip a denial also declares that the runbook continues past a failed critical step. Declare the runbook with `onDeny: "fail"` and call `run` with `onDeny: "skip"`, which skips a denied step at run time.

`make` throws a `PatternError` when there are no steps, when two steps share an id, when the approval flow permits any value other than the literal `"approved"`, or when `onDeny` is `"skip"`.

### Execution

`run(input, options)` returns `{ outputs, ran, skipped }`. `ran` and `skipped` are disjoint and together name every step; `outputs` holds one entry per step in `ran`.

A non-safe step asks `approve` first, and the answer must decode as `"approved"`.

| `onDeny` | A denial                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `"fail"` | Fails the runbook on the typed schema-error channel. No later step runs                                         |
| `"skip"` | Lists the step in `skipped` and continues. The next step sees the last step that actually ran as its `previous` |

## `MergeQueue`

Land a set of members in one prioritized order, at a concurrency the queue owns rather than the members.

```ts
import * as MergeQueue from "@smthrs/patterns/MergeQueue"

const queue = MergeQueue.make({
  members: [
    { id: "docs", flow: land },
    { id: "hotfix", flow: land, priority: 5000 },
    { id: "feature", flow: land }
  ],
  failurePolicy: "quarantine"
})
```

### Order

`MergeQueue.ordered(members, priority)` resolves each member's effective priority and sorts the queue: descending priority first, then declaration order for members of equal priority. The order is a function of the declaration alone, never of which member became ready first.

A member without its own priority gets `MergeQueue.DefaultPriority`, which is `1000`.

### Declaration

`concurrency` defaults to 1: a merge queue serializes landings unless a caller widens it deliberately. At concurrency 1 the queue is a plain `Node.andThen` chain with no `Node.all` at all, so the declared plan admits exactly one landing at a time. Above 1, members are batched into `Node.all` groups of `concurrency` and the batches are sequenced. Only a `quarantine` queue may widen it: `halt` promises that no member behind a failure lands, and a batch starts its members before any of them has failed, so `make` and `run` refuse `halt` above concurrency 1 with a `PatternError`.

Each call carries `{ id, position, input }`, so a built graph names each member's place in the queue. A member's effective priority reaches the plan as a `Node.priority` annotation, which is what lets the scheduler start the higher-priority ready landing first. Priority stays out of key material, so raising a member's number without changing the resulting order re-uses the same steps rather than re-landing the queue. Every landing settles to a tagged outcome, and one final map folds them in queue order into the same `{ landed, quarantined, order }` record `run` returns.

`failurePolicy` picks the topology and is captured as well. Under `quarantine` every landing carries a recovery arm settling it as MergeQueue's `Quarantined` result, so a failing member neither breaks the serial chain nor interrupts its batch: the queue `run` lands. Under `halt` the chain has no continuation past a failed member, and it is always the serial chain, because a halting queue is refused above concurrency 1.

`make` throws a `PatternError` when there are no members, when two members share an id, when `concurrency` is not a positive safe integer, when `failurePolicy` is `halt` and `concurrency` is above 1, or when `priority` is not a safe integer.

### Execution

`run(input, options)` returns `{ landed, quarantined, order }`. A landed entry is `{ id, output }` and a quarantined entry is `{ id, error }`; neither is tagged, because the arrays already separate them.

| `failurePolicy` | A failing member                                                                 |
| --------------- | -------------------------------------------------------------------------------- |
| `"halt"`        | Fails the queue. No member behind it has started, so none lands                  |
| `"quarantine"`  | Is recorded in `quarantined` and does not land. The members behind it still land |

Both policies read the typed failure channel. A member that throws raises a defect, which fails the queue under either policy and cancels the landings still in flight.

## Worked example

[Intervene on a real workspace](/docs/examples/32-intervene/) runs `Intervene` over [`@smthrs/std`](/api/std): the declaration names `Read.flow` and `Edit.flow` and inherits their capabilities and effect envelopes, and the execution runs their implementations, `Read.run` and `Edit.run`, over a real temp directory. Both surfaces are exercised there: the built graph puts the approval ahead of the write, and a dry-run graph holds no write at all, while the execution rewrites the file once the approval passes and fails before the edit when it is denied.
