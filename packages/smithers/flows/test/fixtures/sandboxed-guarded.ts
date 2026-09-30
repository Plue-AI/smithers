/**
 * The entry module the capability-ceiling suite bundles into the guest.
 *
 * Its action writes through the kernel's guarded `FileSystem` over a real
 * `GrantStore`, so a write the ceiling does not cover is refused by the same
 * host boundary a local run uses. The store's rules allow every filesystem
 * operation: the ceiling is the only thing that can refuse one here. The
 * workspace is attested isolated because the guest machine is the isolation
 * boundary; a local run in the suite uses the same host over a scratch root.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { fromPlatformError, PermissionDenied, Rule } from "@smthrs/capability/Permission"
import { Action, Flow } from "@smthrs/flow"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const Touch = Action.make("flows/SandboxedFlow/guarded/Touch", {
  payload: { name: Schema.String },
  success: Schema.String,
  error: PermissionDenied
})

/** Writes `name` in the workspace through the guarded filesystem. */
export const Guarded = Flow.make("flows/SandboxedFlow/guarded/Guarded", {
  payload: { name: Schema.String },
  success: Schema.String,
  error: PermissionDenied,
  body: (payload) => Touch.call(payload)
})

/** The same write under a declared read-only ceiling of its own. */
export const ReadOnly = Flow.make("flows/SandboxedFlow/guarded/ReadOnly", {
  payload: { name: Schema.String },
  success: Schema.String,
  error: PermissionDenied,
  capabilities: ["fs:read:**"],
  body: (payload) => Touch.call(payload)
})

const isolated = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function*() {
    return KernelFileSystem.withIsolatedFileSystem(yield* FileSystem.FileSystem)
  })
).pipe(Layer.provide(NodeFileSystem.layer))

/** The guarded host a local run and the guest both use, rooted at `root`. */
export const host = (root: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(Layer.merge(isolated, NodePath.layer)),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(
      GrantStore.layer({
        attended: false,
        rules: [new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "fs:*", resource: "**" }) })]
      }).pipe(Layer.provide(Workspace.layer(root)))
    )
  )

/** Touch's implementation: a guarded write, its refusal as the kernel's own typed error. */
export const touch = Touch.toLayer(({ name }) =>
  Effect.gen(function*() {
    const files = yield* FileSystem.FileSystem
    yield* files.writeFileString(name, "guarded").pipe(
      Effect.catchTag("PlatformError", (error) => {
        const refusal = fromPlatformError(error)
        return Option.isSome(refusal) && refusal.value._tag === "@smthrs/capability/PermissionDenied"
          ? Effect.fail(
            new PermissionDenied({ capability: new Capability(refusal.value.capability), reason: refusal.value.reason })
          )
          : Effect.die(error)
      })
    )
    return name
  })
)

export const layer = Layer.unwrap(Effect.sync(() => touch.pipe(Layer.provide(host(process.cwd())))))
