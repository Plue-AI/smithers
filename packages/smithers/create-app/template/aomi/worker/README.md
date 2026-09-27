# The Aomi Worker

One Cloudflare Worker serves the whole app on `aomi.smithers.sh`: the built SPA
as static assets, the `/api/*` seams, and the agent turn itself. There is no
second deployable and no origin server.

## Layout

| File | What it is |
| --- | --- |
| `wrangler.jsonc` | Worker name, custom domain, assets, Durable Object bindings, vars |
| `index.ts` | The entry point. Exports the Durable Object class, so it is the only module here that imports `cloudflare:workers` |
| `router.ts` | The router. One switch over `Routes` from `src/api.ts`; everything else falls through to `ASSETS`. Free of `cloudflare:workers`, so `test/worker.test.ts` drives it on plain Node |
| `registry.ts` | Which Durable Object holds a session, and the one well-known object that holds the session list |
| `guard.ts` | Request admission: credential, browser origin, JSON media type, body size, session-id shape |
| `stream.ts` | Streamed-response bookkeeping that runs once on close, source error, and cancel |
| `env.ts` | The bindings, as an interface. Nothing else reads configuration |
| `AppSession.ts` | One Durable Object per session: transcript, cards, saved flows |
| `turn.ts` | One agent turn as an NDJSON stream of `TurnFrame` lines, with the runtime imported lazily |
| `turnImpl.ts` | The turn itself: `runTurn` from `@smthrs/create-app/worker`, written into the session as it runs |
| `flowRunImpl.ts` | `POST /api/flows/run`: a routed flow executed outside the conversation, projected onto one `flow-run` card |
| `host.ts` | The run host both share: the Tevm fork, the per-run `ui` and `flows` tool sources, and the observer that persists frames |
| `sandbox.ts` | The QuickJS variant built from the `.wasm` module import; the only file that imports it |

## Routes

| Method and path | Answer |
| --- | --- |
| `POST /api/agent/turn` | NDJSON stream of `TurnFrame`, forwarded from the session object; 400 for a flow that is not routed or not a chat flow; 503 `{ error, code: "host_unconfigured" }` naming the missing secret |
| `POST /api/agent/turn/cancel` | `{ cancelled }` |
| `GET /api/session?id=` | `SessionState` |
| `GET /api/session` | `{ sessions: SessionSummary[] }`, newest first, read from the registry object; the shell's Recent column renders it. An object evicted mid-turn never reports its settle, so a `running` row can outlive its turn; `?id=` reads the session object itself |
| `GET /api/flows?sessionId=` | File flows from `routes.gen.ts` plus the session's saved flows |
| `POST /api/flows/run` | `{ executionId }` |
| `GET /api/health` | `{ ok, build, app }`, reachable without a credential |
| anything else | `env.ASSETS.fetch(request)` |

Every `/api/*` route but health answers `401` when `APP_API_TOKEN` is missing
or empty without the local `APP_API_OPEN=1` opt-in, or when a configured token
has no matching `Authorization: Bearer` header. API requests with a foreign
`Origin` or a `Sec-Fetch-Site` other than `same-origin` answer `403`. JSON
routes require `Content-Type: application/json` (`415` otherwise), answer
`413` for a body over 64 KiB, and `400` for a session id that is not a flat
identifier of at most 128 characters.

