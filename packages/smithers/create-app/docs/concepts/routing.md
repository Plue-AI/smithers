---
title: "File routing"
description: "File location is the only thing that names anything in a Smithers app: the rules the router walk enforces, the name grammar every segment obeys, and the three ways it refuses a tree."
sidebar:
  order: 1
---

File location is the only thing that names anything in a Smithers app. The
router walks the app root once and derives every page route, every pane name,
and every flow id from where a file sits. Nothing registers a route, and no
path literal appears in a second place.

The walk evaluates no module. It reads file names, so the same code runs inside
the `smithers-routes` executable, inside the Vite plugin, and inside a test.

## What each location means

- `<app>/layout.tsx` is the shell layout, and it is optional. Only the app
  root's `layout.tsx` is a shell layout: a nested one is an ordinary file the
  router ignores.
- `<app>/**/page.tsx` is the page at `/<dir>`, and `<app>/page.tsx` is `/`.
- `<app>/panes/<name>.tsx` is the pane `<name>`, and only at that exact depth.
  A file deeper than that falls through to the page rule, so
  `<app>/panes/deep/page.tsx` is the page `/panes/deep` rather than a pane
  called `page`.
- `<flows>/**/flow.ts` is the flow named by its directory, so
  `flows/build/plan/flow.ts` is the flow `build/plan`.
- `AGENT.ts`, `SANDBOX.ts`, and `TOOLS.ts` are layers for every flow in their
  directory and below. [Layer files](./layers.md) has the resolution rule.

`<app>`, `<flows>`, and the tools directory default to `app`, `flows`, and
`tools`. An app renames them in `PACKAGE.ts` with `dirs`, and every consumer
follows: the `routes` target's input globs, the Vite plugin, and the
`--app`, `--flows`, and `--tools` flags of the
[`smithers-routes` executable](../reference/cli.md).

## The name grammar

A pane name, every directory segment of a page route, and every directory
segment of a flow id must match this expression:

```text
/^[a-z][a-z0-9-]*$/
```

Lowercase letters, digits, and hyphens, starting with a letter. A file that
breaks it is refused with the router's `invalid_name` code, naming the file:

```text
page directory segments must match /^[a-z][a-z0-9-]*$/: app/v1.2/page.tsx
```

The grammar applies to page segments as well as to panes and flows because
every segment reaches a generated import specifier as well as a URL path.
Unvalidated, `app/v1.2/page.tsx` was accepted, and any character at all in a
directory name reached that specifier.

`isRouteSegment` and `routeSegmentGrammar` are exported from
`@smthrs/create-app/app`, in the browser-safe half, so code that has to predict
what the router will accept can ask rather than keep a second copy of the
expression. The `aomi` template's promote tool does exactly that: it runs
inside a Worker and refuses a flow id the router would refuse, before writing
`flows/<id>/flow.ts` for it.

## What the walk skips

Six directory names are never entered: `node_modules`, `.git`, `dist`,
`.flows`, `.wrangler`, and `.smithers`.

Symbolic links are neither walked nor routed. The walk reads each directory
entry's own type rather than following it, so a checkout's dangling link, a
link pointing at an ancestor, and a link into a large external tree can none of
them fail, wedge, or inflate a route generation.

## Where the walk lands

The walk produces one `AppRoutes` value: the layout, the pages, the panes, and
the flows with their layers resolved. Two renderers turn that value into the
files an app actually imports, which is
[The generated route tables](./generated-routes.md).

A host that wants the walk itself rather than the files calls `discover` from
`@smthrs/create-app/router`:

```ts
import { defaultDirs } from "@smthrs/create-app/app"
import { discover } from "@smthrs/create-app/router"

const routes = discover({ root: process.cwd(), dirs: defaultDirs })
```
