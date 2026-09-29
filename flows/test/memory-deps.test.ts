import { NodeServices } from "@effect/platform-node"
import { Smithers as S } from "@smthrs/targets"
import { Effect, type FileSystem, type Path } from "effect"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { declared, directory, fetchBounded, importDeclared, importDocs, maxDocBytes, TooLarge } from "../memory/deps.ts"

type Platform = FileSystem.FileSystem | Path.Path
const run = <A, E>(effect: Effect.Effect<A, E, Platform>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const failure = <A, E>(effect: Effect.Effect<A, E, Platform>) =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(NodeServices.layer))) as Promise<
    { code: string; message: string }
  >

const repository = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memory-deps-")))
  await mkdir(join(root, "node_modules", "@scope", "lib", "docs"), { recursive: true })
  await writeFile(join(root, "node_modules", "@scope", "lib", "package.json"), JSON.stringify({ version: "1.2.3" }))
  await writeFile(join(root, "node_modules", "@scope", "lib", "README.md"), "# lib\n\nUse lib.start().\n")
  await writeFile(join(root, "node_modules", "@scope", "lib", "docs", "api.md"), "# API\n")
  return root
}

const bytes = (text: string) => new TextEncoder().encode(text)
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")
const targets = new URL(import.meta.resolve("@smthrs/targets")).href
const workspace = (docs: string, extra = "") =>
  `import { Smithers as S } from ${JSON.stringify(targets)}
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.91" })],
  docs: ${docs}
})
${extra}`

test("a package's files are copied from the installed version with a pinned receipt", async (t) => {
  const root = await repository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const imported = await run(
    importDocs(root, { lib: S.Docs.Package("@scope/lib", { files: ["README.md", "docs/api.md"] }) })
  )
  assert.deepEqual(imported, [{ name: "lib", files: ["README.md", "docs__api.md"], pin: "@scope/lib@1.2.3" }])
  const base = join(root, directory, "lib")
  assert.equal(await readFile(join(base, "README.md"), "utf8"), "# lib\n\nUse lib.start().\n")
  const receipt = JSON.parse(await readFile(join(base, "source.json"), "utf8"))
  assert.equal(receipt.pin, "@scope/lib@1.2.3")
  assert.equal(receipt.files[0].sha256, sha("# lib\n\nUse lib.start().\n"))
})

test("a URL is imported only when its bytes hash to the declared digest", async (t) => {
  const root = await repository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const text = "# Guide\n"
  const fetched: Array<string> = []
  const fetchBytes = async (url: string) => (fetched.push(url), bytes(text))
  const good = S.Docs.Url("https://example.com/docs/guide", { sha256: sha(text) })
  assert.deepEqual(await run(importDocs(root, { guide: good }, fetchBytes)), [
    { name: "guide", files: ["guide.md"], pin: `sha256:${sha(text)}` }
  ])
  assert.deepEqual(fetched, ["https://example.com/docs/guide"])
  const wrong = S.Docs.Url("https://example.com/guide.md", { sha256: "0".repeat(64) })
  const refused = await failure(importDocs(root, { guide: wrong }, fetchBytes))
  assert.equal(refused.code, "digest")
  // The failed import wrote nothing: the earlier, verified page is still there.
  assert.equal(await readFile(join(root, directory, "guide", "guide.md"), "utf8"), text)
  const down = await failure(importDocs(root, { guide: good }, async () => {
    throw new Error("offline")
  }))
  assert.equal(down.code, "fetch")
  const huge = "x".repeat(maxDocBytes + 1)
  const big = await failure(
    importDocs(root, { big: S.Docs.Url("https://example.com/big.md", { sha256: sha(huge) }) }, async () => bytes(huge))
  )
  assert.equal(big.code, "too_large")
})

