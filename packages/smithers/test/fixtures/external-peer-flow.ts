import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"

const Work = Action.make("external-peer/Work", {
  implementationVersion: "external-peer/v1",
  payload: { root: Schema.String },
  success: Schema.Number,
  error: Schema.Unknown
})
export const layer = Work.toLayer(({ root }) =>
  Effect.gen(function*() {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [
          "-e",
          `
const fs = require('node:fs'); const path = require('node:path'); const root = process.argv[1];
fs.appendFileSync(path.join(root, 'spawns'), JSON.stringify({ pid: process.pid, owner: process.ppid }) + '\\n');
setInterval(() => {
  try { process.kill(process.ppid, 0); } catch { process.exit(1); }
  if (fs.existsSync(path.join(root, 'release'))) process.exit(0);
}, 20);
`,
          root
        ], { cwd: root, stdio: "ignore" })
      ),
      (process) =>
        Effect.sync(() => {
          process.kill("SIGKILL")
        })
    )
    const code = yield* Effect.callback<number, unknown>((resume) => {
      const onError = (error: Error) => resume(Effect.fail(error))
      const onExit = (code: number | null) => resume(Effect.succeed(code ?? -1))
      child.once("error", onError)
      child.once("exit", onExit)
      return Effect.sync(() => {
        child.removeListener("error", onError)
        child.removeListener("exit", onExit)
      })
    })
    if (code !== 0) return yield* Effect.fail({ code })
    return child.pid!
  }).pipe(Effect.scoped), { implementationVersion: "external-peer/v1" })
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
