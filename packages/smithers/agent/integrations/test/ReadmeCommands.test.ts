import * as Channels from "@smthrs/control/Channels"
import { Effect, Layer, Redacted } from "effect"
import { readFileSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"
import { computeHmacSha256Hex } from "../src/core/Signature.ts"
import { Core, Linear } from "../src/index.ts"
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
  it("documents the three live suites", () => {
    expect(singleFileCommands).toHaveLength(3)
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

const linearGuide = readFileSync(join(packageRoot, "docs/guides/linear.md"), "utf8")
const secret = "doc-fence-signing-secret"

// Execute the copied fence with real imports and explicit host dependencies.
const runFence = (document: string, needle: string, result: string, host: Record<string, unknown> = {}): unknown => {
  const fence = [...document.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((match) => match[1]!)
    .find((code) => code.includes(needle))
  if (!fence) throw new Error(`Missing doc fence: ${needle}`)
  const bindings = { Channels, Core, Linear, Effect, Redacted, createServer, ...host }
  const code =
    transpileModule(fence.replace(/^import .*$/gm, ""), { compilerOptions: { target: ScriptTarget.ESNext } }).outputText
  return new Function(...Object.keys(bindings), `${code}\nreturn ${result}`)(...Object.values(bindings))
}

describe("documented webhook setup", () => {
  it("verifies a signature using only the README's advertised secret variable", async () => {
    const channel = runFence(readme, "const channel =", "channel", {
      process: { env: { SMITHERS_LINEAR_WEBHOOK_SECRET: secret } }
    }) as Channels.Channel
    const body = Buffer.from(JSON.stringify({ webhookTimestamp: Date.now() }))
    await expect(Effect.runPromise(channel.verify({
      body,
      idempotencyKey: "doc-signature",
      headers: { "linear-signature": computeHmacSha256Hex(body, secret) }
    }))).resolves.toBeUndefined()
  })

  it.each([undefined, "", "   "])("rejects a missing or empty README secret (%s)", (value) => {
    expect(() =>
      runFence(readme, "const channel =", "channel", {
        process: { env: { SMITHERS_LINEAR_WEBHOOK_SECRET: value } }
      })
    ).toThrow("SMITHERS_LINEAR_WEBHOOK_SECRET is required")
  })

  it("attributes Linear secret resolution to Config.resolve", () => {
    const row = readme.split("\n").find((line) => line.startsWith("| `SMITHERS_LINEAR_WEBHOOK_SECRET`"))
    expect(row).toContain("Linear.Config.resolve")
    const guide = linearGuide
    expect(guide).toContain("Linear.Config.resolve")
    expect(guide).not.toContain("webhook secret falls back")
    expect(guide).toContain("1 MiB")
    expect(guide).toContain("credentialSecret")
  })
})

describe("documented HTTP receiver", () => {
  it.each([1024 * 1024, 1024 * 1024 + 1])("bounds a chunked %i-byte body before ingestion", async (size) => {
    const ingest = vi.fn(() => Effect.succeed({ _tag: "Accepted" as const, receiptId: "receipt" }))
    const channelsLayer = Layer.succeed(Channels.Channels, {
      register: () => Effect.void,
      lookup: () => Effect.die("unused"),
      ingest,
      project: () => Effect.die("unused")
    })
    const server = runFence(linearGuide, "const server =", "server", { webhookSecret: secret, channelsLayer }) as Server
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
      headers: { "linear-delivery": "doc-delivery" }
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
        expect(call.channel).toBe("linear")
        expect(call.raw.idempotencyKey).toBe(
          Linear.Webhook.idempotencyKey({ headers: { "linear-delivery": "doc-delivery" } }, undefined)
        )
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
