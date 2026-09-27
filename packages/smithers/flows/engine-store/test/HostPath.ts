import * as NodePath from "@effect/platform-node/NodePath"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"

/** The host platform's `Path` service, for constructors that take one directly. */
export const hostPath: Path.Path = Effect.runSync(
  Effect.gen(function*() {
    return yield* Path.Path
  }).pipe(Effect.provide(NodePath.layer))
)
