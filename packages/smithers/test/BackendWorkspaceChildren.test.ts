import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import { guest, workspaceChildren } from "../src/internal/backend/WorkspaceChildren.ts"

interface Seen {
  method: string
  url: string
  authorization: string | undefined
  body: unknown
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step()
})

// A real HTTP backend that records every request and answers its path.
const backend = async () => {
  const seen: Array<Seen> = []
  const server: Server = createServer((req: IncomingMessage, res) => {
    let text = ""
    req.on("data", (chunk) => text += chunk)
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, body: text ? JSON.parse(text) : undefined })
      res.setHeader("content-type", "application/json")
      res.statusCode = req.method === "POST" && req.url!.endsWith("/children") ? 202 : 200
      res.end(JSON.stringify({ url: req.url }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())))
  return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const machine = async (origin: string, files: { config?: string; token?: string } = {}) => {
  const home = await mkdtemp(join(tmpdir(), "children-cli-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const config = join(home, "workspace-coding.json")
  if (files.config !== undefined) await writeFile(config, files.config)
  if (files.token !== undefined) {
    await mkdir(join(home, ".config/smithers"), { recursive: true })
    await writeFile(join(home, guest.token), files.token)
  }
  return new Client({
    environment: {
      HOME: home,
      SMITHERS_API_ORIGIN: origin,
      SMITHERS_TOKEN: "owner-login",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      SMITHERS_WORKSPACE_CODING_CONFIG: config
    }
  })
}

const parent = "0f8fad5b-d9cb-469f-a165-70867728950e"
const coding = (origin: string) =>
  JSON.stringify({ workspaceId: parent, repositorySlug: "alice/demo", apiBaseUrl: `${origin}/api` })

describe("workspace children", () => {
  it("uses the workspace's own credential inside the workspace", async () => {
    const { seen, origin } = await backend()
    const c = await machine("http://unused.invalid", { config: coding(origin), token: "children-credential\n" })
    await workspaceChildren["workspace children spawn"]!(c, {}, { count: 3, profile: "build", ttl: 600 })
    await workspaceChildren["workspace children list"]!(c, {}, {})
    await workspaceChildren["workspace children stop"]!(c, { child: "c/1" }, { workspace: parent.toUpperCase() })
    expect(seen).toEqual([
      { method: "POST", url: `/api/repos/alice/demo/workspaces/${parent}/children`, authorization: "token children-credential", body: { count: 3, profile: "build", ttl_secs: 600 } },
      { method: "GET", url: `/api/repos/alice/demo/workspaces/${parent}/children`, authorization: "token children-credential", body: undefined },
      { method: "POST", url: `/api/repos/alice/demo/workspaces/${parent.toUpperCase()}/children/c%2F1/stop`, authorization: "token children-credential", body: undefined }
    ])
  })

  it("uses the signed-in account for another workspace or repository", async () => {
    const { seen, origin } = await backend()
    const c = await machine(origin, { config: coding("http://unused.invalid"), token: "children-credential" })
    await workspaceChildren["workspace children spawn"]!(c, {}, { count: 1, workspace: "other" })
    await workspaceChildren["workspace children list"]!(c, {}, { repo: "bob/site", workspace: parent })
    expect(seen.map(({ url, authorization, body }) => ({ url, authorization, body }))).toEqual([
      { url: "/api/repos/alice/demo/workspaces/other/children", authorization: "token owner-login", body: { count: 1 } },
      { url: `/api/repos/bob/site/workspaces/${parent}/children`, authorization: "token owner-login", body: undefined }
    ])
  })

  it("needs a workspace outside one", async () => {
    const { origin } = await backend()
    for (const files of [{}, { config: "not json", token: "t" }, { config: "{}", token: "t" }, { config: coding(origin) }]) {
      const c = await machine(origin, files)
      await expect(workspaceChildren["workspace children list"]!(c, {}, { repo: "alice/demo" })).rejects.toThrow("--workspace is required")
      await expect(workspaceChildren["workspace children list"]!(c, {}, {})).rejects.toThrow()
    }
  })

  it("reads the guest's own identity file by default", async () => {
    const c = new Client({ environment: { HOME: tmpdir(), SMITHERS_DISABLE_SYSTEM_KEYRING: "1" } })
    await expect(workspaceChildren["workspace children list"]!(c, {}, {})).rejects.toThrow("--workspace is required")
    expect(guest.config).toBe("/etc/smithers/workspace-coding.json")
  })

  it("refuses a count that is not a positive whole number", async () => {
    const { seen, origin } = await backend()
    const c = await machine(origin, { config: coding(origin), token: "t" })
    for (const value of [0, -1, 1.5, "x"]) {
      await expect(workspaceChildren["workspace children spawn"]!(c, {}, { count: value })).rejects.toThrow("--count")
    }
    expect(seen).toEqual([])
  })
})
