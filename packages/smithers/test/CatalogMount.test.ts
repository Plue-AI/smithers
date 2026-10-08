import { Cli, z } from "incur"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { targetsInstall } from "../src/internal/backend/Destination.ts"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, it } from "vitest"
import { mountCatalog } from "../src/internal/backend/Catalog.ts"

it("keeps a local verb executable while mounting an install-only door", async () => {
  const calls: string[] = []
  const cli = Cli.create("smthrs").command(
    Cli.create("runs").command("list", {
      options: z.object({ root: z.string() }),
      run: ({ options }) => {
        calls.push(options.root)
        return { source: "local" }
      }
    })
  ).command("stack", {
    run: () => ({ source: "local-stack" })
  }).command("flow", {
    run: () => ({ source: "local-flow" })
  })
  mountCatalog(cli, {})
  let stdout = ""
  await cli.serve(["runs", "list", "--root", "/local/project", "--json"], {
    stdout: (text) => { stdout += text },
    exit: () => {}
  })
  expect(calls).toEqual(["/local/project"])
  expect(JSON.parse(stdout)).toEqual({ source: "local" })
  stdout = ""
  await cli.serve(["branches", "--schema", "--json"], {
    stdout: (text) => { stdout += text },
    exit: () => {}
  })
  expect(JSON.parse(stdout)).toHaveProperty("options")
  for (const verb of ["stack", "flow"]) {
    stdout = ""
    await cli.serve([verb, "--json"], {
      stdout: (text) => { stdout += text },
      exit: () => {}
    })
    expect(JSON.parse(stdout)).toEqual({ source: `local-${verb}` })
  }
})

it("accepts Appendix A TODO numbers through the catalog transport", async () => {
  const seen: unknown[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      seen.push({ method: request.method, path: request.url, body: JSON.parse(body) })
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ state: "accepted" }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const cli = Cli.create("smthrs")
    mountCatalog(cli, { environment: {
      SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      SMITHERS_TOKEN: "test-token"
    } })
    for (const todo of ["T3"]) {
      let stdout = ""
      await cli.serve(["todo", "answer", todo, "Use backoff", "--wait", "q-1", "--json"], {
        stdout: (text) => { stdout += text },
        exit: () => {}
      })
      expect(JSON.parse(stdout)).toEqual({ todo: 3, wait: "q-1", state: "accepted" })
    }
    expect(seen).toEqual([0].map(() => ({
      method: "POST", path: "/api/todos/3/answer", body: { wait: "q-1", answer: "Use backoff" }
    })))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it.each(["standalone", "origin", "credential", "token-file", "repo", "cloud"])("selects one runs list dispatcher in %s mode", async (mode) => {
  const home = mkdtempSync(join(tmpdir(), "b8-catalog-"))
  const tokenFile = join(home, "token")
  writeFileSync(tokenFile, "test-token", { mode: 0o600 })
  let local = 0
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url!)
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ source: "catalog" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const environment = mode === "standalone" ? { HOME: home } : {
      HOME: home, SMITHERS_API_ORIGIN: origin,
      ...(mode === "token-file" ? { SMITHERS_TOKEN_FILE: tokenFile } : { SMITHERS_TOKEN: "test-token" })
    }
    const cli = Cli.create("smthrs").command(Cli.create("runs").command("list", {
      options: z.object({ root: z.string().optional(), repo: z.string().optional(), cloud: z.boolean().optional() }),
      run: () => { local++; return { source: "local" } }
    }))
    mountCatalog(cli, { environment })
    const serve = async (flags: string[]) => {
      let stdout = ""
      await cli.serve(["runs", "list", ...flags, "--json"], { stdout: (value) => { stdout += value }, exit: () => {} })
      return JSON.parse(stdout)
    }
    // A local project remains local even with a globally configured install.
    expect(await serve(["--root", home])).toEqual({ source: "local" })
    expect(requests).toEqual([])
    if (mode === "repo") {
      // One repository per install: /api/runs accepts no repository selector.
      expect(await serve(["--repo", "owner/repo"])).toEqual({
        code: "UsageError",
        message: "This HTTP door does not accept repo"
      })
      expect(requests).toEqual([])
    } else {
      expect(await serve(mode === "cloud" ? ["--cloud"] : []))
        .toEqual({ source: mode === "standalone" ? "local" : "catalog" })
      expect(requests).toEqual(mode === "standalone" ? [] : ["/api/runs"])
    }
    expect(local).toBe(mode === "standalone" ? 2 : 1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(home, { recursive: true, force: true })
  }
})


it.each([
  { args: {}, options: { root: "/tmp/project", repo: "owner/repo" } },
  { args: {}, options: { data: "{}", cloud: true } },
  { args: {}, options: { flow: "local-flow" } },
  { args: { path: "/tmp/project" }, options: {} }
])("explicit local scope wins with a configured install: %j", (context) => {
  expect(targetsInstall(context, { environment: { SMITHERS_URL: "http://localhost:1", SMITHERS_TOKEN: "test-token" } })).toBe(false)
})
