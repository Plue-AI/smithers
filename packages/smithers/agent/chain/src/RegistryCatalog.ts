/**
 * Projects the flow registry into the chain's catalog.
 *
 * Projection, not fusion: the registry stays the owner of discovery,
 * naming, warnings, and lazy bodies; this module renders its descriptors
 * as catalog entries at layer construction. Only callable descriptors are
 * projected — a module-bodied flow needs a host implementation and a
 * markdown-bodied flow needs a prompt runner — so the model's catalog
 * never discloses a call that is guaranteed to refuse. The system entries
 * (`sys/now`, `sys/random`) are always composed in, keeping the sealed
 * realm's promise (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */

import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option } from "effect"
import * as Catalog from "./Catalog.ts"

/**
 * A host-supplied handler for a module-bodied flow.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Implementation = (payload: unknown) => Effect.Effect<unknown, Catalog.CallError>

/**
 * How a rendered markdown prompt executes — the seam a sub-agent seat
 * fills. Without one, markdown flows are not projected at all.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type PromptRunner = (
  rendered: string,
  descriptor: Descriptor.FlowDescriptor
) => Effect.Effect<string, Catalog.CallError>

/**
 * How the registry is projected into a catalog: which flows have host
 * implementations, how markdown prompts execute, which flows are visible,
 * and what extra entries follow.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly implementations?: ReadonlyMap<string, Implementation> | undefined
  readonly prompt?: PromptRunner | undefined
  readonly visible?: ((descriptor: Descriptor.FlowDescriptor) => boolean) | undefined
  /** Extra host entries, composed after the projection. */
  readonly entries?: ReadonlyArray<Catalog.Entry> | undefined
}

/**
 * The canonical digest of a descriptor's full declaration, and so of what
 * every catalog entry key pins.
 *
 * Re-exported from `@smthrs/registry`, which owns `FlowDescriptor`: one
 * declaration is one number here, in `@smthrs/harness`'s call identities, and
 * anywhere else that keys on a declaration.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const declarationDigest: (descriptor: Descriptor.FlowDescriptor) => string = Descriptor.declarationDigest

const promptArgs = (name: string, payload: unknown): Effect.Effect<string, Catalog.CallError> => {
  if (typeof payload === "string") return Effect.succeed(payload)
  if (typeof payload === "object" && payload !== null && "args" in payload) {
    const args = (payload as { readonly args: unknown }).args
    if (typeof args === "string") return Effect.succeed(args)
  }
  return Effect.fail(new Catalog.CallError({ message: `"${name}" takes { args: string }`, name }))
}

const markdownHandler = (
  registry: Registry.Registry,
  descriptor: Descriptor.FlowDescriptor,
  digest: string,
  prompt: PromptRunner
): Implementation =>
(payload) =>
  Effect.gen(function*() {
    const args = yield* promptArgs(descriptor.name, payload)
    // The projection is a snapshot; a refreshed registry may carry a
    // different declaration under the same name. Re-check at call time so
    // the journaled entryDigest never lies about what actually ran.
    const current = yield* registry.getOption(descriptor.name)
    if (Option.isNone(current) || declarationDigest(current.value) !== digest) {
      return yield* new Catalog.CallError({
        message: `"${descriptor.name}" was redeclared since this catalog was built; rebuild the catalog`,
        name: descriptor.name
      })
    }
    const rendered = yield* registry.runPrompt(descriptor.name, { args }).pipe(
      Effect.mapError((error) =>
        new Catalog.CallError({ message: `"${descriptor.name}" failed: ${error.message}`, name: descriptor.name })
      )
    )
    return yield* prompt(rendered, descriptor)
  })

/**
 * Builds the catalog service from the ambient registry.
 *
 * Precedence when names collide: registry projection, then host extras,
 * then the system entries — later wins, so `sys/now` can never be
 * shadowed. Binding an implementation for a name the registry does not
 * know is a host configuration defect and dies at construction.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: Options = {}): Effect.Effect<Catalog.Service, never, Registry.Registry> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    const implementations = options.implementations ?? new Map<string, Implementation>()
    const descriptors = options.visible === undefined
      ? yield* registry.visible()
      : (yield* registry.list()).filter(options.visible)
    const known = new Set((yield* registry.list()).map((descriptor) => descriptor.name))
    const unknown = [...implementations.keys()].filter((name) => !known.has(name))
    if (unknown.length > 0) {
      return yield* Effect.die(
        new Error(`implementations bind flows the registry does not know: ${unknown.join(", ")}`)
      )
    }
    const projected = descriptors.flatMap((descriptor): ReadonlyArray<Catalog.Entry> => {
      const digest = declarationDigest(descriptor)
      const bound = implementations.get(descriptor.name)
      const handler = bound !== undefined
        ? bound
        : descriptor.body._tag === "Markdown" && options.prompt !== undefined
        ? markdownHandler(registry, descriptor, digest, options.prompt)
        : undefined
      if (handler === undefined) return []
      return [{
        capabilities: descriptor.capabilities,
        description: descriptor.description,
        digest,
        handler,
        name: descriptor.name
      }]
    })
    return Catalog.make(Catalog.withSystem([...projected, ...(options.entries ?? [])]))
  })

/**
 * The registry-backed catalog layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (options: Options = {}): Layer.Layer<Catalog.Catalog, never, Registry.Registry> =>
  Layer.effect(Catalog.Catalog)(make(options))
