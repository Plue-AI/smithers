import * as Channels from "@smthrs/control/Channels"
import { Effect, Layer, Redacted } from "effect"
import { readFileSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"
import { Core } from "../src/index.ts"
import config from "../vitest.config.ts"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const readme = readFileSync(join(packageRoot, "README.md"), "utf8")

/**
 * Every shell line in the README that runs vitest over a single test file.
 * The credential prefix and the pnpm filter are kept so a failure names the
 * command an operator would copy.
 */
const singleFileCommands = readme
  .split("\n")
  .filter((line) => /vitest run test\/\S+\.test\.ts/.test(line))

describe("README live-suite commands", () => {
  it("documents the GitHub live suite", () => {
    expect(singleFileCommands).toHaveLength(1)
  })

  it("runs each single-file command with coverage disabled", () => {
    // The package enables v8 coverage with global thresholds, so a run over one
    // file reports a few percent and vitest exits 1 after the tests pass. A
    // documented command that always exits 1 is a broken command.
    expect(config.test?.coverage?.enabled).toBe(true)
    expect(config.test?.coverage?.thresholds).toBeDefined()
    for (const command of singleFileCommands) {
      expect(command).toContain("--coverage.enabled=false")
    }
  })
})

const receiverGuide = readFileSync(join(packageRoot, "docs/guides/webhook-ingress.md"), "utf8")

// Execute the copied fence with real imports and explicit host dependencies.
const runFence = (document: string, needle: string, result: string, host: Record<string, unknown> = {}): unknown => {
  const fence = [...document.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((match) => match[1]!)
    .find((code) => code.includes(needle))
  if (!fence) throw new Error(`Missing doc fence: ${needle}`)
  const bindings = { Channels, Core, Effect, Redacted, createServer, ...host }
  const code =
    transpileModule(fence.replace(/^import .*$/gm, ""), { compilerOptions: { target: ScriptTarget.ESNext } }).outputText
  return new Function(...Object.keys(bindings), `${code}\nreturn ${result}`)(...Object.values(bindings))
}

describe("documented HTTP receiver", () => {
  it.each([1024 * 1024, 1024 * 1024 + 1])("bounds a chunked %i-byte body before ingestion", async (size) => {
    const ingest = vi.fn(() => Effect.succeed({ _tag: "Accepted" as const, receiptId: "receipt" }))
    const channelsLayer = Layer.succeed(Channels.Channels, {
      register: () => Effect.void,
      lookup: () => Effect.die("unused"),
      ingest,
      project: () => Effect.die("unused")
    })
    const server = runFence(receiverGuide, "const server =", "server", { channelsLayer }) as Server
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture address")
    let ended = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const body = Buffer.alloc(size, "x")
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      headers: { "x-delivery": "doc-delivery" }
    })
    try {
      const reply = new Promise<{ status: number | undefined; ended: boolean }>((resolve, reject) => {
        request.on("error", reject)
        request.on("response", (response) => {
          response.resume()
          resolve({ status: response.statusCode, ended })
        })
      })
      // No Content-Length, and no final chunk until the fallback timer fires.
      for (let offset = 0; offset < size; offset += 64 * 1024) {
        request.write(body.subarray(offset, offset + 64 * 1024))
      }
      timer = setTimeout(() => {
        ended = true
        request.end()
      }, 2000)
      const response = await reply
      if (size > 1024 * 1024) {
        expect(response.status).toBe(413)
        expect(response.ended).toBe(false)
        expect(ingest).not.toHaveBeenCalled()
      } else {
        expect(response.status).toBe(200)
        expect(ingest).toHaveBeenCalledOnce()
        // Compare the bytes directly. A matcher deep-diff over 1 MiB took
        // over 17 seconds and timed out under parallel load.
        const [call] = ingest.mock.calls[0] as unknown as [
          { readonly channel: string; readonly raw: { readonly body: Uint8Array; readonly idempotencyKey: string } }
        ]
        expect(call.channel).toBe("signed")
        expect(call.raw.idempotencyKey).toBe("doc-delivery")
        expect(Buffer.compare(Buffer.from(call.raw.body), body)).toBe(0)
      }
    } finally {
      clearTimeout(timer)
      request.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

it.each([undefined, "   "])("refuses a generic delivery without a stable identity (%j)", async (delivery) => {
  const ingest = vi.fn(() => Effect.succeed({ _tag: "Accepted" as const, receiptId: "receipt" }))
  const channelsLayer = Layer.succeed(Channels.Channels, {
    register: () => Effect.void,
    lookup: () => Effect.die("unused"),
    ingest,
    project: () => Effect.die("unused")
  })
  const server = runFence(receiverGuide, "const server =", "server", { channelsLayer }) as Server
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      method: "POST",
      body: "{}",
      ...(delivery === undefined ? {} : { headers: { "x-delivery": delivery } })
    })
    expect(response.status).toBe(401)
    expect(ingest).not.toHaveBeenCalled()
    await response.body?.cancel()
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
