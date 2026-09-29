import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { unknownSentence } from "../src/internal/Failure.ts"

// The backend command boundary: a real CLI invocation against a local HTTP
// server, reporting through Presentation.guard.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})
const fixture = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const home = await mkdtemp(join(tmpdir(), "backend-cli-refusal-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const server = createServer((req, res) => handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  await writeFile(
    environment.SMITHERS_AUTH_FILE,
    JSON.stringify({ api_url: origin, host: "127.0.0.1", token: "refusal-session-secret" }),
    { mode: 0o600 }
  )
  return async (args: Array<string>) => {
    let output = "", code = 0
    const cli = makeCli({ environment, exit: (value) => void (code = value) })
    await cli.serve([...args, "--json"], {
      env: environment,
      stdout: (text) => void (output += text),
      exit: (value) => void (code = value)
    })
    expect(output).not.toContain("refusal-session-secret")
    return { output, code }
  }
}

describe("backend command refusals", () => {
  it.each([
    [404, "Issue 4 was not found", "not_found"],
    [409, "The issue is being edited", "conflict"],
    [429, "Too many requests from this login", "rate_limited"],
    [503, "Smithers Cloud is restarting", "backend_unavailable"]
  ])("reports HTTP %i with its code and the backend's sentence only", async (status, message, code) => {
    const run = await fixture((_req, res) => {
      res.writeHead(status, { "content-type": "application/json", "x-request-id": "req-42" })
      res.end(JSON.stringify({ message }))
    })
    const result = await run(["issue", "view", "4", "--repo", "owner/repo"])
    expect(result.code).toBe(1)
    expect(result.output).toContain(code)
    expect(result.output).toContain(message)
    expect(result.output).not.toContain("/api/repos/owner/repo/issues/4")
    expect(result.output).not.toContain(`-> ${status}`)
    expect(result.output).not.toContain("command_failed")
  })

  it("states a designed sentence when the backend failed without one", async () => {
    const run = await fixture((_req, res) => {
      res.writeHead(502)
      res.end("<html>Bad Gateway</html>")
    })
    const result = await run(["issue", "view", "4", "--repo", "owner/repo"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("backend_unavailable")
    expect(result.output).toContain("Smithers Cloud did not answer. Not your fault")
    expect(result.output).not.toContain("Bad Gateway")
  })

  it("prints the generic sentence for a response the CLI cannot parse, never the parser's text", async () => {
    const run = await fixture((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end("{not json")
    })
    const result = await run(["issue", "view", "4", "--repo", "owner/repo"])
    expect(result.code).toBe(1)
    expect(result.output).toContain(unknownSentence)
    expect(result.output).not.toMatch(/Unexpected token|JSON at position|SyntaxError/)
  })

  it("exits 2 for an invocation the operator must retype", async () => {
    const run = await fixture((_req, res) => res.end("{}"))
    const result = await run(["issue", "create", "--repo", "owner/repo", "--title", " "])
    expect(result.code).toBe(2)
    expect(result.output).toContain("Issue title is required")
  })

  it("keeps the redacted backend sentence when the backend echoes the session token", async () => {
    const run = await fixture((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" })
      res.end(JSON.stringify({ message: "token refusal-session-secret lacks access" }))
    })
    const result = await run(["issue", "view", "4", "--repo", "owner/repo"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("forbidden")
    expect(result.output).toContain("lacks access")
  })
})
