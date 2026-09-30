import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

interface Seen {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly body: unknown
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/**
 * A real HTTP backend holding one repository's egress policy the way
 * `GET/PUT /api/repos/{owner}/{repo}/egress-policy` does: PUT stores the list
 * lower-cased and sorted and answers each running sandbox's reload.
 */
const backend = async (options: { status?: number; sandboxes?: Array<string>; domains?: Array<string> } = {}) => {
  const seen: Array<Seen> = []
  let domains = [...(options.domains ?? [])]
  const server = createServer((req: IncomingMessage, res) => {
    let text = ""
    req.on("data", (chunk) => text += chunk)
    req.on("end", () => {
      const body = text ? JSON.parse(text) : undefined
      seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, body })
      res.setHeader("content-type", "application/json")
      if (options.status !== undefined) {
        res.statusCode = options.status
        res.end(JSON.stringify({ message: "repository owner access required" }))
        return
      }
      if (req.url !== "/api/repos/acme/app/egress-policy") {
        res.statusCode = 404
        res.end(JSON.stringify({ message: "not found" }))
        return
      }
      if (req.method === "PUT") {
        domains = [...new Set((body.allow_domains as Array<string>).map((d) => d.toLowerCase()))].sort()
        res.end(JSON.stringify({
          allow_domains: domains,
          updated_at: "2026-09-30T12:00:00Z",
          reloads: (options.sandboxes ?? []).map((id) => ({ sandbox_id: id, reloaded: true }))
        }))
        return
      }
      res.end(
        JSON.stringify({ allow_domains: domains, ...(domains.length ? { updated_at: "2026-09-30T11:00:00Z" } : {}) })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = await mkdtemp(join(tmpdir(), "egress-cli-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  await writeFile(
    env.SMITHERS_AUTH_FILE,
    JSON.stringify({ api_url: origin, host: "127.0.0.1", token: "owner-login" }),
    {
      mode: 0o600
    }
  )
  const run = async (args: Array<string>) => {
    let output = "", code = 0
    const cli = makeCli({ environment: env, exit: (value) => void (code = value) })
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = env.XDG_DATA_HOME
    try {
      await cli.serve([...args, "--repo", "acme/app", "--json"], {
        env,
        stdout: (text) => void (output += text),
        exit: (value) => void (code = value)
      })
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previous
    }
    return { output, code }
  }
  return { seen, run }
}

const POLICY = "/api/repos/acme/app/egress-policy"
const read = { method: "GET", url: POLICY, authorization: "token owner-login", body: undefined }

describe("smthrs egress", () => {
  it("lists the repository's allowlist", async () => {
    const b = await backend({ domains: ["api.example.com"] })
    const result = await b.run(["egress", "list"])
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(result.output)).toEqual({
      allow_domains: ["api.example.com"],
      updated_at: "2026-09-30T11:00:00Z"
    })
    expect(b.seen).toEqual([read])
  })

  it("allows a host by writing the list with it added, and reports each sandbox's reload", async () => {
    const b = await backend({ domains: ["registry.npmjs.org"], sandboxes: ["sb-1", "sb-2"] })
    const result = await b.run(["egress", "allow", " API.Example.com. "])
    expect(result.code, result.output).toBe(0)
    expect(b.seen).toEqual([
      read,
      { ...read, method: "PUT", body: { allow_domains: ["registry.npmjs.org", "api.example.com"] } }
    ])
    expect(JSON.parse(result.output)).toEqual({
      allow_domains: ["api.example.com", "registry.npmjs.org"],
      updated_at: "2026-09-30T12:00:00Z",
      reloads: [{ sandbox_id: "sb-1", reloaded: true }, { sandbox_id: "sb-2", reloaded: true }]
    })
  })

  it("writes an already allowed host's list unchanged, so the running sandboxes reload it", async () => {
    const b = await backend({ domains: ["*.example.com"], sandboxes: ["sb-1"] })
    const result = await b.run(["egress", "allow", "*.EXAMPLE.com"])
    expect(result.code, result.output).toBe(0)
    expect(b.seen).toEqual([read, { ...read, method: "PUT", body: { allow_domains: ["*.example.com"] } }])
    expect(JSON.parse(result.output).reloads).toEqual([{ sandbox_id: "sb-1", reloaded: true }])
  })

  it("denies an allowed host by writing the list without it; the last one empties the list", async () => {
    const b = await backend({ domains: ["a.example.com", "b.example.com"] })
    expect((await b.run(["egress", "deny", "A.example.com"])).code).toBe(0)
    const last = await b.run(["egress", "deny", "b.example.com"])
    expect(last.code, last.output).toBe(0)
    expect(JSON.parse(last.output).allow_domains).toEqual([])
    expect(b.seen).toEqual([
      read,
      { ...read, method: "PUT", body: { allow_domains: ["b.example.com"] } },
      read,
      { ...read, method: "PUT", body: { allow_domains: [] } }
    ])
  })

  it("refuses to deny a host that is not allowed, without writing", async () => {
    const b = await backend({ domains: ["a.example.com"] })
    const result = await b.run(["egress", "deny", "other.example.com"])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("other.example.com is not on the allowlist")
    expect(b.seen).toEqual([read])
  })

  it("refuses an empty host before any request", async () => {
    const b = await backend()
    for (const verb of ["allow", "deny"]) {
      const result = await b.run(["egress", verb, " . "])
      expect(result.code).not.toBe(0)
      expect(result.output).toContain("A host is required")
    }
    expect(b.seen).toEqual([])
  })

  it("surfaces the backend's refusal to a caller who is not the owner", async () => {
    const b = await backend({ status: 403 })
    for (const args of [["egress", "list"], ["egress", "allow", "api.example.com"]]) {
      const result = await b.run(args)
      expect(result.code).not.toBe(0)
      expect(result.output).toContain("repository owner access required")
    }
    expect(b.seen).toEqual([read, read])
  })
})
