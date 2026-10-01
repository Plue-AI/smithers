---
title: "Module index"
description: "All 29 modules of @smthrs/patterns, what each one is for, its import specifier, and the page that documents it."
---

The root entry point exports every module as a namespace, and each module is
also importable on its own subpath:

```ts
import { Saga } from "@smthrs/patterns"
```

```ts
import * as Saga from "@smthrs/patterns/Saga"
```

The two forms give you the same module. `@smthrs/patterns/package.json` is
exported as well. The `internal/*` and nested `*/index` subpaths are private.

Every module name below links to the page that documents it.

## Loops and search

Work whose round count is a runtime fact. [Loops](./loops.md) covers all five,
including the inference rule that inline callbacks need.

| Module                                      | Import specifier                 | What it does                                                                        |
| ------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| [`Loop`](./loops.md#loop)                   | `@smthrs/patterns/Loop`          | Repeat a body until a predicate says stop, bounded by an iteration count            |
| [`Optimizer`](./loops.md#optimizer)         | `@smthrs/patterns/Optimizer`     | Generate, score, and improve until a candidate reaches a target score               |
| [`ScanFixVerify`](./loops.md#scanfixverify) | `@smthrs/patterns/ScanFixVerify` | Scan for issues, fix each one in parallel, verify, and rescan until nothing is left |
| [`DriftDetector`](./loops.md#driftdetector) | `@smthrs/patterns/DriftDetector` | Capture the world, compare it to a baseline, and alert only when it moved           |
| [`Sidecar`](./loops.md#sidecar)             | `@smthrs/patterns/Sidecar`       | Run a cheap shadow beside the primary and measure the gap between them              |

## Deliberation

Several opinions, and a rule for settling them.

| Module                              | Import specifier              | What it does                                                                   |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| [`Debate`](./api.md#debate)         | `@smthrs/patterns/Debate`     | Alternate a proponent and an opponent for a fixed number of rounds, then judge |
| [`Panel`](./api.md#panel)           | `@smthrs/patterns/Panel`      | Ask every panelist once, in parallel, then moderate their opinions             |
| [`ReviewLoop`](./api.md#reviewloop) | `@smthrs/patterns/ReviewLoop` | Produce, review, and revise until the review approves or the rounds run out    |
| [`Escalation`](./api.md#escalation) | `@smthrs/patterns/Escalation` | Walk a ladder of alternative strategies, weakest first, with a fallback rung   |

## Fan-out and fault isolation

How many calls run at once, and what a failure does to the calls beside it.

| Module                                        | Import specifier                   | What it does                                                                       |
| --------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| [`Bounded`](./api.md#bounded)                 | `@smthrs/patterns/Bounded`         | Run a named set of members at most `concurrency` at a time, highest priority first |
| [`Quarantine`](./api.md#quarantine)           | `@smthrs/patterns/Quarantine`      | Settle every member in an explicit envelope so one failure does not halt the rest  |
| [`MapReduce`](./api.md#mapreduce)             | `@smthrs/patterns/MapReduce`       | Map every shard at a bounded concurrency, then reduce the results in shard order   |
| [`Recursion`](./api.md#recursion)             | `@smthrs/patterns/Recursion`       | Expand a literal tree of work under a fuel, depth, and fan-out envelope            |
| [`TryCatchFinally`](./api.md#trycatchfinally) | `@smthrs/patterns/TryCatchFinally` | Protect a body, recover the errors you select, and finalize on every path          |
| [`Saga`](./api.md#saga)                       | `@smthrs/patterns/Saga`            | Run forward steps whose compensations unwind in reverse when one fails             |

## Teams and queues

Several agents coordinated by one owner. [Teams](./teams.md) covers the first
six, and [Burn down a backlog](./burndown.md) covers `Burndown`.

| Module                                | Import specifier              | What it does                                                                             |
| ------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| [`Supervisor`](./teams.md#supervisor) | `@smthrs/patterns/Supervisor` | A boss plans, workers run in parallel, the boss reviews, and only retriable tasks repeat |
| [`Intervene`](./teams.md#intervene)   | `@smthrs/patterns/Intervene`  | Read a target, propose a change, apply it behind an approval, and report                 |
| [`CheckSuite`](./teams.md#checksuite) | `@smthrs/patterns/CheckSuite` | Run independent checks at a bounded concurrency and reduce them to one verdict           |
| [`Kanban`](./teams.md#kanban)         | `@smthrs/patterns/Kanban`     | Move every item through an ordered list of columns, bounded inside each column           |
| [`Runbook`](./teams.md#runbook)       | `@smthrs/patterns/Runbook`    | Run ordered steps whose risk decides which of them an approval gates                     |
| [`MergeQueue`](./teams.md#mergequeue) | `@smthrs/patterns/MergeQueue` | Land a set of members in one prioritized order, at a concurrency the queue owns          |
| [`Burndown`](./burndown.md)           | `@smthrs/patterns/Burndown`   | Claim, work, land, and release every backlog item that is ours, round after round        |

## Delegation

Plans a model writes, admitted against bounds it cannot widen.
[Delegation](./delegation.md) covers both.

| Module                                               | Import specifier                   | What it does                                                           |
| ---------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| [`Trellis`](./delegation.md#trellis)                 | `@smthrs/patterns/Trellis`         | Validate, compile, and execute a model-authored plan under an envelope |
| [`DelegationChain`](./delegation.md#delegationchain) | `@smthrs/patterns/DelegationChain` | The fixed chain: refine, plan, derisk, execute, review, settle         |

## Decorators and building blocks

Wrappers around one flow, and the pieces the patterns are built from.

| Module                                  | Import specifier                | What it does                                                             |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| [`Pattern`](./api.md#pattern)           | `@smthrs/patterns/Pattern`      | Flow-valued slots and the decorator combinator every wrapper applies     |
| [`WithRetry`](./api.md#withretry)       | `@smthrs/patterns/WithRetry`    | Retry a flow or an Effect within an attempt budget and a backoff ladder  |
| [`WithCache`](./api.md#withcache)       | `@smthrs/patterns/WithCache`    | Declare how long a recorded result stays servable and how far it travels |
| [`WithApproval`](./api.md#withapproval) | `@smthrs/patterns/WithApproval` | Run a typed approval flow ahead of the flow it gates                     |
| [`PatternError`](./api.md#patternerror) | `@smthrs/patterns/PatternError` | The tagged failure most of these modules report a refusal through        |
