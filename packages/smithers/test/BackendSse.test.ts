/** Real CLI/TCP streams retain inert, redacted logs through completion and failure. */
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const secret = "synthetic-sse-session-secret"
const content = `before\u001b]0;changed\u0007\u001b[2J\u009b31mred\u0000\u202e\r\n\tsecond ${secret}`

it.each(["complete", "drop", "cancel"] as const)("keeps backend SSE stderr inert through %s", async (mode) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-backend-sse-"))
  let child: ChildProcess | undefined
  let requests = 0
  let released!: () => void
  const release = new Promise<void>((resolve) => released = resolve)
  let afterLog = () => {}
  const server = createServer((req, res) => {
    requests++
    expect(req.method).toBe("GET")
    expect(req.url).toBe("/api/repos/owner/repo/runs/7/logs")
    expect(req.headers.authorization).toBe(`token ${secret}`)
    res.on("close", released)
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`event: log\ndata: ${JSON.stringify({ content })}\n\n`)
    afterLog = () => {
      if (mode === "complete") res.end("event: done\ndata: {\"status\":\"completed\"}\n\n")
      else if (mode === "drop") res.destroy()
      else child!.kill("SIGINT")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing HTTP address")
    let output = "", error = "", acted = false
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child = spawn(process.execPath, [
        "--no-warnings",
        executable,
        "runs",
        "logs",
        "7",
        "--cloud",
        "--repo",
        "owner/repo",
        "--format=json"
      ], {
        cwd: home,
        timeout: 60_000,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          SMITHERS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
          SMITHERS_TOKEN: secret,
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      })
      child.stdout!.on("data", (chunk) => output += chunk)
      child.stderr!.on("data", (chunk) => {
        error += chunk
        // Drop or cancel only after the actual child rendered the preceding log.
        if (!acted && error.includes("second")) {
          acted = true
          afterLog()
        }
      })
      child.on("error", reject)
      child.on("close", (code, signal) => resolve({ code, signal }))
    })
    expect(acted, output + error).toBe(true)
    expect(result.signal).toBeNull()
    expect(result.code, output + error).toBe(mode === "complete" ? 0 : mode === "cancel" ? 130 : 1)
    expect(requests).toBe(1)
    expect(error).toContain("beforered\n\tsecond [REDACTED]\n")
    expect(error).not.toMatch(/[\u001b\u0000\u0007\u009b\u202e]/u)
    expect(output + error).not.toContain(secret)
    // JSON escapes C0 controls and preserves the decoded event's Unicode data.
    expect(output).not.toMatch(/[\u001b\u0000\u0007]/u)
    if (mode === "complete") {
      expect(JSON.parse(output)).toEqual([
        { type: "log", data: { content: content.replace(secret, "[REDACTED]") } },
        { type: "done", data: { status: "completed" } }
      ])
      expect(error).toContain("completed\n")
    }
    await release
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
}, 90_000)
