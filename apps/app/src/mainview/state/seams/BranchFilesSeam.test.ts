import { describe, expect, test } from "bun:test"
import { createFilesSeam, BRANCH_FILE_PROVIDERS, type BranchFileOptions } from "./FilesSeam"
import type { SeamContext } from "./SeamContext"
import type { FileCard } from "@smthrs/rpc/FileCard"

const writer = { kind: "person", login: "maya", name: "Maya", avatar_url: "https://example.com/maya.png", color_index: 1 } as const
const file = (digest = "one", text = "first\n"): FileCard => ({
  branch: "scratch/maya/demo", path: "src/deliver.ts", language: "typescript", digest,
  content: { kind: "text", text }, mode: "read_only", diagnostics: [], authors: [], editors: []
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const fixture = (http: SeamContext["http"], options?: BranchFileOptions) => createFilesSeam({
  http, store: {}, baseUrl: "", isDisposed: () => false
} as SeamContext, options).branchFiles
const scope = { branch: "scratch/maya/demo", member: "maya", revision: 1, sleeping: false }
const ready: BranchFileOptions = { ready: () => true, scope: () => scope }

describe("dark branch file operations", () => {
  test("missing activation and every missing provider refuse before HTTP", async () => {
    let requests = 0
    for (const missing of [undefined, ...BRANCH_FILE_PROVIDERS]) {
      const seam = fixture(async () => { requests++; return json(file()) }, missing === undefined ? undefined : {
        ...ready, ready: provider => provider !== missing
      })
      expect(await seam.read(scope.branch, file().path)).toEqual({ error: "Branch files are unavailable." })
      expect(await seam.restore(file("current"), { version: "burst-17", post_digest: "one" })).toEqual({ error: "Branch files are unavailable." })
      expect(await seam.compare(file(), "burst-17")).toEqual({ error: "Branch files are unavailable." })
    }
    expect(requests).toBe(0)
  })
  test("removed membership, cross-branch and unsafe paths refuse without effects", async () => {
    let requests = 0
    const http = async () => { requests++; return json(file()) }
    expect(await fixture(http, { ...ready, scope: () => null }).read(scope.branch, file().path)).toHaveProperty("error")
    const seam = fixture(http, ready)
    for (const path of ["../secret", "%2e%2e/secret", "/etc/passwd", "src/%2Fsecret", ""]) expect(await seam.read(scope.branch, path)).toHaveProperty("error")
    expect(await seam.read("foreign", file().path)).toHaveProperty("error")
    expect(requests).toBe(0)
  })
  test("digest reads are read-only, scoped and preserve literal bytes", async () => {
    const calls: string[] = []
    const seam = fixture(async url => { calls.push(url); return json({ ...file("two", "résumé\n"), mode: "live" }) }, ready)
    expect(await seam.read(scope.branch, file().path, "two")).toEqual({ ok: file("two", "résumé\n") })
    expect(calls).toEqual(["/api/branches/scratch%2Fmaya%2Fdemo/files/src/deliver.ts?digest=two"])
  })
  test("other paths and unchanged digest do nothing; current write keeps its actor", async () => {
    let requests = 0
    const seam = fixture(async () => { requests++; return json(file("two", "new\n")) }, ready)
    expect(await seam.reload(file(), { path: "other.ts", post_digest: "two", actor: writer })).toBeUndefined()
    expect(await seam.reload(file(), { path: file().path, post_digest: "one", actor: writer })).toBeUndefined()
    expect(requests).toBe(0)
    expect(await seam.reload(file(), { path: file().path, post_digest: "two", actor: writer })).toEqual({ ok: { ...file("two", "new\n"), last_writer: writer } })
    await seam.reload(file(), { path: file().path, post_digest: "two", actor: writer })
    expect(requests).toBe(1)
  })
  test("an older delayed response cannot replace the newer digest", async () => {
    let finish!: (response: Response) => void
    const seam = fixture(async url => url.endsWith("digest=two") ? new Promise(resolve => { finish = resolve }) : json(file("three", "latest\n")), ready)
    const old = seam.read(scope.branch, file().path, "two")
    expect(await seam.read(scope.branch, file().path, "three")).toEqual({ ok: file("three", "latest\n") })
    finish(json(file("two", "old\n")))
    expect(await old).toHaveProperty("error")
  })
  test("revocation during a read discards its response", async () => {
    let active = true
    const seam = fixture(async () => { active = false; return json(file()) }, { ...ready, scope: () => active ? scope : null })
    expect(await seam.read(scope.branch, file().path)).toHaveProperty("error")
  })
  test("sleeping reads use capture; restores never wake or write", async () => {
    const calls: string[] = []
    const seam = fixture(async url => { calls.push(url); return json(file()) }, { ...ready, scope: () => ({ ...scope, sleeping: true, capturedHead: "captured-7" }) })
    expect(await seam.read(scope.branch, file().path)).toEqual({ ok: file() })
    expect(await seam.restore(file("current"), { version: "burst-17", post_digest: "one" })).toEqual({ error: "The branch is asleep." })
    expect(calls).toEqual(["/api/branches/scratch%2Fmaya%2Fdemo/files/src/deliver.ts?at=captured-7"])
  })
  test("restore supplies the burst post digest; stale opens Compare once without overwrite", async () => {
    const calls: Array<[string, unknown]> = []
    const seam = fixture(async (url, init) => {
      calls.push([url, init?.body ? JSON.parse(String(init.body)) : null])
      return init?.method === "POST" ? json({ error: { code: "stale" } }, 409) : json({ before: "old\n", current: "new\n" })
    }, ready)
    expect(await seam.restore(file("current"), { version: "versions-17", post_digest: "one" })).toEqual({ compare: { before: "old\n", current: "new\n" } })
    expect(calls).toEqual([
      ["/api/branches/scratch%2Fmaya%2Fdemo/files/src/deliver.ts", { action: "restore", version: "versions-17", base_digest: "one" }],
      ["/api/branches/scratch%2Fmaya%2Fdemo/files/src/deliver.ts?compare=versions-17", null]
    ])
  })
  test("deleted Restore sends absent; 409 reads the recreated file without retry", async () => {
    const methods: string[] = []
    const seam = fixture(async (_url, init) => {
      methods.push(init?.method ?? "GET")
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ action: "restore-deleted", version: "versions-delete", base_digest: "absent" })
        return json({ error: { code: "stale" } }, 409)
      }
      return json(file("recreated", "someone else's bytes\n"))
    }, ready)
    expect(await seam.restore(file("current"), { version: "versions-delete", post_digest: "one" }, true)).toEqual({ ok: file("recreated", "someone else's bytes\n") })
    expect(methods).toEqual(["POST", "GET"])
  })
  test("Follow reads the rename destination; hostile destinations refuse", async () => {
    const calls: string[] = []
    const seam = fixture(async url => { calls.push(url); return json({ ...file(), path: "src/shipped.ts" }) }, ready)
    expect(await seam.follow({ ...file(), gone: { kind: "renamed", to: "src/shipped.ts", by: writer } })).toHaveProperty("ok.path", "src/shipped.ts")
    expect(await seam.follow({ ...file(), gone: { kind: "renamed", to: "../secret", by: writer } })).toHaveProperty("error")
    expect(calls).toEqual(["/api/branches/scratch%2Fmaya%2Fdemo/files/src/shipped.ts"])
  })
  test("malformed, foreign-path, foreign-branch and wrong-digest responses never project", async () => {
    for (const body of [{}, { ...file(), branch: "foreign" }, { ...file(), path: "other.ts" }, file("wrong")]) {
      expect(await fixture(async () => json(body), ready).read(scope.branch, file().path, "one")).toHaveProperty("error")
    }
  })
  test("50 writes leave the final literal bytes and digest current", async () => {
    const seam = fixture(async url => {
      const digest = new URL(url, "http://localhost").searchParams.get("digest")!
      return json(file(digest, `${digest}\n`))
    }, ready)
    let current = file()
    for (let i = 1; i <= 50; i++) {
      const answer = await seam.reload(current, { path: current.path, post_digest: `write-${i}`, actor: writer })
      if (answer && "ok" in answer) current = answer.ok
    }
    expect(current.digest).toBe("write-50")
    expect(current.content).toEqual({ kind: "text", text: "write-50\n" })
  })
  test("successful Restore reads the resulting bytes once; failures never retry", async () => {
    for (const status of [200, 403, 500]) {
      const methods: string[] = []
      const seam = fixture(async (_url, init) => {
        methods.push(init?.method ?? "GET")
        return init?.method === "POST" ? json({}, status) : json(file("restored", "before bytes\n"))
      }, ready)
      const result = await seam.restore(file(), { version: "versions-17", post_digest: "one" })
      if (status === 200) {
        expect(result).toEqual({ ok: file("restored", "before bytes\n") })
        expect(methods).toEqual(["POST", "GET"])
      } else {
        expect(result).toHaveProperty("error")
        expect(methods).toEqual(["POST"])
      }
    }
  })
  test("network, invalid JSON and HTTP refusals return errors", async () => {
    for (const http of [async () => { throw Error("offline") }, async () => new Response("bad json"), async () => json({}, 403)]) {
      const seam = fixture(http, ready)
      expect(await seam.read(scope.branch, file().path)).toHaveProperty("error")
      expect(await seam.compare(file(), "versions-17")).toHaveProperty("error")
      expect(await seam.restore(file(), { version: "versions-17", post_digest: "one" })).toHaveProperty("error")
    }
  })
  test("sleep without a capture and Follow without a rename perform no requests", async () => {
    let requests = 0
    const seam = fixture(async () => { requests++; return json(file()) }, { ...ready, scope: () => ({ ...scope, sleeping: true }) })
    expect(await seam.read(scope.branch, file().path)).toHaveProperty("error")
    expect(await seam.compare(file(), "versions-17")).toHaveProperty("error")
    expect(await seam.follow(file())).toHaveProperty("error")
    expect(requests).toBe(0)
  })
  test("a failed reload can be retried, while provider withdrawal discards pending content", async () => {
    let attempts = 0
    let enabled = true
    const seam = fixture(async () => {
      attempts++
      if (attempts === 1) throw Error("offline")
      if (attempts === 3) enabled = false
      return json(file("two", "second\n"))
    }, { ...ready, ready: () => enabled })
    const event = { path: file().path, post_digest: "two", actor: writer }
    expect(await seam.reload(file(), event)).toHaveProperty("error")
    expect(await seam.reload(file(), event)).toHaveProperty("ok.digest", "two")
    expect(await seam.read(scope.branch, file().path)).toHaveProperty("error")
    expect(attempts).toBe(3)
  })

  test("sleep transitions do not reuse an awake reload result", async () => {
    let sleeping = false
    const calls: string[] = []
    const seam = fixture(async url => { calls.push(url); return json(file("two", "second\n")) }, {
      ...ready, scope: () => ({ ...scope, sleeping, ...(sleeping ? { capturedHead: "captured-7" } : {}) })
    })
    const event = { path: file().path, post_digest: "two", actor: writer }
    await seam.reload(file(), event)
    sleeping = true
    await seam.reload(file(), event)
    expect(calls).toEqual([
      "/api/branches/scratch%2Fmaya%2Fdemo/files/src/deliver.ts?digest=two",
      "/api/branches/scratch%2Fmaya%2Fdemo/files/src/deliver.ts?digest=two&at=captured-7"
    ])
  })

})
