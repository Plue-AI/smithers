import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import { misc } from "../src/internal/backend/Misc.ts"

const roots: Array<string> = []
const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!
afterEach(async () => {
  vi.restoreAllMocks()
  Object.defineProperty(process, "stdin", stdin)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-api-input-"))
  roots.push(root)
  return root
}
const max = 4 * 1024 * 1024

describe("raw API JSON input units", () => {
  it.each(
    [null, true, 42, "text", [false, 0], { private: true, nested: { values: [1, null, "é"] } }].map((body) => ({
      body
    }))
  )(
    "preserves typed JSON $body from an actual file",
    async ({ body }) => {
      const root = await temporary(), path = join(root, "body.json")
      await writeFile(path, JSON.stringify(body))
      const client = new Client()
      const response = vi.spyOn(client, "response").mockResolvedValue(new Response("{}"))
      await misc.api!(client, { endpoint: "/api/input" }, { method: "POST", input: path })
      expect(response).toHaveBeenCalledWith("POST", "/api/input", body, { headers: {} })
    }
  )
  it.each(["file", "stdin"])("accepts exactly 4 MiB and refuses the next byte from %s before HTTP", async (source) => {
    const root = await temporary(), path = join(root, "body.json")
    const client = new Client()
    const response = vi.spyOn(client, "response").mockResolvedValue(new Response("{}"))
    const input = source === "file" ? path : "-"
    const provide = async (text: string) => {
      if (source === "file") await writeFile(path, text)
      else Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([Buffer.from(text)]) })
    }
    const body = "x".repeat(max - 2)
    await provide(JSON.stringify(body))
    await misc.api!(client, { endpoint: "/api/input" }, { method: "POST", input })
    expect(response.mock.calls[0]![2]).toBe(body)
    response.mockClear()
    await provide(JSON.stringify(body + "x"))
    await expect(misc.api!(client, { endpoint: "/api/input" }, { method: "POST", input }))
      .rejects.toMatchObject({ code: "input_too_large" })
    expect(response).not.toHaveBeenCalled()
  })
  it.each(["", "{", "{} {}", "null trailing", "NaN"])("refuses %j without HTTP", async (text) => {
    const root = await temporary(), path = join(root, "body.json")
    await writeFile(path, text)
    const client = new Client(), response = vi.spyOn(client, "response")
    await expect(misc.api!(client, { endpoint: "/api/input" }, { method: "POST", input: path }))
      .rejects.toThrow("one valid JSON value")
    expect(response).not.toHaveBeenCalled()
  })
  it("refuses conflicts before reading stdin and missing files without exposing their names", async () => {
    const root = await temporary(), client = new Client()
    const read = vi.spyOn(client, "stdin"), response = vi.spyOn(client, "response")
    await expect(misc.api!(client, { endpoint: "/api/input" }, { input: "-", field: ["private=true"] }))
      .rejects.toThrow("together")
    expect(read).not.toHaveBeenCalled()
    await expect(misc.api!(client, { endpoint: "/api/input" }, { method: "POST", input: join(root, "private-secret") }))
      .rejects.toMatchObject({ code: "input_unreadable", message: "Cannot read JSON input file" })
    expect(response).not.toHaveBeenCalled()
  })
  it("retains flat string fields", async () => {
    const client = new Client(), response = vi.spyOn(client, "response").mockResolvedValue(new Response("{}"))
    await misc.api!(client, { endpoint: "/api/input" }, { method: "POST", field: ["private=true", "name=a=b"] })
    expect(response).toHaveBeenCalledWith("POST", "/api/input", { private: "true", name: "a=b" }, { headers: {} })
  })
})

describe("actual CLI JSON input over TCP HTTP", () => {
  it("sends typed file/stdin bodies, preserves fields, and refuses invalid input before requests", async () => {
    const root = await temporary(), path = join(root, "body.json")
    const bodies: Array<unknown> = []
    const server = createServer(async (req, res) => {
      let text = ""
      for await (const chunk of req) text += chunk
      expect(req.method).toBe("POST")
      expect(req.url).toBe("/api/input")
      expect(req.headers.authorization).toBe("token input-secret")
      bodies.push(JSON.parse(text))
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ accepted: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing server port")
      const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
      const run = (args: Array<string>, input = "") =>
        new Promise<{ code: number | null; output: string; error: string }>(
          (resolve, reject) => {
            const child = spawn(process.execPath, [
              "--no-warnings",
              executable,
              "api",
              "/api/input",
              "--method",
              "POST",
              "--format=json",
              ...args
            ], {
              cwd: root,
              timeout: 60_000,
              env: {
                HOME: root,
                PATH: process.env.PATH,
                TMPDIR: process.env.TMPDIR,
                XDG_DATA_HOME: root,
                SMITHERS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
                SMITHERS_TOKEN: "input-secret",
                SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
              },
              stdio: ["pipe", "pipe", "pipe"]
            })
            let output = "", error = ""
            child.stdout.on("data", (chunk) => output += chunk)
            child.stderr.on("data", (chunk) => error += chunk)
            child.on("error", reject)
            child.on("close", (code) => resolve({ code, output, error }))
            child.stdin.end(input)
          }
        )
      const body = { private: true, nested: { enabled: false, values: [0, null, "é"] } }
      await writeFile(path, JSON.stringify(body))
      for (
        const [args, input] of [[["--input", path], ""], [["--input", "-"], JSON.stringify(body)], [[
          "--field",
          "private=true",
          "--field",
          "name=a=b"
        ], ""]] as const
      ) {
        const result = await run([...args], input)
        expect(result.code, result.output + result.error).toBe(0)
        expect(JSON.parse(result.output)).toEqual({ accepted: true })
        expect(result.output + result.error).not.toContain("input-secret")
      }
      expect(bodies).toEqual([body, body, { private: "true", name: "a=b" }])
      for (const text of ["{} {}", "{", JSON.stringify("x".repeat(max))]) {
        await writeFile(path, text)
        const result = await run(["--input", path])
        expect(result.code, result.output + result.error).not.toBe(0)
      }
      for (const args of [["--input", "-", "--field", "private=true"], ["--input", join(root, "private-filename")]]) {
        const result = await run(args, "{}")
        expect(result.code, result.output + result.error).not.toBe(0)
        expect(result.output + result.error).not.toContain("private-filename")
      }
      expect(bodies).toHaveLength(3)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 180_000)
})
