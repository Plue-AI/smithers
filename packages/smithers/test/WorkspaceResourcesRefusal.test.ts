import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const run = promisify(execFile)

describe("workspace resource refusal through the public CLI", () => {
  it.each([
    [400, "workspace_resources_exceeded", "workspace_resources_exceeded"],
    [400, "unknown_server_code", "request_refused"],
    [500, "workspace_resources_exceeded", "backend_unavailable"]
  ])("classifies HTTP %s and %s as %s", async (status, suppliedCode, expectedCode) => {
    const home = await mkdtemp(join(tmpdir(), "sizing-cli-refusal-"))
    const requests: unknown[] = []
    const server = createServer((req, res) => {
      let data = ""
      req.on("data", (chunk) => {
        data += chunk
      })
      req.on("end", () => {
        requests.push({ method: req.method, path: req.url, body: JSON.parse(data) })
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ code: suppliedCode, message: "resources.vcpu must be between 1 and 16" }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected a local HTTP port")
    try {
      const result = await run(process.execPath, [
        "bin/smithers.mjs",
        "workspace",
        "create",
        "--repo",
        "owner/repo",
        "--cpus",
        "17",
        "--format",
        "json"
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          SMITHERS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
          SMITHERS_TOKEN: "sizing-test-session",
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
        },
        timeout: 90_000
      }).then(() => {
        throw new Error("Expected a CLI refusal")
      }, (error) => error)
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stdout).code).toBe(expectedCode)
      expect(requests).toEqual([{
        method: "POST",
        path: "/api/repos/owner/repo/workspaces",
        body: { name: "", resources: { vcpu: 17 } }
      }])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})
