import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { APP_BOOTSTRAP_PATH, AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import { EXTERNAL_LAUNCH_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import type { AgentLauncher } from "./AgentLaunch"
import { startLocalServer, type LocalServerOptions } from "./server"

// #3736, condition 1: even an injected launcher cannot enter an install composition.
const modes: Array<[string, Partial<LocalServerOptions>]> = [
  ["install-connected", { backendApi: "http://127.0.0.1:9", cloudMode: "offline" }],
  ["hybrid", { backendApi: null, cloudMode: "hybrid", cloudApi: null, identityUpstream: null }],
  ["hybrid install-connected", { backendApi: "http://127.0.0.1:9", cloudMode: "hybrid", cloudApi: null, identityUpstream: null }],
  ["environment-configured install", { cloudMode: "offline" }],
  ["local preview", { backendApi: null, cloudMode: "offline" }]
]
for (const [mode, options] of modes) test(`${mode}: route and bootstrap agree on launcher availability`, async () => {
  const dist = await mkdtemp(join(tmpdir(), "smithers-launch-composition-"))
  const savedBackend = Bun.env.SMITHERS_BACKEND_API
  let calls = 0
  const launcher: AgentLauncher = {
    agents: ["codex", "claude-code"], admission: () => 0,
    launch: async agent => { calls++; return { agent, session: "fixture" } },
    revoke: async transition => transition(), stopAll: async () => {}, dispose: async () => {}
  }
  const preview = mode === "local preview"
  try {
    Bun.env.SMITHERS_BACKEND_API = "http://127.0.0.1:9"
    await writeFile(join(dist, "index.html"), "<!doctype html><div id=root></div>")
    const server = await startLocalServer({ port: 0, distDir: dist, stateDir: dist,
      log: () => {}, agentLauncher: launcher, ...options })
    try {
      const headers = { [LOCAL_SESSION_HEADER]: server.sessionToken, origin: server.origin, "content-type": "application/json" }
      const response = await fetch(`${server.origin}${EXTERNAL_LAUNCH_PATH}`, {
        method: "POST", headers, body: JSON.stringify({ agent: "codex", prompt: "fixture" })
      })
      expect(response.status).toBe(preview ? 200 : 404)
      expect(calls).toBe(preview ? 1 : 0)
      if (!preview) expect(await response.json()).toMatchObject({ error: { code: "not_found" } })
      const bootstrap = AppBootstrapSchema.parse(await (await fetch(`${server.origin}${APP_BOOTSTRAP_PATH}`, { headers })).json())
      for (const capability of ["launch.codex", "launch.claude-code"] as const) {
        expect(bootstrap.capabilities.includes(capability)).toBe(preview)
      }
    } finally { await server.stop() }
  } finally {
    if (savedBackend === undefined) delete Bun.env.SMITHERS_BACKEND_API
    else Bun.env.SMITHERS_BACKEND_API = savedBackend
    await rm(dist, { recursive: true, force: true })
  }
})

const sources = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(root, entry.name))
    : /\.(?:tsx?|go)$/.test(entry.name) && !/\.test\.|_test\.go$|test-support/.test(entry.name) ? [join(root, entry.name)] : []))).flat()
}

test("app source never constructs a host launcher outside the local composition", async () => {
  const root = resolve(import.meta.dir, "..")
  const references: string[] = []
  for (const path of await sources(root)) {
    if (path === join(root, "bun/AgentLaunch.ts")) continue
    const source = await readFile(path, "utf8")
    // Catch imports (including aliases), direct calls and namespace access to the factory.
    if (/import\s+(?!type\b)(?:\{[^}]*\}|[\w* ,]+)\s+from\s*["'][^"']*\/AgentLaunch["']|\bagentLauncher\s*\(/.test(source)) references.push(relative(root, path))
  }
  expect(references).toEqual([])
  const composition = await readFile(join(root, "bun/server.ts"), "utf8")
  expect(composition).toContain("const launcher = localPreview ? options.agentLauncher : undefined")
})

test("install network composition registers no host launch route or bootstrap capability", async () => {
  const root = resolve(import.meta.dir, "../../../..", "packages/backend/internal/compose")
  const router = await readFile(join(root, "router.go"), "utf8")
  // 5391e0e43e removed owner-home transcript reads from the install.
  expect(router).not.toMatch(/external\/sessions|ExternalSessions/)
  for (const path of await sources(root)) {
    const source = await readFile(path, "utf8")
    expect(source).not.toMatch(/external\/launch|launch\.codex|launch\.claude-code/)
  }
})
