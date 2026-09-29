---
title: "Add a pane"
description: "Give the agent a component it can put on screen: where a pane file goes, what its props schema guarantees, how the model calls it, and why the registered pane list is the host's to build."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/guides/add-a-pane.md"
---

A pane is a React component the agent renders by name. The model calls
`ui/pane` with a name and a props object, the host emits a card on the turn
stream, and the shell renders the component in the transcript.

## Write the file

A pane lives at `app/panes/<name>.tsx` and exports `Pane`:

```tsx
import { definePane } from "@smthrs/create-app/ui"
import * as Schema from "effect/Schema"

export const Pane = definePane({
  props: Schema.Struct({
    address: Schema.String,
    eth: Schema.String,
    tone: Schema.optionalKey(Schema.Literals(["neutral", "warning"]))
  }),
  title: "Balance",
  render: ({ address, eth, tone }) => (
    <dl className={`pane pane-${tone ?? "neutral"}`}>
      <dt>{address}</dt>
      <dd>{eth} ETH</dd>
    </dl>
  )
})
```

The file name is the pane name, so this is `balance`, and the name must match
the route grammar: lowercase letters, digits, and hyphens, starting with a
letter. Only files directly under `panes/` are panes.
`app/panes/deep/page.tsx` is the page `/panes/deep`.

Run `pnpm routes` after adding the file. `routes.ui.gen.ts` gains the component
and `routes.gen.ts` gains the name in `paneNames`.

## The props schema is the contract

Props reach the shell as `unknown`, because the model wrote them. `definePane`
closes over the schema and exposes two renderers: `render` takes decoded props,
and `renderUnknown` decodes first and throws the schema's own error when the
props are rejected. A shell shows that message in place of the pane, so a
malformed call renders an explanation rather than a broken card.

Annotate the fields you want the model to fill correctly. The annotation
reaches the model as part of the tool's description:

```ts
props: Schema.Struct({
  eth: Schema.String.annotate({ description: "Balance in ETH, already formatted" })
})
```

## Offer a fullscreen presentation

```ts
export const Pane = definePane({ props, title: "Plan", fullscreen: true, render })
```

`fullscreen` defaults to `false`. Set it on the pane definition to offer a
maximize control. Aomi's `PaneHost` reads this capability from the registered
component, even when the Worker emits `fullscreen: false` on the wire card.
The wire flag is metadata for hosts without a pane registry.

A pane starts embedded in the transcript. Maximizing changes the same mounted
host to a fixed overlay; restoring changes it back. Local component state is
preserved. The pane receives `PaneContext` with `fullscreen`, `maximize`, and
`restore`. Context changes can render it again without mounting another
instance.

## Register the name with the tool

Routing a pane makes it exist. Making it callable is the host's job, because
the `ui` binding needs a card sink and a list of registered panes, and both
belong to a turn rather than to a file.

The templates ship a `tools/ui.ts` that builds the binding over a fixed list:

```ts
export const ui: FlowBinding.Source = uiSource(
  Context.add(
    Context.make(CardSink, makeCollecting(collectedCards)),
    PaneNames,
    makePanes([{ name: "balance", fullscreen: false }, { name: "message", fullscreen: false }])
  )
)
```

Add the new name there, or replace the whole value with a source your host
builds per turn from `paneNames` in `routes.gen.ts`. A real host does the
second, because `makeCollecting` appends to a module-level array and a real
sink writes to the turn's stream.

Until the name is in that list, the call is refused with a message written for
the model:

```text
"balance" is not a registered pane. Registered panes: message. Reissue ui/pane with one of those names.
```

## How the model calls it

From inside a cell:

```ts
const { cardId } = await ctx.call("ui/pane", {
  name: "balance",
  props: { address: "0xabc...", eth: "12.5" },
  title: "vitalik.eth"
})
```

The call returns only a `cardId`. The card itself travels to the browser on the
turn stream rather than through the cell's return value. Pass `cardId` to
`ui/pane` to replace that card:

```ts
await ctx.call("ui/pane", {
  cardId,
  name: "balance",
  props: { address: "0xabc...", eth: "13.0" },
  title: "vitalik.eth"
})
```

Omitting `cardId` creates a card through `CardSink.emit`. Supplying it calls
`CardSink.update` with a full replacement: props are replaced, an omitted title
clears the previous heading, and the registered pane supplies `fullscreen`.
The pane name is validated for both operations. Updates preserve the card's
position; the default chat page appends an update for an absent ID. Custom sinks
must implement these replacement semantics and stream `card.update` for updates.

New pane and HTML card ids have the form `card-${session}-${frame}-${ordinal}`.
Here `session` is `call.identity.session`, the execution lineage, so separate
executions with equal frame and ordinal values receive distinct ids. Replaying
the same call keeps its id. Hosts must deduplicate replayed emissions by id;
the collecting sink appends emissions and replaces explicit updates.

## The card kinds

`@smthrs/create-app/ui` exports the schema for every card a transcript can
hold: `PaneCard`, `HtmlCard`, `FlowRunCard`, `FlowSavedCard`, and their union
`AppCard`. `TurnFrame` is the union of everything one turn emits, including
`delta`, `cell`, `call`, `card`, `card.update`, `park`, `done`, and `error`.
A host that streams turns decodes against those, which is
[Run a routed flow from your own host](/guides/host-a-turn/).

Reach for `ui/html` only when no pane fits. A pane is decoded, typed, and
styled by the app; model-authored HTML is none of those.
