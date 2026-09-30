import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const Work = Action.make("external-peer/Work", {
  implementationVersion: "external-peer/v1",
  payload: { root: Schema.String },
  success: Schema.Number,
  error: Schema.Unknown
})
export const layer = Layer.unwrap(Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return Work.toLayer(({ root }) =>
    Effect.gen(function*() {
      const child = yield* spawner.spawn(ChildProcess.make(process.execPath, [
        "-e",
        `
const fs = require('node:fs'); const path = require('node:path'); const root = process.argv[1];
fs.appendFileSync(path.join(root, 'spawns'), JSON.stringify({ pid: process.pid, owner: process.ppid }) + '\\n');
setInterval(() => { if (fs.existsSync(path.join(root, 'release'))) process.exit(0); }, 20);
`,
        root
      ], { cwd: root }))
      const [code] = yield* Effect.all([
        child.exitCode,
        child.stdout.pipe(Stream.drain),
        child.stderr.pipe(Stream.drain)
      ], { concurrency: "unbounded" })
      if (code !== 0) return yield* Effect.fail({ code })
      return Number(child.pid)
    }).pipe(Effect.scoped), { implementationVersion: "external-peer/v1" })
}))
export default Flow.make("external-peer", {
  description: "Keep an external worker alive during peer observation.",
  capabilities: ["proc:spawn:**", "fs:read:**", "fs:write:**"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { root: Schema.String },
  success: Schema.Number,
  error: Schema.Unknown,
  body: Node.capture(
    { action: Work.name, implementationVersion: "external-peer/v1" },
    ({ root }) => Work.call({ root })
  )
})
