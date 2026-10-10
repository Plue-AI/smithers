import { Cli, z } from "incur"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as Presentation from "../src/cli/Presentation.ts"
import { catalogCommands, dispatchCatalog, mountCatalog } from "../src/internal/backend/Catalog.ts"
import { Client } from "../src/internal/backend/Client.ts"
import { targetsInstall } from "../src/internal/backend/Destination.ts"

it.each(["missing binding", "ambiguous binding", "invalid payload"])(
  "refuses malformed person-action transport locally: %s",
  async (boundary) => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url!)
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end("{}")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      // Exercise the production dispatcher through incur's command boundary.
      // Broken transport metadata cannot reach the install for authorization.
      // Person policy is authoritative only in the install, after credential checks.
      const { client: _client, ...descriptor } = catalogCommands.find((row) => row.name === "todo.new")!
      const row = {
        ...descriptor,
        agent: "never" as const,
        ...(boundary === "missing binding" ? { http: null } : {}),
        ...(boundary === "ambiguous binding" ?
          {
            payload: { dialect: "draft-2020-12", schema: { anyOf: [] }, definitions: {} }
          } :
          {})
      }
      const client = new Client({
        environment: {
          SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          SMITHERS_TOKEN: "test-token"
        }
      })
      const cli = Cli.create("smthrs").command("new", {
        run: (context) =>
          Presentation.guard(context, async () => {
            try {
              return await dispatchCatalog(client, row, { text: 42 })
            } catch (error) {
              throw client.failure(error)
            }
          })
      })
      let stdout = "", exit = 0
      await Presentation.withErrorEnvelope((text) => {
        stdout += text
      }, (stdout) =>
        cli.serve(["new", "--json"], {
          stdout,
          exit: (code) => {
            exit = code
          }
        }))
      expect(exit).not.toBe(0)
      expect(JSON.parse(stdout)).toEqual(
        boundary === "missing binding"
          ? { code: "not_available", message: "Not available yet" }
          : boundary === "ambiguous binding"
          ? { code: "UsageError", message: "This HTTP door has no unique payload variant" }
          : { code: "command_failed", message: "Something went wrong on our side. Not your fault." }
      )
      if (boundary === "invalid payload") {
        await expect(dispatchCatalog(client, row, { text: 42 })).rejects.toMatchObject({
          name: "ZodError",
          issues: [expect.objectContaining({
            code: "invalid_union",
            path: ["text"],
            errors: [
              [expect.objectContaining({ code: "invalid_type", expected: "string" })],
              [expect.objectContaining({ code: "invalid_type", expected: "null" })]
            ]
          })]
        })
      }
      expect(requests).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
)

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
    stdout: (text) => {
      stdout += text
    },
    exit: () => {}
  })
  expect(calls).toEqual(["/local/project"])
  expect(JSON.parse(stdout)).toEqual({ source: "local" })
  stdout = ""
  await cli.serve(["branches", "--schema", "--json"], {
    stdout: (text) => {
      stdout += text
    },
    exit: () => {}
  })
  expect(JSON.parse(stdout)).toHaveProperty("options")
  for (const verb of ["stack", "flow"]) {
    stdout = ""
    await cli.serve([verb, "--json"], {
      stdout: (text) => {
        stdout += text
      },
      exit: () => {}
    })
    expect(JSON.parse(stdout)).toEqual({ source: `local-${verb}` })
  }
})

it("accepts Appendix A TODO numbers through the catalog transport", async () => {
  const seen: unknown[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      seen.push({ method: request.method, path: request.url, body: JSON.parse(body) })
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ state: "accepted" }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const cli = Cli.create("smthrs")
    mountCatalog(cli, {
      environment: {
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        SMITHERS_TOKEN: "test-token"
      }
    })
    for (const todo of ["T3"]) {
      let stdout = ""
      await cli.serve(["todo", "answer", todo, "Use backoff", "--wait", "q-1", "--json"], {
        stdout: (text) => {
          stdout += text
        },
        exit: () => {}
      })
      expect(JSON.parse(stdout)).toEqual({ todo: 3, wait: "q-1", state: "accepted" })
    }
    expect(seen).toEqual([0].map(() => ({
      method: "POST",
      path: "/api/todos/3/answer",
      body: { wait: "q-1", answer: "Use backoff" }
    })))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it.each(["standalone", "origin", "credential", "token-file", "repo", "cloud"])(
  "selects one runs list dispatcher in %s mode",
  async (mode) => {
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
        HOME: home,
        SMITHERS_API_ORIGIN: origin,
        ...(mode === "token-file" ? { SMITHERS_TOKEN_FILE: tokenFile } : { SMITHERS_TOKEN: "test-token" })
      }
      const cli = Cli.create("smthrs").command(
        Cli.create("runs").command("list", {
          options: z.object({
            root: z.string().optional(),
            repo: z.string().optional(),
            cloud: z.boolean().optional()
          }),
          run: () => {
            local++
            return { source: "local" }
          }
        })
      )
      mountCatalog(cli, { environment })
      const serve = async (flags: string[]) => {
        let stdout = ""
        await cli.serve(["runs", "list", ...flags, "--json"], {
          stdout: (value) => {
            stdout += value
          },
          exit: () => {}
        })
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
  }
)

it.each([
  { args: {}, options: { root: "/tmp/project", repo: "owner/repo" } },
  { args: {}, options: { data: "{}", cloud: true } },
  { args: {}, options: { flow: "local-flow" } },
  { args: { path: "/tmp/project" }, options: {} }
])("explicit local scope wins with a configured install: %j", (context) => {
  expect(targetsInstall(context, { environment: { SMITHERS_URL: "http://localhost:1", SMITHERS_TOKEN: "test-token" } }))
    .toBe(false)
})
