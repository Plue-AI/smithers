import { Cli } from "incur"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

describe("common command verbosity", () => {
  it("declares a false-default boolean on every executable canonical and backend leaf", () => {
    const visit = (tree: NonNullable<ReturnType<typeof Cli.toCommands.get>>, path: string) => {
      for (const [name, entry] of tree) {
        if ("_group" in entry) visit(entry.commands, `${path} ${name}`)
        else if ("run" in entry) {
          expect(entry.options?.shape.verbose, `${path} ${name}`).toBeDefined()
          expect(entry.options!.shape.verbose.parse(undefined), `${path} ${name}`).toBe(false)
          expect(entry.options!.shape.verbose.parse(true), `${path} ${name}`).toBe(true)
        }
      }
    }
    visit(Cli.toCommands.get(makeCli() as never)!, "smthrs")
  })

  it(
    "advertises help/schema and exposes safe backend detail only for explicit verbosity through the executable",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "smithers-verbosity-"))
      let requests = 0
      const server = createServer((_req, res) => {
        requests++
        res.writeHead(503, { "content-type": "application/json", "x-request-id": "verbose-req-7" })
        res.end(JSON.stringify({ message: "Restarting Authorization: Bearer synthetic-verbose-secret" }))
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("Missing HTTP address")
        const origin = `http://127.0.0.1:${address.port}`
        const auth = join(home, "auth.json")
        await writeFile(
          auth,
          JSON.stringify({ api_url: origin, host: "127.0.0.1", token: "synthetic-verbose-secret" }),
          {
            mode: 0o600
          }
        )
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
        for (const path of [["flow", "start"], ["api"]]) {
          const help = await run([...path, "--help"])
          expect(help.code, help.output + help.error).toBe(0)
          expect(help.output).toContain("--verbose")
          const schema = await run([...path, "--schema", "--format=json"])
          expect(schema.code, schema.output + schema.error).toBe(0)
          expect(JSON.parse(schema.output).options.properties.verbose).toMatchObject({
            type: "boolean",
            default: false
          })
        }
        expect(requests).toBe(0)
        for (const flag of [[], ["--verbose=false"], ["--header=x-opaque:--verbose"], ["--verbose"]]) {
          const result = await run(["api", "/api/verbosity", "--format=json", ...flag])
          expect(result.code, result.output + result.error).toBe(1)
          expect(JSON.parse(result.output)).toMatchObject({
            code: "backend_unavailable",
            message: expect.stringContaining("Restarting")
          })
          expect(result.output + result.error).not.toContain("synthetic-verbose-secret")
          expect(result.output).not.toContain("-> 503")
          if (flag[0] === "--verbose") {
            expect(result.error).toContain("GET /api/verbosity -> 503")
            expect(result.error).toContain("verbose-req-7")
          } else expect(result.error).toBe("")
        }
        expect(requests).toBe(4)
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        for (const flag of [[], ["--verbose=false"], ["--verbose"]]) {
          const result = await run(["repo", "list", "--format=json", ...flag])
          expect(result.code, result.output + result.error).toBe(1)
          expect(JSON.parse(result.output)).toMatchObject({
            code: "backend_unavailable",
            message: expect.stringContaining("Check api_origin and your connection")
          })
          expect(result.output).not.toContain("ECONNREFUSED")
          expect(result.output + result.error).not.toContain("synthetic-verbose-secret")
          if (flag[0] === "--verbose") expect(result.error).toContain("ECONNREFUSED")
          else expect(result.error).toBe("")
        }
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(home, { recursive: true, force: true })
      }
    },
    360_000
  )
})
