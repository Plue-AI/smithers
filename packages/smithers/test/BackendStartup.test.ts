import { Cli } from "incur"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { handlers } from "../src/internal/backend/Commands.ts"
import { definitions } from "../src/internal/backend/Definitions.ts"
import catalogFixture from "./CatalogCli.fixture.json" with { type: "json" }

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

describe("backend command startup", () => {
  it("keeps backend handlers and mounts the literal install command contract", () => {
    for (const name of Object.keys(definitions)) expect(handlers[name], name).toBeTypeOf("function")
    const cli = makeCli()
    const paths = [...catalogFixture.commands.map((command) => command.path), ...catalogFixture.b6]
    for (const name of paths) {
      let tree = Cli.toCommands.get(cli as never)!
      const words = name.split(" ")
      for (const word of words.slice(0, -1)) {
        const group = tree.get(word)
        expect(group, name).toBeDefined()
        if (!group || !("_group" in group)) throw new Error(`Missing group for ${name}`)
        tree = group.commands
      }
      const leaf = tree.get(words.at(-1)!)
      expect(leaf, name).toBeDefined()
      const command = leaf && "_group" in leaf ? leaf.root : leaf
      expect(command && "run" in command && command.run, name).toBeTypeOf("function")
    }
    const stack = Cli.toCommands.get(cli as never)!.get("stack")
    if (!stack || !("_group" in stack)) throw new Error("Missing install stack group")
    for (const retired of ["land", "submit", "sync"]) expect(stack.commands.has(retired), retired).toBe(false)
  })

  it("boots the actual CLI for help, saved environments and an authenticated HTTP call", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-backend-startup-"))
    const requests: Array<{ method: string; path: string; authorization: string | undefined }> = []
    const server = createServer((req, res) => {
      requests.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(
        req.url === "/api/todos/3"
          ? { n: 3, title: "Fix startup", state: "queued" }
          : { startup: "ready" }
      ))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing HTTP address")
      const origin = `http://127.0.0.1:${address.port}`
      const auth = join(home, "auth.json")
      await writeFile(auth, JSON.stringify({ api_url: origin, host: "127.0.0.1", token: "startup-secret" }), {
        mode: 0o600
      })
      const run = (args: Array<string>) =>
        new Promise<{ code: number | null; output: string; error: string }>(
          (resolve, reject) => {
            const child = spawn(process.execPath, ["--no-warnings", executable, ...args], {
              cwd: home,
              timeout: 60_000,
              env: {
                HOME: home,
                PATH: process.env.PATH,
                TMPDIR: process.env.TMPDIR,
                XDG_CONFIG_HOME: home,
                XDG_DATA_HOME: home,
                SMITHERS_API_ORIGIN: origin,
                SMITHERS_AUTH_FILE: auth,
                SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
                SMITHERS_AUDIENCE: "human"
              },
              stdio: ["ignore", "pipe", "pipe"]
            })
            let output = "", error = ""
            child.stdout.on("data", (chunk) => output += chunk)
            child.stderr.on("data", (chunk) => error += chunk)
            child.on("error", reject)
            child.on("close", (code) => resolve({ code, output, error }))
          }
        )
      const help = await run(["--help"])
      expect(help.code, help.output + help.error).toBe(0)
      expect(help.output).toContain("todo")
      expect(help.output).toContain("host")
      // Appendix B.6 omits saved environments from install docs and discovery.
      expect(help.output).not.toContain("environment")
      expect(requests).toEqual([])
      const environmentHelp = await run(["environment", "list", "--help"])
      expect(environmentHelp.code, environmentHelp.output + environmentHelp.error).toBe(0)
      expect(environmentHelp.output).toContain("Usage: smthrs environment list")
      expect(requests).toEqual([])
      const environments = await run(["environment", "list", "--format=json"])
      expect(environments.code, environments.output + environments.error).toBe(0)
      expect(JSON.parse(environments.output)).toEqual([])
      expect(requests).toEqual([])
      const todo = await run(["todo", "show", "T3", "--format=json"])
      expect(todo.code, todo.output + todo.error).toBe(0)
      expect(JSON.parse(todo.output)).toEqual({ n: 3, title: "Fix startup", state: "queued" })
      expect(requests).toEqual([{ method: "GET", path: "/api/todos/3", authorization: "token startup-secret" }])
      const api = await run(["api", "/api/startup", "--format=json"])
      expect(api.code, api.output + api.error).toBe(0)
      expect(JSON.parse(api.output)).toEqual({ startup: "ready" })
      expect(requests).toEqual([
        { method: "GET", path: "/api/todos/3", authorization: "token startup-secret" },
        { method: "GET", path: "/api/startup", authorization: "token startup-secret" }
      ])
      expect([help, environmentHelp, environments, todo, api].map((result) => result.output + result.error).join(""))
        .not.toContain("startup-secret")
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})
