---
title: "Installation"
description: "How to get @smthrs/triggers, what it requires at runtime, the import forms it publishes, and the packages a running host adds on top."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/triggers/docs/installation.md"
---

## Get the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

The installed manifest resolves to the synchronized RC:

```json
{
  "dependencies": {
    "@smthrs/triggers": "1.0.0-rc.1"
  }
}
```

## Requirements

- Node.js 26.4.0 or later.
- [`effect`](https://effect.website) 4.0.0-rc.115, which supplies the `Effect`,
  `Schema`, `Clock`, and SQL client types this package's signatures use.
- [`@smthrs/control`](https://control.smithers.sh/reference/api/), the authoritative launch boundary. The
  scheduler's Control-backed runner and every channel dispatch go through it.
- [`@smthrs/database`](https://database.smithers.sh/reference/api/), for the SQL client and the durable
  writer that `SqlTriggerStore` writes through.

All three are ordinary dependencies of the package and install with it.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Cron, DispatchReader, Scheduler, SqlTriggerStore, Trigger, TriggerStore, Webhook } from "@smthrs/triggers"
```

Each module is also importable from its own subpath, which is the form these
docs use:

```ts
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
```

The in-memory store for tests lives at its own subpath:

```ts
import * as TestTriggers from "@smthrs/triggers/test/TestTriggers"
```

Three subpath forms are not public and are blocked in the package's export map:
`@smthrs/triggers/migrations/*`, `@smthrs/triggers/internal/*`, and
`@smthrs/triggers/*/index`. `@smthrs/triggers/package.json` is exported.

Migrations are internal on purpose. `SqlTriggerStore.layer` applies
`0001_triggers` and then `0002_reservation_lease` when it builds, so a host
never runs them itself.

## What a running host adds

The package declares triggers and channels; it does not open a database or
reach a control plane. A host that actually fires triggers composes three more
layers:

- A SQL client and a durable writer, from
  [`@smthrs/database`](https://database.smithers.sh/reference/api/). `NodeDatabase.layer({ filename })` plus
  `DurableWriter.layer()` is the Node pairing.
- `SqlTriggerStore.layer`, which turns those two into a `TriggerStore`.
- A `Scheduler.Runner`. `Scheduler.layerControlRunner` is the production one
  and requires `Control.Control` from [`@smthrs/control`](https://control.smithers.sh/reference/api/).

The composition is in [Run the scheduler in a host](/guides/run-the-scheduler/).

## Next step

Register a trigger and watch it launch in the [Quickstart](/quickstart/).
