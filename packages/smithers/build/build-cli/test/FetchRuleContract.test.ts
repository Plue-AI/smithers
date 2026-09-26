import { Smithers as S } from "@smthrs/targets"
import * as FetchTarget from "@smthrs/targets/Fetch"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as FetchExec from "../src/FetchExec.ts"
import * as FetchPlan from "../src/internal/rules/FetchPlan.ts"
import { contract } from "../src/internal/rules/FetchRule.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as Planner from "../src/Planner.ts"

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const body = (size: number) => Buffer.alloc(size, 0x61)
let root: string
let origin: string
let received: (() => void) | undefined
const server = createServer((request, response) => {
  const path = request.url ?? ""
  if (path === "/hold") {
    response.writeHead(200)
    response.write(body(1))
    received?.()
  } else if (path === "/missing") {
    response.writeHead(404)
    response.end()
  } else {
    const bytes = body(Number(path.split("/").at(-1)))
    if (path.startsWith("/chunked/")) response.writeHead(200, { "transfer-encoding": "chunked" })
    response.end(bytes)
  }
})
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-fetch-contract-")))
  vi.spyOn(Planner, "implementationFingerprint").mockResolvedValue("fetch-contract-fixture")
})
afterEach(async () => {
  received = undefined
  vi.restoreAllMocks()
  await Fs.rm(root, { recursive: true, force: true })
})

const planned = async (url: string, digest: string, out = "download.bin") => {
  const packageJson = S.file("//package.json")
  const target = S.Fetch({ url, sha256: digest, out })
  const index = PackageIndex.make({
    root,
    factory: undefined,
    workspace: S.Workspace("fixture", {
      repository: "git+https://example.invalid/fixture.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: ">=26.4.0" }),
      packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
      nodeModules: S.Npm.NodeModules({ packageJson })
    }),
    packages: [{ file: "data/PACKAGE.ts", packagePath: "data", value: S.Package({ targets: { download: target } }) }]
  })
  const plan = await PackageExec.plan({ index, cacheDirectory: ".flows", verb: "auto", patterns: ["//data:download"] })
  const node = plan.nodes.get("//data:download")!
  expect(node.refusal).toBeUndefined()
  if (node.family !== "fetch") throw new Error("expected the complete Fetch variant")
  return node
}

describe("Fetch planner boundary", () => {
  it("produces the complete exact variant without fetching", () => {
    expect(contract.plan({
      packagePath: "data",
      target: S.Fetch({ url: origin + "/bytes/3", sha256: sha(body(3)), out: "nested/a.bin" })
    })).toEqual({
      ok: true,
      value: {
        family: "fetch",
        rule: "Fetch",
        lane: { kind: "fetch", url: origin + "/bytes/3", sha256: sha(body(3)) },
        mode: "execute",
        declaredInputs: [],
        declaredOutputs: { cwd: ".", paths: ["nested/a.bin"] },
        serviceDeps: [],
        argv: undefined,
        bunTemplate: undefined,
        outDirs: [],
        outFiles: ["data/nested/a.bin"],
        sandbox: { network: true }
      }
    })
  })

  it.each([
    ["//a", "data", /must be package-relative/],
    ["../a", "data", /leaves the directory/],
    [".git/a", ".", /\.git/],
    ["nested\\a", "data", /Fetch output is invalid:/],
    ["a", "../outside", /leaves the directory/]
  ])("retains the refusal for output %s in %s", (out, packagePath, message) => {
    const attrs = { url: origin, sha256: sha(body(0)), out }
    const result = FetchPlan.planAttrs({ packagePath, attrs })
    expect(result).toEqual({ ok: false, refusal: expect.stringMatching(message) })
    expect(FetchExec.planAttrs({ packagePath, attrs })).toEqual({
      outFiles: [],
      sandbox: { network: true },
      refusal: expect.stringMatching(message)
    })
  })

  it.each([
    { url: "file:///etc/hosts", sha256: sha(body(0)), out: "a" },
    { url: "https://example.invalid/a", sha256: "not-a-digest", out: "a" },
    { url: "https://example.invalid/a", sha256: sha(body(0)), out: "../a" }
  ])("preserves schema validation before planned values exist", (attrs) => {
    expect(() => S.Fetch(attrs)).toThrow()
  })

  it("preserves the wrong-declaration refusal at the public adapter", () => {
    expect(() => contract.plan({ packagePath: "data", target: S.Filegroup({ srcs: [] }) }))
      .toThrow("expected a Fetch target")
  })
})

