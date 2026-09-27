/**
 * Bun `Jj` implementation.
 *
 * Bun implements the Node child-process API used by the argv-safe jj adapter,
 * so Bun and Node deliberately share the same error classification and
 * interruption finalizer.
 *
 * @since 0.1.0
 */

import type * as Layer from "effect/Layer"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Jj, JjError } from "../Jj.ts"
import * as NodeJj from "../node/NodeJj.ts"

/**
 * Provides the `Jj` service backed by the jj CLI under Bun.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Jj, JjError> = NodeJj.layer

/**
 * Provides the `Jj` service bound to one absolute repository root under Bun.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerAt = NodeJj.layerAt

/**
 * Provides the `Jj` service through the host's `ChildProcessSpawner` under Bun.
 *
 * The contained counterpart of {@link layer}, for the same reason the Node one
 * has one: a jj child started around the host leads no recorded process group
 * and no reaper can ever find it.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSpawner: Layer.Layer<Jj, JjError, ChildProcessSpawner> = NodeJj.layerSpawner

/**
 * Provides a repository-bound `Jj` service through the host spawner under Bun.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSpawnerAt = NodeJj.layerSpawnerAt
