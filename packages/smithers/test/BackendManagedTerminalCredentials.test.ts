import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"

// Map only the Linux guest root; descriptors, files, cache and HTTP are real.
const guest = vi.hoisted(() => ({ root: "" }))
vi.mock("node:fs", async actual => {
  const fs = await actual<typeof import("node:fs")>()
  return { ...fs, openSync: (path: string, flags: number) => fs.openSync(path === "/" ? guest.root : path, flags) }
})
const dispose: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close()
  guest.root = ""
})
it("pins HTTP authority to A across rotation, 401 and a readable copy of B's credential", async () => {
  guest.root = await mkdtemp(join(tmpdir(), "smithers-bound-terminal-"))
  const root = guest.root
  dispose.push(() => rm(root, { recursive: true, force: true }))
  const valid = new Map([["token synthetic-a", "a"], ["token synthetic-b", "b"]])
  const requests: Array<{ token: string; session: string }> = []
  let mutations = 0
  const server = createServer((request, response) => {
    const token = String(request.headers.authorization)
    const session = String(request.headers["smithers-terminal-session"])
    requests.push({ token, session })
    const accepted = valid.get(token) === session
    if (accepted && request.method === "POST") mutations++
    response.writeHead(accepted ? 200 : 401, { "content-type": "application/json" }).end("{}")
  })
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  dispose.push(() => new Promise<void>((done, failed) => server.close(error => error ? failed(error) : done())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No listener")
  const origin = `http://127.0.0.1:${address.port}`
  const file = (session: string) => join(root, "run/smithers/sessions", session, "token")
  for (const session of ["a", "b"]) {
    await mkdir(join(root, "run/smithers/sessions", session), { recursive: true })
    await writeFile(file(session), `synthetic-${session}\n`, { mode: 0o600 })
  }
  const client = (session: string) => new Client({ environment: { HOME: root, SMITHERS_URL: origin,
    SMITHERS_TERMINAL_SESSION: session, SMITHERS_TOKEN_FILE: `/run/smithers/sessions/${session}/token` } })
  const a = client("a"), b = client("b")
  await a.response("GET", "/probe")
  await b.response("GET", "/probe")
  valid.delete("token synthetic-a")
  valid.set("token synthetic-a2", "a")
  await writeFile(file("a"), "synthetic-a2\n")
  await writeFile(file("b"), "malformed token")
  await expect(a.response("POST", "/probe", {})).rejects.toMatchObject({ status: 401 })
  expect(requests).toHaveLength(3)
  expect(mutations).toBe(0)
  await a.response("GET", "/probe")
  await b.response("GET", "/probe")
  expect(requests.slice(-2)).toEqual([{ token: "token synthetic-a2", session: "a" }, { token: "token synthetic-b", session: "b" }])
  valid.delete("token synthetic-a2")
  await expect(a.response("POST", "/probe", {})).rejects.toMatchObject({ status: 401 })
  await writeFile(file("a"), "synthetic-b\n")
  await expect(a.response("POST", "/probe", {})).rejects.toMatchObject({ status: 401 })
  expect(requests.at(-1)).toEqual({ token: "token synthetic-b", session: "a" })
  expect(mutations).toBe(0)
})