describe("exact Fetch execution", () => {
  it.each([0, 1, 9])(
    "agrees with the declaration adapter for %i bytes and never rereads the declaration",
    async (size) => {
      const bytes = body(size)
      const node = await planned(origin + "/bytes/" + size, sha(bytes))
      const exact = {
        ...node,
        get declaration(): never {
          throw new Error("execution reread a declaration")
        }
      }
      const result = await contract.execute(exact, { root, signal: undefined })
      const publicResult = await FetchExec.execute({ root, target: node.declaration, outFile: "data/public.bin" })
      expect(result).toEqual({ bytes: size, sha256: sha(bytes) })
      expect(publicResult).toEqual(result)
      for (const name of ["download.bin", "public.bin"]) {
        expect(await Fs.readFile(Path.join(root, "data", name))).toEqual(bytes)
        expect((await Fs.stat(Path.join(root, "data", name))).mode & 0o777).toBe(0o644)
      }
      expect((await Fs.readdir(Path.join(root, "data"))).sort()).toEqual(["download.bin", "public.bin"])
    }
  )

  it.each(["length", "chunked"])("enforces the byte limit at N-1, N and N+1 for %s responses", async (encoding) => {
    for (const size of [7, 8, 9]) {
      const bytes = body(size)
      const target = FetchTarget.Fetch({ url: origin + "/" + encoding + "/" + size, sha256: sha(bytes), out: "a" })
      await Fs.mkdir(Path.join(root, "data"), { recursive: true })
      await Fs.writeFile(Path.join(root, "data/a"), "previous")
      const execution = FetchExec.execute({ root, target, outFile: "data/a", limitBytes: 8 })
      if (size <= 8) {
        await expect(execution).resolves.toEqual({ bytes: size, sha256: sha(bytes) })
        expect(await Fs.readFile(Path.join(root, "data/a"))).toEqual(bytes)
      } else {
        await expect(execution).rejects.toMatchObject({ _tag: "smithers-build/FetchError", code: "body_too_large" })
        expect(await Fs.readFile(Path.join(root, "data/a"), "utf8")).toBe("previous")
      }
      expect(await Fs.readdir(Path.join(root, "data"))).toEqual(["a"])
    }
  })

  it("retains both hashes and the existing destination on a digest mismatch", async () => {
    const node = await planned(origin + "/bytes/3", "0".repeat(64))
    await Fs.mkdir(Path.join(root, "data"))
    await Fs.writeFile(Path.join(root, "data/download.bin"), "previous")
    await expect(contract.execute(node, { root, signal: undefined })).rejects.toMatchObject({
      _tag: "smithers-build/FetchError",
      code: "digest_mismatch",
      expectedSha256: "0".repeat(64),
      actualSha256: sha(body(3))
    })
    expect(await Fs.readFile(Path.join(root, "data/download.bin"), "utf8")).toBe("previous")
    expect(await Fs.readdir(Path.join(root, "data"))).toEqual(["download.bin"])
  })

  it("returns a typed HTTP status failure through the exact contract", async () => {
    const node = await planned(origin + "/missing", sha(body(0)))
    await expect(contract.execute(node, { root, signal: undefined })).rejects.toMatchObject({
      _tag: "smithers-build/FetchError",
      code: "unexpected_status",
      message: `Fetch request for ${origin}/missing answered HTTP 404`
    })
    await expect(Fs.access(Path.join(root, "data"))).rejects.toThrow()
  })

  it("cancels an active stream and removes its temporary without publishing", async () => {
    const node = await planned(origin + "/hold", sha(body(1)))
    const controller = new AbortController()
    const requested = new Promise<void>((resolve) => {
      received = resolve
    })
    const execution = contract.execute(node, { root, signal: controller.signal })
    const failed = expect(execution).rejects.toMatchObject({ code: "request_failed", cause: expect.anything() })
    await requested
    controller.abort()
    await failed
    await expect(Fs.access(Path.join(root, "data/download.bin"))).rejects.toThrow()
    expect(await Fs.readdir(Path.join(root, "data")).catch(() => [])).toEqual([])
  })

  it("preserves the original filesystem cause when publication cannot replace a directory", async () => {
    const node = await planned(origin + "/bytes/1", sha(body(1)))
    await Fs.mkdir(Path.join(root, "data/download.bin"), { recursive: true })
    await Fs.writeFile(Path.join(root, "data/download.bin/keep"), "previous")
    await expect(contract.execute(node, { root, signal: undefined })).rejects.toMatchObject({
      code: "write_failed",
      cause: expect.objectContaining({ code: expect.stringMatching(/EISDIR|EPERM|EEXIST/) })
    })
    expect(await Fs.readFile(Path.join(root, "data/download.bin/keep"), "utf8")).toBe("previous")
    expect(await Fs.readdir(Path.join(root, "data"))).toEqual(["download.bin"])
  })

  it("preserves a write failure cause and cleans up when the output parent is a file", async () => {
    const node = await planned(origin + "/bytes/1", sha(body(1)), "parent/a")
    await Fs.mkdir(Path.join(root, "data"))
    await Fs.writeFile(Path.join(root, "data/parent"), "previous")
    await expect(contract.execute(node, { root, signal: undefined })).rejects.toMatchObject({
      code: "write_failed",
      cause: expect.objectContaining({ code: "EEXIST" })
    })
    expect(await Fs.readFile(Path.join(root, "data/parent"), "utf8")).toBe("previous")
    expect(await Fs.readdir(Path.join(root, "data"))).toEqual(["parent"])
  })
})
