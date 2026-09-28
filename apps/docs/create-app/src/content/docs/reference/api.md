---
title: "API reference"
description: "Every public export of @smthrs/create-app, subpath by subpath: the authoring constructors, the file router, the Vite plugin, the runtime composition, and the replay test harness."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/api.md"
---

`@smthrs/create-app` declares a Smithers app in one `PACKAGE.ts` at the app
root. Everything else is named by where it sits: pages, panes, flows, and the
three layer files a flow inherits.

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries). Scaffold with
`pnpm exec smithers-build create-app my-app`. The copied manifest pins the same
RC release line. See [Installation](/installation/).

## Runtime class of each subpath

A scaffolded app splits this package across three hosts, so each subpath has a
runtime class. Import the one whose class matches the file doing the importing.

| Import                         | Runtime                |
| ------------------------------ | ---------------------- |
| `@smthrs/create-app`           | Node                   |
| `@smthrs/create-app/index`     | Node                   |
| `@smthrs/create-app/app`       | browser, workerd, Node |
| `@smthrs/create-app/ui`        | browser, workerd, Node |
| `@smthrs/create-app/runtime`   | browser, workerd, Node |
| `@smthrs/create-app/worker`    | workerd, Node          |
| `@smthrs/create-app/http`      | browser, workerd, Node |
| `@smthrs/create-app/package`   | Node                   |
| `@smthrs/create-app/router`    | Node                   |
| `@smthrs/create-app/vite`      | Node                   |
| `@smthrs/create-app/testing`   | Node                   |
| `@smthrs/create-app/routesBin` | Node                   |

`routes.gen.ts` pulls `./app` and `./runtime` into the Worker bundle,
`worker/handle.ts` pulls `./worker` and `./http` in beside them, and
`routes.ui.gen.ts` pulls `./ui` into the browser bundle, so those five carry no
`node:` import. The rest are build and test tooling and reach the
filesystem.

The root entry point re-exports `./app` and `./package` flat, rather than as
namespaces, because it is an authoring API rather than a service API: an app
writes `defineFlow`, not `App.defineFlow`.
The explicit `@smthrs/create-app/index` subpath serves the same root module.

## @smthrs/create-app/package

### CreateApp

```ts
const CreateApp: (options: CreateAppOptions) => AppTargets
```

Declares an app. Returns the serializable manifest plus four
[`@smthrs/targets`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/targets) rules.

```ts
import { CreateApp } from "@smthrs/create-app"

export const App = CreateApp({
  name: "ledger",
  brand: { name: "Ledger", tokens: { accent: "#5288c2" } },
  deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
})
```

`CreateAppOptions`:

| Field               | Type                      | Meaning                                               |
| ------------------- | ------------------------- | ----------------------------------------------------- |
| `name`              | `string`                  | The app's name                                        |
| `brand`             | `Brand`                   | Identity: wordmark, theme, fonts, and token overrides |
| `nav`               | `ReadonlyArray<NavGroup>` | Sidebar groups. Defaults to empty                     |
| `dirs`              | `Partial<AppDirs>`        | Source layout. Defaults to `app`, `flows`, `tools`    |
| `deploy.cloudflare` | `CloudflareDeploy`        | Worker name, custom domain, and wrangler config path  |

`AppTargets`:

| Field      | What it is                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `manifest` | The `AppManifest` the Vite plugin serves as `virtual:smthrs-app/manifest`                                          |
| `routes`   | Regenerates the two route tables. Keyed on every file the router reads                                             |
| `dev`      | `vite` on port 5173, with the network on                                                                           |
| `build`    | `vite build`, writing `dist` and the wrangler deploy redirect                                                      |
| `deploy`   | `wrangler deploy`, gated on `build`, approval required, with the Cloudflare credentials declared as scoped secrets |

`CloudflareDeploy.config` defaults to `worker/wrangler.jsonc`.

`dev` and `build` declare the same inputs: the `app`, `flows` and `tools` trees,
`worker/`, `src/`, `index.html`, `public/**`, the wrangler config,
`vite.config.ts`, and the `routes` target. `index.html` is Vite's entry and
`public/` is copied into `dist` verbatim, so both are named; no import reaches
either, and nothing infers them from the source trees.

