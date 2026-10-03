---
title: "Installation"
description: "Install @smthrs/notifications, the journal a durable composition provides, the HTTP client the webhook sink needs, and the import forms."
sidebar:
  order: 1
---

## Install the package

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. It is built on
[`effect`](https://effect.website) and [`@smthrs/journal`](/api/journal). Declare
`@smthrs/journal` in your own package as well: the compositions below import it
directly, and a strict package manager resolves only the dependencies you have
named.

## Provide a journal

Every durable operation goes through a `Journal.Journal`. The queue writes one
admission record per notification and one promotion record per boundary, and it
rebuilds its state by reading them back, so a composition without a journal has
no queue. `NotificationQueue.layer` states that requirement in its type:

```ts
import { NotificationQueue } from "@smthrs/notifications"

// Layer.Layer<NotificationQueue.NotificationQueue, never, Journal.Journal>
export const queue = NotificationQueue.layer
```

For a real deployment, the journal is the SQLite one, over a database and a
migration run:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Migrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { NotificationQueue } from "@smthrs/notifications"
import * as Layer from "effect/Layer"

export const durableQueue = (filename: string) =>
  NotificationQueue.layer.pipe(
    Layer.provideMerge(
      SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
        Layer.provide(
          Layer.provideMerge(
            Migrations.layer,
            Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
          )
        )
      )
    )
  )
```

Point a second process at the same file and it reads the same queue. That is
the whole reason the state lives in the journal rather than in the layer, and
[the journal records](./concepts/journal-records.md) explains what is written.

`NotificationQueue.layerWith({ capacity })` is the same layer at a bound the
composition chooses. `NotificationQueue.layerNoop()` needs no journal at all and
fails every method; see [Test against the queue](./guides/testing.md).

## What alerting adds

`Alerts.layer(policy)` needs the journal, the queue, and a sink. The noop sink
needs nothing:

```ts
import { Alerts, NotificationQueue } from "@smthrs/notifications"
import * as Layer from "effect/Layer"

export const alerting = (policy: Alerts.Policy) =>
  Alerts.layer(policy).pipe(
    Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, Alerts.layerNoop))
  )
```

`Alerts.layerWebhook` POSTs each alert using its own Fetch HTTP client.
The platform must provide `fetch`; no further install or `HttpClient` layer is
required:

```ts
import { Alerts } from "@smthrs/notifications"

export const webhook = Alerts.layerWebhook({ url: "https://pager.example/alerts" })
```

Injected `HttpClient` layers are not used. The sink controls redirect refusal
and request cleanup. See [Send alerts to a webhook](guides/send-alerts-to-a-webhook.md)
for Fetch configuration and delivery behavior.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Alerts, Notification, NotificationQueue, SteerPayload } from "@smthrs/notifications"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as NotificationQueue from "@smthrs/notifications/NotificationQueue"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"
```

Two subpath forms are blocked in the export map: `@smthrs/notifications/internal/*`
and `@smthrs/notifications/*/index`. `@smthrs/notifications/package.json` is
exported.

## Next step

Admit and drain a notification end to end in the
[Quickstart](./quickstart.md).
