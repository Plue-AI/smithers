/** Registry arguments shared by runtime factories.
 * @since 1.0.0
 */

import * as Layer from "effect/Layer"

/** A declared registry must be supplied, including when callers specify type arguments.
 * @since 1.0.0
 * @private
 */
export type RegistryArgs<A, E, R> =
  | [registry: Layer.Layer<A, E, R>]
  | ([A | E | R] extends [never] ? [registry?: undefined] : never)

/** The empty branch can only be selected when all three registry types are never.
 * @since 1.0.0
 * @private
 */
export const registryLayer = <A, E, R>(args: RegistryArgs<A, E, R>): Layer.Layer<A, E, R> =>
  (args[0] ?? Layer.empty) as Layer.Layer<A, E, R>
