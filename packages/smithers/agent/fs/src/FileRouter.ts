/**
 * File-system routing over metadata-only registry discovery.
 *
 * @since 0.1.0
 */

import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import { DiscoveryError } from "@smthrs/registry/RegistryError"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as CommandTree from "./CommandTree.ts"
import { FsError } from "./FsError.ts"
import * as Boundary from "./internal/Boundary.ts"
import * as Route from "./Route.ts"

/**
 * Configuration for one bounded file-router scan.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScanConfig {
  readonly root: string
}

/**
 * A non-fatal diagnostic emitted by registry discovery.
 *
 * @category models
 * @since 0.1.0
 */
export type Warning = Descriptor.DiscoveryWarning

/**
 * The immutable metadata-only result of scanning a flows tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScanResult {
  readonly routes: ReadonlyArray<Route.Route>
  readonly warnings: ReadonlyArray<Warning>
}

const toSegments = (path: Path.Path, root: string, sourcePath: string): ReadonlyArray<string> => {
  const relative = path.relative(root, path.dirname(sourcePath))
  return relative.split(path.sep).filter((segment) => segment !== "" && segment !== ".")
}

const kindOf = (descriptor: Descriptor.FlowDescriptor): Route.Kind => {
  if (descriptor.body._tag === "Module") return "module"
  return descriptor.path.split(/[\\/]/).at(-1) === "SKILL.md" ? "skill" : "markdown"
}

const failure = (code: FsError["code"], description: string): FsError =>
  new FsError({ code, method: "FileRouter.scan", description })

const discoveryFailure = (cause: unknown): FsError => {
  if (cause instanceof DiscoveryError) {
    switch (cause.code) {
      case "root_missing":
        return failure("root_missing", "The flow root does not exist")
      case "invalid_root":
        return failure("invalid_root", "The flow root is not a readable directory")
      case "read_failed":
        return failure("read_failed", "The flow root could not be read")
      case "unknown":
        return failure("discovery_failed", "Flow discovery failed")
    }
  }
  return failure("discovery_failed", "Flow discovery failed")
}

const readFailure = (): FsError => failure("read_failed", "A route companion could not be inspected")

const snapshotRoot = (config: ScanConfig, path: Path.Path): Effect.Effect<string, FsError> =>
  Effect.suspend(() => {
    const admitted = Boundary.inspectRecord(config, ["root"])
    const root = admitted.ok ? admitted.value.root : undefined
    if (
      typeof root !== "string" || root.length === 0 || root.length > Route.maximumPathLength ||
      root.includes("\0") || !Boundary.isWellFormedText(root)
    ) return Effect.fail(failure("invalid_root", "The flow root must be bounded, well-formed text"))
    return Effect.succeed(path.resolve(root))
  })

const warningSnapshot = (warning: Descriptor.DiscoveryWarning): Warning =>
  new Descriptor.DiscoveryWarning({
    code: warning.code,
    path: warning.path,
    message: warning.message,
    name: warning.name
  })

/**
 * Scans a flows root without importing or evaluating any flow module.
 *
 * The registry owns entry precedence, metadata parsing, directive detection,
 * and bounded reads. This adapter projects descriptors into absolute,
 * immutable path-derived routes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const scan = (config: ScanConfig): Effect.Effect<ScanResult, FsError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* snapshotRoot(config, path)
    const discovery = Discovery.make(fileSystem, path)
    const result = yield* discovery.scan({ source: "flows", root, naming: "path" }).pipe(
      Effect.mapError(discoveryFailure)
    )

    if (result.entries.length > CommandTree.maximumRoutes) {
      return yield* Effect.fail(
        failure("resource_limit", `A scan may return at most ${CommandTree.maximumRoutes} routes`)
      )
    }

    const routes = new Map<string, Route.Route>()
    for (const descriptor of result.entries) {
      const sourcePath = path.resolve(descriptor.path)
      const segments = toSegments(path, root, sourcePath)
      if (segments.length === 0) continue
      const name = segments.join("/")
      if (routes.has(name)) {
        return yield* Effect.fail(
          new FsError({
            code: "duplicate_route",
            method: "FileRouter.scan",
            description: "Distinct source paths collapse to one command name",
            path: name
          })
        )
      }
      const directory = path.dirname(sourcePath)
      const uiPath = path.join(directory, "ui.tsx")
      const hasUi = yield* fileSystem.exists(uiPath).pipe(Effect.mapError(readFailure))
      const route = yield* Route.snapshot({
        name,
        segments,
        kind: kindOf(descriptor),
        sourcePath,
        description: Option.some(descriptor.description),
        input: descriptor.input,
        output: descriptor.output,
        capabilities: descriptor.capabilities,
        effects: descriptor.effects,
        modelInvocable: descriptor.modelInvocable,
        placement: descriptor.placement,
        ui: hasUi ? Option.some(uiPath) : Option.none()
      })
      routes.set(name, route)
    }

    const ordered = Array.from(routes.keys()).sort().map((name) => routes.get(name)!)
    return Object.freeze({
      routes: Object.freeze(ordered),
      warnings: Object.freeze(result.warnings.map(warningSnapshot))
    })
  })
