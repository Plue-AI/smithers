import { Smithers as S } from "@smthrs/targets"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openCache } from "../src/Cache.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as Planner from "../src/Planner.ts"

// Recorded against PackageExec before the extraction. Only host identity and
// the HTTP fixture's ephemeral port are normalized. The complete semantic key
// material, its hash, the cache envelope, and the report remain golden data.
const bytes = Buffer.from([0, 1, 2, 10, 13, 127, 128, 254, 255])
const digest = createHash("sha256").update(bytes).digest("hex")
const directories: Array<string> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const fixture = async (url: string, sha256 = digest, out = "nested/payload.bin") => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-fetch-equivalence-")))
  directories.push(root)
  const packageJson = S.file("//package.json")
  const target = S.Fetch({ url, sha256, out })
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
    packages: [{ file: "data/PACKAGE.ts", packagePath: "data", value: S.Package({ targets: { pinned: target } }) }]
  })
  const notes: Array<string> = []
  const options = {
    index,
    cacheDirectory: ".flows",
    verb: "auto",
    patterns: ["//data:pinned"],
    log: (s: string) => notes.push(s)
  } as const
  const planned = await PackageExec.plan(options)
  return { root, target, options, planned, node: planned.nodes.get("//data:pinned")!, notes }
}

const stableMaterial = (node: PackageExec.PackageNode): Planner.KeyMaterial => {
  const inputs = node.keyMaterial.inputs as Record<string, unknown>
  return {
    ...node.keyMaterial,
    inputs: {
      ...inputs,
      ambient: {
        node: "<node>",
        platform: "<platform>",
        arch: "<arch>",
        lockfile: null,
        implementation: "<implementation>"
      },
      attrs: { ...(inputs["attrs"] as object), url: "https://fixture.invalid/payload.bin" }
    }
  }
}

describe("Fetch extraction goldens recorded through the original PackageExec path", () => {
  it("preserves complete key material, output, provenance, report, and cache replay", async () => {
    vi.spyOn(Planner, "implementationFingerprint").mockResolvedValue("baseline-fixture")
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.end(bytes)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/payload.bin`
      const { root, options, planned, node, notes } = await fixture(url)
      const material = stableMaterial(node)
      const key = Planner.keyOf(material)
      expect({
        material,
        key,
        rule: node.rule,
        mode: node.mode,
        inputs: node.declaredInputs,
        outputs: node.declaredOutputs,
        outDirs: node.outDirs,
        outFiles: node.outFiles,
        services: node.serviceDeps,
        sandbox: node.sandbox,
        cacheable: node.cacheable
      }).toMatchSnapshot("pre-extraction plan")

      const first = await PackageExec.execute(planned, options)
      expect(first.counts).toEqual({ ran: 1, hit: 0, failed: 0, skipped: 0 })
      expect(first.results.map(({ durationMs: _time, ...report }) => ({ ...report, key })))
        .toMatchSnapshot("pre-extraction report")
      const destination = Path.join(root, "data/nested/payload.bin")
      expect(await Fs.readFile(destination)).toEqual(bytes)
      expect((await Fs.stat(destination)).mode & 0o777).toBe(0o644)
      expect(notes).toContain("//data:pinned  fetched 9 byte(s)")
      expect(requests).toBe(1)

      const store = await openCache({ workspaceRoot: root, cacheDirectory: ".flows" })
      try {
        const stored = await store.get(node.keyPreview)
        expect(stored).not.toBeNull()
        expect(stored!.key).toBe(node.keyPreview)
        expect(stored!.storedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        expect({ ...stored, key, storedAt: "<storedAt>" }).toMatchSnapshot("pre-extraction provenance")
      } finally {
        await store.close()
      }

      await Fs.rm(destination)
      const replay = await PackageExec.execute(planned, options)
      expect(replay.counts).toEqual({ ran: 0, hit: 1, failed: 0, skipped: 0 })
      expect(await Fs.readFile(destination)).toEqual(bytes)
      expect((await Fs.stat(destination)).mode & 0o777).toBe(0o644)
      expect(requests).toBe(1)
      const bypass = await PackageExec.execute(planned, { ...options, readCache: false })
      expect(bypass.counts).toEqual({ ran: 1, hit: 0, failed: 0, skipped: 0 })
      expect(requests).toBe(2)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
