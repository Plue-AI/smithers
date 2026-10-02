/** The signed-in Cloud session another host reads with: the CLI's token and origin, sent as the CLI sends them. */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Refused } from "../src/CliError.ts"
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
  it("preserves a typed uncertain refusal when the actual HTTP status is outside the schema bound", async () => {
    const at = await origin(() => ({ status: 999, body: {} }))
    const cloud = (await CloudSession.signedIn({
      HOME: home(),
      XDG_CONFIG_HOME: home(),
      SMITHERS_API_ORIGIN: at,
      SMITHERS_TOKEN: "tok_status"
    }))!
    const failure = await cloud.post("/api/todo", {}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Refused)
    expect(failure).toMatchObject({ fault: "infra", code: "cloud_request_failed", message: "/api/todo: HTTP 999" })
    expect(failure).not.toHaveProperty("httpStatus")
    expect(CloudSession.isAuthenticationRefusal(failure)).toBe(false)
  })

  it("carries the actual HTTP response status despite conflicting error-body metadata", async () => {
    let status = 401
    const at = await origin(() => ({
      status,
      body: {
        _tag: "/cli/Refused",
        code: "cloud_request_failed",
        fault: "user",
        httpStatus: 403,
        message: "HTTP 401",
        cause: { httpStatus: 401 }
      }
    }))
    const cloud = (await CloudSession.signedIn({
      HOME: home(),
      XDG_CONFIG_HOME: home(),
      SMITHERS_API_ORIGIN: at,
      SMITHERS_TOKEN: "tok_status"
    }))!
    for (status of [401, 403, 408, 409, 429, 503]) {
      const failure = await cloud.post("/api/todo", {}).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Refused)
      expect(failure).toMatchObject({ httpStatus: status, code: "cloud_request_failed" })
      expect(CloudSession.isAuthenticationRefusal(failure)).toBe(status === 401 || status === 403)
    }
  })

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
    await expect(cloud!.get("/api/x")).rejects.toMatchObject({
      _tag: "/cli/Refused",
      fault: "user",
      code: "cloud_request_failed",
      message: "/api/x: HTTP 403"
    })
  })

  it("refuses a body that is not JSON by path, never the parser's text", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<html>")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(() => server.close())
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const cloud = await CloudSession.signedIn({
      HOME: home(),
      XDG_CONFIG_HOME: home(),
      SMITHERS_API_ORIGIN: at,
      SMITHERS_TOKEN: "t"
    })
    await expect(cloud!.get("/api/x")).rejects.toMatchObject({
      _tag: "/cli/Refused",
      fault: "infra",
      code: "cloud_response_invalid",
      message: "/api/x: the response is not JSON"
    })
  })

  it("POSTs a JSON body as the signed-in person, and refuses a path off the origin or a refusal by status", async () => {
    const seen: Array<
      { method: string | undefined; type: string | undefined; auth: string | undefined; body: string }
    > = []
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        seen.push({
          method: request.method,
          type: request.headers["content-type"],
          auth: request.headers.authorization,
          body
        })
        response.writeHead(request.url === "/api/no" ? 403 : 201, { "content-type": "application/json" })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(() => server.close())
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const cloud = await CloudSession.signedIn({
      HOME: home(),
      XDG_CONFIG_HOME: home(),
      SMITHERS_API_ORIGIN: at,
      SMITHERS_TOKEN: "tok_2"
    })
    expect(await cloud!.post("/api/x", { title: "T", request: "r-1" })).toEqual({ ok: true })
    expect(seen).toEqual([{
      method: "POST",
      type: "application/json",
      auth: "token tok_2",
      body: "{\"title\":\"T\",\"request\":\"r-1\"}"
    }])
    await expect(cloud!.post("/api/no", {})).rejects.toMatchObject({ fault: "user", message: "/api/no: HTTP 403" })
    await expect(cloud!.post("//evil.example/x", {})).rejects.toThrow("Not a Cloud API path")
    expect(seen).toHaveLength(2)
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

describe("CloudSession.isAuthenticationRefusal", () => {
  const old = { _tag: "/cli/Refused", code: "cloud_request_failed", fault: "user", message: "HTTP 503" } as const
  it("preserves absent-status typed compatibility without reading diagnostics or nested causes", () => {
    expect(CloudSession.isAuthenticationRefusal(new Refused(old))).toBe(true)
    expect(CloudSession.isAuthenticationRefusal(old)).toBe(true)
    for (const httpStatus of [401, 403]) expect(CloudSession.isAuthenticationRefusal({ ...old, httpStatus })).toBe(true)
    const denied = new Refused({ ...old, httpStatus: 401 })
    const uncertain = new Refused({ ...old, fault: "infra", httpStatus: 503 })
    expect(CloudSession.isAuthenticationRefusal(Object.assign(uncertain, { cause: denied }))).toBe(false)
    expect(CloudSession.isAuthenticationRefusal(Object.assign(denied, { cause: uncertain }))).toBe(true)
    for (
      const failure of [
        ...[408, 409, 429, 503, undefined, null, "401", 401.5, NaN, Infinity, 99, 600].map((httpStatus) => ({
          ...old,
          httpStatus
        })),
        { ...old, fault: "infra" },
        { ...old, code: "other_refusal", httpStatus: 401 },
        new Error("HTTP 401", { cause: { ...old, httpStatus: 401 } }),
        { httpStatus: 401 },
        null,
        undefined,
        "HTTP 403"
      ]
    ) expect(CloudSession.isAuthenticationRefusal(failure)).toBe(false)
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
