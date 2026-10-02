import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { day, get, readNote, resolveNote, writeNote } from "../notes/note.ts"

const workspace = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shared-notes-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test("shared note writer preserves Markdown and atomically replaces it without temporary debris", async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, "memory"))
  const path = await resolveNote(root, "memory/decisions.md")
  assert.equal(typeof path, "string")
  assert.equal(await readNote(path as string), "")
  const original = "# Decisions\n\nKeep repository wiki as the source of truth.\n"
  await writeNote(path as string, original)
  assert.equal(await readNote(path as string), original)
  const updated = `${original}\n- Verified ordinary review flow.\n`
  await writeNote(path as string, updated)
  assert.equal(await readNote(path as string), updated)
  assert.deepEqual(await readdir(join(root, "memory")), ["decisions.md"])
})

test("shared note resolution refuses escaping paths and symlinks without changing outside files", async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await writeFile(join(outside, "secret.md"), "private")
  await symlink(outside, join(root, "escape"), "dir")
  await symlink(join(outside, "secret.md"), join(root, "alias.md"))
  await mkdir(join(root, "directory.md"))
  const cases = [
    "",
    "/tmp/outside.md",
    "../secret.md",
    "note.txt",
    "bad\n.md",
    "missing/note.md",
    "escape/secret.md",
    "alias.md",
    "directory.md"
  ]
  for (const note of cases) {
    assert.equal(typeof await resolveNote(root, note), "object", note)
  }
  assert.equal(await readNote(join(outside, "secret.md")), "private")
  await assert.rejects(readNote(join(root, "directory.md")))
})

test("shared HTTP reader performs bounded GETs and keeps upstream failures out of notes", async (t) => {
  const seen: string[] = []
  const huge = "x".repeat(5 * 1024 * 1024 + 1)
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    if (request.url === "/failed") {
      response.writeHead(503)
      response.end("secret upstream response")
    } else if (request.url === "/huge") {
      response.writeHead(200, { "content-length": huge.length })
      response.end(huge)
    } else if (request.url === "/chunked-huge") {
      response.writeHead(200)
      response.end(huge)
    } else {
      response.writeHead(200)
      response.end("repository notes")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const host = { root: await workspace(t), fetch: globalThis.fetch, now: () => new Date() }
  assert.deepEqual(await get(host, base, "text/plain"), { ok: true, text: "repository notes" })
  assert.deepEqual(await get(host, `${base}/failed`, "text/plain"), { ok: false, reason: "HTTP 503" })
  assert.deepEqual(await get(host, `${base}/huge`, "text/plain"), { ok: false, reason: "response too large" })
  assert.deepEqual(await get(host, `${base}/chunked-huge`, "text/plain"), { ok: false, reason: "response too large" })
  assert.deepEqual(await get(host, "http://127.0.0.1:0", "text/plain"), { ok: false, reason: "unreachable" })
  assert.equal(seen.every((request) => request.startsWith("GET ")), true)
})

test("shared note dates retain timezone boundaries", () => {
  const instant = new Date("2026-10-01T00:30:00Z")
  assert.equal(day(instant, "UTC"), "2026-10-01")
  assert.equal(day(instant, "America/Los_Angeles"), "2026-09-30")
})
