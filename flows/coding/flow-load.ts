/**
 * flow-load (engineering spec §11.3.1): the system flow the stack service runs
 * on an ephemeral machine at each new `main` commit. It stands on that commit,
 * discovers every overridable flow the repository declares under `flows/`,
 * loads each one with this host's own loader (the repository's `todo`
 * composition included: only flow-load reads it, the host's registry keeps it
 * dark), and answers one version per flow: its digest and whether it loaded.
 * The stack service writes the versions to `workflow_definitions` and moves
 * Active (§11.3.2). Nothing here writes outside the working copy.
 */
import * as Digest from "@smthrs/core/Digest"
import { Action } from "@smthrs/flow"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { CodingError, StackBase } from "./schema.ts"

const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** One flow version as flow-load measured it at one commit. */
export const FlowVersion = Schema.Struct({
  name: Schema.String,
  /** The entry file, relative to the repository root. */
  path: Schema.String,
  digest: Hex64,
  status: Schema.Literals(["loaded", "failed"]),
  error: Schema.optionalKey(Schema.String)
})
export type FlowVersion = typeof FlowVersion.Type

export const FlowLoadInput = Schema.Struct({ base: StackBase })
export const FlowLoadResult = Schema.Struct({
  commitId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  flows: Schema.Array(FlowVersion)
})
export type FlowLoadResult = typeof FlowLoadResult.Type

export const LoadFlows = Action.make("coding/load-flows", {
  payload: { base: StackBase },
  success: FlowLoadResult,
  error: CodingError,
  nondeterministic: true
})

/**
 * A version's digest: the entry's content digest, which is the built-in's
 * identity (services/builtin_flows.json) when the entry imports nothing from
 * the repository, and otherwise that digest bound to every repository module
 * the entry imports, so a changed helper is a new version (§11.3.0). It is
 * not the execution digest, which also covers the descriptor's metadata: a
 * version measures only bytes, which services/builtin_flows.json can name
 * before any host lists the flow. Neither names an absolute path, so the same
 * bytes measure the same version on every machine.
 */
export const versionDigest = (descriptor: Descriptor.FlowDescriptor): string | undefined => {
  const content = descriptor.body.contentDigest
  if (content === undefined) return undefined
  const imports = descriptor.body._tag === "Module" ? descriptor.body.imports ?? [] : []
  return imports.length === 0 ? content : Digest.digest(Digest.canonical({
    content,
    imports: imports.map((entry) => ({ path: entry.path, contentDigest: entry.contentDigest ?? null }))
  }))
}

/** Statements about this host's delegates, not defects in the flow (Executable.catalog). */
const hostRefusals = new Set(["missing_delegate", "ambiguous_delegate"])
const errorLimit = 2000

/**
 * The refusal as one line that names the repository file and, when the
 * loader reported one, the line: the loader imports a private sibling of the
 * entry, so its location is mapped back to the entry's own path.
 */
const loadError = (failure: Executable.ExecutableError, relative: string): string => {
  const cause = failure.cause as { message?: unknown; stack?: unknown } | undefined
  const stack = typeof cause?.stack === "string" ? cause.stack : ""
  const line = stack.match(/\.smithers-[0-9a-f]{64}-[^:\s]*:(\d+)/)?.[1]
  const reason = typeof cause?.message === "string" && cause.message !== "" ? cause.message : failure.message
  const text = `${relative}${line === undefined ? "" : `:${line}`}: ${reason}`.replace(/\s+/g, " ").trim()
  return text.length > errorLimit ? text.slice(0, errorLimit) : text
}

/**
 * Loads every overridable flow under `<repositoryPath>/flows` and answers its
 * version, sorted by name. A repository without `flows/` declares none.
 */
export const loadRepositoryFlows = (repositoryPath: string, systemFlows: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const root = path.join(repositoryPath, "flows")
    if (!(yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false)))) return []
    const system = new Set(systemFlows)
    const discovered = yield* Registry.make({ sources: [{ root, source: "project", naming: "path" }] }).pipe(
      Effect.provide(Discovery.layer)
    )
    const descriptors = (yield* discovered.list()).filter((entry) => !system.has(entry.name))
    const only = Registry.Registry.of({ ...discovered, list: () => Effect.succeed(descriptors) })
    const built = yield* Executable.catalog({ delegates: [] }).pipe(Effect.provideService(Registry.Registry, only))
    const versions: Array<FlowVersion> = []
    for (const descriptor of descriptors) {
      const digest = versionDigest(descriptor)
      const relative = path.relative(repositoryPath, descriptor.path).split(path.sep).join("/")
      const failure = built.refused.find((entry) => entry.flow === descriptor.name && !hostRefusals.has(entry.code))
      if (digest === undefined) {
        versions.push({
          name: descriptor.name,
          path: relative,
          digest: Digest.digest(yield* fs.readFileString(descriptor.path).pipe(Effect.orElseSucceed(() => ""))),
          status: "failed",
          error: `${relative}: the flow's source could not be measured`
        })
        continue
      }
      versions.push(
        failure === undefined ?
          { name: descriptor.name, path: relative, digest, status: "loaded" } :
          { name: descriptor.name, path: relative, digest, status: "failed", error: loadError(failure, relative) }
      )
    }
    return versions.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })

/**
 * The handler of {@link LoadFlows}: the working copy stands on `base` (the
 * flow admitted it first), so the flows it reads are that commit's.
 */
export const loadFlowsLayer = (repositoryPath: string, systemFlows: ReadonlyArray<string>) =>
  Layer.unwrap(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    return LoadFlows.toLayer(({ base }) =>
      Effect.gen(function*() {
        const flows = yield* loadRepositoryFlows(repositoryPath, systemFlows).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path)
        )
        return { commitId: base.commitId, flows }
      }).pipe(Effect.mapError((cause) =>
        new CodingError({
          code: "source_unavailable",
          message: `The flows at ${base.commitId} could not be read: ${String(cause)}`
        })
      ))
    )
  }))
