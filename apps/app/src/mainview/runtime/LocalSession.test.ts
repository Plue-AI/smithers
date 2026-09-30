import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { LOCAL_SESSION_HEADER, LOCAL_SESSION_META } from "@smthrs/rpc/LocalSession"
import { createAppFetch, localSocketProtocols } from "./LocalSession"

const TOKEN = "A".repeat(42) + "_"

describe("browser local-session transport", () => {
  test("reads only a valid injected token", () => {
    const child = spawnSync(process.execPath, ["--eval", `
      import assert from "node:assert/strict"
      import { GlobalRegistrator } from "@happy-dom/global-registrator"
      import { readLocalSessionToken, localSocketProtocols, createAppFetch } from "./src/mainview/runtime/LocalSession"
      GlobalRegistrator.register({ url: "http://127.0.0.1:4321/app" })
      try {
        assert.equal(readLocalSessionToken(document), undefined)
        assert.deepEqual(localSocketProtocols(), [])
        const meta = document.createElement("meta")
        meta.name = "smithers-local-session"
        document.head.append(meta)
        for (const value of ["", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + " "]) {
          meta.content = value
          assert.equal(readLocalSessionToken(document), undefined)
        }
        const token = "A".repeat(42) + "_"
        meta.content = token
        assert.equal(readLocalSessionToken(document), token)
        assert.equal(readLocalSessionToken(), token)
        assert.deepEqual(localSocketProtocols(), ["smithers.local." + token])
        const original = Object.getOwnPropertyDescriptor(globalThis, "fetch")
        const seen = []
        Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input, init) => {
          seen.push({ input, headers: new Headers(init?.headers) })
          return new Response(null, { status: 204 })
        } })
        try {
          await createAppFetch()("/api/probe")
          assert.equal(seen[0].headers.get("x-smithers-local-session"), token)
          meta.remove()
          await createAppFetch()("/api/no-token")
          assert.equal(seen[1].headers.has("x-smithers-local-session"), false)
          Object.defineProperty(globalThis, "location", { configurable: true, value: undefined })
          await createAppFetch({ token })("/api/no-location")
          assert.equal(seen[2].headers.has("x-smithers-local-session"), false)
        } finally {
          if (original) Object.defineProperty(globalThis, "fetch", original)
          else delete globalThis.fetch
        }
        console.log("owned DOM and default transport controls passed")
      } finally { await GlobalRegistrator.unregister() }
    `], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", timeout: 5000 })
    expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr }).toEqual({ status: 0, signal: null, error: undefined, stderr: "" })
    expect(child.stdout.trim()).toBe("owned DOM and default transport controls passed")
    expect(LOCAL_SESSION_META).toBe("smithers-local-session")
  })

  test("adds the token only to same-origin API calls", async () => {
    const seen: Array<{ readonly input: string; readonly headers: Headers }> = []
    const appFetch = createAppFetch({
      token: TOKEN,
      location: { href: "http://127.0.0.1:4321/app", origin: "http://127.0.0.1:4321" },
      fetchImpl: async (input, init) => {
        seen.push({ input: input.toString(), headers: new Headers(init?.headers) })
        return new Response(null, { status: 204 })
      }
    })
    await appFetch("/api/repos")
    await appFetch("https://smithers-cloud.test/api/repos")
    await appFetch("/assets/app.js")
    expect(seen[0]?.headers.get(LOCAL_SESSION_HEADER)).toBe(TOKEN)
    expect(seen[1]?.headers.has(LOCAL_SESSION_HEADER)).toBe(false)
    expect(seen[2]?.headers.has(LOCAL_SESSION_HEADER)).toBe(false)
    expect(localSocketProtocols(TOKEN)).toEqual([`smithers.local.${TOKEN}`])
  })
})

const origin = { href: "http://127.0.0.1:4321/app", origin: "http://127.0.0.1:4321" }
for (const [input, authorized] of [
  ["/api/repos", true], ["api/repos?next=other", true], ["/api/", true], ["/api", false], ["/apiary/repos", false],
  ["/assets/api/repos", false], ["https://127.0.0.1:4321/api/repos", false], ["//else.test/api/repos", false], ["http://[", false]
] as const) test(`local capability boundary for ${input}`, async () => {
  const init = { headers: { "x-request": "preserved" }, method: "POST", body: "literal body" }
  let captured: RequestInit | undefined
  const response = new Response(null, { status: 204 })
  const appFetch = createAppFetch({ token: TOKEN, location: origin, fetchImpl: async (received, options) => {
    expect(received).toBe(input)
    captured = options
    return response
  } })
  expect(await appFetch(input, init)).toBe(response)
  expect(new Headers(captured?.headers).get(LOCAL_SESSION_HEADER)).toBe(authorized ? TOKEN : null)
  expect(captured?.method).toBe("POST")
  expect(captured?.body).toBe("literal body")
  expect(new Headers(captured?.headers).get("x-request")).toBe("preserved")
  expect(init).toEqual({ headers: { "x-request": "preserved" }, method: "POST", body: "literal body" })
  if (!authorized) expect(captured).toBe(init)
})

for (const kind of ["URL", "Request"] as const) test(`${kind} inputs preserve request headers with init precedence and authoritative local capability`, async () => {
  const input = kind === "URL" ? new URL("/api/probe", origin.href) : new Request(new URL("/api/probe", origin.href), { method: "PUT", body: "request body", headers: { "x-original": "keep", "x-shared": "request", [LOCAL_SESSION_HEADER]: "old" } })
  const init = { method: "POST", body: "override body", headers: { "x-shared": "init", [LOCAL_SESSION_HEADER]: "caller" } }
  let effective: Request | undefined
  const appFetch = createAppFetch({ token: TOKEN, location: origin, fetchImpl: async (received, options) => {
    expect(received).toBe(input)
    effective = new Request(received, options)
    return new Response(null, { status: 204 })
  } })
  await appFetch(input, init)
  expect(effective?.method).toBe("POST")
  expect(await effective?.text()).toBe("override body")
  expect(effective?.headers.get("x-shared")).toBe("init")
  expect(effective?.headers.get(LOCAL_SESSION_HEADER)).toBe(TOKEN)
  expect(effective?.headers.get("x-original")).toBe(kind === "Request" ? "keep" : null)
  expect(init.headers[LOCAL_SESSION_HEADER]).toBe("caller")
  if (input instanceof Request) expect(input.headers.get(LOCAL_SESSION_HEADER)).toBe("old")
})

test("a Request without init retains its own method and body while gaining the local header", async () => {
  const input = new Request(new URL("/api/probe", origin.href), { method: "PUT", body: "original bytes", headers: { "x-original": "keep" } })
  let effective: Request | undefined
  const appFetch = createAppFetch({ token: TOKEN, location: origin, fetchImpl: async (received, options) => {
    expect(received).toBe(input)
    effective = new Request(received, options)
    return new Response(null, { status: 204 })
  } })
  await appFetch(input)
  expect(effective?.method).toBe("PUT")
  expect(await effective?.text()).toBe("original bytes")
  expect(effective?.headers.get("x-original")).toBe("keep")
  expect(effective?.headers.get(LOCAL_SESSION_HEADER)).toBe(TOKEN)
  expect(input.headers.has(LOCAL_SESSION_HEADER)).toBe(false)
})
