import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mcp-argument-roles", version: "1" } }
}) + "\n"

it("selects MCP only from option roles through real CLI, HTTP and stdin lifetimes", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-mcp-roles-"))
  const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const parsed = body === "" ? undefined : JSON.parse(body)
    requests.push({ method: request.method, url: request.url, body: parsed })
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ id: 1, title: parsed?.title ?? "fixture" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("HTTP fixture did not bind")
  const run = async (args: Array<string>, mcp?: "disconnect" | "cancel") => {
    const child = spawn(process.execPath, ["--no-warnings", bin, ...args], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: root,
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
        SMITHERS_TOKEN: "synthetic-mcp-role",
        SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
        GIT_TRACE2_EVENT: join(root, "git-trace.jsonl")
      }
    })
    let stdout = "", stderr = "", handshook = false
    child.stdin.on("error", () => {})
    child.stderr.on("data", (bytes) => {
      stderr += bytes
    })
    child.stdout.on("data", (bytes) => {
      stdout += bytes
      if (mcp !== undefined && !handshook && stdout.includes("\"serverInfo\"")) {
        handshook = true
        expect(child.exitCode).toBeNull()
        if (mcp === "cancel") child.kill("SIGTERM")
        else child.stdin.end()
      }
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000)
    child.stdin.write(initialize)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      const result = { code, stdout, stderr, handshook }
      // These logs retain real process/HTTP evidence independently of assertions.
      console.log(JSON.stringify({ args, ...result, requests: requests.slice() }))
      return result
    } finally {
      clearTimeout(timeout)
      child.stdin.destroy()
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  }
  const issue = ["issue", "create", "--format=json", "--repo", "owner/repo"]
  try {
    for (const title of [["--title", "--mcp"], ["--title=--mcp"], ["--title", "--"]]) {
      const before = requests.length
      const result = await run([...issue, ...title])
      expect(result.code, result.stdout + result.stderr).toBe(0)
      expect(result.handshook).toBe(false)
      expect(JSON.parse(result.stdout).title).toBe(title.at(-1) === "--" ? "--" : "--mcp")
      expect(requests.slice(before)).toEqual([{
        method: "POST",
        url: "/api/repos/owner/repo/issues",
        body: { title: title.at(-1) === "--" ? "--" : "--mcp", body: "" }
      }])
    }
    for (const mode of [["--mcp=false"], ["--no-mcp"], ["--mcp", "false"]]) {
      const before = requests.length
      const result = await run([...issue, "--title", "ordinary", ...mode])
      expect(result.code, result.stdout + result.stderr).toBe(0)
      expect(result.handshook).toBe(false)
      expect(requests.length).toBe(before + 1)
    }
    for (const tail of ["--mcp", "--help", "--version"]) {
      const before = requests.length
      const result = await run([...issue, "--title", "ordinary", "--", tail])
      expect(result.code, result.stdout + result.stderr).toBe(1)
      expect(JSON.parse(result.stdout).message).toBe("Unknown flag: --")
      expect(result.handshook).toBe(false)
      expect(requests.length).toBe(before)
    }
    for (
      const args of [
        ["runs", "list", "--format=json", "--message", "--mcp"],
        [...issue, "--title", "ordinary", "--backend", "--mcp"],
        [...issue, "--title", "ordinary", "--mcp=maybe"]
      ]
    ) {
      const before = requests.length
      const result = await run(args)
      expect(result.code, result.stdout + result.stderr).toBe(1)
      expect(result.stdout).not.toContain("serverInfo")
      expect(requests.length).toBe(before)
    }
    for (const mode of [["--mcp"], ["--mcp=true"], ["--mcp", "true"]]) {
      const before = requests.length
      const result = await run([...mode, "--format=json"], "disconnect")
      expect(result.handshook, result.stdout + result.stderr).toBe(true)
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout.trim()).result.serverInfo.name).toBe("smthrs")
      expect(requests.length).toBe(before)
    }
    const cancelled = await run(["--mcp"], "cancel")
    expect(cancelled.handshook).toBe(true)
    expect(cancelled.code).toBe(143)
    const registration = await run(["mcp", "add", "--help"])
    expect(registration.code).toBe(0)
    expect(registration.stdout).toContain("Register")
    expect(registration.stdout).not.toContain("serverInfo")

    const beforeClone = requests.length
    const cloned = await run(["repo", "clone", root, "--directory", join(root, "copy"), "--", "--mcp"])
    expect(cloned.code, cloned.stdout + cloned.stderr).toBe(1)
    expect(cloned.handshook).toBe(false)
    expect(cloned.stdout + cloned.stderr).toContain("tool_failed")
    const gitTrace = (await readFile(join(root, "git-trace.jsonl"), "utf8")).trim().split("\n").map((line) =>
      JSON.parse(line)
    )
    expect(gitTrace.find((event) => event.event === "start" && event.argv?.[1] === "clone")?.argv)
      .toEqual(["git", "clone", root, join(root, "copy"), "--mcp"])
    expect(requests.length).toBe(beforeClone)
    const literalRegistration = await run(["mcp", "add", "--format=json", "--", "--mcp"])
    expect(literalRegistration.code, literalRegistration.stdout + literalRegistration.stderr).toBe(1)
    expect(JSON.parse(literalRegistration.stdout).message).toBe("Unknown flag: --")
    expect(literalRegistration.handshook).toBe(false)

    const aliasHelp = await run(["targets", "-w", "--mcp", "--help"])
    expect(aliasHelp.code, aliasHelp.stdout + aliasHelp.stderr).toBe(0)
    expect(aliasHelp.stdout).not.toContain("serverInfo")
    expect(aliasHelp.stdout).toContain("workspace")

    const added = await run(["environment", "add", "local", "--local", "--directory", root])
    expect(added.code, added.stdout + added.stderr).toBe(0)
    const receipt = join(root, "forwarded.json"), script = join(root, "record.cjs")
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)))`
    )
    const forwarded = await run([
      "environment",
      "exec",
      "local",
      "--",
      process.execPath,
      script,
      "--mcp",
      "--help",
      "--version"
    ])
    expect(forwarded.code, forwarded.stdout + forwarded.stderr).toBe(0)
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(["--mcp", "--help", "--version"])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
