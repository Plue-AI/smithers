import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { main } from "../src/cli/Entry.ts"

// Remote text can contain terminal commands, including C1 and bidirectional controls.
const hostile = "\u001b]0;owned\u0007Fix\u001b[31m login\u009b2J\u202e"
const readResponse = { title: hostile, nested: [{ [hostile]: "first\nsecond\tcolumn" }], enabled: true, count: 2 }

it.each(
  ["md", "yaml", "toon", "json", "jsonl", "human"].flatMap((format) =>
    [false, true].map((pending) => ({ format, pending }))
  )
)(
  "renders catalog responses safely in $format (confirmation=$pending) without losing JSON data",
  async ({ format, pending }) => {
    const response = pending ? { confirmation: hostile, state: "pending" } : readResponse
    const root = await mkdtemp(join(tmpdir(), "smthrs-catalog-output-"))
    const requests: Array<{ method: string | undefined; path: string | undefined; authorization: string | undefined }> =
      []
    const server = createServer((request, reply) => {
      requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization })
      reply.statusCode = pending ? 202 : 200
      reply.setHeader("content-type", "application/json")
      reply.end(JSON.stringify(response))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const signals = new EventEmitter()
    let output = "", error = "", code = 0
    try {
      await main({
        argv: [
          ...(pending ? ["todo", "new", "--text", "Fix it"] : ["todo", "show", "T2"]),
          ...(format === "human" ? [] : ["--format", format]),
          "--audience",
          "human"
        ],
        env: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          SMITHERS_AUTH_FILE: join(root, "auth.json"),
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_TOKEN: "output-fixture-token"
        },
        stdout: { isTTY: false, columns: 100, write: (text) => void (output += text) },
        stderr: { isTTY: false, columns: 100, write: (text) => void (error += text) },
        on: (signal, listener) => void signals.on(signal, listener),
        removeListener: (signal, listener) => void signals.removeListener(signal, listener),
        setExitCode: (value) => {
          code = value
        }
      })
      expect(code, error + output).toBe(pending ? 3 : 0)
      expect(requests).toEqual([{
        method: pending ? "POST" : "GET",
        path: pending ? "/api/todos" : "/api/todos/2",
        authorization: "token output-fixture-token"
      }])
      expect(output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}]/u)
      expect(output + error).not.toContain("output-fixture-token")
      if (format === "json" || format === "jsonl") {
        expect(JSON.parse(output)).toEqual(pending ? { ...response, message: "Waiting for you to confirm" } : response)
      } else {
        expect(output).toContain("Fix login")
        expect(output).not.toContain("owned")
        if (pending) {
          expect(output).toContain("Waiting for you to confirm")
          expect(output).toContain("pending")
        } else {
          expect(output).toContain("first")
          expect(output).toContain("second")
          expect(output).toContain("column")
        }
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }
)
