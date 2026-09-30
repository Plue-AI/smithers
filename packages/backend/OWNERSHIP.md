# Go backend package ownership

Smithers owns the product implementation and ordinary local runtime. Plue imports
these packages and supplies Kubernetes, cloud storage, fleet placement, and
multitenant policy through the exported contracts. Deployment implementations
and their private SQL live in Plue.

This package inventory comes from `go list ./packages/backend/...`. Update it
when adding, moving, or deleting a package.

## Exported packages

The application entrypoint is `app.Config`. The other exported packages provide
shared contracts, adapters, and command implementations; they do not introduce
another product composition root.

- `packages/backend/admission`
- `packages/backend/app`
- `packages/backend/blobs`
- `packages/backend/canonicalimport`
- `packages/backend/cmd/failurecodes`
- `packages/backend/cmd/legacyimport`
- `packages/backend/cmd/resolve-agent-message`
- `packages/backend/commerce`
- `packages/backend/controlstore`
- `packages/backend/credits`
- `packages/backend/db/product`
- `packages/backend/egressrelay`
- `packages/backend/errors`
- `packages/backend/flowdispatch`
- `packages/backend/flowhost`
- `packages/backend/flowmanifest`
- `packages/backend/flowruntime`
- `packages/backend/httpapi`
- `packages/backend/ironproxy`
- `packages/backend/jobs`
- `packages/backend/localbootstrap`
- `packages/backend/microsandbox`
- `packages/backend/modelhost`
- `packages/backend/modelprice`
- `packages/backend/modelproxy`
- `packages/backend/native`
- `packages/backend/operations`
- `packages/backend/ports`
- `packages/backend/postgres`
- `packages/backend/previewgateway`
- `packages/backend/process`
- `packages/backend/productstore`
- `packages/backend/provisioning`
- `packages/backend/repository`
- `packages/backend/runtimebridge`
- `packages/backend/runtimeports`
- `packages/backend/sandbox`
- `packages/backend/sandbox/guest`
- `packages/backend/security`
- `packages/backend/ssh`
- `packages/backend/telemetry`
- `packages/backend/testkit`
- `packages/backend/testkit/postgresfixture`
- `packages/backend/testkit/testdb`
- `packages/backend/webapp`
- `packages/backend/webhooks`
- `packages/backend/workspace`
- `packages/backend/workspaceconformance`

## Internal product packages

Hosts use the exported contracts and cannot import these packages directly.
Generated product rows remain canonical; exported stores expose the operations
needed by adapters without copying product queries or schemas.

- `packages/backend/internal/auth`
- `packages/backend/internal/billingstore`
- `packages/backend/internal/blob`
- `packages/backend/internal/buildcache`
- `packages/backend/internal/chat`
- `packages/backend/internal/cleanup`
- `packages/backend/internal/compose`
- `packages/backend/internal/config`
- `packages/backend/internal/configsync`
- `packages/backend/internal/credentialscan`
- `packages/backend/internal/database`
- `packages/backend/internal/db`
- `packages/backend/internal/diffview`
- `packages/backend/internal/email`
- `packages/backend/internal/githubrepo`
- `packages/backend/internal/identity`
- `packages/backend/internal/lfsauth`
- `packages/backend/internal/middleware`
- `packages/backend/internal/observability`
- `packages/backend/internal/ownership`
- `packages/backend/internal/pairauth`
- `packages/backend/internal/pkg/crypto`
- `packages/backend/internal/pkg/errors`
- `packages/backend/internal/repohost`
- `packages/backend/internal/repohostffi`
- `packages/backend/internal/repohostserver`
- `packages/backend/internal/revocation`
- `packages/backend/internal/routes`
- `packages/backend/internal/services`
- `packages/backend/internal/services/workspace_scripts`
- `packages/backend/internal/sse`
- `packages/backend/internal/ssh`
- `packages/backend/internal/subscriptiontoken`
- `packages/backend/internal/webhook`
- `packages/backend/internal/webhooks`

## SQL ownership

`db/ownership.csv` records table ownership. `db/product.Apply` installs only the
ordered product migrations, and product sqlc reads only that schema lineage.
Plue maintains its private migrations and separate revision ledger. Public
code reaches private state through injected stores and ports.

`scripts/check-go-boundaries.py` rejects private packages, private-table SQL,
cloud SDK dependencies, and deployment configuration in the public backend.
Plue's ownership check compares its packages with its pinned public module and
rejects duplicate product packages after the legacy cutover.
