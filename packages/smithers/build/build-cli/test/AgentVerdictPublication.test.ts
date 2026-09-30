import * as ChildProcess from "node:child_process"
import { once } from "node:events"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import type * as Reporter from "../src/Reporter.ts"
import { executionPresentation } from "./fixtures/presentation.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const terminal = (writeText: (text: string) => void): Reporter.Terminal => ({
  write: writeText,
  isTTY: false,
  columns: undefined
})

const run = async (root: string, target: string | ReadonlyArray<string>, cacheUrl: string | undefined) => {
  let exitCode = 0
  let logs = ""
  const environment = { ...process.env, SMTHRS_AGENT_FAKE: "fake.json", SMITHERS_CACHE_TOKEN: "local-test-token" }
  await makeCli({
    ...(cacheUrl === undefined ? {} : { cacheUrl }),
    cacheToken: "local-test-token",
    environment,
    presentation: executionPresentation,
    stdout: terminal(() => undefined),
    stderr: terminal((text) => {
      logs += text
    })
  }).serve([...normalizeArgv(typeof target === "string" ? [target] : target), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: () => undefined
  })
  return { exitCode, logs }
}

const skipped = "smthrs: remote cache publication skipped: "
const occurrences = (logs: string, text: string): number => logs.split(text).length - 1

const spawnCount = async (root: string): Promise<number> => {
  const log = await Fs.readFile(Path.join(root, "fake.json.spawns.jsonl"), "utf8").catch(() => "")
  return log.split("\n").filter(Boolean).length
}

describe("unconfined agent verdict publication", () => {
  it(
    "keeps agent and shell results local, reuses a local verdict, and runs a fresh agent after clearing it",
    async () => {
      const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-verdict-publication-")))
      roots.push(root)
      await write(
        root,
        "WORKSPACE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  agents: S.Agents({ default: S.Agent.Codex({ model: "luna" }) }),
})
`
      )
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const agent = S.Agent.Diff({
  prompt: S.file("//prompt.md"), data: [S.file("src/input.ts")],
  changes: ["src/**"], gates: [], sandbox: "none", maxRounds: 1
})
const shell = S.Shell.Test({ shell: "true", sandbox: "none" })
const other = S.Shell.Test({ shell: "exit 0", sandbox: "none" })
export const Package = S.Package({ targets: { agent, shell, other } })
`
      )
      await write(root, "package.json", "{}\n")
      await write(root, "yarn.lock", "\n")
      await write(root, "prompt.md", "Review the input.\n")
      await write(root, "src/input.ts", "export const value = 1\n")
      await write(
        root,
        "fake.json",
        JSON.stringify({
          identity: "fake",
          responses: [
            { purpose: "diff", edits: [] },
            { purpose: "diff", edits: [] }
          ]
        })
      )
      ChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
      ChildProcess.execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"])
      ChildProcess.execFileSync("git", ["-C", root, "config", "user.name", "Test"])
      ChildProcess.execFileSync("git", ["-C", root, "add", "-A"])
      ChildProcess.execFileSync("git", ["-C", root, "commit", "-qm", "initial"])

      const requests: Array<{ method: string | undefined; path: string | undefined }> = []
      const published = new Map<string, string>()
      const server = Http.createServer(async (request, response) => {
        const chunks: Array<Buffer> = []
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        requests.push({ method: request.method, path: request.url })
        const path = request.url ?? ""
        if (request.method === "PUT") {
          published.set(path, Buffer.concat(chunks).toString("utf8"))
          response.writeHead(201).end()
        } else if (request.method === "GET" && published.has(path)) {
          response.writeHead(200, { "content-type": "application/json" }).end(published.get(path))
        } else {
          response.writeHead(404).end()
        }
      })
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      try {
        const address = server.address()
        if (address === null || typeof address === "string") throw new Error("cache server did not bind")
        const cacheUrl = `http://127.0.0.1:${address.port}/cache`

        const shell = await run(root, ["test", "//:shell", "//:other"], cacheUrl)
        expect(shell.exitCode, shell.logs).toBe(0)
        expect(requests.some(({ method }) => method === "GET")).toBe(true)
        expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(0)
        // The publisher says why nothing reached the remote, once per run.
        expect(occurrences(shell.logs, skipped), shell.logs).toBe(1)
        expect(shell.logs).toMatch(/smthrs: remote cache publication skipped: \/\/:(shell|other) ran unconfined/)
        expect(shell.logs).toMatch(/\/\/:shell {2}ran/)
        expect(shell.logs).toMatch(/\/\/:other {2}ran/)

        requests.length = 0
        const first = await run(root, "//:agent", cacheUrl)
        expect(first.exitCode, first.logs).toBe(0)
        expect(await spawnCount(root)).toBe(1)
        expect(requests.some(({ method, path }) => method === "GET" && path?.startsWith("/cache/ac/agent-verdict-")))
          .toBe(true)
        expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(0)
        expect(occurrences(first.logs, skipped), first.logs).toBe(1)
        expect(first.logs).toContain(`${skipped}//:agent ran unconfined`)

        requests.length = 0
        const local = await run(root, "//:agent", cacheUrl)
        expect(local.exitCode, local.logs).toBe(0)
        expect(local.logs).toContain("(cached verdict)")
        expect(await spawnCount(root)).toBe(1)
        expect(requests).toHaveLength(0)

        await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
        requests.length = 0
        const fresh = await run(root, "//:agent", cacheUrl)
        expect(fresh.exitCode, fresh.logs).toBe(0)
        expect(fresh.logs).not.toContain("(cached verdict)")
        expect(await spawnCount(root)).toBe(2)
        expect(requests.some(({ method, path }) => method === "GET" && path?.startsWith("/cache/ac/agent-verdict-")))
          .toBe(true)
        expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(0)

        // Without a remote there is nothing to skip, so nothing is said.
        await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
        const offline = await run(root, "//:shell", undefined)
        expect(offline.exitCode, offline.logs).toBe(0)
        expect(offline.logs).not.toContain(skipped)
      } finally {
        server.close()
        await once(server, "close")
      }
    },
    120_000
  )
})
