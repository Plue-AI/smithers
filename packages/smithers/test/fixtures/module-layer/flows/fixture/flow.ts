import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const Write = Action.make("fixture/Write", {
  implementationVersion: "fixture-write/v1",
  payload: { output: Schema.String, value: Schema.String },
  success: Schema.Struct({ value: Schema.String, pid: Schema.Number }),
  error: Schema.Unknown
})

export const layer = Layer.unwrap(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner
  return Write.toLayer(({ output, value }) =>
    Effect.gen(function*() {
      const filename = path.resolve(output)
      const child = yield* spawner.spawn(ChildProcess.make(process.execPath, [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], process.argv[2]); process.stdout.write(String(process.pid))",
          filename,
          value
        ], { cwd: path.dirname(filename), env: {}, extendEnv: false }))
      const [stdout, stderr, code] = yield* Effect.all([
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode
      ], { concurrency: "unbounded" })
      if (code !== 0) return yield* Effect.fail({ code, stderr })
      return { value: yield* fs.readFileString(filename), pid: Number(stdout) }
    }).pipe(Effect.scoped), { implementationVersion: "fixture-write/v1" })
}))

export default Flow.make("fixture", {
  description: "Write a value using a child process.",
  capabilities: ["proc:spawn:**", "fs:read:**", "fs:write:**"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { output: Schema.String, value: Schema.String },
  success: Schema.Struct({ value: Schema.String, pid: Schema.Number }),
  error: Schema.Unknown,
  body: Node.capture({ action: Write.name, implementationVersion: "fixture-write/v1" },
    ({ output, value }) => Write.call({ output, value }))
})
