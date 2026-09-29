/** The signed-in Cloud session another host reads with: the CLI's token and origin, sent as the CLI sends them. */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as CloudSession from "../src/CloudSession.ts"

const servers: Array<() => void> = []
afterEach(() => {
  for (const close of servers.splice(0)) close()
})
const origin = async (reply: (path: string, auth: string | undefined) => { status: number; body: unknown }) => {
  const server = createServer((request, response) => {
    const { status, body } = reply(request.url ?? "", request.headers.authorization)
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const home = () => mkdtempSync(join(tmpdir(), "cloud-session-"))

describe("CloudSession.signedIn", () => {
  it("GETs a path as the signed-in person, with the token the CLI sends", async () => {
    const at = await origin((path, auth) => ({ status: 200, body: { path, auth } }))
    const cloud = await CloudSession.signedIn({
      HOME: home(),
      XDG_CONFIG_HOME: home(),
      SMITHERS_API_ORIGIN: at,
      SMITHERS_TOKEN: "tok_1"
    })
    expect(cloud?.origin).toBe(at)
    expect(await cloud!.get("/api/repos/o/r/mythical", new AbortController().signal)).toEqual({
      path: "/api/repos/o/r/mythical",
      auth: "token tok_1"
    })
  })

  it("is undefined without an origin or a login, and a refused read names its status", async () => {
    expect(await CloudSession.signedIn({ HOME: home(), XDG_CONFIG_HOME: home(), SMITHERS_TOKEN: "tok_1" }))
      .toBeUndefined()
    const at = await origin(() => ({ status: 403, body: {} }))
    expect(await CloudSession.signedIn({ HOME: home(), XDG_CONFIG_HOME: home(), SMITHERS_API_ORIGIN: at }))
      .toBeUndefined()
    const cloud = await CloudSession.signedIn({
      HOME: home(),
      XDG_CONFIG_HOME: home(),
      SMITHERS_API_ORIGIN: at,
      SMITHERS_TOKEN: "t"
    })
    await expect(cloud!.get("/api/x")).rejects.toThrow("/api/x: HTTP 403")
  })

  it("never sends the token to another host, and refuses redirects", async () => {
    const at = await origin((path) => ({ status: 200, body: { path } }))
    const cloud = await CloudSession.signedIn({
      HOME: home(),
      XDG_CONFIG_HOME: home(),
      SMITHERS_API_ORIGIN: at,
      SMITHERS_TOKEN: "t"
    })
    await expect(cloud!.get("@evil.example/x")).rejects.toThrow("Not a Cloud API path")
    await expect(cloud!.get("//evil.example/x")).rejects.toThrow("Not a Cloud API path")
  })
})

describe("CloudSession.repository", () => {
  it("names owner/name from a git remote, and nothing without one", () => {
    const dir = home()
    execFileSync("git", ["init", "-q", dir])
    expect(CloudSession.repository(dir, process.env)).toBeUndefined()
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/smithersai/smithers.git"])
    expect(CloudSession.repository(dir, process.env)).toBe("smithersai/smithers")
    execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "/srv/git/acme/secret-project.git"])
    expect(CloudSession.repository(dir, process.env)).toBeUndefined()
  })
})
