import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main, writeStorageState } from "./launch-mint-session.ts"

const workDir = join(mkdtempSync(join(tmpdir(), "launch-mint-session-")), "work")
beforeEach(() => mkdirSync(workDir, { recursive: true }))
afterEach(() => rmSync(workDir, { recursive: true, force: true }))

test("writeStorageState writes the cookie store readable only by the owner", () => {
  const outPath = join(workDir, "storage-state.json")
  writeStorageState(outPath, { cookies: [{ name: "session", value: "s3cret" }], origins: [] })
  // A Playwright storage state holds live session cookies; it must never be
  // group/world-readable even when the caller's umask is permissive.
  expect(statSync(outPath).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(outPath, "utf8")).cookies[0].value).toBe("s3cret")
})

const cookieValue = "s3cret-session-cookie-value"

test("writeStorageState replaces an existing public file with a private file", () => {
  const path = join(workDir, "existing.json")
  writeFileSync(path, "old", { mode: 0o644 })
  writeStorageState(path, { cookie: "secret" })
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("writeStorageState never follows an existing output symlink", () => {
  const target = join(workDir, "target")
  const path = join(workDir, "state.json")
  writeFileSync(target, "untouched")
  symlinkSync(target, path)
  writeStorageState(path, { cookie: "secret" })
  expect(readFileSync(target, "utf8")).toBe("untouched")
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

const startResponse = () =>
  new Response(null, {
    status: 302,
    headers: { location: "https://github.test/login/oauth/authorize?state=state-123" }
  })

const okFetch = () => {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("/api/auth/github/start")) return startResponse()
    if (url.includes("/api/auth/github/callback")) {
      return new Response(null, {
        status: 302,
        headers: { "set-cookie": `session=${cookieValue}; Path=/; HttpOnly; Max-Age=3600` }
      })
    }
    if (url.includes("/api/user")) return Response.json({ login: "fixture-user" })
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
  return { impl, calls }
}

test("main does not echo the session cookie when the set-cookie header is unparseable", async () => {
  const errors: string[] = []
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "))
  })
  try {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/auth/github/start")) return startResponse()
      if (url.includes("/api/auth/github/callback")) {
        // A header the parser rejects, carrying the cookie value.
        return new Response(null, { status: 302, headers: { "set-cookie": `=${cookieValue}` } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
    const code = await main(
      ["http://127.0.0.1:8861", "http://localhost:8788", join(workDir, "state.json")],
      fetchImpl
    )
    expect(code).toBe(1)
  } finally {
    errorSpy.mockRestore()
  }
  expect(errors.length).toBeGreaterThan(0)
  expect(errors.join("\n")).not.toContain(cookieValue)
})

test("main mints and proves a session, writing the storage state at mode 0600", async () => {
  const { impl, calls } = okFetch()
  const outPath = join(workDir, "mvp-storage-state.json")
  const code = await main(["http://127.0.0.1:8861", "http://localhost:8788", outPath], impl)
  expect(code).toBe(0)
  expect(calls.includes("http://127.0.0.1:8861/api/user")).toBe(true)
  expect(statSync(outPath).mode & 0o777).toBe(0o600)
  const stored = JSON.parse(readFileSync(outPath, "utf8"))
  expect(stored.cookies[0].name).toBe("session")
  expect(stored.cookies[0].value).toBe(cookieValue)
  expect(stored.cookies[0].httpOnly).toBe(true)
  expect(stored.cookies[0].expires).toBeGreaterThan(Math.floor(Date.now() / 1000))
})

test("main fails when the minted cookie does not validate", async () => {
  const { impl: base } = okFetch()
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/user")) return Response.json({})
    return base(input, init)
  }) as typeof fetch
  const code = await main(
    ["http://127.0.0.1:8861", "http://localhost:8788", join(workDir, "state.json")],
    fetchImpl
  )
  expect(code).toBe(1)
})