`build` declares two outputs: `dist` and `.wrangler/deploy/config.json`. The
second is the redirect the Cloudflare Vite plugin writes to point
`wrangler deploy` at the built Worker. It sits outside `dist`, so a build
restored from cache into a clean checkout supplies it only because the target
names it.

## @smthrs/create-app/app

The browser-safe half: types and plain data constructors only.

### Constructors

| Export          | Signature                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `defineAgent`   | `(options: Omit<AgentSpec, "_tag">) => AgentSpec`                                                                 |
| `defineSandbox` | `(options: Omit<SandboxSpec, "_tag">) => SandboxSpec`                                                             |
| `defineTools`   | `(options: Omit<ToolsSpec, "_tag" \| "grant"> & { grant?: ReadonlyArray<ToolsGrant> }) => ToolsSpec`              |
| `defineFlow`    | `<P extends Schema.Struct.Fields, O extends Schema.Top>(options: Omit<FlowSpec<P, O>, "_tag">) => FlowSpec<P, O>` |

`defineTools` defaults `grant` to `[]`, the empty envelope: the harness refuses
every call that declares a capability. `[{ action: "*", resource: "*" }]` grants
every capability and is an opt-in for trusted local use. The field is required
on `ToolsSpec` itself, so a spec built by hand states its envelope rather than
inheriting one silently.

### Specs

| Type             | Fields                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `AgentSpec`      | `seat: string`, `system: ReadonlyArray<string>`, `limits?: { calls?: number }`, `maxFrames?: number` |
| `SandboxSpec`    | `limits: { heapBytes?: number; interruptChecks?: number; wallClockMs?: number }`                     |
| `ToolsSpec`      | `sources: ReadonlyArray<FlowBinding.Source>`, `grant: ReadonlyArray<ToolsGrant>`                     |
| `ToolsGrant`     | `action: Capability.PatternAction`, `resource: string`                                               |
| `FlowSpec<P, O>` | `description`, `payload: P`, `output: O`, `prompt: (payload) => string`, `system?`, `chat?`          |
| `AnyFlowSpec`    | `FlowSpec` with its payload type erased, which is what a route table holds                           |

`AnyFlowSpec.prompt` takes `never` rather than the erased payload: `prompt` is
contravariant in its payload, so any other erasure would refuse every concrete
flow.

`chat` is routing metadata and nothing else. Nothing in
`@smthrs/create-app/runtime` reads it.

### Brand and navigation

| Type         | Fields                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `Brand`      | `name`, `wordmark?`, `theme?: "light" \| "dark" \| "system"`, `fonts?: BrandFonts`, `tokens: Partial<Record<BrandToken, string>>` |
| `BrandFonts` | `display?`, `body?`, `mono?`, `wordmark?`, `googleFonts?: ReadonlyArray<string>`                                                  |
| `BrandToken` | The 32 token names a brand may override                                                                                           |
| `NavItem`    | `label`, `href`, `icon?`                                                                                                          |
| `NavGroup`   | `label`, `items: ReadonlyArray<NavItem>`                                                                                          |

The token names and the CSS custom properties each one sets are listed in
[Brand an app](/guides/brand-an-app/).

### Routes and the manifest

| Type               | Fields                                                   |
| ------------------ | -------------------------------------------------------- |
| `PageRoute`        | `route`, `file`                                          |
| `PaneRoute`        | `name`, `file`                                           |
| `FlowRoute`        | `id`, `file`, `agent`, `sandbox`, `tools`                |
| `AppRoutes`        | `layout: string \| undefined`, `pages`, `panes`, `flows` |
| `AppDirs`          | `app`, `flows`, `tools`                                  |
| `CloudflareDeploy` | `workerName`, `domain`, `config?`                        |
| `AppManifest`      | `name`, `brand`, `nav`, `dirs`, `deploy`                 |

### Values

