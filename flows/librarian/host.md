# Product workspace gateway

`node flows/librarian/build.mjs` writes `dist/product-host/smithers.mjs` and its SHA-256 sidecar. The artifact contains the 1.0 gateway, durable engine and dependencies. Provisioners stage these exact bytes; they must not run the unrelated `smthrs@0.33.0` package or install dependencies from the user's repository.

Run with Node 26.4+ or Bun 1.4:

```
bun /usr/local/lib/smithers/product-gateway.mjs serve --root /workspace/repo --host 0.0.0.0 --port 7331 --listen
```

The provisioner supplies `SMITHERS_API_KEY`, `SMITHERS_GATEWAY_ID`, `SMITHERS_REPO=owner/repository`, `SMITHERS_FLOW_ARTIFACT_SHA256`, `SMITHERS_SOURCE_REVISION` and `SMITHERS_OWNER_GENERATION`. Git and JJ must be installed. The API key is captured by the host and removed from the subprocess environment. The gateway uses its existing bearer approval authority and the same Control/Projection RPC protocols as the application.

The product catalog is empty: the Librarian history flow is retired (#2165; the stack service owns `mythical`), and target-repository modules cannot register here. The host still pins its source revision before readiness. Durable SQLite state lives under the state directory, outside the served checkout.

Acceptance executes the built artifact in a separate process over real HTTP RPC, real Git, and durable SQLite. The fixture builds that artifact from the current sources into a temporary directory and checks the SHA-256 sidecar, so it needs no prior build and never reads a stale one. Set `SMITHERS_PRODUCT_HOST_ARTIFACT` to validate staged bytes instead.

```
node --test flows/test/product-host.test.mjs
SMITHERS_PRODUCT_HOST_RUNTIME=bun node --test flows/test/product-host.test.mjs
```

It checks health and the runtime bridge identity, authentication, the empty catalog, a refused bridge launch, and restart.
