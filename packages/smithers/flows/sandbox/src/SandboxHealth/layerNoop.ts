/**
 * Provides the healthy no-op sandbox health layer.
 *
 * @since 0.1.0
 */

import * as Layer from "effect/Layer"
import { makeNoop } from "./makeNoop.ts"
import { SandboxHealth } from "./SandboxHealth.ts"
import type { Service } from "./Service.ts"

/**
 * Layer form of `makeNoop`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Service> = Layer.sync(SandboxHealth, makeNoop)
