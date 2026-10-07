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
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as ExecutionSnapshot from "@smthrs/registry/ExecutionSnapshot"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { checkFlowTypes } from "./flow-typecheck.ts"
import { prepareFlowDependencies } from "./immutable-source.ts"
import { CodingError, StackBase } from "./schema.ts"

const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** One flow version as flow-load measured it at one commit. */
export const FlowVersion = Schema.Struct({
  name: Schema.String,
  /** The entry file, relative to the repository root. */
  path: Schema.String,
  digest: Hex64,
  status: Schema.Literals(["loaded", "failed"]),
  error: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(Schema.Array(Schema.String)),
  inspection: Schema.optionalKey(Schema.Struct({
    nodes: Schema.Array(Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      label: Schema.optionalKey(Schema.String),
      dependencies: Schema.Array(Schema.String)
    })),
    edges: Schema.Array(
      Schema.Struct({
        from: Schema.String,
        to: Schema.String,
        reason: Schema.Literals(["value", "continuation", "failure"])
      })
    ),
    steps: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
    diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.String })),
    prompt: Schema.optionalKey(Schema.String)
  })),
  /** Steps inspected inside the guest without selecting an execution payload. */
  steps: Schema.optionalKey(Schema.Array(Schema.Struct({
    id: Schema.String,
    label: Schema.optionalKey(Schema.String),
    wait: Schema.optionalKey(Schema.Boolean),
    signals: Schema.optionalKey(Schema.Array(Schema.Struct({ on: Schema.String, to: Schema.String })))
  })))
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
export const loadRepositoryFlows = (
  repositoryPath: string,
  systemFlows: ReadonlyArray<string>,
  environment?: Readonly<Record<string, string>>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const root = path.join(repositoryPath, "flows")
    if (!(yield* fs.exists(root))) return []
    const system = new Set(systemFlows)
    const discovered = yield* Registry.make({
      sources: [{ root, source: "project", naming: "path", lockfileRoot: repositoryPath }]
    }).pipe(
      Effect.provide(Discovery.layer)
    )
    const discoveredDescriptors = yield* discovered.list()
    const descriptors = discoveredDescriptors.filter((entry) => !system.has(entry.name))
    const only = Registry.Registry.of({ ...discovered, list: () => Effect.succeed(descriptors) })
    // Measure before installing: a failed or lockfile-mutating installer must
    // never turn its output into an accepted source identity.
    // Use the snapshot store's dependency identity; lockfile reads stay in the guest.
    const lockfileDigest = yield* ExecutionSnapshot.measureLockfiles(repositoryPath)
    const dependenciesReady = yield* prepareFlowDependencies({ repositoryPath, fs, environment }, repositoryPath).pipe(
      Effect.andThen(Effect.gen(function*() {
        if ((yield* ExecutionSnapshot.measureLockfiles(repositoryPath)) !== lockfileDigest) {
          return yield* new CodingError({
            code: "invalid_receipt",
            message: "Pinned flow dependency installation changed its lockfiles"
          })
        }
      })),
      Effect.result
    )
    const typeFailures = dependenciesReady._tag === "Failure" ?
      new Map<string, string>() :
      yield* Effect.try(() =>
        checkFlowTypes(
          repositoryPath,
          descriptors.filter((entry) => entry.body._tag === "Module").map((entry) => entry.path)
        )
      )
    const loadable = Registry.Registry.of({
      ...only,
      list: () => Effect.succeed(descriptors.filter((entry) => !typeFailures.has(entry.path)))
    })
    const built = dependenciesReady._tag === "Failure" ?
      undefined :
      yield* Executable.catalog({ delegates: [] }).pipe(Effect.provideService(Registry.Registry, loadable))
    // Reserved declarations are measured as data, never typechecked or imported.
    // Retain the refusal so the install can show it on the Flow card.
    const versions: Array<FlowVersion> = []
    for (const descriptor of discoveredDescriptors.filter((entry) => system.has(entry.name))) {
      const relative = path.relative(repositoryPath, descriptor.path).split(path.sep).join("/")
      versions.push({
        name: descriptor.name,
        path: relative,
        digest: Descriptor.executionDigest(descriptor) ?? Digest.digest(yield* fs.readFileString(descriptor.path)),
        status: "failed",
        error: `${relative}: reserved_name`
      })
    }
    // Discovery refusals are still declarations, not removals. Omitting one
    // would make settlement retire its previous Active version.
    const declared = new Set(discoveredDescriptors.map((entry) => entry.name))
    for (const warning of yield* discovered.warnings()) {
      const name = warning.name
      if (name === undefined) {
        // A scan/confinement refusal cannot prove which entries disappeared.
        // Refuse the load rather than deactivate an incomplete catalog.
        return yield* new CodingError({ code: "source_unavailable", message: warning.message })
      }
      if (declared.has(name)) continue
      const relative = path.relative(repositoryPath, warning.path).split(path.sep).join("/")
      if (!relative.startsWith("flows/") || relative.split("/").includes("..")) continue
      const source = yield* fs.readFileString(warning.path)
      versions.push({
        name,
        path: relative,
        digest: Digest.digest(JSON.stringify({ source, lockfileDigest })),
        status: "failed",
        error: `${relative}: ${system.has(name) ? "reserved_name" : warning.message}`.replace(/\s+/g, " ").slice(
          0,
          errorLimit
        )
      })
      declared.add(name)
    }
    for (const descriptor of descriptors) {
      const digest = Descriptor.executionDigest(descriptor)
      const relative = path.relative(repositoryPath, descriptor.path).split(path.sep).join("/")
      const failure = built?.refused.find((entry) => entry.flow === descriptor.name && !hostRefusals.has(entry.code))
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
      const imported = descriptor.body._tag === "Module" ? descriptor.body.imports ?? [] : []
      const dependencies = imported.map((entry) =>
        path.relative(repositoryPath, path.resolve(path.dirname(descriptor.path), entry.path)).split(path.sep).join("/")
      )
      const inspection = built?.executables.find((entry) => entry.descriptor.name === descriptor.name)?.inspect?.()
      const metadata = {
        ...(dependencies.length === 0 ? {} : { dependencies }),
        ...(inspection === undefined ? {} : { inspection }),
        // An input-dependent declaration remains runnable. Never publish an
        // invented path through it or erase the historical display on refusal.
        ...(inspection === undefined || inspection.diagnostics.length > 0 ? {} : { steps: inspection.steps })
      }
      versions.push(
        dependenciesReady._tag === "Failure" ?
          {
            name: descriptor.name,
            path: relative,
            digest,
            status: "failed",
            error: `${relative}: ${dependenciesReady.failure.message}`,
            ...metadata
          } :
          typeFailures.has(descriptor.path) ?
          {
            name: descriptor.name,
            path: relative,
            digest,
            status: "failed",
            error: typeFailures.get(descriptor.path)!,
            ...metadata
          } :
          failure === undefined ?
          { name: descriptor.name, path: relative, digest, status: "loaded", ...metadata } :
          {
            name: descriptor.name,
            path: relative,
            digest,
            status: "failed",
            error: loadError(failure, relative),
            ...metadata
          }
      )
    }
    return versions.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })

/**
 * The handler of {@link LoadFlows}: the working copy stands on `base` (the
 * flow admitted it first), so the flows it reads are that commit's.
 */
export const loadFlowsLayer = (
  repositoryPath: string,
  systemFlows: ReadonlyArray<string>,
  environment?: Readonly<Record<string, string>>
) =>
  Layer.unwrap(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    return LoadFlows.toLayer(({ base }) =>
      Effect.gen(function*() {
        const flows = yield* loadRepositoryFlows(repositoryPath, systemFlows, environment).pipe(
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
