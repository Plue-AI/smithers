/**
 * Engine-private Jujutsu authority.
 *
 * Action bodies resolve the public `Jj` tag from their guarded host context.
 * Snapshot, restore, and diff bookkeeping resolve this distinct tag instead,
 * so an engine operation never grants the same authority to user code.
 *
 * @since 1.0.0
 */

import { Jj } from "@smthrs/kernel"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Engine-owned repository operations, absent from public action context.
 *
 * @since 1.0.0
 * @category services
 */
export class EngineJj extends Context.Service<EngineJj, Jj.Jj>()("@smthrs/engine-store/internal/EngineJj") {}

/**
 * Captures the current public Jj implementation under the private engine tag.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerFromJj: Layer.Layer<EngineJj, never, Jj.Jj> = Layer.effect(EngineJj, Effect.map(Jj.Jj, EngineJj.of))
