/**
 * What a module says it loads, and what the walk makes of it.
 *
 * `Executable.test.ts` proves the refusals this feeds; this suite is the
 * scanner and the walk on their own: which specifier shapes are module
 * specifiers, which are not, how a specifier resolves to a file, and what the
 * walk does at its bounds.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { fileURLToPath } from "node:url"
import * as ModuleClosure from "../src/internal/ModuleClosure.ts"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** A directory holding the named files, written relative to it. */
const tree = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".g6-" })
    for (const [name, contents] of Object.entries(files)) {
      const target = `${root}/${name}`
      yield* fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true })
      yield* fs.writeFileString(target, contents)
    }
    return root
  })

const walk = (
  root: string,
  entry: string,
  memo?: ModuleClosure.Cache,
  bounds?: { readonly files: number; readonly bytes: number }
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entryPath = `${root}/${entry}`
    return yield* ModuleClosure.collect(
      fs,
      path,
      entryPath,
      yield* fs.readFileString(entryPath),
      memo,
      bounds
    )
  })

describe("the specifiers a module states", () => {
  it("reads every shape that names a module, and nothing that does not", () => {
    const found = ModuleClosure.specifiersOf(
      [
        `import a from "./a.ts"`,
        `import { b } from "../b.ts"`,
        `import type { T } from "./types.ts"`,
        `import "./side-effect.ts"`,
        `export { c } from "./c.ts"`,
        `export * from "./d.ts"`,
        `const late = () => import("./late.ts")`,
        // Bare specifiers resolve into installed packages, which are the
        // host's own code and carry the host's trust. Every shape of one is
        // ignored, including the two that reach a package without naming a
        // binding.
        `import { Flow } from "@smthrs/flow"`,
        `import { Schema } from "effect"`,
        `import "@smthrs/side-effect"`,
        `const pkg = () => import("effect")`,
        // None of these is a module specifier, and a scanner that took them
        // for one would pin files that do not exist.
        `const record = { from: "./not-an-import.ts" }`,
        `const chosen = pick(from, "./also-not.ts")`,
        `// import realImport from "./commented.ts"`,
        `const text = 'import x from "./quoted.ts"'`
      ].join("\n")
    )

    expect([...found.relative].sort()).toEqual([
      "../b.ts",
      "./a.ts",
      "./c.ts",
      "./d.ts",
      "./late.ts",
      "./side-effect.ts",
      "./types.ts"
    ])
    expect(found.opaque).toBe(0)
  })

  it("counts an import whose target is decided at run time", () => {
    // A template with a substitution is as unreadable as an identifier: what
    // it names is not in the source.
    expect(ModuleClosure.specifiersOf(`const m = await import(name)`).opaque).toBe(1)
    expect(ModuleClosure.specifiersOf("const m = await import(`./${name}.ts`)").opaque).toBe(1)
    expect(ModuleClosure.specifiersOf(`const m = await import("./fixed.ts")`).opaque).toBe(0)
    // `import.meta` is not a call, and reading it as one would refuse every
    // module that asks where it lives.
    expect(ModuleClosure.specifiersOf(`export const here = import.meta.dirname`).opaque).toBe(0)
  })

  it("reads require() like import(), and counts a computed or created require as opaque", () => {
    expect(ModuleClosure.specifiersOf(`const { a } = require("./impl.ts")`).relative).toEqual(["./impl.ts"])
    expect(ModuleClosure.specifiersOf(`const { a } = import.meta.require("./impl.ts")`).relative).toEqual([
      "./impl.ts"
    ])
    expect(ModuleClosure.specifiersOf(`const m = require(name)`).opaque).toBe(1)
    expect(
      ModuleClosure.specifiersOf(
        `import { createRequire } from "node:module"\ncreateRequire(import.meta.url)("./impl.ts")`
      )
        .opaque
    ).toBeGreaterThan(0)
    // `require.resolve` names a path without loading it.
    expect(ModuleClosure.specifiersOf(`const p = require.resolve("./x.ts")`).opaque).toBe(0)
  })

  it("lists absolute and file: specifiers, which the pin does not follow", () => {
    const found = ModuleClosure.specifiersOf(
      [
        `import { a } from "/workspace/repo/flows/echo/impl.ts"`,
        `import "file:///workspace/repo/x.ts"`,
        `const b = require("/abs/b.ts")`,
        `export * from "C:/repo/c.ts"`,
        `import { Effect } from "effect"`
      ].join("\n")
    )
    expect(found.absolute).toEqual([
      "/workspace/repo/flows/echo/impl.ts",
      "file:///workspace/repo/x.ts",
      "/abs/b.ts",
      "C:/repo/c.ts"
    ])
    expect(found.relative).toEqual([])
    // A specifier with a substitution names nothing the scan can list.
    expect(ModuleClosure.specifiersOf("export * from `./${name}.ts`").absolute).toEqual([])
    expect(ModuleClosure.specifiersOf(`import "\\\\host\\share\\x.ts"`).absolute).toHaveLength(1)
  })
})

