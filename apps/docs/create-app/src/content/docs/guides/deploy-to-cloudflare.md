---
title: "Deploy to Cloudflare"
description: "What CreateApp's four targets run, which credentials each one needs, why wrangler deploy takes no --config flag, and what to set before the first deploy."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/guides/deploy-to-cloudflare.md"
---

`CreateApp` returns four targets beside the manifest. Put them in the package's
target map and `smithers-build` addresses them by label:

```ts
export const Package = S.Package({
  targets: { routes: App.routes, dev: App.dev, build: App.build, deploy: App.deploy }
})
```

| Target   | Label       | What it runs                                                    |
| -------- | ----------- | --------------------------------------------------------------- |
| `routes` | `//:routes` | The `smithers-routes` executable over the app root              |
| `dev`    | `//:dev`    | `vite` on port 5173, with workerd in the loop                   |
| `build`  | `//:build`  | `vite build`, producing the Worker bundle and the static assets |
| `deploy` | `//:deploy` | `wrangler deploy`, gated on `build`                             |

Each is an ordinary [`@smthrs/targets`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/targets) rule, so an app runs on
the build CLI without a target kind of its own.

## What the targets declare

`routes` keys on everything the router reads: pages, panes, flows, layer files,
and `PACKAGE.ts`. Adding one of those invalidates the generated tables, and
nothing else does. It writes exactly two files, `routes.gen.ts` and
`routes.ui.gen.ts`.

`dev` waits for port 5173 and stops with `SIGTERM` and a five second grace
period. It runs with the network on.

`build` reads the app, flow, tool, worker, and source directories plus the
wrangler config and `vite.config.ts`, and writes `dist`.

`deploy` is gated on `build`, runs with the network on, and requires approval.
Its two credentials are declared as secrets scoped to
`https://api.cloudflare.com`:

- `CLOUDFLARE_API_TOKEN`, with permission to edit Workers Scripts and Workers
  Routes.
- `CLOUDFLARE_ACCOUNT_ID`.

## Point the app at a domain you own

Two files name the same hostname, and both have to be a zone your Cloudflare
account owns:

```ts
// PACKAGE.ts
deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
```

```jsonc
// worker/wrangler.jsonc
"routes": [{ "pattern": "ledger.example.com", "custom_domain": true }]
```

Wrangler creates the DNS record and the certificate on the first deploy, so
there is nothing to add in the dashboard. Removing the `routes` entry detaches
the domain from the Worker.

`config` defaults to `worker/wrangler.jsonc` and is the one path an app
overrides:

```ts
deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com", config: "infra/wrangler.jsonc" } }
```

The Worker name and its routes are its identity. Durable Object storage is
keyed to the Worker name, so renaming it creates a fresh Worker with empty
storage. Neither field changes as part of a routine deploy.

## Set the secrets

The provider credential follows the seat in `AGENT.ts`. A host resolves the
seat's provider and reads that provider's key, so an `anthropic:` seat needs
`ANTHROPIC_API_KEY` and an `openai:` seat needs `OPENAI_API_KEY`:

```bash
wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
```

Every turn uses the resolved seat for completion judgments too. No separate
judge credential is required. Until the seat is connected, the `default` template's `POST /api/turn` answers HTTP 503
`host_unconfigured` and names the missing binding.

Both templates require `APP_API_TOKEN` as a Worker secret before the first
public deploy, because every turn spends the seat's key:

```bash
wrangler secret put APP_API_TOKEN --config worker/wrangler.jsonc
```

Without a nonempty token, the `default` template's `POST /api/turn` and every
`aomi` `/api/*` route except `GET /api/health` refuse requests with 401. Open
the deployed app once as `https://<host>/#token=<APP_API_TOKEN>`; the page keeps
the token in this tab's sessionStorage and strips it from the address bar.
Health reports `{ ok, build, app }` without disclosing authentication
configuration.

Local development reads values from the gitignored `.dev.vars`. Set
`APP_API_OPEN=1` there (the `aomi` template's `.dev.vars.example` does) to
admit token-free local requests. Never add that opt-in to deployed vars or
secrets. A configured token always requires a matching bearer header.

API requests with an `Origin` or `Sec-Fetch-Site` header must identify the same
origin (403 otherwise). JSON routes require `Content-Type: application/json`
(415 otherwise), including in local open mode.

## Build and deploy

```bash
pnpm build
pnpm deploy
```

Run `wrangler deploy` from the app root and pass no `--config` flag. The build
writes `.wrangler/deploy/config.json`, and wrangler follows that redirect only
when no `--config` is given. With the flag set, wrangler bundles the Worker
entry point with esbuild alone, which fails on
`virtual:smthrs-app/manifest`: that module is served by the create-app Vite
plugin and is reachable from `routes.gen.ts`.

Both templates' `deploy` script is a bare `wrangler deploy`, and the `deploy`
target passes no `--config` either, so both paths already take the redirect.
The `--config` flag is still correct for `wrangler secret put`, which does not
go through the build.

## What a deployed app serves

The templates put the SPA in the assets bucket and scope
`run_worker_first` to `/api/*`, so an asset request never wakes the Worker.
`not_found_handling` is `single-page-application`, which is what lets the
templates route in the browser: the `default` template on the location hash,
the `aomi` template on history with a hash fallback. An unrouted
`/api/*` path answers the Worker's own JSON 404 rather than the SPA's
`index.html`.
