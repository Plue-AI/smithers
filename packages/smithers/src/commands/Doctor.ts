/**
 * `smthrs doctor`: the report, from either catalog source.
 *
 * @since 1.0.0
 */

import { Control as ControlService } from "@smthrs/control"
import * as ResolveJj from "@smthrs/jj/node/resolveJjBinary"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import type * as Registry from "@smthrs/registry/Registry"
import * as RegistryError from "@smthrs/registry/RegistryError"
import { Effect, type Layer } from "effect"
import * as Doctor from "../Doctor.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"
import * as Unsupported from "../Unsupported.ts"
import * as FlowCatalog from "./FlowCatalog.ts"
import * as Globals from "./Globals.ts"

/**
 * A catalog the registry could not produce, reported as a failed check.
 * @category models
 * @since 1.0.0
 */
export interface DiscoveryFailed {
  readonly failure: string
}

/**
 * The report for one already-read catalog.
 * @category constructors
 * @since 1.0.0
 */
export const report = (
  catalog: Pick<FlowCatalog.FlowPage, "items" | "warnings"> | DiscoveryFailed,
  globals: Globals.Options
): Effect.Effect<Doctor.Report> =>
  Effect.gen(function*() {
    // Doctor owns the unsupported-backend check. The shared guard would fail
    // before the report exists, so this verb prints the notices and lets
    // `Doctor.failed` decide the command status from the complete report.
    yield* Globals.notices(globals)
    const environment = globals.environment ?? process.env
    const projectRoot = yield* Project.ProjectRoot
    return Doctor.inspect({
      root: projectRoot,
      environment: globals.backend === undefined ? environment : { ...environment, SMITHERS_BACKEND: globals.backend },
      jj: ResolveJj.resolveJjBinary(),
      legacyPaths: yield* Project.LegacyState,
      ...("failure" in catalog
        ? { discoveryFailure: catalog.failure }
        : {
          discoveredFlows: catalog.items.filter((item) => !Unsupported.isReservedFlow(item.flowId)),
          discoveryWarnings: catalog.warnings
        })
    })
  })

/**
 * Resolves the filesystem helper as an operation would. Flow discovery reads
 * through the host platform and never starts the helper, so a missing or
 * unusable `smithers-jj-export` would otherwise pass as `registry: ok` and
 * fail later, when a flow's module is first loaded. The failure text is a
 * discovery error's, carrying the helper's own diagnosis and install hint.
 */
const checkHelper = (root: string): string | undefined => {
  try {
    AtomicFileSystem.resolveHelper()
    return undefined
  } catch (cause) {
    return RegistryError.discoveryError({
      code: "read_failed",
      module: "AtomicFileSystem",
      method: "resolveHelper",
      path: root,
      description: cause instanceof Error ? cause.message : String(cause),
      cause
    }).message
  }
}

/**
 * Local diagnostics use the discovery snapshot without opening execution
 * databases. A registry that discovery cannot build, such as one whose
 * filesystem helper is missing, is a failed `registry` check rather than a
 * crash; any other defect still crashes.
 * @category constructors
 * @since 1.0.0
 */
export const fromRegistry = (
  globals: Globals.Options,
  registry: (root: string) => Layer.Layer<Registry.Registry> = NodeControl.layerRegistry
): Effect.Effect<Doctor.Report> =>
  Effect.gen(function*() {
    const helper = checkHelper(yield* Project.ProjectRoot)
    if (helper !== undefined) return yield* report({ failure: helper }, globals)
    const catalog = yield* FlowCatalog.discovered.pipe(
      Effect.provide(registry(yield* Project.ProjectRoot)),
      Effect.catchDefect((defect): Effect.Effect<DiscoveryFailed> =>
        defect instanceof RegistryError.DiscoveryError
          ? Effect.succeed({ failure: defect.message })
          : Effect.die(defect)
      )
    )
    return yield* report(catalog, globals)
  })

/**
 * Remote diagnostics read the catalog the selected control plane serves.
 * @category constructors
 * @since 1.0.0
 */
export const fromControl = (globals: Globals.Options) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    return yield* report(yield* FlowCatalog.read(control), globals)
  })
