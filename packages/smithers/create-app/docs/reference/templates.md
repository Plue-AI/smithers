---
title: "Templates"
description: "The public default scaffold and the repository-only UI reference: what each routes, depends on, and wires."
sidebar:
  order: 1
---

The npm package ships the `default` template. The source repository also keeps
the Aomi UI reference beside it for development, but excludes that tree from
the tarball until `@smthrs/ui` is released.

```bash
pnpm exec smithers-build create-app ledger                 # default
```

|                          | `default`   | `aomi`             |
| ------------------------ | ----------- | ------------------ |
| Files copied             | 33          | 116                |
| Pages                    | 1           | 12                 |
| Panes                    | 1           | 6                  |
| Flows                    | 1           | 2                  |
| Tool sources             | 1           | 3                  |
| Agent host in the Worker | shipped     | shipped            |
| Fixture recording        | not shipped | `pnpm test:record` |
| Private dependencies     | none        | `@smthrs/ui`       |

Use `default` to start an app. Read `aomi` in the repository as a worked UI
example; it is not a public scaffold in this release candidate.

The default template ships its ignore rules as `_gitignore` so npm includes
them in the tarball. Scaffolding writes that file as `.gitignore`, excluding
`node_modules`, `dist`, `.wrangler`, `.flows`, and `.dev.vars` from Git.
The pack regression test checks every default template file and the count above.

## Shared shape

Both templates are the same app skeleton:

| Path                                 | What it is                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `PACKAGE.ts`                         | `CreateApp()`: brand, navigation, and the dev, build, and deploy targets   |
| `AGENT.ts`, `SANDBOX.ts`, `TOOLS.ts` | The root layer files every flow inherits                                   |
| `flows/<id>/flow.ts`                 | One flow, named by its directory                                           |
| `app/**/page.tsx`                    | One page at `/<dir>`; `app/page.tsx` is `/`                                |
| `app/panes/<name>.tsx`               | One pane the agent renders by name                                         |
| `app/layout.tsx`                     | The shell layout                                                           |
| `tools/*.ts`                         | Flow bindings a cell reaches as `ctx.call("<source>/<flow>")`              |
| `worker/`                            | The Cloudflare Worker: the API and the assets bucket                       |
| `src/`                               | The browser entry point and styles                                         |
| `routes.gen.ts`, `routes.ui.gen.ts`  | Generated. Run `pnpm routes` after adding a routed file                    |
| `.smithers/`                         | Workspace configuration for the Smithers build CLI, not for the app itself |

Both carry the same scripts, and `aomi` adds one:

| Script                      | Command                      |
| --------------------------- | ---------------------------- |
| `dev`                       | `vite`                       |
| `build`                     | `vite build`                 |
| `preview`                   | `vite preview`               |
| `deploy`                    | `wrangler deploy`            |
| `routes`                    | `smithers-routes`            |
| `routes:check`              | `smithers-routes --check`    |
| `typecheck`                 | `tsc --noEmit`               |
| `test`                      | `vitest run`                 |
| `test:record` (`aomi` only) | `SMTHRS_RECORD=1 vitest run` |

The `.smithers/` directory configures the `smithers-build` CLI: the Node
version, the package manager, and the coding agents that CLI may run. None of
the app's own `pnpm` scripts read it, and its `agents.ts` has nothing to do
with the in-app agent seats, which live in `AGENT.ts` files.

## default

The smallest app that routes, runs, tests, and deploys.

- **Seat.** `anthropic:claude-sonnet-4-5`, 16 calls, 8 frames.
- **Sandbox.** 128 MiB heap, 1000 interrupt checks, 30 s wall clock.
- **Tools.** One source, `ui`, holding `ui/pane` and `ui/html`.
- **Flow.** `chat`, a chat flow whose output is an answer plus the ids of the
  cards it emitted.
- **Page.** `/`, a composer that posts to `/api/turn` and renders the turn
  stream: text, pane cards, and one error line.
- **Pane.** `message`, a heading, a body, and an optional tone.
- **Test.** `flows/chat/flow.e2e.ts`, replaying
  `flows/chat/fixtures/answer.json`. It asserts against the cards the `ui`
  binding actually collected rather than against the ids the model reported,
  because a model that answered in prose can still name a card in its output.

The Worker serves `GET /api/routes`, which reports what the router found, and
runs `POST /api/turn` through `turnResponse` from `@smthrs/create-app/worker`:
the chat flow on the seat in `AGENT.ts`, in a QuickJS sandbox built from the
WebAssembly module `worker/index.ts` imports, streamed back as `TurnFrame`
NDJSON. It needs the seat's provider connection, and answers
HTTP 503 `host_unconfigured` until the seat is connected. See
[Run a routed flow from your own host](../guides/host-a-turn.md).