test("an undeclared source's directory is removed and a missing package or file is refused", async (t) => {
  const root = await repository()
  t.after(() => rm(root, { recursive: true, force: true }))
  await run(importDocs(root, { lib: S.Docs.Package("@scope/lib"), old: S.Docs.Package("@scope/lib") }))
  await run(importDocs(root, { lib: S.Docs.Package("@scope/lib") }))
  assert.deepEqual(await readdir(join(root, directory)), ["lib"])
  assert.equal((await failure(importDocs(root, { gone: S.Docs.Package("absent") }))).code, "missing")
  assert.equal(
    (await failure(importDocs(root, { lib: S.Docs.Package("@scope/lib", { files: ["NOPE.md"] }) }))).code,
    "missing"
  )
  await writeFile(join(root, "node_modules", "@scope", "lib", "BIG.md"), "y".repeat(maxDocBytes + 1))
  assert.equal(
    (await failure(importDocs(root, { lib: S.Docs.Package("@scope/lib", { files: ["BIG.md"] }) }))).code,
    "too_large"
  )
})

test("the declared record is read from .smithers/WORKSPACE.ts, and a repository without one declares nothing", async (t) => {
  const root = await repository()
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await run(declared(root)), {})
  assert.deepEqual(await run(importDeclared(root)), [])
  await mkdir(join(root, ".smithers"))
  await writeFile(join(root, ".smithers", "WORKSPACE.ts"), workspace(`{ lib: S.Docs.Package("@scope/lib") }`))
  assert.deepEqual(await run(importDeclared(root)), [{ name: "lib", files: ["README.md"], pin: "@scope/lib@1.2.3" }])
  // Each read evaluates the file afresh: an edit is seen without a restart.
  await writeFile(
    join(root, ".smithers", "WORKSPACE.ts"),
    workspace(`{ api: S.Docs.Package("@scope/lib", { files: ["docs/api.md"] }) }`)
  )
  assert.deepEqual(Object.keys(await run(declared(root))), ["api"])
  // The loader every smthrs verb uses refuses a module exporting two declarations.
  await writeFile(
    join(root, ".smithers", "WORKSPACE.ts"),
    workspace("{}", "export const Second = Workspace\n")
  )
  assert.equal((await failure(declared(root))).code, "workspace")
  // A declaration that does not evaluate is refused, not read as "no docs".
  const broken = await repository()
  t.after(() => rm(broken, { recursive: true, force: true }))
  await mkdir(join(broken, ".smithers"))
  await writeFile(join(broken, ".smithers", "WORKSPACE.ts"), "throw new Error('broken')\n")
  assert.equal((await failure(declared(broken))).code, "workspace")
})

test("the import re-checks every declaration and never reads outside node_modules/<package>", async (t) => {
  const root = await repository()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "secret.md"), "secret")
  const forged = [
    { _tag: "DocsPackage", package: "../..", files: ["secret.md"] },
    { _tag: "DocsPackage", package: "@scope/lib", files: ["../../../secret.md"] },
    { _tag: "DocsPackage", package: "@scope/lib", files: ["a\r/../../../../secret.md"] },
    { _tag: "DocsUrl", url: "http://example.com/a.md", sha256: "0".repeat(64) },
    { _tag: "Other" }
  ]
  for (const source of forged) {
    const refused = await failure(importDocs(root, { x: source as never }, async () => bytes("never")))
    assert.equal(refused.code, "invalid", JSON.stringify(source))
  }
  // A symlink inside the package that points out of it is refused on its real path.
  await symlink(join(root, "secret.md"), join(root, "node_modules", "@scope", "lib", "LINK.md"))
  const linked = await failure(importDocs(root, { lib: S.Docs.Package("@scope/lib", { files: ["LINK.md"] }) }))
  assert.equal(linked.code, "invalid")
  await assert.rejects(readdir(join(root, directory)), "a refused import writes nothing")
})

test("a package linked from elsewhere, as pnpm installs it, is read through its real path", async (t) => {
  const root = await repository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = join(root, "node_modules", ".pnpm", "linked@2.0.0", "node_modules", "linked")
  await mkdir(store, { recursive: true })
  await writeFile(join(store, "package.json"), JSON.stringify({ version: "2.0.0" }))
  await writeFile(join(store, "README.md"), "# linked\n")
  await symlink(store, join(root, "node_modules", "linked"))
  assert.deepEqual(await run(importDocs(root, { linked: S.Docs.Package("linked") })), [
    { name: "linked", files: ["README.md"], pin: "linked@2.0.0" }
  ])
})