describe("resolving a specifier to a file", () => {
  it.effect("tries the exact path, then the extensions, then a directory index", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": [
          `import "./exact.mjs"`,
          `import "./extensionless"`,
          `import "./folder"`
        ].join("\n"),
        "exact.mjs": "export const a = 1",
        "extensionless.ts": "export const b = 2",
        "folder/index.ts": "export const c = 3"
      })

      expect((yield* walk(root, "flow.ts")).map((entry) => entry.path))
        .toEqual(["exact.mjs", "extensionless.ts", "folder/index.ts"])
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("resolves a NodeNext .js, .mjs or .cjs specifier to its TypeScript source", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": [`import { x } from "./schema.js"`, `import "./view.js"`, `import "./m.mjs"`, `import "./c.cjs"`]
          .join("\n"),
        "schema.ts": "export const x = 1",
        "view.tsx": "export const v = 2",
        "m.mts": "export const m = 3",
        "c.cts": "export const c = 4"
      })

      const found = yield* walk(root, "flow.ts")
      expect(found.map((entry) => entry.path)).toEqual(["c.cts", "m.mts", "schema.ts", "view.tsx"])
      expect(found.every((entry) => entry.contentDigest !== undefined)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("prefers a real .js file over its TypeScript counterpart", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": `import "./both.js"`,
        "both.js": "export const js = 1",
        "both.ts": "export const ts = 1"
      })

      expect((yield* walk(root, "flow.ts")).map((entry) => entry.path)).toEqual(["both.js"])
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("records a specifier nothing answers to, naming the file that asked", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": `import "./present.ts"`,
        "present.ts": `import "./absent.ts"`
      })

      const found = yield* walk(root, "flow.ts")
      const unpinned = found.filter((entry) => entry.contentDigest === undefined)
      expect(unpinned).toHaveLength(1)
      // The importer is named, not only the specifier: one missing file can be
      // asked for from several places.
      expect(unpinned[0]!.path).toContain("present.ts")
      expect(unpinned[0]!.path).toContain("./absent.ts")
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("refuses to pin an entry that requires or absolutely imports a sibling", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": `const { suffix } = require("./impl.ts")\nimport { other } from "/elsewhere/impl.ts"`,
        "impl.ts": `export const suffix = "-ok"`
      })
      const found = yield* walk(root, "flow.ts")
      expect(found.find((entry) => entry.path === "impl.ts")?.contentDigest).toBeDefined()
      const unpinned = found.filter((entry) => entry.contentDigest === undefined).map((entry) => entry.path)
      expect(unpinned).toEqual([
        `the entry imports "/elsewhere/impl.ts", an absolute specifier the pin does not follow`
      ])
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("records a computed import in the entry itself", () =>
    Effect.gen(function*() {
      const root = yield* tree({ "flow.ts": `export const load = (name) => import(name)` })

      const found = yield* walk(root, "flow.ts")
      expect(found).toHaveLength(1)
      expect(found[0]!.contentDigest).toBeUndefined()
      expect(found[0]!.path).toContain("the entry computes the target")
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("records a computed import inside a reached module, not only the entry", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": `import "./deep.ts"`,
        "deep.ts": `export const load = (name) => import(name)`
      })

      const found = yield* walk(root, "flow.ts")
      expect(found.find((entry) => entry.path === "deep.ts")?.contentDigest).toBeDefined()
      expect(found.some((entry) => entry.contentDigest === undefined && entry.path.includes("deep.ts")))
        .toBe(true)
    }).pipe(Effect.scoped, Effect.provide(platform)))
})

