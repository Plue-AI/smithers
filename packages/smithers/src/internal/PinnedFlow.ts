/** A registry's private capability to serve one flow at a pinned version.
 * Private host composition, never a public registry method.
 * @since 1.0.0
 */

import type * as Descriptor from "@smthrs/registry/Descriptor"
import type * as Registry from "@smthrs/registry/Registry"
import type { RegistryError } from "@smthrs/registry/RegistryError"
import type { Effect } from "effect"

/**
 * The version a launch must run: a flow, the source commit it was chosen
 * from and that version's digest (engineering spec §11.4.1).
 *
 * @since 1.0.0
 * @private
 */
export interface Pin {
  readonly flow: string
  readonly sourceCommit: string
  readonly executionDigest: string
}

/**
 * Reads the pinned version from its source commit, never from the served
 * working copy, refuses unless it measures the pin's digest, and makes the
 * registry answer that version for the flow's name. Answers its descriptor.
 *
 * @since 1.0.0
 * @private
 */
export type Activate = (pin: Pin) => Effect.Effect<Descriptor.FlowDescriptor, RegistryError>

// Kept on the service so structural wrappers (`{ ...registry, list }`) keep it.
const key = Symbol.for("@smthrs/internal/PinnedFlow")

/**
 * The registry with its pinning capability attached.
 *
 * @since 1.0.0
 * @private
 */
export const attach = <R extends Registry.Registry>(registry: R, activate: Activate): R =>
  Object.assign(registry, { [key]: activate })

/**
 * The registry's pinning capability, or `undefined` when it pins nothing.
 *
 * @since 1.0.0
 * @private
 */
export const of = (registry: Registry.Registry): Activate | undefined =>
  (registry as Registry.Registry & { readonly [key]?: Activate })[key]