`assets.run_worker_first` is scoped to `/api/*`, so an asset request never wakes
this code. An unrouted `/api/*` path answers this Worker's own JSON 404 rather
than the SPA's `index.html`.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then fill in the seat's provider key
pnpm dev
```

`pnpm dev` runs Vite, and `@cloudflare/vite-plugin` runs `worker/index.ts`
inside workerd in the same process. Durable Objects, the SQLite storage, and the
assets binding are all local. `.dev.vars` supplies the Worker's secrets to
`pnpm dev`; it is gitignored, and Vitest never reads it (see below). The example explicitly sets `APP_API_OPEN=1` to admit local API
requests without a token. A nonempty `APP_API_TOKEN` still requires a matching
bearer header. Keep `APP_API_OPEN` out of deployed vars and secrets.

## Deploy

```sh
pnpm build                     # vite build: dist/client (SPA) + dist/aomi-smithers-demo (Worker)
wrangler deploy                # from the app root, with NO --config
```

`wrangler deploy` must run from the app root **without** `--config`. The build
writes `.wrangler/deploy/config.json`, and wrangler follows that redirect only
when no `--config` flag is given: `resolveWranglerConfigPath` in
`node_modules/wrangler/wrangler-dist/cli.js:2942` returns early with
`redirected: false` as soon as `--config` is set. Passing
`--config worker/wrangler.jsonc` makes wrangler bundle `worker/index.ts` from
source with esbuild alone. That is not the Worker `pnpm build` produced:
`@cloudflare/vite-plugin` writes its own `dist/__APP_NAME__/wrangler.json`, and
the redirect is the only thing that points a deploy at it.

`package.json`'s `deploy` script is a bare `wrangler deploy` and `CreateApp`'s
deploy target passes no `--config` either, so both paths already take the
redirect.

Credentials, exported in the deploying shell:

```sh
export CLOUDFLARE_API_TOKEN=<token with Workers Scripts + Workers Routes edit>
export CLOUDFLARE_ACCOUNT_ID=<account id>
```

Secrets, required before deploy, set once per environment and never committed:

```sh
wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
wrangler secret put TEVM_FORK_RPC_URL --config worker/wrangler.jsonc
wrangler secret put APP_API_TOKEN --config worker/wrangler.jsonc
```

The seat resolver (`seatsFromEnv` in `@smthrs/create-app/worker`) reads the
credential for the provider the seat names, so the secret follows `AGENT.ts`:
`OPENAI_API_KEY` for the `openai:gpt-5.5` this template ships,
`ANTHROPIC_API_KEY` for an `anthropic:` seat. The resolved seat also judges
completions. `TEVM_FORK_RPC_URL` is the endpoint the chain tool forks;
the run grants `net:post` on its origin and nothing wider. A turn missing any
of them is refused with a 503 that names the secret.

`pnpm test` runs Vitest as a plain Node process, outside workerd, so nothing
in `.dev.vars` reaches it. A recording (`pnpm test:record`) reads the seat's
provider key from `process.env` and the fork suite reads `TEVM_FORK_RPC_URL`
the same way, skipping itself when the variable is absent. Export both in the
shell that runs the tests:

```sh
export OPENAI_API_KEY=<key>          # the provider AGENT.ts names
export TEVM_FORK_RPC_URL=<archive-capable JSON-RPC endpoint>
pnpm test:record
```

`routes: [{ pattern: "aomi.smithers.sh", custom_domain: true }]` binds the
custom domain. Wrangler creates the DNS record and the certificate on the
`smithers.sh` zone during the first deploy; nothing has to be added in the
dashboard.

## Security

`CreateApp` ships `deploy` as a first-class target with a custom domain, so what
a deployed instance is bounded by is worth stating plainly. `guard.ts` owns all
request checks; `test/guard.test.ts` and `test/worker.test.ts` drive them.

| Bound | What it does | Default |
| --- | --- | --- |
| `APP_API_TOKEN` | Every `/api/*` route but `GET /api/health` requires `Authorization: Bearer <it>`, refused with 401 before any Durable Object is woken | **Unset, so the API refuses requests (401)** |
| Browser origin | Refuses a present `Origin` unequal to the request URL origin or a present `Sec-Fetch-Site` other than `same-origin` with 403; absent headers allow non-browser clients | Always on |
| JSON media type | JSON routes require `Content-Type: application/json`, with optional parameters; otherwise 415 | Always on |
| 64 KiB body cap | Every JSON body is read through the cap and refused with 413 past it, with or without a declared `content-length` | Always on |
| Session-id shape | A flat identifier of at most 128 characters, never the registry object's name, so `INDEX_SESSION` cannot be addressed as a session | Always on |

A missing or empty `APP_API_TOKEN` refuses API requests unless `APP_API_OPEN`
is exactly `1`. Only `.dev.vars.example` ships that opt-in for `pnpm dev`;
never configure it on a deployment. A configured token always takes precedence.
`GET /api/health` reports `{ ok, build, app }` without authentication details.
Open the browser shell
as `https://<host>/#token=<APP_API_TOKEN>` (URL-encode the value). The fragment
stays out of HTTP requests. The shell claims it before redirecting to `/build`,
strips it from the URL, and stores it in `sessionStorage` (`src/shell/token.ts`).
It survives reloads for this tab's session; closing the tab clears it. Bootstrap
again for a new session. Legacy `?token=` links work for one release with a
console warning; use the fragment form to avoid sending credentials in URLs.

What is still NOT bounded, and what a production app would add: per-session
Durable Object storage growth, model spend, and request rate. One shared token
is one tenant, not tenancy: a holder of the token reaches every session id it
can guess.

### Two config files, one directory

`wrangler.jsonc` here is the source config. `vite build` writes a second one,
`dist/aomi-smithers-demo/wrangler.json`, with `main` and `assets.directory`
rewritten to the build output (`@cloudflare/vite-plugin`'s `getOutputConfig`
and `getAssetsDirectory`), and drops `.wrangler/deploy/config.json` so
`wrangler deploy` picks the generated config up. The plugin never reads
`assets.directory` from the source config; the value there (`../dist/client`)
is for a deploy that bypasses the plugin, and both paths resolve to the same
directory.

### Frozen fields

`name` and `routes` are the Worker's identity. Durable Object storage is keyed
to the Worker name, so renaming it creates a fresh Worker with empty storage and
orphans every session. The custom domain follows the `routes` entry in whichever
config declares it. Neither field changes as part of a routine deploy.

## The turn

A turn is `runTurn` from `@smthrs/create-app/worker`, the same host the
default template serves: the seat from `AGENT.ts`, the completion judge, cells
in a QuickJS realm built from the `.wasm` module `wrangler.jsonc` compiles, and
the in-memory flow engine. `host.ts` rebinds three tool sources per run: `ui`
paints into the turn's stream, `flows` saves into this session's object and
reads the cells this turn ran, and `tevm` is the real fork over
`TEVM_FORK_RPC_URL`. Every frame is observed as the run produces it, so the
cards, the user message, the answer, and the Recent row are written whether or
not a reader is keeping up.

A pipeline flow (`POST /api/flows/run`) runs on the same host through
`runFlow`. Its `flow-run` card settles once, with the steps the flow returned
in its output (`BuildPlan.steps`).

A turn is one request. Its journal is the in-memory engine's, so an eviction
mid-turn ends the turn; the transcript and cards already written stay, and the
next turn starts fresh.

## Cancellation

workerd forbids one request touching another request's I/O, so `POST
/api/agent/turn/cancel` does not abort the turn's `fetch`. It aborts an
`AbortController` the turn itself holds, and the turn checks `signal.aborted`
between frames. The controller map and the `busy` flag are transient: an
eviction ends every stream the object was serving, so state that outlived it
would be a lie the next reader could not clear.
