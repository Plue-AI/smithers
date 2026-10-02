import { expect, it } from "@effect/vitest"
import { build } from "esbuild"
import { webcrypto } from "node:crypto"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

it("keeps the public package browser import and unchanged work independent of the Node host adapter", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import * as Effect from "effect/Effect"
        import * as Sandbox from "./src/index.ts"
        globalThis.runBrowserProbe = async () => {
          const work = new Sandbox.Sandbox.Unchanged({ session: "browser", base: "base" })
          const result = await Effect.runPromise(Sandbox.SandboxMerge.apply(work, {
            repository: "/unused", onto: "main", message: "unused"
          }))
          return JSON.stringify({
            processAbsent: typeof process === "undefined",
            modules: Object.keys(Sandbox).sort(),
            sameWork: result === work,
            result
          })
        }
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url))
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    metafile: true
  })
  expect(Object.keys(bundle.metafile.inputs).some((path) => path.endsWith("/node/NodeJj.ts"))).toBe(false)
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
  expect(result.processAbsent).toBe(true)
  expect(result.modules).toContain("SandboxMerge")
  expect(result.sameWork).toBe(true)
  expect(result.result).toEqual({ _tag: "Unchanged", session: "browser", base: "base" })
})
