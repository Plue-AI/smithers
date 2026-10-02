# @smthrs/rpc

`LocalApp` defines harness, repository, file, and target records. `LocalLsp` defines code intelligence. `CloudTunnel` defines the cloud proxy, terminal tunnel, and sign-in contracts.

Shared product contracts for the local host, browser, and server. Import individual modules such as `@smthrs/rpc/LocalApp`, `@smthrs/rpc/AppLinks`, and `@smthrs/rpc/TargetGraph`.

`BrowserFetch` is the one implementation module: the browser tool's guarded fetch-and-extract handler, shared by the product Worker and the local host. It is the only module that performs network I/O, with the DNS resolver injected by each host.

The model host owns enrollment (`POST /api/model/credential`) and safe receipts
(`GET /api/model/credential/receipt`). Bun uses its state-scoped OS keychain;
the Worker returns `local_host_required` after its session gate.

## Route ownership

Each route family has one home module, and a route constant is declared only there. A route belongs to the longest family it falls under. Add a route to the module its family names; a new family gets a row here first. `test/RouteOwnership.test.ts` holds every `/api/` constant to this table.

| Family                                                                                                                                                                                                          | Module               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `/api/auth/github/start`, `/api/auth/github/callback`                                                                                                                                                           | `AgentApiRoutes.ts`  |
| `/api/auth/local`, `/api/auth/sse-ticket`, `/api/auth/github`, `/api/user`                                                                                                                                      | `ApplicationAuth.ts` |
| `/api/repo/files`                                                                                                                                                                                               | `LocalApp.ts`        |
| `/api/cloud`, `/api/cloud-ws`, `/api/cloud-auth`                                                                                                                                                                | `CloudTunnel.ts`     |
| `/api/bootstrap`                                                                                                                                                                                                | `AppBootstrap.ts`    |
| `/api/repository-setup`                                                                                                                                                                                         | `RepositorySetup.ts` |
| `/api/repos/{owner}/{repo}/mythical`                                                                                                                                                                            | `Mythical.ts`        |
| `/api/model/credential`, `/api/model/credential/receipt`                                                                                                                                                        | `AgentApiRoutes.ts`  |
| `/api/commands`, `/api/agent`, `/api/auth`, `/api/identity`, `/api/billing`, `/api/tools`, `/api/workflow`, `/api/model`, `/api/public`, `/api/admin`, `/api/recommend`, `/api/jev`, `/api/chat`, `/api/health` | `AgentApiRoutes.ts`  |

These are public product contracts even while the package is private. Preserve wire fields and route strings when changing implementation details. All exported declarations carry descriptions, `@since`, and `@category`.

Run `pnpm run check`, `pnpm run lint`, and `pnpm run test` here. Sources use the standard NodeNext configuration with unchecked indexed access enabled; an array or dictionary lookup must handle absence. Tests live in `test/` and run under Vitest, matching the other packages. `IndexAccess.types.ts` pins the compiler contract.