| Export                | Type                         | Value                                            |
| --------------------- | ---------------------------- | ------------------------------------------------ |
| `defaultDirs`         | `AppDirs`                    | `{ app: "app", flows: "flows", tools: "tools" }` |
| `defaultCallLimit`    | `number`                     | `16`                                             |
| `defaultMaxFrames`    | `number`                     | `8`                                              |
| `routeSegmentGrammar` | `string`                     | `/^[a-z][a-z0-9-]*$/` as text                    |
| `isRouteSegment`      | `(value: string) => boolean` | Whether a value may be one route segment         |

`isRouteSegment` lives in the browser-safe half because code that predicts what
the router will accept often cannot import a filesystem walk. The `aomi`
template's promote tool runs inside a Worker and uses it to refuse a flow id
the router would refuse, before writing the file.

## @smthrs/create-app/ui

### definePane

```ts
const definePane: <P>(options: {
  props: Schema.Codec<P, unknown>
  title?: string
  fullscreen?: boolean
  render: (props: P, context: PaneContext) => ReactNode
}) => PaneDefinition<P>
```

`fullscreen` defaults to `false`. The returned definition carries both
`render`, over decoded props, and `renderUnknown`, which decodes wire props
with the schema and throws the schema's own error when they are rejected.

| Type                | What it is                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `PaneContext`       | `fullscreen`, `maximize()`, `restore()`: what the shell tells a pane about its presentation           |
| `PaneDefinition<P>` | One pane with its props type                                                                          |
| `AnyPaneDefinition` | The erased half a registry holds: `title?`, `fullscreen`, `renderUnknown`                             |
| `PaneRegistry`      | `Readonly<Partial<Record<string, AnyPaneDefinition>>>`. An unrouted name is `undefined`, not an error |

### Cards and frames

| Schema          | Shape                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| `PaneCard`      | `kind: "pane"`, `id`, `name`, `title?`, `props`, `fullscreen`                            |
| `HtmlCard`      | `kind: "html"`, `id`, `title?`, `html`                                                   |
| `FlowRunCard`   | `kind: "flow-run"`, `id`, `flowId`, `executionId`, `phase`, `steps`, `result?`, `error?` |
| `FlowSavedCard` | `kind: "flow-saved"`, `id`, `flowId`, `description`, `files`                             |
| `AppCard`       | The union of the four                                                                    |
| `TurnFrame`     | One frame of a turn's NDJSON stream                                                      |

`TurnFrame` members: `delta` is assistant text, `cell` is a code cell the agent
ran, `call` is one host call with its outcome, `card` and `card.update` carry
the transcript's cards, `park` suspends the run for a human, and `done` or
`error` ends it. Each schema is also exported as a type of the same name.

## @smthrs/create-app/runtime

### materializeFlow

```ts
const materializeFlow: (id: string, spec: AnyFlowSpec, agent: AgentSpec) => MaterializedFlow
```

Binds one flow declaration to the agent layer resolved for it. Returns `id`, an
`action` named `app/<id>/agent`, and a `flow` named `app/<id>` whose body is one
call to that action. The action's system teaching is the agent layer's lines
followed by the flow's own, in that order.

### layerFor

```ts
const layerFor: (options: LayerOptions) => Layer.Layer<...>
```

The full host for one flow: the agent host, the seat resolver, the agent loop,
the sandbox and steering defaults, the action implementations, an in-memory
flow engine, and the caller's crypto. It requires no service in return, which
the package asserts at compile time through the exported type
`CompositionRootsAreComplete`.

| `LayerOptions` field | Type                                                                              |
| -------------------- | --------------------------------------------------------------------------------- |
| `agent`              | `AgentSpec`                                                                       |
| `sandbox`            | `SandboxSpec`                                                                     |
| `tools`              | `ToolsSpec`                                                                       |
| `seats`              | `SeatProvider`                                                                    |
| `evaluator`          | `Layer.Layer<Evaluator.Evaluator>`, optional; defaults to the resolved agent seat |
| `crypto`             | `Layer.Layer<Crypto.Crypto>`                                                      |
| `sandboxVariant`     | `Layer.Layer<QuickJSSandbox.Variant>`, optional                                   |

`sandboxVariant` names the QuickJS build the sandbox compiles. Omitted, the
host gets the single-file build, which Node and a browser compile from bytes
and Cloudflare's workerd refuses. A workerd host builds a variant from a
`.wasm` module import with `QuickJSSandbox.layerVariant` and passes it here.

