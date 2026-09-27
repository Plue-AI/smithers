# __APP_NAME__

A Smithers app. `PACKAGE.ts` declares it; everything else is named by where it
sits.

```sh
pnpm install
pnpm routes     # write routes.gen.ts and routes.ui.gen.ts
pnpm typecheck
pnpm dev        # vite, with workerd in the loop
```

## Layout

| Path                      | What it is                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `PACKAGE.ts`              | `CreateApp()`: brand, navigation, and the dev/build/deploy targets |
| `AGENT.ts`                | The seat and teaching every flow below it runs with                |
| `SANDBOX.ts`              | The QuickJS budget every cell runs under                           |
| `TOOLS.ts`                | The flow-binding sources every flow below it can call              |
| `flows/<id>/flow.ts`      | One flow, named by its directory                                   |
| `app/**/page.tsx`         | One page at `/<dir>`; `app/page.tsx` is `/`                        |
| `app/panes/<name>.tsx`    | One pane the agent renders by name                                 |
| `app/layout.tsx`          | The shell layout, optional                                         |
| `tools/*.ts`              | Flow bindings the agent calls as `ctx.call("<source>/<flow>")`     |
| `worker/index.ts`         | The Worker entry: loads the QuickJS module and serves `handle.ts`  |
| `worker/handle.ts`        | `/api/routes`, `/api/turn` (the chat turn as NDJSON), and assets   |
| `flows/<id>/flow.e2e.ts`  | One flow replayed against a recorded model, so `pnpm test` needs no key |

`routes.gen.ts` and `routes.ui.gen.ts` are generated. Run `pnpm routes` after
adding a page, a pane, a flow, or a layer file. `vite` regenerates them while
it runs, and `pnpm routes:check` exits 1 on drift.

The scaffolded `.gitignore` excludes `node_modules`, `dist`, `.wrangler`,
`.flows`, and local credentials in `.dev.vars` from Git.

The build graph reads the workspace's Git index. Initialize the repository and
stage the generated app before running its routes target:

```sh
git init
git add .
pnpm exec smithers-build lint '//:routes'
```

Install bubblewrap on Linux. macOS uses its built-in seatbelt confinement.

## Installing

The template pins the synchronized Smithers RC packages. `pnpm install`
resolves them from the registry without overrides, local links, or vendoring.

## Secrets

`/api/turn` runs the chat flow on the seat in `AGENT.ts` and answers HTTP 503
`host_unconfigured` until the Worker has what the turn needs:

| Secret               | When                                          |
| -------------------- | --------------------------------------------- |
| `ANTHROPIC_API_KEY`  | The seat is `anthropic:<model>`               |
| `OPENAI_API_KEY`     | The seat is `openai:<model>`                  |

Set them with `wrangler secret put <NAME>`, or in `.dev.vars` for `pnpm dev`.

## Adding things

A layer file applies to its own directory and everything below it. The nearest
ancestor of each kind wins, and nothing merges, so `flows/build/AGENT.ts` moves
just the `build` flows to another seat and leaves their sandbox and tools alone.

A flow never names a model. Change the seat in `AGENT.ts`.

## Testing

```sh
pnpm test   # replays flows/chat/fixtures/answer.json; no network, no key
```

Re-recording a fixture needs a `live` model, which this template does not ship.
`flows/chat/flow.e2e.ts` says what to add, and the `aomi` template's
`test/support/liveModel.ts` is the worked example.

## Deploying

```sh
pnpm build
pnpm deploy
```

Set the secrets above before the first turn.

`domain` in `PACKAGE.ts` and the `routes` entry in `worker/wrangler.jsonc` name
the same hostname. Point both at a zone your Cloudflare account owns before the
first deploy.
