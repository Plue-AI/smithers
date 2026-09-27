# @smthrs/create-app

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://create-app.smithers.sh

Build a web app around Smithers flows. You declare the app once, in a
`PACKAGE.ts` at the app root, and every other name comes from where a file
sits: a page, a pane the model can put on screen, a flow, and the three layer
files that give a flow its model, its compute budget, and its tools. There is
no route table, pane registry, or flow-to-model map to keep in step by hand.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries). Then scaffold:

```sh
pnpm exec smithers-build create-app my-app
```

`smithers-build` is the executable of `@smthrs/build-cli`, and `create-app` is
one of its verbs. The scaffold copies a template and substitutes the app name;
its manifest already contains installable RC versions.

## The shortest real example

```sh
pnpm exec smithers-build create-app ledger
cd ledger
pnpm install
pnpm test
```

```text
Test Files  1 passed (1)
     Tests  1 passed (1)
```

That ran the template's `chat` flow through the production agent loop against a
committed model transcript, so the run made no network call and needed no API
key.

## The authoring surface

```ts
// PACKAGE.ts, at the app root
import { CreateApp } from "@smthrs/create-app"

export const App = CreateApp({
  name: "ledger",
  brand: { name: "Ledger", tokens: { accent: "#5288c2" } },
  deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
})
```

`App` carries the manifest plus four targets: `routes` regenerates the route
tables, `dev` serves, `build` bundles, and `deploy` ships the app to a
Cloudflare Worker.

Every other name comes from a file's location:

| File                   | Export    | Constructor       |
| ---------------------- | --------- | ----------------- |
| `AGENT.ts`             | `Agent`   | `defineAgent`     |
| `SANDBOX.ts`           | `Sandbox` | `defineSandbox`   |
| `TOOLS.ts`             | `Tools`   | `defineTools`     |
| `flows/<id>/flow.ts`   | `Flow`    | `defineFlow`      |
| `app/panes/<name>.tsx` | `Pane`    | `definePane`      |
| `app/**/page.tsx`      | default   | a React component |
| `app/layout.tsx`       | default   | a React component |

Only the app root's `layout.tsx` is a shell layout. A nested `layout.tsx` is an
ordinary file the router ignores, and a file below `app/panes/` is a page rather
than a pane, so `app/panes/deep/page.tsx` is the page `/panes/deep`.

A layer file applies to its own directory and everything below it. The nearest
ancestor of each kind wins and nothing merges, so `flows/build/AGENT.ts` moves
the build flows to another seat and leaves their sandbox and tools alone. The
app root must provide all three, which is what makes resolution terminate.

A flow never names a model. Its seat comes from the resolved `AGENT.ts`.

## Public API

| Import                         | Runtime                | What it holds                                                                                               |
| ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@smthrs/create-app`           | Node                   | Both halves, flat: `CreateApp` plus everything in `./app`.                                                  |
| `@smthrs/create-app/app`       | browser, workerd, Node | The layer, flow, and manifest constructors and types, plus the route-name grammar.                          |
| `@smthrs/create-app/ui`        | browser, workerd, Node | `definePane`, `PaneRegistry`, `PaneContext`, the card schemas, `AppCard`, and `TurnFrame`.                  |
| `@smthrs/create-app/runtime`   | browser, workerd, Node | `materializeFlow`, `layerFor`, `emptyRegistry`, `LayerError`, `SeatProvider`.                               |
| `@smthrs/create-app/package`   | Node                   | `CreateApp` over `@smthrs/targets`, `CreateAppOptions`, `AppTargets`.                                       |
| `@smthrs/create-app/router`    | Node                   | `discover`, `render`, `renderUi`, `renderAll`, `writeRoutes`, `resolveLayer`, `RouterError`.                |
| `@smthrs/create-app/vite`      | Node                   | `createApp` (the plugin), `brandCss`, `loadManifest`, `brandModuleId`, `manifestModuleId`.                  |
| `@smthrs/create-app/testing`   | Node                   | `cachedModelTest`, `runCachedModelTest`, `recordModel`, `replayModelError`, `recording`, `preparedRequest`. |
| `@smthrs/create-app/routesBin` | Node                   | `runRoutesBin` and `usage`: the body of the `smithers-routes` executable.                                   |

`./app`, `./ui`, and `./runtime` are what a scaffolded app ships: `routes.gen.ts`
pulls `./app` and `./runtime` into the Worker bundle, `routes.ui.gen.ts` pulls
`./ui` into the browser bundle, and `sideEffects: []` lets a bundler drop the
Node half.

Each subpath is one module, `src/<subpath>.ts`, that holds every export of its
runtime class. This package is exempt from the repository's one-export-per-file
layout for that reason: the imports that decide whether a Worker or a browser
can load a subpath sit at the top of one file. The
[API reference](https://create-app.smithers.sh/reference/api/) lists each
module's exports.

## Generated files

`smithers-routes` writes two files at the app root and never anything else.

- `routes.gen.ts`: every flow with its three resolved layers, plus the pane
  names. No React import, so the Worker and a plain Vitest run both load it.
- `routes.ui.gen.ts`: the layout, the pages, the pane components, and
  `flowSummaries` (each flow's `id`, `file`, and `chat` flag). The browser
  reads its flow list here, never from `routes.gen.ts`.

```sh
smithers-routes           # write; exit 2 on a flag given no value
smithers-routes --check   # write nothing, exit 1 on drift
```

Both templates expose those as `pnpm routes` and `pnpm routes:check`. The Vite
plugin regenerates the tables on start and on every routed file change, so
`pnpm dev` never serves a stale table.

## Testing a flow

`@smthrs/create-app/testing` selects optional peers. The default library
install includes no test runner. Add the testing facade, the Node adapter with
the shared implementation it loads, and the runner before importing this
subpath:

```sh
pnpm add -D @smthrs/testing@1.0.0-rc.1 @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115 vitest@5.0.0
```

```ts
cachedModelTest("chat answers a balance question", {
  fixture: new URL("./fixtures/balance.json", import.meta.url),
  flow: "chat",
  payload: { message: "What is vitalik.eth's balance?" },
  expect: (output) => {
    expect(output.answer).toContain("ETH")
  }
})
```

Replay is the default: no network, no key. `SMTHRS_RECORD=1` records against
the live model the option `live` builds, and rewrites the fixture.

## Templates

The public package ships the `default` template: the smallest app that routes,
runs, tests, and deploys, with a Worker that runs its chat flow at
`POST /api/turn`. The repository's
UI-only Aomi reference stays outside the package until the UI is released.

## Documentation

The full documentation, including the file-routing rules, the layer resolution
order, every public export, and the Cloudflare deploy guide, is at
https://create-app.smithers.sh.