`SeatProvider` is one method:

```ts
interface SeatProvider {
  readonly resolve: (seatId: string) => Effect.Effect<
    { readonly model: Model.Model; readonly route: Seat.Seat["route"] },
    Seat.SeatUnresolved
  >
}
```

A resolved seat is given a 200,000 token context window. Quota refusals park
under the default policy, and the run has no spend ceiling, because this
boundary has no approved envelope from which to derive one.

### emptyRegistry

```ts
const emptyRegistry: () => Registry.Registry
```

The catalog a routed app's cells are shown: nothing. A routed app reaches its
tools through the `TOOLS.ts` binding sources, which the agent host composes
into every cell, so an empty registry is the honest declaration rather than a
placeholder.

### LayerError

```ts
class LayerError extends Error {
  readonly name: "LayerError"
  readonly code: LayerErrorCode
}
type LayerErrorCode = "invalid_grant"
```

Thrown rather than returned, because every caller wants the host build to stop.
`invalid_grant` is a `TOOLS.ts` grant whose action is not one the kernel knows,
or whose resource is longer than 4096 characters. The message names the grant's
index and the field.

## @smthrs/create-app/worker

The turn host a Worker serves `POST /api/turn` with. It composes
`materializeFlow` and `layerFor` for one request and streams the run back.

### turnResponse

```ts
const turnResponse: (request: Request, host: TurnEndpoint) => Promise<Response>

interface TurnEndpoint extends TurnHost {
  readonly authorize: (request: Request) => boolean
  readonly maxBodyBytes?: number
}
```

