/**
 * Provisioned machines, provider-neutral remote process execution, and sandbox
 * liveness.
 *
 * Modules are re-exported as namespaces, the way `effect`'s own index does it,
 * so each keeps its `make` / `makeNoop` / `layerNoop` trio without colliding
 * with its neighbour.
 *
 * The package is **platform-neutral and browser-bundleable**: it adapts a
 * provider a caller hands it onto Effect's `ChildProcessSpawner` contract and
 * owns no host access of its own. `scripts/browser-check.mjs` at the repository
 * root pins that property. Every provider below obeys it the same way: a
 * vendor SDK arrives as an injected structural slice and a CLI arrives as an
 * injected spawner, so adding a backend costs this package no dependency and
 * no host access.
 *
 * @since 0.1.0
 */

/** Remote implementation of Effect's `ChildProcessSpawner`. */
export * as RemoteChildProcessSpawner from "./RemoteChildProcessSpawner/index.ts"

/** The conformance suite a provider implementation must pass. */
export * as ProviderConformance from "./ProviderConformance/index.ts"

/** The provisioned-machine contract and its projections. */
export * as Sandbox from "./Sandbox/index.ts"

/** Lands a session's captured work in a host jj repository. */
export * as SandboxMerge from "./SandboxMerge/index.ts"

/** The conformance suite a sandbox session provider must pass. */
export * as SandboxConformance from "./SandboxConformance/index.ts"

/** The scratch-directory sandbox provider. */
export * as DirectorySandbox from "./DirectorySandbox/index.ts"

/** The container-lifecycle sandbox provider, over a Docker-compatible CLI. */
export * as ContainerSandbox from "./ContainerSandbox/index.ts"

/** The argv-prefix sandbox provider, over `ssh`, `docker exec`, or this machine. */
export * as CommandSandbox from "./CommandSandbox/index.ts"

/** The Pod-per-session sandbox provider, over `kubectl`. */
export * as KubernetesSandbox from "./KubernetesSandbox/index.ts"

/** The in-process interpreter sandbox provider, for hosts that cannot spawn. */
export * as JustBashSandbox from "./JustBashSandbox/index.ts"

/** The Microsandbox microVM provider. */
export * as MicrosandboxSandbox from "./MicrosandboxSandbox/index.ts"

/** The Vercel Sandbox provider. */
export * as VercelSandbox from "./VercelSandbox/index.ts"

/** The Daytona sandbox provider. */
export * as DaytonaSandbox from "./DaytonaSandbox/index.ts"

/** The AWS ECS task provider. */
export * as AwsSandbox from "./AwsSandbox/index.ts"

/** The Cloudflare Durable Object provider. */
export * as CloudflareSandbox from "./CloudflareSandbox/index.ts"

/** Sandbox health-check contracts. */
export * as SandboxHealth from "./SandboxHealth/index.ts"

/** Heartbeat supervision over a remote sandbox session. */
export * as SandboxSupervision from "./SandboxSupervision/index.ts"