The template ships no live model, so it has no `test:record` script. Add a
`live` function and pass it to `cachedModelTest` to record; `aomi` has the
worked example.

## aomi

The Aomi Build page as a Smithers app: a chat flow and a build pipeline over an
in-memory EVM fork, six panes, a full Worker, and a Cloudflare deploy.

- **Seats.** The root `AGENT.ts` seats `openai:gpt-5.5` with 32 calls and 12
  frames. `flows/build/AGENT.ts` seats `openai:gpt-6-sol` with 64 calls and
  24 frames, which is the layer rule in one file: it moves the build pipeline
  to a stronger seat and leaves its sandbox and tools resolving to the root.
- **Flows.** `chat` (a chat flow, answering chain questions) and `build` (a
  pipeline flow returning a typed `BuildPlan` of files and stages).
- **Pages.** `/`, `/build`, `/overview`, `/projects`, `/providers`,
  `/integrations`, `/settings`, and five under `/operate`.
- **Panes.** `build-files`, `build-plan`, `chain-balance`, `chain-block`,
  `chain-contract`, and `chain-tx`.
- **Tools.** Three sources: `tevm` (`fork`, `getBalance`, `readContract`,
  `call`, `setAccount`, `mine`, `simulate`, `getBlock`), `ui` (`pane`, `html`),
  and `flows` (`show-script`, `write-flow`, which writes a flow, its test, and
  its fixture back into the app's own source tree).
- **Worker.** A router free of `cloudflare:workers` so it can be driven on
  plain Node, one Durable Object per session, an NDJSON turn stream run by
  `@smthrs/create-app/worker`, and a guard that enforces a bearer credential,
  a 64 KiB body cap, and a session-id shape.
- **Tests.** Every flow replays a fixture, plus suites for the wire contract,
  the stream, the turn, the Worker, and the Tevm fork.

### Chain tool configuration

`TOOLS.ts` composes the deterministic Tevm mock with an empty grant, which the
fixtures and tests run on. A host using `layerTevm` supplies
`TevmOptions.rpcUrl`, or sets `TEVM_FORK_RPC_URL` in the process environment.
The shipped Worker passes its `TEVM_FORK_RPC_URL` binding as `rpcUrl` and
refuses a turn without it. `tevm/fork` accepts only `blockTag` and
cannot select an endpoint. Its block defaults to `TevmOptions.blockTag`, then
`latest`. Failed lazy connections are retried on the next call.

Build `tevmSource` from that layer's service context. Every real binding,
including `mine` and `setAccount`, declares
`net:post:<configured origin>/*` because any first call can open the fork.
Give the host tool layer the matching grant:
`{ action: "net:post", resource: new URL(rpcUrl).origin + "/*" }`.
The origin omits credentials, paths, and query parameters.

`tevm/mine` accepts an integer `blocks` from 1 to 256 (default 1) and an
integer `intervalSeconds` from 0 to 86400 (default 12). `tevm/simulate` accepts
at most 256 calls, including an empty list. Inputs outside these bounds
return `invalid_input` before a handler runs.

### The turn

A turn runs the chat flow on `runTurn` from `@smthrs/create-app/worker`, and a
pipeline run runs the build flow on `runFlow`, with the QuickJS variant built
from the `.wasm` module `wrangler.jsonc` compiles. The Worker rebinds `ui` to
the turn's stream, `flows` to the session's Durable Object, and `tevm` to the
real fork. There is no mock turn: a turn missing the seat's key or
`TEVM_FORK_RPC_URL` answers 503 with
`code: "host_unconfigured"` and a message naming the secret, before the session
is marked running. A pipeline run in the same state settles its `flow-run` card
`failed` with that message.

A turn is one request on the in-memory flow engine. An eviction mid-turn ends
it; the messages and cards already written stay.

### What it needs to run

`.dev.vars.example` lists four values, and the template's own README explains
each:

| Variable            | What reads it                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`    | Seat resolution, for the `openai:` seats the template ships                                            |
| `TEVM_FORK_RPC_URL` | The Worker's Tevm fork, and the fork test                                                              |
| `APP_API_TOKEN`     | The API guard. Missing or empty refuses requests (401) unless local open mode is explicitly enabled    |
| `APP_API_OPEN`      | Set to `1` only in `.dev.vars.example` for local development without a token; never deploy this opt-in |

Set `APP_API_TOKEN` as a secret before the first public deploy. A configured
token takes precedence over `APP_API_OPEN`. Health omits authentication
configuration. JSON routes require `Content-Type: application/json` (415
otherwise); present `Origin` and `Sec-Fetch-Site` headers must identify the
same origin (403 otherwise). See
[Deploy to Cloudflare](../guides/deploy-to-cloudflare.md).
