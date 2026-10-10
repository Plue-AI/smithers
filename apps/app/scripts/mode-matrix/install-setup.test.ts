import { afterEach, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { anchorTarget, fakeManifestURL, InstallBrowser, setCookiePair, waitStep } from "./install-setup"

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

/** A loopback backend that answers each request with `handle`; answers its origin. */
const backend = async (handle: (request: IncomingMessage, body: string, response: ServerResponse) => void): Promise<string> => {
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    handle(request, body, response)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

test("the install browser reaches the private backend under the public host and refuses a foreign one with 421", async () => {
  const seen: Array<{ host?: string; path?: string }> = []
  const origin = await backend((request, _body, response) => {
    seen.push({ host: request.headers["x-forwarded-host"] as string, path: request.url })
    if (request.headers["x-forwarded-host"] !== "127.0.0.1:49001") return void response.writeHead(421).end('{"code":"unknown_origin"}')
    response.end("{}")
  })
  expect((await new InstallBrowser(origin, "http://127.0.0.1:49001").request("GET", "/api/install?x=1")).status).toBe(200)
  expect((await new InstallBrowser(origin, "http://127.0.0.1:49002").request("GET", "/api/install")).status).toBe(421)
  expect(seen).toEqual([{ host: "127.0.0.1:49001", path: "/api/install?x=1" }, { host: "127.0.0.1:49002", path: "/api/install" }])
})

test("the install browser keeps the install's cookies and echoes its CSRF cookie on writes only", async () => {
  const seen: Array<{ method?: string; cookie?: string; csrf?: string; origin?: string; type?: string; body: string }> = []
  const origin = await backend((request, body, response) => {
    seen.push({ method: request.method, cookie: request.headers.cookie, csrf: request.headers["x-csrf-token"] as string,
      origin: request.headers.origin, type: request.headers["content-type"], body })
    if (request.url === "/setup?token=t") {
      response.setHeader("Set-Cookie", ["smithers_setup_session=setup; Path=/; HttpOnly", "__csrf=token; Path=/"])
      return void response.writeHead(303, { Location: "/" }).end()
    }
    if (request.url === "/signed-out") {
      response.setHeader("Set-Cookie", "smithers_setup_session=; Path=/; Max-Age=0")
      return void response.end()
    }
    response.end()
  })
  const browser = new InstallBrowser(origin, "http://127.0.0.1:49001")
  const redirect = await browser.request("GET", "/setup?token=t")
  expect(redirect).toEqual({ status: 303, text: "", location: "/" })
  expect(browser.cookie("__csrf")).toBe("token")
  await browser.request("GET", "/api/install")
  await browser.request("POST", "/api/install/setup/address", { bind: "127.0.0.1:4000" })
  await browser.request("GET", "/signed-out")
  await browser.request("GET", "/api/install")
  expect(seen).toEqual([
    { method: "GET", body: "" },
    { method: "GET", cookie: "smithers_setup_session=setup; __csrf=token", body: "" },
    { method: "POST", cookie: "smithers_setup_session=setup; __csrf=token", csrf: "token", origin: "http://127.0.0.1:49001",
      type: "application/json", body: '{"bind":"127.0.0.1:4000"}' },
    { method: "GET", cookie: "smithers_setup_session=setup; __csrf=token", body: "" },
    { method: "GET", cookie: "__csrf=token", body: "" }
  ])
})

test("the install browser refuses a link that leaves the install origin and names an unexpected status", async () => {
  const origin = await backend((_request, _body, response) => void response.writeHead(409).end("previous step"))
  const browser = new InstallBrowser(origin, "http://127.0.0.1:49001")
  await expect(browser.request("GET", "https://github.com/login")).rejects.toThrow("leaves the install origin")
  await expect(browser.expect("POST", "/api/install/setup/source", 202, {})).rejects.toThrow("answered 409, not 202: previous step")
})

test("a Set-Cookie header yields its name and value, and nothing for a malformed pair", () => {
  expect(setCookiePair("smithers_session=0790-ab; Path=/; HttpOnly; SameSite=Lax")).toEqual(["smithers_session", "0790-ab"])
  expect(setCookiePair("__csrf=a=b; Path=/")).toEqual(["__csrf", "a=b"])
  expect(setCookiePair("gone=; Max-Age=0")).toEqual(["gone", ""])
  expect(setCookiePair("=value")).toBeUndefined()
  expect(setCookiePair("novalue")).toBeUndefined()
})

test("a provider page's labelled link is found and its escaped target decoded", () => {
  const page = '<p><a href="http://127.0.0.1:49001/api/auth/github/callback?code=a&amp;state=b">Authorize</a></p>' +
    '<p><a href="http://127.0.0.1:49001/api/auth/github/callback?code=c&amp;state=b">Authorize as ben</a></p>'
  expect(anchorTarget(page, "Authorize")).toBe("http://127.0.0.1:49001/api/auth/github/callback?code=a&state=b")
  expect(anchorTarget(page, "Authorize as ben")).toBe("http://127.0.0.1:49001/api/auth/github/callback?code=c&state=b")
  expect(() => anchorTarget(page, "Create GitHub App")).toThrow('offers no "Create GitHub App" link')
})

test("GitHub's manifest page maps to the fake's, for a user and an organization, and nothing else does", () => {
  expect(fakeManifestURL("https://github.com/settings/apps/new?state=s", "http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000/settings/apps/new?state=s")
  expect(fakeManifestURL("https://github.com/organizations/acme/settings/apps/new", "http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000/organizations/acme/settings/apps/new")
  expect(() => fakeManifestURL("https://evil.example/settings/apps/new", "http://127.0.0.1:5000")).toThrow("unexpected GitHub page")
  expect(() => fakeManifestURL("https://github.com/login", "http://127.0.0.1:5000")).toThrow("unexpected GitHub page")
})

test("a setup step is waited for until done, and a failed step or the deadline fails the walk with its reason", async () => {
  const states = ["running", "running", "done"]
  const origin = await backend((request, _body, response) => {
    const sourceState = request.url === "/api/install" ? states.shift() ?? "done" : "done"
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ steps: [{ id: "source", state: sourceState }, { id: "models", state: "failed", error: { code: "key_refused" } }, { id: "machine", state: "pending" }] }))
  })
  const browser = new InstallBrowser(origin, "http://127.0.0.1:49001")
  await waitStep(browser, "source", 5_000)
  expect(states).toEqual([])
  await expect(waitStep(browser, "models", 5_000)).rejects.toThrow('setup step models failed: {"code":"key_refused"}')
  await expect(waitStep(browser, "machine", 300)).rejects.toThrow("setup step machine is still pending after 300 ms")
})
