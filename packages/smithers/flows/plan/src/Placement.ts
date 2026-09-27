/**
 * Where a node runs, declared.
 *
 * This is the ONE placement model. `@smthrs/core` re-exports it, `@smthrs/flow`
 * annotates with it, and `@smthrs/registry` lowers a descriptor's frontmatter
 * literal into it. It used to be a typed enum in `@smthrs/core` and an opaque
 * `Schema.Unknown` in `@smthrs/flow`, with a cast in the registry standing
 * between them, so a directive lost its type the moment it crossed a package.
 *
 * It lives here because `KeyMaterial.placement` is the field it ends up in, and
 * `@smthrs/plan` is the lowest package core, flow and the registry all depend
 * on. A placement is serializable detail that identifies a host profile; it
 * never contains a host implementation, credentials, or any other runtime
 * handle.
 *
 * The four tags still read `flows/core/Placement/...`. They are hashed into
 * `KeyMaterial.placement` and therefore into the step key of every node that
 * declares a placement, so retagging them would re-key production work and
 * miss its cached results. The tag is a wire value, not a location.
 *
 * @since 1.0.0-rc.0
 */

import * as Context from "effect/Context"
import * as Data from "effect/Data"

/**
 * Serializable host-selection details. These fields identify a host profile;
 * they never contain a host implementation, credentials, or other runtime
 * handle.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly image?: string | undefined
  readonly profile?: string | undefined
  readonly target?: string | undefined
}

/**
 * A serializable directive describing where a flow node should run.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Placement = Data.TaggedEnum<{
  readonly "flows/core/Placement/Local": Readonly<Record<never, never>>
  readonly "flows/core/Placement/Client": Readonly<Record<never, never>>
  readonly "flows/core/Placement/Sandbox": Options
  readonly "flows/core/Placement/Remote": Options
}>

const constructors = Data.taggedEnum<Placement>()

/**
 * Creates a placement directive for the local process host.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const local = (): Placement => constructors["flows/core/Placement/Local"]()

/**
 * Creates a placement directive for the viewer's browser host.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const client = (): Placement => constructors["flows/core/Placement/Client"]()

/**
 * Creates a placement directive for an isolated sandbox host.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const sandbox = (options: Options = {}): Placement =>
  constructors["flows/core/Placement/Sandbox"]({ ...options })

/**
 * Creates a placement directive for a remote control-plane host.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const remote = (options: Options = {}): Placement => constructors["flows/core/Placement/Remote"]({ ...options })

/**
 * The annotation key a declared placement is carried under.
 *
 * One key, here, because both graph builders read it: `@smthrs/core` publishes
 * it as `Annotations.Placement` and `@smthrs/flow` as `Flow.Placement`. While
 * they were two keys with two value types, crossing between them was a cast.
 *
 * @category annotations
 * @since 1.0.0-rc.0
 */
export const Annotation = Context.Service<Placement>("@smthrs/plan/Placement")
