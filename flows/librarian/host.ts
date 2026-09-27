/**
 * Repository gateway host. It serves native Control and Projection RPC over the
 * repository checkout with an empty product catalog: the Librarian history flow
 * it once served is retired (#2165), and target-repository modules can never
 * register here.
 */
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"

export interface Options {
  readonly root: string
  readonly stateRoot: string
  readonly repo: string
  readonly gatewayId: string
  readonly credential: string
  readonly artifactDigest: string
  readonly sourceRevision: string
  readonly ownerGeneration: number
}

export const layer = (platform: NativeControl.Platform, options: Options) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error("SMITHERS_REPO must identify the owning repository")
  if (!options.credential.trim() || !options.gatewayId.trim()) {
    throw new Error("Product host requires its gateway identity and bearer credential")
  }
  if (!/^[a-f0-9]{64}$/.test(options.artifactDigest)) {
    throw new Error("Product host requires its immutable artifact digest")
  }
  if (
    !/^[a-f0-9]{40}$/.test(options.sourceRevision) || !Number.isSafeInteger(options.ownerGeneration) ||
    options.ownerGeneration <= 0
  ) {
    throw new Error("Product host requires an immutable source revision and positive owner generation")
  }
  const native = NativeControl.make(platform)
  const registry = Registry.layerFromDescriptors([]).pipe(Layer.provide(platform.host))
  // An empty executable catalog, still built: the host pins its source
  // revision when its catalog is read, before any admission or readiness.
  const executableOptions: Executable.RefreshOptions = {
    delegates: [],
    refreshable: () => false,
    load: () => Effect.fail(new Error("Unknown product flow"))
  }
  const modules = Layer.unwrap(
    Executable.catalog(executableOptions).pipe(
      Effect.provide(platform.host),
      Effect.map((built) => Executable.layerRefreshable(built, executableOptions))
    )
  ).pipe(Layer.provide(registry), Layer.orDie)
  const host = native.layerHost(
    {
      root: options.root,
      stateRoot: options.stateRoot,
      credential: options.credential,
      // No product flow runs here, so nothing is judged and no evaluator is needed.
      startsRuns: false,
      expectedSourceRevision: options.sourceRevision,
      approvalAuthority: native.gatewayApprovalAuthority
    },
    modules,
    registry
  )
  return Layer.effect(Serve.GatewayHost)(Effect.map(Serve.GatewayHost, (gateway) => ({
    launch: (health, bind, root) =>
      gateway.launch({
        ...health,
        gatewayId: options.gatewayId,
        runtimeBridge: {
          protocol: "smithers.flow-runtime/v1",
          runtimeArtifactDigest: options.artifactDigest,
          sourceRevision: options.sourceRevision,
          ownerGeneration: options.ownerGeneration
        },
        capabilities: ["flow-runtime-bridge/v1"]
      }, {
        ...bind,
        runtimeBridge: {
          runtimeArtifactDigest: options.artifactDigest,
          sourceRevision: options.sourceRevision,
          ownerGeneration: options.ownerGeneration
        }
      }, root)
  }))).pipe(Layer.provideMerge(host))
}
