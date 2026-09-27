/**
 * Explicit kernel decision for the Effect path service.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */
import { Effect, Layer, Path as EffectPath } from "effect"
import * as Rooted from "./Rooted.ts"
import { Workspace } from "./Workspace.ts"

/**
 * Effect's lexical path-service shape.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Path = EffectPath.Path

/**
 * The unchanged underlying path-service tag.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export const Path = EffectPath.Path

/**
 * Re-provides Effect's path service with relative paths resolved against
 * `Workspace.root`, the same root the kernel spawner runs commands in. Path
 * manipulation is pure and lexical, so it requires no capability check. This
 * explicit layer proves that every member of the Host services closed list has
 * a kernel decision.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer: Layer.Layer<Path, never, Path | Workspace> = Layer.effect(
  Path,
  Effect.gen(function*() {
    const path = yield* Path
    return Rooted.path(path, path.resolve((yield* Workspace).root))
  })
)
