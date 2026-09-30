# apps

The deployable applications of the Smithers product, as pnpm workspace
members (`apps/*` in `pnpm-workspace.yaml`). Formerly one package,
`apps/mvp`; split 2026-08-15.

| Package           | Name              | What it is                                                                                                                                                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/app/`        | `smithers-app`     | The Electrobun + React native app and pure-web UI. Vite builds to `ui/dist`. `src/dev/` is the vite dev/preview AgentApi middleware (not a deployable).                                          |
| `apps/server/`    | `smithers-server` | The Cloudflare Worker deployable (`smithers-mvp-web`, canary.smithers.sh). Serves `../ui/dist` assets and the `/api`, `/v1`, `/workflows` seams.                                                 |
| `packages/rpc/`   | `@smthrs/rpc`     | The agent contract both sides import (`AgentContext`, `AgentApiRoutes`, `NativeAgent` frames, `Cards`, ...). Import as `@smthrs/rpc/<Module>`.                                                   |

Deploy identity: the Worker's wrangler `name` stays `smithers-mvp-web`.
Renaming it would deploy a fresh Worker and orphan the Durable Object
state and the canary.smithers.sh custom-domain binding.

`@smthrs/*` dependencies resolve as workspace links into `packages/`
(the vendored copies under `vendor/smthrs` are gone). `@smthrs/chain`
had no living source elsewhere and was promoted to `packages/smithers/agent/chain`
(`@smthrs/chain`).

Product-level docs (`DESIGN.md`, `UPSTREAMS.md`, `E2E-CANARY-CHECKLIST.md`,
`REMEDIATION.md`) live at this level because they cover UI and Worker waves
alike. `UPSTREAMS.md` names the one active upstream, the shared Smithers
backend, and the retired identity, billing and chat Workers.

## Running it locally

| Command                               | From            | What runs                                                                                                                                                     |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                            | repository root | The Electrobun app. Forwards to `pnpm --filter smithers-app run start` (devkit projection, `vite build --configLoader runner`, `electrobun dev`), so the launch lives in one place. |
| `pnpm --filter smithers-app run build` | anywhere        | The Electrobun bundle: `vite build` into `apps/app/dist`, then `electrobun build`.                                                                             |

The app serves the SPA from a Bun local origin on `127.0.0.1` and forwards
`/api/auth/*` and `/api/identity/*` to `https://canary.smithers.sh`; chat is a
turn on the shared backend's `/api/agent/turn` as the signed-in Smithers Cloud
user. Ports, env flags (`SMITHERS_LOCAL_PORT`,
`SMITHERS_CHAT_STUB`, ...), the HTTP and WebSocket API, and the test tiers are
specified in `apps/app/docs/LOCAL-APP.md`. Signed-in state completes on the
canary origin: the session cookie and the GitHub OAuth callback are bound
there.
