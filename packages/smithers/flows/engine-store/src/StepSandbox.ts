/**
 * Injectable, scope-safe step sandboxing over the workspace transaction.
 *
 * @since 0.1.0
 */

import type * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as StepBoundary from "./StepBoundary.ts"
import * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

/**
 * A hermetic body attempted to read a path outside its declared read set.
 *
 * @category errors
 * @since 0.1.0
 */
export class UndeclaredRead extends Schema.TaggedError<UndeclaredRead>()(
  "@smthrs/engine-store/UndeclaredRead",
  {
    code: Schema.Literal("undeclared_read"),
    paths: Schema.Array(Schema.String),
    diffIdentity: Schema.NonEmptyString
  }
) {}

/**
 * A sandbox that can acquire an isolated workspace for one step.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly open: Effect.Effect<WorkspaceSandbox.Service, StepBoundary.UnsupportedBoundary>
}

/**
 * Injectable step-sandbox service.
 *
 * @category services
 * @since 0.1.0
 */
export const StepSandbox: Context.Service<Service, Service> = Context.Service<Service>(
  "@smthrs/engine-store/StepSandbox"
)

/**
 * Constructs a step sandbox around a workspace transaction backend.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (workspace: WorkspaceSandbox.Service): Service =>
  StepSandbox.of({
    open: Effect.succeed(workspace)
  })

/**
 * Filesystem-backed sandbox layer. The workspace transaction seeds only the
 * declared reads, exposes its scoped FileSystem to the body, observes every
 * mutation, and performs atomic copy-back on release. Built from
 * `WorkspaceSandbox.layerFileSystem`, so it refuses a path-based host the same way.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  Service,
  WorkspaceSandbox.WorkspaceError,
  FileSystem.FileSystem | ArtifactStore.ArtifactStore | KernelWorkspace.Workspace
> = Layer.effect(
  StepSandbox,
  Effect.map(WorkspaceSandbox.WorkspaceSandbox, make)
).pipe(Layer.provide(WorkspaceSandbox.layerFileSystem()))

/**
 * Deterministic in-memory sandbox layer for tests.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTest = (
  initialFiles: WorkspaceSandbox.InitialFiles = {}
): Layer.Layer<Service, WorkspaceSandbox.WorkspaceError, Crypto.Crypto> =>
  Layer.effect(StepSandbox, Effect.map(WorkspaceSandbox.makeMemory(initialFiles), (sandbox) => make(sandbox.service)))

const unsupported = new StepBoundary.UnsupportedBoundary({
  code: "unsupported_boundary",
  message: "this host cannot provide a hermetic step sandbox"
})

/**
 * Fail-closed host layer for environments that cannot sandbox (for example browsers).
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Service> = Layer.succeed(
  StepSandbox,
  StepSandbox.of({
    open: Effect.fail(unsupported)
  })
)
