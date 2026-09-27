# The seams this product runs on

`smithers-mvp-web` (`apps/server`) is the shared edge: it serves the
smithers.sh site and forwards every `/api/*` request unchanged to the one
active product upstream, the shared Smithers backend at
`SMITHERS_BACKEND_ORIGIN` (`apps/server/wrangler.jsonc`). Sign-in, balance,
chat turns and repository reads all resolve there.

The edge activation (#1795) retired the sibling Cloudflare Workers the legacy
Worker proxied. They live under `workers/` in `github.com/smithersai/ui`, a
separate repository, and are no longer upstreams of `apps/server`. Their
retirement (repointing or deleting `identity.smithers.sh` and the personal
`workers.dev` hostnames) is an operator step tracked in #2103; do not delete
their data before it has a recorded disposition.

## The inventory

| Seam | Worker env var (`apps/server/wrangler.jsonc`) | Cloudflare Worker | Source | Status |
| --- | --- | --- | --- | --- |
| Smithers backend — every `/api/*` route | `SMITHERS_BACKEND_ORIGIN` | _(not a Worker)_ | `packages/backend`, composed by `../plue` | active, `api.jjhub.tech` |
| Identity — GitHub OAuth, sessions, the allowlist, the watched-repos chooser | _(retired: `IDENTITY_UPSTREAM_URL`)_ | `smithers-cloud-identity` | `smithersai/ui`, `workers/identity` | retired upstream, `identity.smithers.sh` |
| Billing — balances, grants, the admin grant surface | _(retired: `BILLING_UPSTREAM_URL`)_ | `smithers-cloud-billing` | `smithersai/ui`, `workers/billing` | retired upstream, `billing.smithers.sh` |
| Chat — the metered turn upstream | _(retired: `SMITHERS_CHAT_URL`)_ | `smithers-cloud-chat` | `smithersai/ui`, `workers/chat` | retired upstream, `chat.smithers.sh` |

The recommendations worker (`smithers-cloud-reco`, `reco.smithers.sh`) was
deleted on 2026-08-24. Five more workers exist in that tree and this product
does not call them: `connectors-catalog`, `cron`, `status`, `sync`, `webhooks`.

## Deploying one

From a checkout of `github.com/smithersai/ui`:

```sh
node workers/deploy.mjs --list                  # every deployable worker
node workers/deploy.mjs identity --dry-run      # no credentials, nothing published
node workers/deploy.mjs identity                # real deploy; writes a receipt
```

Receipts land in `workers/<name>/deploy-receipts/`, with `latest.json` naming
the git sha, the timestamp, and the Cloudflare version id — the same shape
`apps/server/deploy-receipts/` uses, so both halves of a deploy can be read the
same way.

Each Worker's `name` and `routes` are its identity. Renaming one deploys a
fresh Worker with empty Durable Object storage and detaches its custom domain;
the deploy script never edits either.

## Before you touch these

**The source tree is a working branch.** The `smithersai/ui` checkout was on
`wave5-billing-bridge` with uncommitted changes to the identity worker when
this was written. Commit or stash before deploying anything from it: a deploy
ships the working tree, and the receipt's git sha will not describe what
actually went out.
