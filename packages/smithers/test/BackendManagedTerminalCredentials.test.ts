import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"

// Only root ownership and the guest's fixed /run root are simulated. Actual
// descriptors, symlinks, modes, file reads and HTTP admission remain real.
const guest = vi.hoisted(() => ({ root: "", issuerDescriptors: new Set<number>() }))
vi.mock("node:fs", async (actual) => {
  const fs = await actual<typeof import("node:fs")>()
  return { ...fs,
    openSync: (path: string, flags: number) => {
      const fd = fs.openSync(path === "/" && guest.root ? guest.root : path, flags)
      if (path.endsWith("/issuer.json")) guest.issuerDescriptors.add(fd)
      return fd
    },
    fstatSync: (fd: number) => {
      const info = fs.fstatSync(fd)
      if (guest.issuerDescriptors.has(fd)) info.uid = 0
      return info
    },
    closeSync: (fd: number) => { guest.issuerDescriptors.delete(fd); fs.closeSync(fd) }
  }
})
const dispose: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const f of dispose.splice(0).reverse()) await f()
  guest.root = ""
  guest.issuerDescriptors.clear()
})
const fixture = async () => {
  guest.root = await mkdtemp(join(tmpdir(), "smithers-managed-"))
  const root = guest.root
  dispose.push(() => rm(root, { recursive: true, force: true }))
  let calls = 0
  const admitted = new Set<string>()
  const server = createServer((request, response) => {
    calls++
    response.writeHead(admitted.has(String(request.headers.authorization)) ? 200 : 401,
      { "content-type": "application/json" }).end("{}")
  })
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  dispose.push(() => new Promise<void>((done, failed) => server.close(error => error ? failed(error) : done())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No HTTP listener")
  const issuer = `http://127.0.0.1:${address.port}`
  const session = "terminal-a"
  const directory = join(root, "run/smithers/sessions", session)
  await mkdir(directory, { recursive: true, mode: 0o755 })
  const token = "synthetic-managed-a"
  const envelope = { version: 1, session_id: session, issuer,
    credential_identity: createHash("sha256").update(token).digest("hex") }
  const install = async (value = token, binding = envelope) => {
    await writeFile(join(directory, "token"), value + "\n", { mode: 0o600 })
    await writeFile(join(directory, "issuer.json"), JSON.stringify(binding), { mode: 0o644 })
  }
  await install()
  admitted.add(`token ${token}`)
  const environment = { HOME: root, SMITHERS_URL: issuer, SMITHERS_TERMINAL_SESSION: session,
    SMITHERS_TOKEN_FILE: `/run/smithers/sessions/${session}/token`, SMITHERS_TOKEN: "foreign-env-token" }
  return { issuer, token, envelope, install, directory, environment, admitted, calls: () => calls }
}
it("authenticates only the issuer's session file and freezes the bridge origin", async () => {
  const f = await fixture()
  const client = new Client({ environment: f.environment })
  expect((await client.response("GET", "/probe")).status).toBe(200)
  expect(f.calls()).toBe(1)
  await expect(client.response("POST", "/probe", {}, { origin: "http://127.0.0.1:9" }))
    .rejects.toMatchObject({ code: "token_file_unavailable" })
  expect(f.calls()).toBe(1)
  await expect(new Client({ environment: { ...f.environment, SMITHERS_API_ORIGIN: "http://127.0.0.1:9" } })
    .response("POST", "/probe", {})).rejects.toMatchObject({ code: "token_file_unavailable" })
  await expect(new Client({ environment: { ...f.environment, SMITHERS_TOKEN_FILE: join(f.directory, "token") } })
    .response("POST", "/probe", {})).rejects.toMatchObject({ code: "token_file_unavailable" })
  await expect(client.response("POST", "/probe", {}, { token: "foreign-explicit-token" }))
    .rejects.toMatchObject({ code: "token_file_unavailable" })
  await expect(client.response("POST", "/probe", {}, { headers: { Authorization: "token foreign-header-token" } }))
    .rejects.toMatchObject({ code: "token_file_unavailable" })
  await expect(new Client({ environment: { ...f.environment, SMITHERS_TERMINAL_SESSION: undefined } })
    .response("POST", "/probe", {})).rejects.toMatchObject({ code: "token_file_unavailable" })
  expect(f.calls()).toBe(1)
})
it.each(["session", "issuer", "identity", "version", "missing", "writable", "link", "invalid-json", "oversized"])("refuses a %s envelope before HTTP admission", async kind => {
  const f = await fixture()
  const binding = { ...f.envelope }
  if (kind === "session") binding.session_id = "terminal-b"
  if (kind === "issuer") binding.issuer = "http://127.0.0.1:9"
  if (kind === "identity") binding.credential_identity = "0".repeat(64)
  if (kind === "version") binding.version = 2
  await f.install(f.token, binding)
  if (kind === "missing") await rm(join(f.directory, "issuer.json"))
  if (kind === "writable") await chmod(join(f.directory, "issuer.json"), 0o666)
  if (kind === "invalid-json") await writeFile(join(f.directory, "issuer.json"), "{")
  if (kind === "oversized") await writeFile(join(f.directory, "issuer.json"), "x".repeat(1025))
  if (kind === "link") {
    await rm(join(f.directory, "issuer.json"))
    await symlink(join(f.directory, "token"), join(f.directory, "issuer.json"))
  }
  await expect(new Client({ environment: f.environment }).response("POST", "/probe", {}))
    .rejects.toMatchObject({ code: "token_file_unavailable" })
  expect(f.calls()).toBe(0)
})
it("rereads the same authenticated envelope after 401 without replaying the mutation", async () => {
  const f = await fixture()
  const client = new Client({ environment: f.environment })
  await client.response("GET", "/probe")
  f.admitted.clear()
  await expect(client.response("POST", "/probe", {})).rejects.toMatchObject({ status: 401 })
  expect(f.calls()).toBe(2)
  const replacement = "synthetic-managed-rotated"
  await f.install(replacement, { ...f.envelope, credential_identity: createHash("sha256").update(replacement).digest("hex") })
  f.admitted.add(`token ${replacement}`)
  await client.response("GET", "/probe")
  expect(f.calls()).toBe(3)
})
