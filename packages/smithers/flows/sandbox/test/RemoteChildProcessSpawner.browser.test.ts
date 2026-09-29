import { expect, it } from "@effect/vitest"
import { build } from "esbuild"
import { webcrypto } from "node:crypto"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

it("runs remote commands with and without guest environment in a browser runtime", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import * as Effect from "effect/Effect"
        import * as ChildProcess from "effect/unstable/process/ChildProcess"
        import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
        import * as Remote from "./src/RemoteChildProcessSpawner/index.ts"

        globalThis.runBrowserProbe = async () => {
          const observed = []
          for (const env of [undefined, { REVIEW_VAR: "delivered", PATH: "/guest/bin", REMOVED: undefined }]) {
            const scripted = Remote.TestRemote.make({ scripts: { "printf hi": { stdout: "hi" } } })
            const received = []
            const provider = {
              ...scripted,
              spawn: (command, options) => {
                received.push(options.env)
                return scripted.spawn(command, options)
              }
            }
            const command = ChildProcess.make("printf", ["hi"], { env })
            const stdout = await Effect.runPromise(
              Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(command)).pipe(
                Effect.provide(Remote.layer(provider))
              )
            )
            observed.push({
              stdout,
              commands: scripted.state.commands,
              env: received[0],
              hasRemoval: received[0] !== undefined && Object.hasOwn(received[0], "REMOVED")
            })
          }
          return JSON.stringify({ processAbsent: typeof process === "undefined", observed })
        }
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url))
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false
  })
  const context = {
    AbortController,
    crypto: webcrypto,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder
  }
  runInNewContext(bundle.outputFiles[0]!.text, context)
  const run = (context as typeof context & { runBrowserProbe: () => Promise<string> }).runBrowserProbe
  const result = JSON.parse(await run())
  expect(result).toEqual({
    processAbsent: true,
    observed: [
      { stdout: "hi", commands: ["printf hi"], hasRemoval: false },
      {
        stdout: "hi",
        commands: ["printf hi"],
        env: { REVIEW_VAR: "delivered", PATH: "/guest/bin" },
        hasRemoval: true
      }
    ]
  })
})
