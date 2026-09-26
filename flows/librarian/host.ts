/** Product workspace host. Its executable catalog is part of the deployed artifact. */
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Flow } from "@smthrs/flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as NativeEquipment from "../../packages/smithers/src/internal/NativeEquipment.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import history, { registration as historyRegistration } from "./history/flow.ts"
import { agentRuntime } from "./runtime.ts"
import { configured, type Options as SeatOptions, roleResolver } from "./seats.ts"

export { roleResolver } from "./seats.ts"

export interface Options extends SeatOptions {
  readonly root: string
  readonly stateRoot: string
  readonly repo: string
  readonly gatewayId: string
  readonly credential: string
  readonly artifactDigest: string
  readonly sourceRevision: string
  readonly ownerGeneration: number
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

/** Identity includes the entire compiled host, not just a declaration's prose. */
export const catalog = async (options: Options) => {
  // These packaged descriptors are host state. Writing them into the served
  // checkout would dirty Git and change JJ's source snapshot during startup.
  const directory = join(options.stateRoot, "product", options.artifactDigest)
  await mkdir(directory, { recursive: true })
  return Promise.all(([["history", history]] as const).map(async ([kind, declaration]) => {
    const path = join(directory, `${kind}.json`)
    const source = JSON.stringify({ artifact: options.artifactDigest, flow: `librarian/${kind}` })
    try {
      await writeFile(path, source, { flag: "wx", mode: 0o444 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (await readFile(path, "utf8") !== source) {
        throw new Error("Product flow identity was modified; refusing to serve")
      }
    }
    const descriptor = new Descriptor.FlowDescriptor({
      name: `librarian/${kind}`,
      description: declaration.description ?? "",
      path,
      body: new Descriptor.BodyRefModule({ path, contentDigest: sha(source) }),
      input: new Descriptor.SchemaRefInline({
        document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(declaration.payloadSchema)))
      }),
      output: new Descriptor.SchemaRefInline({
        document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(declaration.successSchema)))
      }),
      // The module IS the flow, so it names no delegate.
      model: Option.some(configured(options)),
      flows: [],
      capabilities: Context.get(declaration.annotations, Flow.Capabilities),
      effects: Schema.decodeUnknownSync(Descriptor.EffectDeclaration)(
        Option.getOrThrow(Context.getOption(declaration.annotations, Flow.EffectEnvelope))
      ),
      // The declaration says `modelInvocable: false` so a coding host scanning
      // this repository does not teach an agent a call it cannot serve. THIS
      // host implements the action, so its own catalog offers it.
      placement: Option.none(),
      modelInvocable: true,
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "product", root: directory })
    })
    return { descriptor, declaration }
  }))
}

export const layer = (platform: NativeControl.Platform, options: Options, suppliedSeats?: SeatResolver.Service) => {
  const model = configured(options)
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
  const native = NativeControl.make(platform, (environment) =>
    Layer.effect(SeatResolver.SeatResolver)(
      Effect.map(SeatResolver.SeatResolver, (base) => roleResolver(base, model, options))
    ).pipe(
      Layer.provide(
        suppliedSeats === undefined ? NativeEquipment.layerSeatResolver(environment) : SeatResolver.layer(suppliedSeats)
      )
    ))
  return Layer.unwrap(
    Effect.promise(() => catalog(options)).pipe(Effect.map((entries) => {
      const registry = Registry.layerFromDescriptors(entries.map((entry) => entry.descriptor)).pipe(
        Layer.provide(platform.host)
      )
      // The product flow is its own delegate: its module default-exports the
      // `@smthrs/flow` flow it declares, so nothing is registered by name.
      const executableOptions: Executable.RefreshOptions = {
        delegates: [],
        refreshable: () => false,
        load: (path) => {
          const entry = entries.find((entry) => entry.descriptor.path === path)
          return entry ? Effect.succeed({ default: entry.declaration }) : Effect.fail(new Error("Unknown product flow"))
        }
      }
      // Only reading the immutable packaged catalog uses the host filesystem.
      // Flow registrations still receive the native action filesystem guards.
      const modules = Layer.unwrap(
        Executable.catalog(executableOptions).pipe(
          Effect.provide(platform.host),
          Effect.map((built) =>
            Layer.mergeAll(
              Executable.layerRefreshable(built, executableOptions),
              ...built.executables.map((executable) => executable.layer)
            )
          )
        )
      ).pipe(
        Layer.provideMerge(historyRegistration(options.root, options.repo)),
        agentRuntime,
        Layer.provide(registry),
        Layer.orDie
      )
      const host = native.layerHost(
        {
          root: options.root,
          stateRoot: options.stateRoot,
          credential: options.credential,
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
            capabilities: ["librarian/v1", "flow-runtime-bridge/v1"]
          }, {
            ...bind,
            runtimeBridge: {
              runtimeArtifactDigest: options.artifactDigest,
              sourceRevision: options.sourceRevision,
              ownerGeneration: options.ownerGeneration
            }
          }, root)
      }))).pipe(Layer.provideMerge(host))
    }))
  )
}
