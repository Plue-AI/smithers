import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect"
import * as ApplyPatch from "../../src/ApplyPatch.ts"
import * as Edit from "../../src/Edit.ts"
import type { StdError } from "../../src/StdError.ts"

const [path, kind, pause] = process.argv.slice(2)
const result = await Effect.runPromiseExit(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const operation: Effect.Effect<unknown, StdError, FileSystem.FileSystem | Path.Path> = kind === "patch"
      ? ApplyPatch.run({ input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-beta\n+BETA\n*** End Patch` })
      : Edit.run({
        path: path!,
        oldString: kind === "first" ? "alpha" : "beta",
        newString: kind === "first" ? "ALPHA" : "BETA"
      })
    return yield* operation.pipe(Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      readFile: (file) =>
        fs.readFile(file).pipe(Effect.tap(() =>
          pause === "pause"
            ? Effect.promise(() =>
              new Promise<void>((resolve) => {
                process.once("message", () => resolve())
                process.send!({ event: "read" })
              })
            )
            : Effect.void
        ))
    }))
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer))
)
const error = Exit.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
process.send!({ event: "result", ok: Exit.isSuccess(result), code: error?.code, message: error?.message })
process.disconnect!()
