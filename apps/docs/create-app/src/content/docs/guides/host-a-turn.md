---
title: "Run a routed flow from your own host"
description: "Materialize a routed flow, compose the services it runs under with layerFor, resolve its seat against your own credentials, and execute it: the path a Worker, a CLI, or a test takes."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/guides/host-a-turn.md"
---

Routing an app produces declarations. Running one is two calls:
`materializeFlow` pairs a flow with the agent layer resolved for it, and
`layerFor` composes every service that flow needs. This is the path the test
harness takes, and the path a Worker takes per turn.

A Worker does not have to write these steps itself: `turnResponse` from
`@smthrs/create-app/worker` runs all of them for one `POST /api/turn`, and the
`default` template's `worker/handle.ts` calls it. The sections below are what
it does, for a host that needs to do it differently.

## Read the routed flows

`routes.gen.ts` carries each flow with its three resolved layers already
imported:

```ts
import { flows, paneNames } from "./routes.gen.ts"

const route = flows.find((candidate) => candidate.id === "chat")
```

Each entry holds `id`, `file`, `spec`, `agent`, `sandbox`, and `tools`. That
file imports no React and no virtual module, so a Worker bundle can load it.

## Materialize the flow

```ts
import { materializeFlow } from "@smthrs/create-app/runtime"

const materialized = materializeFlow(route.id, route.spec, route.agent)
```

You get back three things: the `id`, an `action` named `app/<id>/agent`, and a
`flow` named `app/<id>` whose body is one call to that action. The action's
system teaching is the agent layer's lines followed by the flow's own, in that
order.

## Resolve the seat

The one seam between a routed app and a provider is a `SeatProvider`, which is
a single method:

```ts
import type { SeatProvider } from "@smthrs/create-app/runtime"
import * as Effect from "effect/Effect"

const seats: SeatProvider = {
  resolve: (seatId) => Effect.succeed({ model: modelFor(seatId), route: routeFor(seatId) })
}
```

Return the live model and the route its requests are sealed under, or fail with
`SeatUnresolved`. A Worker resolves against its bound secrets, a CLI against
the environment, and a test against a recorded transcript. Nothing above this
method changes between those three.

The resolved seat is given a 200,000 token context window, which is what
compaction budgets against until a host installs its own resolver upstream.

## Compose the host

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { layerFor } from "@smthrs/create-app/runtime"

const host = layerFor({
  agent: route.agent,
  sandbox: route.sandbox,
  tools: route.tools,
  seats,
  crypto: NodeCrypto.layer
})
```

`layerFor` composes the agent host, the seat resolver, the agent loop, the
sandbox and steering defaults, the action implementations, an in-memory flow
engine, and the crypto service you passed. It requires no service in return:
the package asserts that at compile time, so a composition that type-checks is
complete. The optional `sandboxVariant` names the QuickJS build; omit it on
Node, pass a `.wasm`-module variant on a host that refuses to compile
WebAssembly from bytes.

Two of its choices are worth knowing. The catalog a cell is shown is empty,
because a routed app reaches its tools through the `TOOLS.ts` binding sources
rather than by registry lookup; `emptyRegistry` is exported if you need the
same value. And the run parks on a reset-bearing quota refusal rather than
failing, with no spend ceiling, because this boundary has no approved envelope
from which to derive one.

`crypto` is yours to supply because the platform differs: `NodeCrypto.layer` in
Node, and a WebCrypto layer in a Worker.

## Execute it

```ts
import { Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const runtime = Layer.mergeAll(
  materialized.action.layer,
  Interpreter.layer(materialized.flow)
).pipe(Layer.provideMerge(host))

const output = await Effect.runPromise(
  materialized.flow.execute({ message: "What is the balance?" }, { executionId: "turn-1" }).pipe(
    Effect.provide(runtime)
  )
)
```

The result is the flow's declared `output`, already decoded. A run that misses
the schema fails with the agent's structured-output failure rather than
returning loose text.

## Stream what happens on the way

`flow.execute` answers once. To render a turn as it runs, provide
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/)'s `EventSink` alongside the host: the action
looks the service up optionally and taps every agent event through it while the
step runs. Map those events onto `TurnFrame` from `@smthrs/create-app/ui`, and
the browser gets `delta`, `cell`, `call`, `card`, `card.update`, `park`,
`done`, and `error` in the shape the shell already decodes.

Cards are the other half of that stream. The `ui` binding a host composes into
`TOOLS.ts` needs a card sink, and a real host binds one per turn so `ui/pane`
writes into the response rather than into a module-level array. See
[Add a pane](/guides/add-a-pane/).

## Serve it from a Worker

```ts
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import { turnResponse, type TurnRoute } from "@smthrs/create-app/worker"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { newVariant, type QuickJSSyncVariant } from "quickjs-emscripten-core"
import { flows } from "./routes.gen.ts"

const sandboxVariant = QuickJSSandbox.layerVariant(
  newVariant(wasmfile as unknown as QuickJSSyncVariant, { wasmModule })
)

export default {
  fetch: (request: Request, env: Record<string, string | undefined>) =>
    turnResponse(request, { flows: flows as unknown as ReadonlyArray<TurnRoute>, env, sandboxVariant })
}
```

workerd compiles only WebAssembly its toolchain bundled, so the QuickJS module
is imported as a module and `wrangler.jsonc` carries a `CompiledWasm` rule for
it. `env` supplies the seat's provider key (`ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`). The resolved seat also judges completions.

The response is `200 application/x-ndjson`: one `TurnFrame` per line, ending in
exactly one `done` or `error` frame. A turn that cannot start is refused before
any stream opens:

| Status | `error`             | When                                           |
| ------ | ------------------- | ---------------------------------------------- |
| 400    | `invalid_request`   | The body is not `{ flow, payload }` JSON       |
| 400    | `flow_not_routed`   | No routed flow has that id; `known` lists them |
| 400    | `flow_not_chat`     | The flow is not declared `chat: true`          |
| 503    | `host_unconfigured` | The selected seat is unavailable               |

Pass `tools` to rebind a route's `ui` source to the turn's `TurnCards`, so each
card a tool paints becomes a `card` frame. `seats`, `evaluator`, and `crypto`
default to `seatsFromEnv(env)`, the resolved agent seat for judgment, and `layerCryptoWeb`; tests
replace them.

## Refusals to expect

`layerFor` throws `LayerError` with the code `invalid_grant` when a `TOOLS.ts`
grant names an action the kernel does not know or a resource past 4096
characters. It names the grant's index and the field, so the message points at
the declaration rather than at a schema deep inside the kernel.

Everything else fails inside the execution as a typed flow failure.
