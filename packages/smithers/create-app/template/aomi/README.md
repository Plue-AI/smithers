# __APP_NAME__

The Aomi Build page as a Smithers app: a chat flow and a build pipeline over an
in-memory EVM fork, six panes, an in-Worker agent, and a Cloudflare deploy.

This is the reference layout. It is larger than the `default` template on
purpose: every rule the router enforces is exercised somewhere in it.

```sh
pnpm install
cp .dev.vars.example .dev.vars  # includes APP_API_OPEN=1 for local development
pnpm routes     # write routes.gen.ts and routes.ui.gen.ts
pnpm typecheck
pnpm dev        # vite, with workerd in the loop
```

The local `.dev.vars` explicitly opts into an open API with `APP_API_OPEN=1`.
Without that opt-in, a missing or empty `APP_API_TOKEN` refuses API requests
with 401. A nonempty token always requires a matching bearer header.

This UI reference remains repository-only for the 1.0 RC. It depends on the
unreleased `@smthrs/ui` package and is deliberately excluded from the
published `@smthrs/create-app` tarball.

## Layout

| Path                      | What it is                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `PACKAGE.ts`              | `CreateApp()`: brand, navigation, and the dev/build/deploy targets |
| `AGENT.ts`                | The seat and teaching every flow below it runs with                |
| `SANDBOX.ts`              | The QuickJS budget every cell runs under                           |
| `TOOLS.ts`                | The flow-binding sources every flow below it can call              |
| `flows/chat/`             | The conversation: chain questions in, an answer plus cards out     |
| `flows/build/`            | The pipeline, with its own `AGENT.ts` overriding the root one      |
| `app/**/page.tsx`         | One page at `/<dir>`; `app/page.tsx` is `/`                        |
| `app/panes/<name>.tsx`    | One pane the agent renders by name                                 |
| `tools/tevm.ts`           | Chain reads against an in-memory fork                              |
| `tools/ui.ts`             | `ui/pane` and `ui/html`, the two ways to put a card on screen      |
| `tools/promote.ts`        | Writes a flow, its test, and its fixture back into `flows/`        |
| `worker/`                 | The Worker: session Durable Object, turn stream, seat resolution   |
| `src/`                    | The browser shell: routing, transcript, brand, components          |

`routes.gen.ts` and `routes.ui.gen.ts` are generated. Run `pnpm routes` after
adding a page, a pane, a flow, or a layer file. `vite` regenerates them while it
runs, `pnpm routes:check` exits 1 on drift, and `smithers-build lint
'//:routes'` is the form the build graph runs.

`flows/build/AGENT.ts` is the layer rule in one file: it moves the build
pipeline to its own seat and teaching, and leaves its sandbox and tools
resolving to the root. Nothing merges.

## Tests

```sh
pnpm test          # replay every flow's recorded fixture, plus the wire contract
pnpm test:record   # re-record against the live seat; needs a provider key
```

Vitest runs as a plain Node process and never reads `.dev.vars`; that file
feeds only `pnpm dev`'s workerd. A recording reads the credential for the
provider `AGENT.ts` names from the test process environment, and
`test/tevm.test.ts` reads `TEVM_FORK_RPC_URL` the same way, skipping the fork
suite when it is absent. Export both before running:

```sh
export OPENAI_API_KEY=<key>
export TEVM_FORK_RPC_URL=<archive-capable JSON-RPC endpoint>
pnpm test:record
```

The shipped `TOOLS.ts` uses the deterministic Tevm mock with an empty grant.
A host using `layerTevm` sets `TevmOptions.rpcUrl` or exports
`TEVM_FORK_RPC_URL` in the process environment; Worker hosts pass the binding
as `rpcUrl`. Build `tevmSource` from that service and grant only
`{ action: "net:post", resource: new URL(rpcUrl).origin + "/*" }`.
`tevm/fork` accepts only `blockTag`, defaults to the host's configured block,
and cannot change the endpoint. A failed initial connection retries on the
next call.

Mining accepts 1–256 blocks and an integer interval of 0–86400 seconds.
Simulation accepts at most 256 calls. Out-of-range input returns
`invalid_input` to the model.

## Deploying

Set the credential for the provider the app's seat names. `AGENT.ts` seats
`openai:gpt-5.5` and `flows/build/AGENT.ts` seats `openai:gpt-6-sol`, so this
template needs `OPENAI_API_KEY`. Change the seats and the secret changes with
them: an `anthropic:` seat reads `ANTHROPIC_API_KEY`. Every turn also needs
`TEVM_FORK_RPC_URL` for the
chain fork; a turn without one is refused with a 503 naming it.

```sh
wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
wrangler secret put TEVM_FORK_RPC_URL --config worker/wrangler.jsonc
wrangler secret put APP_API_TOKEN --config worker/wrangler.jsonc
pnpm build
pnpm deploy
```

`APP_API_TOKEN` is a required Worker secret for deployment. Set it before the
first deploy. A missing or empty token refuses every `/api/*` route except
`GET /api/health` with 401. Keep the local `APP_API_OPEN=1` opt-in out of
production vars and secrets. Health reports only `{ ok, build, app }` and does
not disclose authentication configuration.

Open the deployed app as `https://<host>/#token=<APP_API_TOKEN>` (URL-encode the
value). The fragment is not sent in the HTTP request. Before redirecting to
`/build`, the shell stores the token in `sessionStorage` and strips it from the
address bar (`src/shell/token.ts`). API requests carry it for this tab's session,
including reloads; closing the tab clears it. Bootstrap again for a new session.
Legacy `?token=` links work for one release with a console warning; use the
fragment form to keep credentials out of HTTP request URLs.

JSON routes require `Content-Type: application/json` (415 otherwise). API
requests carrying `Origin` or `Sec-Fetch-Site` must identify the same origin
(403 otherwise); clients without these headers remain supported.

Two further bounds need no configuration: a JSON body over 64 KiB is
refused with 413, and a session id must be a flat identifier of at most 128
characters, so the registry object cannot be addressed as a session. Per-session
storage, model spend, and request rate stay unbounded; `worker/README.md` has
the full list.

`domain` in `PACKAGE.ts` and the `routes` entry in `worker/wrangler.jsonc` name
the same hostname. Point both at a zone your Cloudflare account owns before the
first deploy.
