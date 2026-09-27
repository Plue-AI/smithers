---
title: "@smthrs/triggers"
description: "Durable cron triggers and verified inbound channels for flows: a scheduler that survives restarts, leased claims and a runner deduplication contract, and webhook doors that carry no execution authority."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/triggers/docs/README.md"
---

`@smthrs/triggers` starts flows on a clock, and lets an outside system start
them over HTTP. A **flow** is a durable workflow, declared with
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) and addressed by a stable id. A **trigger** is a
durable row: a flow id, a JSON input, and a cron expression. A **channel** is a
verified door: it authenticates raw request bytes and maps them onto a start or
a signal.

## What it is for

Writing a cron loop is easy. The parts that are not easy are the ones this
package spends its code on:

- **Coordinating claims across two hosts.** Both hosts notice the 03:00 boundary.
  The store grants a leased reservation. Recovery can retry that occurrence,
  so preventing duplicate runs requires runner deduplication.
- **Deciding what a boundary means when the previous run is still going.** Skip
  it, remember the newest one, or cancel the run in flight and replace it.
- **Knowing what a trigger owes after the process was down for six hours.** Owe
  nothing, owe the most recent missed boundary, or owe all of them, bounded by
  a number the declaration states.
- **Accepting an inbound request without handing it authority.** A verified
  webhook payload can ask for a start or a signal. It cannot widen what the run
  is then allowed to do: the capabilities and the budget stay the ones
  [`@smthrs/control`](https://control.smithers.sh/reference/api/) already grants that flow. A mistaken
  declaration starts the wrong flow rather than escalating a privilege.

Scheduled dispatch makes at-least-once launch attempts. `RunnerService.start`
must durably deduplicate by `idempotencyKey` and return the same run identity on
replay, including across host restarts.

Reach for a queue instead when every unit of work must survive: a trigger
coalesces, and that is deliberate. A nightly report that ran long owes you the
latest report, not four of them.

## Who uses this package

Hosts use it. A **host** is the long-lived process that keeps flows running: a
server, a worker, or the `smthrs` command line. It composes the scheduler into
its runtime so registered triggers keep firing, and declares webhook doors so an
outside system can start a flow. Flow authors do not import it: a trigger points
at a flow by id, and the flow itself never learns that a clock started it.

## Install

`@smthrs/triggers` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and
[Installation](/installation/) covers how to depend on it from a checkout,
what it requires at runtime, and which packages a running host adds.

## The smallest declaration

A trigger is data. `Trigger.make` decodes it, fills the policy defaults, and
refuses a cron expression that the calendar never satisfies:

```ts
import * as Trigger from "@smthrs/triggers/Trigger"

const nightly = Trigger.make({
  id: "nightly-report",
  flowId: "reports/nightly",
  input: { channel: "#ops" },
  cron: "0 3 * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "one",
  maxCatchUp: 1,
  enabled: true
})
```

`nightly` is an `Effect<Trigger, TriggerError>`. Registering it in a
`TriggerStore` makes it durable, and a running `Scheduler` fires it from there.
For the whole path, including the launch, see the
[Quickstart](/quickstart/).

## Where this sits

Flows themselves are written with [`@smthrs/flow`](https://flow.smithers.sh/reference/api/), and nothing here
executes one. A trigger names a flow and hands the launch to
[`@smthrs/control`](https://control.smithers.sh/reference/api/), the control plane every run is admitted
through, so the flow's own authority, its approvals, and the host's permission
checks apply exactly as they would if a person had started it.

When that flow is an agent session, the package that executes it is
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/), which owns the agent loop and ships
`AgentSession` as the production executor Control launches through.
`@smthrs/triggers` is one layer out from that: the clock and the front door in
front of an agent, rather than any part of the agent itself. Read
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) for what a launched run actually does.

[`@smthrs/cli`](https://cli.smithers.sh/reference/api/) is the top of that stack: the `smthrs` command line
an operator installs, which composes `@smthrs/agent` and the rest of Smithers
into one executable. Start there if you want the whole product rather than one
of its parts.

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/triggers/<Module>`:

| Namespace         | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `Trigger`         | The trigger declaration: a flow id, a JSON input, a schedule, and an enabled flag.           |
| `Schedule`        | The reusable schedule half of a declaration: cron, timezone, and the two policies.           |
| `Cron`            | Typed wrappers around Effect's cron: parse, next, previous, and a bounded occurrence search. |
| `Overlap`         | The pure decision for an occurrence that arrives while a run is in flight.                   |
| `CatchUp`         | The pure computation of what a trigger owes after downtime, bounded by its declaration.      |
| `TriggerStore`    | The durable state contract: registration, listing, the claim protocol, and results.          |
| `SqlTriggerStore` | The SQLite and PostgreSQL implementation of that contract, with its own migrations.          |
| `Scheduler`       | The Clock-driven poller, and the `Runner` port it launches through.                          |
| `DispatchReader`  | The `@smthrs/control` read port served from a store: trigger summaries and the fire ledger.  |
| `Channel`         | The authority-free inbound channel declaration: verify, then map to a start or a signal.     |
| `Webhook`         | A verified webhook door built on `Channel`, dispatching only through Control.                |
| `TriggerError`    | The one failure type, carrying a stable code and an optional field path.                     |

Every export, with signatures and guarantees, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and the
  packages a running host adds.
- [Quickstart](/quickstart/): register a trigger and watch it launch, end to
  end, in milliseconds.
- Concepts: [cron schedules and occurrences](/concepts/schedules/),
  [overlap and catch-up](/concepts/policies/),
  [the claim protocol](/concepts/claim-protocol/), and
  [authority-free channels](/concepts/channels/).
- Guides: [declare and register a trigger](/guides/declare-a-trigger/),
  [run the scheduler in a host](/guides/run-the-scheduler/),
  [choose an overlap and catch-up policy](/guides/choose-a-policy/),
  [ingest a verified webhook](/guides/ingest-a-webhook/), and
  [test trigger code](/guides/testing/).
- [Troubleshooting](/troubleshooting/): every failure code, what causes it,
  and what to change.
