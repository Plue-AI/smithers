import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_BOOTSTRAP_PATH } from "@smthrs/rpc/AppBootstrap"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { browserTestOptions } from "../../scripts/browser-test-host"
import { startLocalServer, type LocalServerOptions } from "./server"

/*
 * T-AGT-02/T-AGT-03 (#3731 ruling b): a member's Codex or Claude Code session reaches the branch conversation only as
 * imported entries. The local preview that started agent CLIs on this host and served their raw transcripts is
 * deleted, so no composition answers its doors, advertises a launch capability or starts a process.
 */
const RETIRED: ReadonlyArray<readonly [method: string, path: string, body?: string]> = [
  ["POST", "/api/external/launch", JSON.stringify({ agent: "codex", prompt: "Fix the flaky test" })],
  ["POST", "/api/external/launch", JSON.stringify({ agent: "claude-code", prompt: "Fix the flaky test" })],
  ["DELETE", "/api/external/launch"],
  ["GET", "/api/external/sessions?agent=codex&session=0199aaaa&offset=0"],
  ["GET", "/api/external/sessions?agent=claude-code&session=5b2c&offset=0"],
  ["GET", "/api/external/codex?session=0199aaaa"]
]

const roots: string[] = []
const savedBackend = Bun.env.SMITHERS_BACKEND_API
afterEach(async () => {
  if (savedBackend === undefined) delete Bun.env.SMITHERS_BACKEND_API
  else Bun.env.SMITHERS_BACKEND_API = savedBackend
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A scratch root with a built page and an agent CLI that leaves a mark if anything ever starts it. */
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-retired-external-"))
  roots.push(root)
  const dist = join(root, "dist")
  await mkdir(dist)
  await writeFile(join(dist, "index.html"), "<!doctype html><div id=root></div>")
  const ran = join(root, "agent-cli-ran")
  const cli = join(root, "agent-cli.ts")
  await writeFile(cli, `await Bun.write(${JSON.stringify(ran)}, "ran")\n`)
  return { root, dist, cli, ran }
}

const compositions: ReadonlyArray<readonly [string, (root: string, dist: string, cli: string) => LocalServerOptions]> = [
  // The browser-test host was the one composition that ever held a launcher.
  ["browser-test host with agent CLIs", (root, dist, cli) => browserTestOptions(root, dist, { SMITHERS_E2E_CODEX_CLI: cli, SMITHERS_E2E_CLAUDE_CLI: cli })],
  ["local preview", (root, dist) => ({ port: 0, distDir: dist, stateDir: root, log: () => {}, backendApi: null, cloudMode: "offline" })],
  ["install-connected", (root, dist) => ({ port: 0, distDir: dist, stateDir: root, log: () => {}, backendApi: "http://127.0.0.1:9", cloudMode: "offline" })],
  ["environment-configured install", (root, dist) => {
    Bun.env.SMITHERS_BACKEND_API = "http://127.0.0.1:9"
    return { port: 0, distDir: dist, stateDir: root, log: () => {}, cloudMode: "offline" }
  }],
  ["hybrid", (root, dist) => ({ port: 0, distDir: dist, stateDir: root, log: () => {}, backendApi: null, cloudMode: "hybrid", cloudApi: null, identityUpstream: null })]
]

for (const [name, options] of compositions) test(`${name}: the retired agent launch and raw transcript doors answer 404 and start nothing`, async () => {
  const { root, dist, cli, ran } = await fixture()
  const server = await startLocalServer(options(root, dist, cli))
  try {
    const headers = { [LOCAL_SESSION_HEADER]: server.sessionToken, origin: server.origin, "content-type": "application/json" }
    for (const [method, path, body] of RETIRED) {
      const response = await fetch(`${server.origin}${path}`, { method, headers, ...(body === undefined ? {} : { body }) })
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 })
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } })
    }
    const bootstrap = await (await fetch(`${server.origin}${APP_BOOTSTRAP_PATH}`, { headers })).json() as { capabilities: string[] }
    expect(bootstrap.capabilities.filter(capability => capability.startsWith("launch."))).toEqual([])
    expect(existsSync(ran)).toBe(false)
  } finally { await server.stop() }
})
