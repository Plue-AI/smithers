# Worker implementation

- Use Effect for service implementation, I/O, resource lifetimes, concurrency,
  cancellation, and failures. Services expose Effects and receive dependencies
  through typed Effect services and Layers. Effect v4 is authoritative; read
  `node_modules/effect/src` before guessing an API. `docs/EFFECT.md` is the
  map of the program.
- Promise interop lives only at the platform boundaries `docs/EFFECT.md`
  lists (`src/Http.ts`, `src/DurableStorage.ts`, `src/Boundary.ts`, and a
  native Durable Object class's `fetch` line marked
  `// effect-policy: boundary`). `pnpm run check:effect` enforces it; run
  `pnpm run check` (typecheck + policy) before landing.
- The deployed entry is `src/edge.ts` (`wrangler.jsonc` `main`): workerd's
  `fetch(request, env)` over the Effect transport and asset router. Product
  authority belongs to the shared backend; the edge adds no `/api` route.
  `src/index.ts` is legacy maintenance-export and rollback source only.
- Security boundaries trace `wrangler.jsonc` main through shared backend
  authentication; legacy maintenance exports are separate review scope.
- Preserve HTTP contracts and the deployed Worker name, domains, Durable Object
  class identities AND binding names, and persisted storage keys during
  implementation refactors. `src/workerIdentity.ts` is the one place those
  facts live; `src/workerIdentity.test.ts` pins it and holds `wrangler.jsonc`
  (what `wrangler deploy` reads) to it. A change there is a DEPLOY.md
  cutover-log entry in the same commit.
- Secrets are declared in `WORKER_IDENTITY.secrets`, each marked required or
  not with the state its absence leaves (the preflight FAILs on a missing
  required one and prints the rest), set once on the live script with
  `wrangler secret put`, and kept by every deploy (`keep_bindings`); a
  deploying shell never carries a value, and no script, test or workflow may
  ask for one. Never print a secret value, in code or in a report.
- Deploys are the Deploy apps workflow on a push to `main`: landing on `main`
  is the deploy. It runs `scripts/deploy.ts` (site build, preflight, then
  `wrangler deploy`), which refuses a real deploy of a dirty tree or of a
  commit not on origin/main. Never run it for real or mutate Cloudflare from
  an agent session; the dry run and the preflight are read-only and are the
  most an agent may run. `wrangler deploy --dry-run` bundles and reads no live script, so it is
  never the identity verdict — `bun scripts/adopt-durable-objects.ts` is.
- A Durable Object's in-memory state is made once by the object (the native
  class's field), never a Layer built per request: the client-error throttle
  `Ref`.
- Routes the Smithers backend serves (`/api/workflow/{provision,rpc}`,
  `/api/repository-setup/*`, the platform proxy) are forwarded as the
  signed-in user through `forwardToCloud` (`src/proxies.ts`); never a second
  forwarder, and never Worker-side state for them.
- This package is the UI gateway. Changes to sandbox execution or frontend
  framework code belong to their owning packages.