Every turn spends the host's model keys, so the endpoint has no anonymous
default. `authorize` decides each request first and a refusal answers
`401 unauthorized` before the body is read. The body must be
`application/json` (`415` otherwise) and at most `maxBodyBytes`, 64 KiB by
default (`413` past it, whether or not `content-length` was declared).
`authorized(request, env.APP_API_TOKEN, env.APP_API_OPEN)` from
[`@smthrs/create-app/http`](#smthrscreate-apphttp) is the bearer check the
templates pass.

Then it decodes a `{ flow, payload }` body and answers
`200 application/x-ndjson`: one `TurnFrame` per line, ending in exactly one
`done` or `error` frame. A turn that cannot start is refused before any stream
opens, as JSON with `error` and `message`: `400 invalid_request`,
`400 flow_not_routed` (with `known`), `400 flow_not_chat`, or
`503 host_unconfigured` when the selected seat is unavailable. The request's
signal cancels the run.

A refusal or `error` frame carries a typed error's own message (a payload the
flow's schema rejects, a provider refusal, a seat with no key). Any other
failure, including a throw from a host callback such as `tools` or `observe`,
is logged on the server with `Effect.logError` and reaches the reader as
`The turn failed.`

| `TurnHost` field | Type                                                       |
| ---------------- | ---------------------------------------------------------- |
| `flows`          | `ReadonlyArray<TurnRoute>`, the `flows` of `routes.gen.ts` |
| `env`            | model connection configuration                             |
| `sandboxVariant` | `Layer.Layer<QuickJSSandbox.Variant>`                      |
| `tools`          | `(route, cards: TurnCards) => ToolsSpec`, optional         |
| `seats`          | `SeatProvider`, optional                                   |
| `evaluator`      | `Layer.Layer<Evaluator.Evaluator>`, optional               |
| `crypto`         | `Layer.Layer<Crypto.Crypto>`, optional                     |
| `observe`        | `(frame: TurnFrame) => void`, optional                     |

`tools` rebinds a route's sources per turn, so a `ui` source can write each
card to `TurnCards` and it streams as a `card` frame. The optional layers
default to `seatsFromEnv(env)`, the resolved agent seat for judgment, and
`layerCryptoWeb`. `observe` sees every frame as the run produces it, and
exactly one terminal frame even after the reader hangs up, so a host can
persist a run without depending on its reader. A throw while observing the
terminal frame replaces it with an `error` frame.

A turn's model spend is bounded by the agent's `maxFrames` (default 8), the
per-cell call limit, and each request's `maxTokens`; there is no ceiling across
turns, so `authorize` is what stands between the internet and the keys.

### The rest

`runTurn` is `turnResponse` without the HTTP, the authorization, or the body
cap: it returns the stream or the refusal, and its caller must admit the
request first. `runFlow` is the same for a pipeline flow, refusing a chat flow with
`400 flow_not_pipeline`. `resolveChatFlow` and `resolvePipelineFlow` are the
routing checks alone. `seatsFromEnv` resolves
`anthropic:<model>` and `openai:<model>` seats over `fetch` from
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. `layerCryptoWeb` is `effect/Crypto`
over WebCrypto.

## @smthrs/create-app/http

Request admission for a Worker route, with no imports, so a router can guard
its routes without loading the agent runtime.

| Export           | Signature                                                                  |
| ---------------- | -------------------------------------------------------------------------- |
| `authorized`     | `(request: Request, token: string \| undefined, open?: string) => boolean` |
| `readJson`       | `(request: Request, limit?: number) => Promise<BodyResult>`                |
| `MAX_BODY_BYTES` | `65536`                                                                    |

`authorized` admits `Authorization: Bearer <token>` only, compared without an
early exit. A missing or empty `token` refuses every request unless `open` is
`"1"`, the local-development opt-in; a configured token always wins over it.
`readJson` requires `application/json` (`415`), refuses a declared or counted
body past `limit` (`413`) without buffering more than the cap, and answers
`400` for a body that is missing, unreadable, or not JSON.

## @smthrs/create-app/router

### discover

```ts
const discover: (options: RouterOptions) => AppRoutes
```

Walks an app root and returns everything the two generated files are rendered
from. `RouterOptions` is `{ root: string; dirs: AppDirs }`.

```ts
import { defaultDirs } from "@smthrs/create-app/app"
import { discover } from "@smthrs/create-app/router"

const routes = discover({ root: process.cwd(), dirs: defaultDirs })
```

### resolveLayer

```ts
const resolveLayer: (
  root: string,
  dir: string,
  kind: "AGENT.ts" | "SANDBOX.ts" | "TOOLS.ts",
  files: ReadonlySet<string>
) => string
```

The nearest file of one layer kind at `dir` or any ancestor up to and including
`root`. Both paths are normalized before the walk, and `dir` must sit inside
`root`.

### Renderers

| Export      | Signature                                                 | What it renders                             |
| ----------- | --------------------------------------------------------- | ------------------------------------------- |
| `render`    | `(routes: AppRoutes) => string`                           | `routes.gen.ts`                             |
| `renderUi`  | `(routes: AppRoutes) => string`                           | `routes.ui.gen.ts`                          |
| `renderAll` | `(routes: AppRoutes) => Readonly<Record<string, string>>` | Both, keyed by their app-root relative path |

### writeRoutes

```ts
const writeRoutes: (options: RouterOptions & { check?: boolean }) => RoutesReport
```

Discovers an app root and writes both files, or reports their drift when
`check` is set. This is the whole body of the `smithers-routes` executable and
of the Vite plugin's regeneration step, so drift checking and writing cannot
diverge.

```ts
interface RoutesReport {
  readonly files: Readonly<Record<string, RoutesFileStatus>>
  readonly stale: ReadonlyArray<string>
  readonly counts: { readonly pages: number; readonly panes: number; readonly flows: number }
}
type RoutesFileStatus = "written" | "clean" | "stale"
```

### RouterError

```ts
class RouterError extends Error {
  readonly name: "RouterError"
  readonly code: RouterErrorCode
}
type RouterErrorCode = "missing_layer" | "duplicate_name" | "invalid_name"
```

`missing_layer` is a flow with no ancestor layer file of some kind,
`duplicate_name` is two files claiming one route, and `invalid_name` is a pane,
page segment, or flow segment that is not lowercase kebab-case.

## @smthrs/create-app/vite

### createApp

```ts
const createApp: (options?: CreateAppPluginOptions) => CreateAppPlugin
```

The plugin. It regenerates both route tables when the config resolves and
whenever a routed file appears or disappears, and serves the brand and the
manifest as virtual modules.

| `CreateAppPluginOptions` field | Default                                 |
| ------------------------------ | --------------------------------------- |
| `root`                         | Vite's resolved root                    |
| `manifest`                     | `loadManifest` over `<root>/PACKAGE.ts` |
| `onRouterError`                | Report the refusal on stderr            |

`configResolved` is deliberately not routed through `onRouterError`: Vite
awaits that hook, so a refused tree at startup fails the startup. A filesystem
that refuses the write while the server runs (`ENOSPC`, `EACCES`, `EBUSY`,
`EROFS`) is reported on stderr instead, since nothing in the tree is wrong;
`ENOENT` still throws.

`CreateAppPlugin` is typed by what the plugin actually uses rather than by
Vite's full hook signatures, so a host or a test can drive it directly:
`name`, `configResolved`, `configureServer`, `resolveId`, and `load`.

### The virtual modules

| Export             | Value                          | What it serves                          |
| ------------------ | ------------------------------ | --------------------------------------- |
| `brandModuleId`    | `virtual:smthrs-app/brand.css` | The brand as CSS custom properties      |
| `manifestModuleId` | `virtual:smthrs-app/manifest`  | The `AppManifest` as the default export |

### brandCss

```ts
const brandCss: (brand: Brand) => string
```

Renders a brand as one CSS rule of custom properties, scoped to
`:root:root:root:root, :root:root:root [data-theme]`. `:root` is repeated to
raise specificity: the brand sheet is a CSS import and so lands in `<head>`,
while `@smthrs/ui` renders its own `<style>` in the tree, so only specificity
can carry the brand over the styleguide's token rules. A token the brand did
not declare is not emitted, so the styleguide default survives; an app never
needs a second sheet aliasing these names. Google Fonts `@import` rules come
first, because CSS ignores an `@import` that follows a rule. It throws on a
token or font value containing `;`, `{`, `}`, `<`, a backslash, a line break,
or `/*`, and on a `googleFonts` entry outside letters, digits, and `+:@;,.-`,
because either could inject a rule or an `@import`.

### loadManifest

```ts
const loadManifest: (root: string) => Promise<AppManifest>
```

Loads an app's manifest by evaluating its `PACKAGE.ts` through `tsx`. The
config process is not a TypeScript process and `PACKAGE.ts` imports
`@smthrs/targets`, so the manifest cannot simply be imported. `tsx` is an
optional peer for exactly this reason: an app that passes
`CreateAppPluginOptions.manifest` never needs it.

## @smthrs/create-app/testing

### cachedModelTest

```ts
const cachedModelTest: <P, O>(name: string, options: CachedModelTestOptions<P, O>) => void
```

Registers one Vitest test that runs a routed flow on a cached model.

The flow id is a string and only `payload` constrains `P`, so nothing infers
`O`. State both type arguments, or `output` is `unknown` and `expect` cannot
read a field.

```ts
import { Flow } from "../flows/chat/flow.ts"

cachedModelTest<{ message: string }, typeof Flow.output.Type>(
  "chat answers a balance question",
  {
    fixture: new URL("./fixtures/balance.json", import.meta.url),
    flow: "chat",
    payload: { message: "What is vitalik.eth's balance?" },
    expect: (output) => {
      expect(output.answer).toContain("ETH")
    }
  }
)
```

| `CachedModelTestOptions` field | Default                       | Meaning                                                    |
| ------------------------------ | ----------------------------- | ---------------------------------------------------------- |
| `fixture`                      | required                      | `URL` of the recorded transcript                           |
| `flow`                         | required                      | The routed flow id                                         |
| `payload`                      | required                      | The flow's payload                                         |
| `expect`                       | required                      | Assertions over the decoded output                         |
| `live`                         | none                          | Builds the live model used when `SMTHRS_RECORD=1`          |
| `routes`                       | re-run the router over `root` | Loads the routed flows this test may run                   |
| `dirs`                         | `defaultDirs`                 | Source directories, when the app does not use the defaults |
| `root`                         | `process.cwd()`               | The app root the default loader walks                      |
| `signal`                       | vitest's test signal          | Cancels the run, interrupting the flow                     |

Replay is the default: the fixture is decoded with
[`@smthrs/testing`](https://testing.smithers.sh/reference/api/)'s `Fixture` schema and served by
`RecordedModel`, with no network and no API key. `SMTHRS_RECORD=1` builds the
live model from `live`, captures every request and event, and rewrites the
fixture after a run that reached its assertions. A recording that failed leaves
the committed fixture untouched, and the write goes through a temporary file
and a rename, so an interrupted process cannot truncate it. A recording whose
text contains the value of a credential-named environment variable (`KEY`,
`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, eight characters or more) is not
written; the error names the variable.

A recorded provider refusal is stored whole, retry metadata included, and
reconstructed field for field on replay. A kernel permission decision is not
recorded: it is not a provider response, and replaying it would hand the code
under test a refusal the provider never made.

The default loader re-runs the router and imports only the named flow and its
three layer files. `routes.gen.ts` is deliberately not used: it is generated,
so a test that read it would depend on it being current, and it imports every
flow in the app with every layer file and tool module any of them resolves to,
so one flow's test would load every other flow. The pages and the shell layout
are not the reason; they live in `routes.ui.gen.ts`, which no Worker table
imports.

### The rest

| Export               | Signature                                                                      | What it is                                                                        |
| -------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `runCachedModelTest` | `<P, O>(name: string, options: CachedModelTestOptions<P, O>) => Promise<void>` | The body `cachedModelTest` puts inside `test()`, for a harness that is not Vitest |
| `recording`          | `() => boolean`                                                                | Whether `SMTHRS_RECORD` is `1`                                                    |
| `recordModel`        | `(live: Model, sink: (call: RecordedCall) => void) => Model`                   | Wraps a live model so every request and its events are appended to `sink`         |
| `replayModelError`   | `(error: ModelLikeError) => ModelError`                                        | Rebuilds the `ModelError` a fixture recorded                                      |
| `preparedRequest`    | `Route.PreparedRequest`                                                        | The credential-free route every test seat resolves to                             |
| `RoutedFlow`         | interface                                                                      | One routed flow: `id`, `file`, `spec`, `agent`, `sandbox`, `tools`                |

## @smthrs/create-app/routesBin

The body of the `smithers-routes` executable, exported so a test or another
host can run it and read exactly what a user at a terminal would see.

```ts
const runRoutesBin: (argv: ReadonlyArray<string>, options: RoutesBinOptions) => number
const usage: string
```

`runRoutesBin` returns the process exit code: 0 is a written or clean tree, 1 is
drift under `--check` or a refused tree, and 2 is a flag given without a value.

| `RoutesBinOptions` field | Default         | Meaning                                                                                            |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------------- |
| `io`                     | required        | `{ out, err }`, one line at a time. The bin binds these to `console.log` and `console.error`       |
| `cwd`                    | `process.cwd()` | The directory `--root` defaults to                                                                 |
| `write`                  | `writeRoutes`   | The router entry point, so a caller can observe a failure the filesystem cannot be made to produce |

The flags are `--check`, `--root`, `--app`, `--flows`, and `--tools`, each
accepting either `--root <dir>` or `--root=<dir>`. The full command reference,
including exit codes and the shim's entry-point choice, is in
[Command reference](/reference/cli/).

## Generated files

`smithers-routes` writes two files at the app root and never anything else.
`routes.gen.ts` holds every flow with its three resolved layers plus the pane
names, and imports no React and no virtual module. `routes.ui.gen.ts` holds the
shell layout, the pages, the pane components, and `flowSummaries`: each flow's
`id`, `file`, and `chat` flag, read from the flow file alone. A browser entry
reads its flow list from there and never from `routes.gen.ts`, which imports
every layer file and every tool module.

```bash
smithers-routes           # write; exit 2 on a flag given no value
smithers-routes --check   # write nothing, exit 1 on drift
```

Import bindings in both generated files are numbered by position, and every
specifier is a JSON string literal. No derivation from a route name is
injective, so `flow_a_b` once served the two distinct flows `a-b` and `a/b` and
the generated module failed to parse while the generator reported success. See
[The generated route tables](/concepts/generated-routes/).