describe("the walk", () => {
  it.effect("measures the bytes of every module it reaches, sorted by path", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": `import "./b.ts"\nimport "./a.ts"`,
        "a.ts": "export const a = 1",
        "b.ts": "export const b = 2"
      })

      const found = yield* walk(root, "flow.ts")
      expect(found.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"])
      expect(found[0]!.contentDigest).toBe(Digest.digest(new TextEncoder().encode("export const a = 1")))
      // Two modules reaching one file record it once, with one digest.
      expect(new Set(found.map((entry) => entry.path)).size).toBe(found.length)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  for (const entryPath of ["flow.ts", "./flow.ts"]) {
    it.effect(`ends on a cycle and names each module once with entry ${entryPath}`, () =>
      Effect.gen(function*() {
        const root = yield* tree({
          "flow.ts": `import "./a.ts"`,
          "a.ts": `import "./b.ts"`,
          "b.ts": `import "./a.ts"\nimport "./flow.ts"`
        })

        // `flow.ts` imports itself back through `b.ts`, which is legal and must
        // not be walked a second time.
        expect((yield* walk(root, entryPath)).map((entry) => entry.path)).toEqual(["a.ts", "b.ts"])
      }).pipe(Effect.scoped, Effect.provide(platform)))
  }

  it.effect("reads each module once across the flows that share it", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* tree({
        "one.ts": `import "./shared.ts"`,
        "two.ts": `import "./shared.ts"`,
        "shared.ts": "export const shared = 1"
      })
      let reads = 0
      const counting = FileSystem.make({
        ...fs,
        readFile: (requested) => Effect.tap(fs.readFile(requested), () => Effect.sync(() => void reads++))
      })
      const memo = ModuleClosure.cache()

      yield* Effect.provideService(walk(root, "one.ts", memo), FileSystem.FileSystem, counting)
      const after = reads
      yield* Effect.provideService(walk(root, "two.ts", memo), FileSystem.FileSystem, counting)

      // The second walk reads its own entry and serves `shared.ts` from the
      // cache; without it a project's flows re-read their common imports once
      // per flow.
      expect(reads - after).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("stops at its file bound and says so instead of pinning a partial closure", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": `import "./a.ts"`,
        "a.ts": `import "./b.ts"`,
        "b.ts": `import "./c.ts"`,
        "c.ts": "export const c = 1"
      })

      const found = yield* walk(root, "flow.ts", undefined, { files: 2, bytes: 1_000_000 })
      const unpinned = found.filter((entry) => entry.contentDigest === undefined)
      expect(unpinned).toHaveLength(1)
      expect(unpinned[0]!.path).toContain("more than 2 modules")
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("stops at its byte bound the same way", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": `import "./big.ts"`,
        "big.ts": `export const big = "${"x".repeat(200)}"`
      })

      const found = yield* walk(root, "flow.ts", undefined, { files: 100, bytes: 16 })
      expect(found.some((entry) => entry.path.includes("more than 16 bytes"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("accepts a closure exactly at both bounds", () =>
    Effect.gen(function*() {
      const sibling = "export const value = 1"
      const root = yield* tree({
        "flow.ts": `import "./sibling.ts"`,
        "sibling.ts": sibling
      })

      const found = yield* walk(root, "flow.ts", undefined, {
        files: 2, // The entry itself counts toward the file limit.
        bytes: new TextEncoder().encode(sibling).length
      })
      expect(found).toEqual([{
        path: "sibling.ts",
        contentDigest: Digest.digest(new TextEncoder().encode(sibling))
      }])
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("sorts pinned modules and distinct refusals into one stable closure", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "flow.ts": `import "./z.ts"\nimport "./missing.ts"\nimport "./a.ts"`,
        "a.ts": "export const a = 1",
        "z.ts": "export const z = 1"
      })

      const found = yield* walk(root, "flow.ts")
      expect(found.map(({ path }) => path)).toEqual([
        "a.ts",
        "the entry imports \"./missing.ts\", which resolves to no file",
        "z.ts"
      ])
      expect(found.map(({ contentDigest }) => contentDigest !== undefined)).toEqual([true, false, true])
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("keeps a computed-import refusal when a real module has the same displayed path", () =>
    Effect.gen(function*() {
      const collision = "the entry computes the target of 1 import() or require() call(s)"
      const source = "export const a = 1"
      const root = yield* tree({
        "flow.ts": `import "./${collision}"\nexport const load = (target) => import(target)`,
        [collision]: source
      })

      const found = yield* walk(root, "flow.ts")
      expect(found).toEqual([
        { path: collision },
        { path: collision, contentDigest: Digest.digest(new TextEncoder().encode(source)) }
      ])
      expect(found.some((entry) => entry.contentDigest === undefined)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("records a module it cannot read rather than dropping it", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* tree({
        "flow.ts": `import "./unreadable.ts"`,
        "unreadable.ts": "export const a = 1"
      })
      const failing = FileSystem.make({
        ...fs,
        readFile: (requested) =>
          requested.endsWith("unreadable.ts")
            ? Effect.fail(new Error("denied") as never)
            : fs.readFile(requested)
      })

      const found = yield* Effect.provideService(walk(root, "flow.ts"), FileSystem.FileSystem, failing)
      expect(found).toHaveLength(1)
      expect(found[0]!.contentDigest).toBeUndefined()
      expect(found[0]!.path).toContain("could not be read")
    }).pipe(Effect.scoped, Effect.provide(platform)))
})