test("a manifest without JSON or a version, and files that flatten to one name, are refused", async (t) => {
  const root = await repository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = join(root, "node_modules", "@scope", "lib", "package.json")
  for (const text of ["{not json", JSON.stringify({ name: "@scope/lib" }), JSON.stringify({ version: "" })]) {
    await writeFile(manifest, text)
    assert.equal((await failure(importDocs(root, { lib: S.Docs.Package("@scope/lib") }))).code, "missing", text)
  }
  await writeFile(manifest, JSON.stringify({ version: "1.2.3" }))
  await mkdir(join(root, "node_modules", "@scope", "lib", "a"))
  await writeFile(join(root, "node_modules", "@scope", "lib", "a", "b.md"), "nested")
  await writeFile(join(root, "node_modules", "@scope", "lib", "a__b.md"), "flat")
  await writeFile(join(root, "node_modules", "@scope", "lib", "readme.md"), "lower")
  for (const files of [["a/b.md", "a__b.md"], ["README.md", "readme.md"]]) {
    const refused = await failure(importDocs(root, { lib: S.Docs.Package("@scope/lib", { files }) }))
    assert.equal(refused.code, "invalid", files.join())
  }
  // A directory named like a Markdown file is not a document.
  await mkdir(join(root, "node_modules", "@scope", "lib", "dir.md"))
  assert.equal(
    (await failure(importDocs(root, { lib: S.Docs.Package("@scope/lib", { files: ["dir.md"] }) }))).code,
    "missing"
  )
})

test("a URL's verified bytes are written unchanged, even when they are not UTF-8", async (t) => {
  const root = await repository()
  t.after(() => rm(root, { recursive: true, force: true }))
  const latin1 = Uint8Array.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a])
  const source = S.Docs.Url("https://example.com/cafe.md", { sha256: sha(latin1) })
  await run(importDocs(root, { cafe: source }, async () => latin1))
  const written = await readFile(join(root, directory, "cafe", "cafe.md"))
  assert.deepEqual(new Uint8Array(written), latin1)
  const receipt = JSON.parse(await readFile(join(root, directory, "cafe", "source.json"), "utf8"))
  assert.equal(receipt.files[0].sha256, sha(latin1))
  // A fetcher's TooLarge is reported as too_large, not as a failed fetch.
  const refused = await failure(importDocs(root, { cafe: source }, async () => {
    throw new TooLarge("big")
  }))
  assert.equal(refused.code, "too_large")
})

const serve = async (t: { after: (f: () => unknown) => void }, handler: Parameters<typeof createServer>[1]) => {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  t.after(() => server.closeAllConnections())
  const address = server.address()
  return `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`
}

test("fetchBounded answers a small body and refuses an error status", async (t) => {
  const url = await serve(t, (request, response) => {
    if (request.url === "/missing") return void response.writeHead(404).end()
    response.end("# ok\n")
  })
  assert.deepEqual(await fetchBounded(`${url}/ok.md`), bytes("# ok\n"))
  await assert.rejects(fetchBounded(`${url}/missing`), /answered 404/)
})

test("fetchBounded refuses a declared oversize body and stops streaming one at the limit", async (t) => {
  let streamed = 0
  let closed = false
  const url = await serve(t, (request, response) => {
    if (request.url === "/declared") {
      response.writeHead(200, { "content-length": String(maxDocBytes + 1) })
      return void response.end("x".repeat(maxDocBytes + 1))
    }
    // No content-length: chunks until the client hangs up.
    response.writeHead(200)
    response.on("close", () => {
      closed = true
    })
    const chunk = "y".repeat(64 * 1024)
    const pump = () => {
      while (!closed && streamed < 64 * maxDocBytes) {
        streamed += chunk.length
        if (!response.write(chunk)) return void response.once("drain", pump)
      }
      response.end()
    }
    pump()
  })
  await assert.rejects(fetchBounded(`${url}/declared`), TooLarge)
  await assert.rejects(fetchBounded(`${url}/streamed`), TooLarge)
  // The client read at most one chunk past the limit plus socket buffers, not the 64x body.
  assert.ok(streamed < 32 * maxDocBytes, `server wrote ${streamed} bytes`)
})

test("fetchBounded gives up on a server that never answers", async (t) => {
  const url = await serve(t, () => undefined)
  await assert.rejects(fetchBounded(`${url}/stall`, 200), (error: Error) => error.name === "TimeoutError")
})
