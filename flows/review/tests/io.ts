/** Real platform for helper integration tests; production helpers have no native fallback. */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import { Effect, FileSystem, Layer } from "effect"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { withIo } from "../src/io.ts"
export const testIo = <A>(operation: () => Promise<A>): Promise<A> => Effect.runPromise(Effect.scoped(Effect.gen(function*() {
 const fs = yield* FileSystem.FileSystem
 const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
 return yield* Effect.tryPromise({ try: (signal) => withIo({ fs, spawner, signal }, operation), catch: (error) => error })
})).pipe(Effect.provide(NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))))))
