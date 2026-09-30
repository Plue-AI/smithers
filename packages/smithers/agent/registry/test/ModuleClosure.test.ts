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
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { fileURLToPath } from "node:url"
import * as ModuleClosure from "../src/internal/ModuleClosure.ts"
import { tokenize } from "../src/internal/ModuleMetadata.ts"

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

  it("counts a loader reached under another name as opaque", () => {
    // Each of these loads `./impl.ts` at run time without a literal call the
    // scan can read, so each must be refused rather than silently unpinned.
    const aliased = [
      `import { createRequire as cr } from "node:module"\ncr(import.meta.url)("./impl.ts")`,
      `import * as M from "node:module"\nM["create" + "Require"](import.meta.url)("./impl.ts")`,
      `import M from "module"\nnew M.Module("x")`,
      `const r = require\nr("./impl.ts")`,
      `const r = import.meta.require\nr("./impl.ts")`,
      `const [r] = [require]\nr("./impl.ts")`
    ]
    for (const source of aliased) {
      expect(ModuleClosure.specifiersOf(source).opaque, source).toBeGreaterThan(0)
    }
    // Not loaders: an object key named `require`, and an identifier that
    // merely starts with the word.
    expect(ModuleClosure.specifiersOf(`const o = { require: true, x: 1 }`).opaque).toBe(0)
    expect(ModuleClosure.specifiersOf(`const o = { x: 1, require: true }`).opaque).toBe(0)
    expect(ModuleClosure.specifiersOf(`const requireAuth = 1`).opaque).toBe(0)
  })

  it("does not count an ordinary property named require as a loader", () => {
    expect(ModuleClosure.specifiersOf(`opts.require = true`).opaque).toBe(0)
    expect(ModuleClosure.specifiersOf(`const y = cfg.require`).opaque).toBe(0)
    expect(ModuleClosure.specifiersOf(`const y = cfg?.require`).opaque).toBe(0)
    // The loader reached as a property of a host object is still a loader.
    const loaders = [
      `const r = module.require\nr("./impl.ts")`,
      `const r = globalThis.require\nr("./impl.ts")`,
      `const r = global.require\nr("./impl.ts")`,
      `const r = self.require\nr("./impl.ts")`,
      `const r = window.require\nr("./impl.ts")`,
      `globalThis["require"]("./impl.ts")`,
      `const r = globalThis['require']\nr("./impl.ts")`
    ]
    for (const source of loaders) {
      expect(ModuleClosure.specifiersOf(source).opaque, source).toBeGreaterThan(0)
    }
  })

  it("lists every other literal specifier as bare, except node: and bun: builtins", () => {
    const found = ModuleClosure.specifiersOf(
      [
        `import { suffix } from "#impl"`,
        `import { other } from "@x/other.ts"`,
        `import { Effect } from "effect"`,
        `import * as fs from "node:fs"`,
        `import { test } from "bun:test"`
      ].join("\n")
    )
    expect(found.bare).toEqual(["#impl", "@x/other.ts", "effect"])
    expect(found.relative).toEqual([])
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

describe("where a regular expression may start (#3106)", () => {
  // Each source compiles as JavaScript; `new Function` parses it without
  // running it. A `'` inside a regular expression the scan misreads as a
  // division opens a string that swallows the load after it.
  const compiles = (source: string) => {
    expect(() => new Function(source), source).not.toThrow()
  }

  it("reads a line after break, continue or debugger as a new statement", () => {
    const literal = [
      `for(;;){ if (c) break\n/'/.test(s); import("./evil.ts"); /'/ }`,
      `for(;;){ if (c) continue\n/'/.test(s); import("./evil.ts"); /'/ }`,
      `debugger\n/'/.test(s); import("./evil.ts"); /'/`,
      `a: for(;;){ if (c) break a\n/'/.test(s); import("./evil.ts"); /'/ }`,
      `a: for(;;){ if (c) continue a\n/'/.test(s); import("./evil.ts"); /'/ }`
    ]
    for (const source of literal) {
      compiles(source)
      expect(ModuleClosure.specifiersOf(source), source).toMatchObject({ relative: ["./evil.ts"], opaque: 0 })
    }
  })

  it("reads a keyword spelled as a private or property name as a name", () => {
    const computed = [
      `class X { #return = 1; run(p) { return this.#return / import(p) / 1 } }`,
      `class X { #typeof = 1; run(p) { return this.#typeof / import(p) / 1 } }`,
      `const o = { return: 1 }; o.return / import(p) / 1`,
      `const o = { return: 1 }; o?.return / import(p) / 1`
    ]
    for (const source of computed) {
      compiles(source)
      expect(ModuleClosure.specifiersOf(source).opaque, source).toBe(1)
    }
  })

  it("reads Unicode and escaped identifiers whole", () => {
    const computed = [
      `const éreturn = 2; éreturn / import(p) / 1`,
      `const \\u{65}return = 2; \\u{65}return / import(p) / 1`,
      `const \\u0065return = 2; \\u0065return / import(p) / 1`,
      `const 𝑥return = 2; 𝑥return / import(p) / 1`,
      `const a\\u200Dreturn = 2; a\\u200Dreturn / import(p) / 1`
    ]
    for (const source of computed) {
      compiles(source)
      expect(ModuleClosure.specifiersOf(source).opaque, source).toBe(1)
    }
    // An escape decodes to the binding it names, so the loader stays a loader.
    compiles(`const m = requir\\u0065(p)`)
    expect(ModuleClosure.specifiersOf(`const m = requir\\u0065(p)`).opaque).toBe(1)
    expect(ModuleClosure.specifiersOf(`const m = \\u{72}equire("./impl.ts")`).relative).toEqual(["./impl.ts"])
  })

  it("reads a regular expression after an if, while, for or with head", () => {
    const literal = [
      `if (c) /'/.test(s); import("./evil.ts"); /'/`,
      `while (c) /'/.test(s); import("./evil.ts"); /'/`,
      `for (;;) /'/.test(s); import("./evil.ts"); /'/`,
      `if ((c)) /'/.test(s); import("./evil.ts"); /'/`,
      `if (c) {}\n/'/.test(s); import("./evil.ts"); /'/`
    ]
    for (const source of literal) {
      compiles(source)
      expect(ModuleClosure.specifiersOf(source).relative, source).toEqual(["./evil.ts"])
    }
  })

  it("reads a line after a type annotation both ways", () => {
    // Valid TypeScript: ASI ends `let x: string`, so the next line is a
    // regular expression. The same tokens in JavaScript divide, so the scan
    // reads both and keeps what either finds.
    const typed = `let x: string\n/'/.test(s); import("./evil.ts"); /'/`
    expect(ModuleClosure.specifiersOf(typed).relative).toEqual(["./evil.ts"])
    const both = [
      `const o = {}\n/'/.test(s); import("./evil.ts"); /'/`,
      `const o = f()\n/'/.test(s); import("./evil.ts"); /'/`,
      `const o = a[0]\n/'/.test(s); import("./evil.ts"); /'/`,
      `const o = "s"\n/'/.test(s); import("./evil.ts"); /'/`
    ]
    for (const source of both) {
      expect(ModuleClosure.specifiersOf(source).relative, source).toEqual(["./evil.ts"])
    }
    // A load both readings find is listed once.
    expect(ModuleClosure.specifiersOf(`import "./a.ts"\nconst o = {}\n/x/.test(s)`).relative).toEqual(["./a.ts"])
  })

  it("still divides where only a division can stand", () => {
    const divisions = [
      `let i = 0; i++ / 2; import(p)`,
      `let i = 0; i-- / 2; import(p)`,
      `const x = f(a) / 2 / import(p)`,
      `const x = a[0] / 2 / import(p)`,
      `const x = ({}) / 2 / import(p)`,
      `const x = 1 / 2 / import(p)`
    ]
    for (const source of divisions) {
      compiles(source)
      expect(ModuleClosure.specifiersOf(source).opaque, source).toBe(1)
    }
    // `+ +/re/` is two prefix operators before a regular expression.
    compiles(`const x = + +/'/.source; import("./evil.ts"); /'/`)
    expect(ModuleClosure.specifiersOf(`const x = + +/'/.source; import("./evil.ts"); /'/`).relative)
      .toEqual(["./evil.ts"])
    // Ordinary division beside a string keeps both where they were.
    const plain = `const half = total / 2; const s = "import(x)"; import "./a.ts"`
    expect(ModuleClosure.specifiersOf(plain)).toMatchObject({ relative: ["./a.ts"], opaque: 0 })
  })

  it("reads what is not a name as punctuation", () => {
    const tokens = (source: string) => tokenize(source).map(({ kind, value }) => `${kind}:${value}`)
    expect(tokens(`#!x`)).toEqual(["punctuation:#", "punctuation:!", "identifier:x"])
    expect(tokens(`\\u{110000}`)).toEqual([
      "punctuation:\\",
      "identifier:u",
      "punctuation:{",
      "number:110000",
      "punctuation:}"
    ])
    expect(tokens(`\\uZZ`)).toEqual(["punctuation:\\", "identifier:uZZ"])
    expect(tokens(`\\x`)).toEqual(["punctuation:\\", "identifier:x"])
    expect(tokenize(`a\\u0062`)).toEqual([{ kind: "identifier", value: "ab", start: 0, end: 7, escaped: true }])
    expect(tokenize(`#p`)).toEqual([{ kind: "identifier", value: "#p", start: 0, end: 2 }])
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

  it.effect("keeps counterpart precedence when a later candidate answers first", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* tree({
        "flow.ts": `import "./both.js"`,
        "both.ts": "export const chosen = 1",
        "both.tsx": "export const later = 2"
      })
      const laterCompleted = yield* Deferred.make<void>()
      const completed: Array<string> = []
      const racing = FileSystem.make({
        ...fs,
        stat: (requested) =>
          Effect.gen(function*() {
            if (requested === `${root}/both.ts`) yield* Deferred.await(laterCompleted)
            const result = yield* fs.stat(requested)
            if (requested === `${root}/both.ts` || requested === `${root}/both.tsx`) {
              completed.push(requested)
            }
            if (requested === `${root}/both.tsx`) yield* Deferred.succeed(laterCompleted, undefined)
            return result
          })
      })

      const found = yield* Effect.provideService(walk(root, "flow.ts"), FileSystem.FileSystem, racing)
      expect(completed).toEqual([`${root}/both.tsx`, `${root}/both.ts`])
      expect(found.map(({ path }) => path)).toEqual(["both.ts"])
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

describe("bare specifiers a loader maps onto project files", () => {
  it.effect("pins the file a package.json imports entry names", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "package.json": JSON.stringify({ imports: { "#impl": "./impl.ts", "#lib/*": { bun: "./lib/*.ts" } } }),
        "flow.ts": `import { suffix } from "#impl"\nimport { x } from "#lib/x"`,
        "impl.ts": `export const suffix = "impl"`,
        "lib/x.ts": `export const x = 1`
      })
      const before = yield* walk(root, "flow.ts")
      expect(before).toEqual([
        { path: "impl.ts", contentDigest: Digest.digest(new TextEncoder().encode(`export const suffix = "impl"`)) },
        { path: "lib/x.ts", contentDigest: Digest.digest(new TextEncoder().encode(`export const x = 1`)) }
      ])

      // The edit an approval must not survive.
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(`${root}/impl.ts`, `export const suffix = "edited"`)
      const after = yield* walk(root, "flow.ts")
      expect(after.find((entry) => entry.path === "impl.ts")!.contentDigest)
        .not.toBe(before.find((entry) => entry.path === "impl.ts")!.contentDigest)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("refuses a # specifier it cannot map to a relative file", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "package.json": JSON.stringify({ imports: { "#dep": "some-package" } }),
        "flow.ts": `import "#dep"\nimport "#missing"`,
        // The nearest package.json decides, even one that declares no imports.
        "sub/package.json": "{}",
        "sub/flow.ts": `import "#dep"`
      })
      const found = yield* walk(root, "flow.ts")
      expect(found).toHaveLength(2)
      expect(found.every((entry) => entry.contentDigest === undefined)).toBe(true)
      const nested = yield* walk(root, "sub/flow.ts")
      expect(nested).toHaveLength(1)
      expect(nested[0]!.contentDigest).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("pins the file a tsconfig paths alias or baseUrl names, through extends and comments", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "base.json": `{\n  // shared\n  "compilerOptions": { "paths": { "@x/*": ["./src/*"], }, },\n}`,
        "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
        "flows/echo/jsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
        "flows/echo/flow.ts":
          `import { a } from "@x/other.ts"\nimport { b } from "helper"\nimport { Effect } from "effect"`,
        "src/other.ts": `export const a = 1`,
        "flows/echo/helper.ts": `export const b = 2`
      })
      expect((yield* walk(root, "flows/echo/flow.ts")).map((entry) => [entry.path, entry.contentDigest !== undefined]))
        .toEqual([["../../src/other.ts", true], ["helper.ts", true]])
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("reads configs the way the loaders do: shared extends, cycles, arrays, and junk skipped", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        // The nearest package.json is not JSON, so the next one up decides `#`.
        "package.json": JSON.stringify({
          imports: { "#arr": ["./arr.ts"], "#none": null, "#cond": { node: { default: "./cond.ts" } } }
        }),
        "flows/package.json": "{ not json",
        // A shared config from node_modules, a missing parent, a non-string
        // entry, and a cycle back to itself, all of which a loader tolerates.
        "node_modules/shared-config/tsconfig.json":
          `/* shared */ { "compilerOptions": { "paths": { "@s/*": [1, "./lib/*"] } }, "extends": "../../tsconfig.json" }`,
        "tsconfig.json": `{ "extends": [42, "./missing.json", "shared-config"], "x": "a \\" // b" }`,
        "flows/tsconfig.json": "[]",
        "flows/echo/flow.ts": [`import "#arr"`, `import "#none"`, `import "#cond"`, `import "@s/lib.ts"`].join("\n"),
        "arr.ts": "export const a = 1",
        "cond.ts": "export const c = 1",
        "node_modules/shared-config/lib/lib.ts": "export const l = 1"
      })
      const found = yield* walk(root, "flows/echo/flow.ts")
      expect(found.map((entry) => [entry.path, entry.contentDigest !== undefined])).toEqual([
        ["../../arr.ts", true],
        ["../../cond.ts", true],
        ["../../node_modules/shared-config/lib/lib.ts", true]
      ])
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("refuses a self-import through the flow package's exports", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "package.json": JSON.stringify({ name: "my-flows", exports: { "./*": "./*.ts" } }),
        "flow.ts": `import { a } from "my-flows/impl"`,
        "impl.ts": `export const a = 1`
      })
      const found = yield* walk(root, "flow.ts")
      expect(found).toHaveLength(1)
      expect(found[0]!.contentDigest).toBeUndefined()
      expect(found[0]!.path).toContain("my-flows/impl")
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

  it.effect("shares positive and missing resolution probes while preserving each entry's closure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* tree({
        "one.ts": `import "./shared.ts"\nimport "./missing.ts"`,
        "two.ts": `import "./shared.ts"\nimport "./missing.ts"`,
        "shared.ts": `import "./leaf.ts"\nexport const shared = 1`,
        "leaf.ts": "export const leaf = 1"
      })
      const probes = new Map<string, number>()
      const counting = FileSystem.make({
        ...fs,
        stat: (requested) => {
          probes.set(requested, (probes.get(requested) ?? 0) + 1)
          return fs.stat(requested)
        }
      })
      const memo = ModuleClosure.cache()
      const first = yield* Effect.provideService(walk(root, "one.ts", memo), FileSystem.FileSystem, counting)
      const second = yield* Effect.provideService(walk(root, "two.ts", memo), FileSystem.FileSystem, counting)

      expect(first).toEqual(yield* walk(root, "one.ts"))
      expect(second).toEqual(yield* walk(root, "two.ts"))
      expect(first.map(({ path }) => path)).toEqual([
        "leaf.ts",
        "shared.ts",
        `the entry imports "./missing.ts", which resolves to no file`
      ])
      expect(probes.get(`${root}/shared.ts`)).toBe(1)
      expect(probes.get(`${root}/leaf.ts`)).toBe(1)
      expect(probes.get(`${root}/missing.ts`)).toBe(1)
      expect([...probes.values()].every((count) => count === 1)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("stats one absolute file once when imports reach it from different directories", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* tree({
        "one/flow.ts": `import "../shared.ts"`,
        "two/flow.ts": `import "../shared.ts"`,
        "shared.ts": "export const shared = 1"
      })
      const probes = new Map<string, number>()
      const counting = FileSystem.make({
        ...fs,
        stat: (requested) => {
          probes.set(requested, (probes.get(requested) ?? 0) + 1)
          return fs.stat(requested)
        }
      })
      const memo = ModuleClosure.cache()
      const first = yield* Effect.provideService(walk(root, "one/flow.ts", memo), FileSystem.FileSystem, counting)
      const second = yield* Effect.provideService(walk(root, "two/flow.ts", memo), FileSystem.FileSystem, counting)

      expect(first).toEqual(yield* walk(root, "one/flow.ts"))
      expect(second).toEqual(yield* walk(root, "two/flow.ts"))
      expect(first.map(({ path }) => path)).toEqual(["../shared.ts"])
      expect(second.map(({ path }) => path)).toEqual(["../shared.ts"])
      expect(probes.get(`${root}/shared.ts`)).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("probes wildcard path aliases once across importer directories", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* tree({
        "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "*": ["./*"] } } }),
        "one/flow.ts": [
          `import "effect/Effect"`,
          `import "@smthrs/flow"`,
          `import "../shared.ts"`
        ].join("\n"),
        "two/flow.ts": [
          `import "effect/Effect"`,
          `import "@smthrs/flow"`,
          `import "../shared.ts"`
        ].join("\n"),
        "shared.ts": "export const shared = 1"
      })
      const probes = new Map<string, number>()
      const counting = FileSystem.make({
        ...fs,
        stat: (requested) => {
          probes.set(requested, (probes.get(requested) ?? 0) + 1)
          return fs.stat(requested)
        }
      })
      const memo = ModuleClosure.cache()
      const first = yield* Effect.provideService(walk(root, "one/flow.ts", memo), FileSystem.FileSystem, counting)
      const second = yield* Effect.provideService(walk(root, "two/flow.ts", memo), FileSystem.FileSystem, counting)

      expect(first).toEqual(yield* walk(root, "one/flow.ts"))
      expect(second).toEqual(yield* walk(root, "two/flow.ts"))
      expect(first.map(({ path }) => path)).toEqual(["../shared.ts"])
      expect(second.map(({ path }) => path)).toEqual(["../shared.ts"])
      expect(probes.get(`${root}/effect/Effect`)).toBe(1)
      expect(probes.get(`${root}/@smthrs/flow`)).toBe(1)
      expect(probes.get(`${root}/shared.ts`)).toBe(1)
      expect([...probes.values()].every((count) => count === 1)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("sees a newly created missing import and an edited module in a fresh scan", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* tree({
        "one.ts": `import "./shared.ts"\nimport "./missing.ts"`,
        "two.ts": `import "./shared.ts"\nimport "./missing.ts"`,
        "shared.ts": "export const shared = 1"
      })
      const firstScan = ModuleClosure.cache()
      yield* walk(root, "one.ts", firstScan)
      const before = yield* walk(root, "two.ts", firstScan)
      expect(before.some(({ path }) => path.includes("missing.ts") && path.includes("no file"))).toBe(true)

      yield* fs.writeFileString(`${root}/missing.ts`, "export const added = 1")
      yield* fs.writeFileString(`${root}/shared.ts`, "export const shared = 2")
      const after = yield* walk(root, "two.ts", ModuleClosure.cache())
      expect(after.map(({ path }) => path)).toEqual(["missing.ts", "shared.ts"])
      expect(after.find(({ path }) => path === "shared.ts")?.contentDigest)
        .not.toBe(before.find(({ path }) => path === "shared.ts")?.contentDigest)
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("enforces the same byte bound for cached and freshly read modules", () =>
    Effect.gen(function*() {
      const sibling = "export const shared = 12345"
      const root = yield* tree({
        "one.ts": `import "./shared.ts"`,
        "two.ts": `import "./shared.ts"`,
        "shared.ts": sibling
      })
      const size = new TextEncoder().encode(sibling).length
      for (const bytes of [size - 1, size, size + 1]) {
        const bounds = { files: 100, bytes }
        const memo = ModuleClosure.cache()
        yield* walk(root, "one.ts", memo, { files: 100, bytes: size + 1 })
        const warm = yield* walk(root, "two.ts", memo, bounds)
        const cold = yield* walk(root, "two.ts", ModuleClosure.cache(), bounds)
        expect(warm, `byte bound ${bytes}`).toEqual(cold)
        expect(warm.some(({ path }) => path.includes(`more than ${bytes} bytes`))).toBe(bytes < size)
      }
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

describe("the measured closure a loader evaluates", () => {
  const snapshot = (root: string, entry: string) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const entryPath = `${root}/${entry}`
      return yield* ModuleClosure.snapshot(fs, path, entryPath, yield* fs.readFile(entryPath))
    })

  /** Each link of `file`, as the specifier text it replaces and the target's path under `root`. */
  const linksOf = (root: string, closure: ReadonlyMap<string, ModuleClosure.Module>, file: string) => {
    const module = closure.get(`${root}/${file}`)!
    return module.links.map((link) => [module.source.slice(link.start, link.end), link.target.slice(root.length + 1)])
  }

  it.effect("links each static specifier naming a closure module, and no call or package", () =>
    Effect.gen(function*() {
      const root = yield* tree({
        "package.json": JSON.stringify({
          imports: { "#impl": "./impl.ts", "#either": { bun: "./a.ts", default: "./b.ts" } }
        }),
        "flow.ts": [
          `import { helper } from "./helper.ts"`,
          `import "./side.ts"`,
          `export * from './lib/reexport.ts'`,
          `import { suffix } from "#impl"`,
          `import { either } from "#either"`,
          `import { Effect } from "effect"`,
          `const late = () => import("./late.ts")`
        ].join("\n"),
        "helper.ts": `import { back } from "./flow.ts"\nexport const helper = 1`,
        "side.ts": ``,
        "lib/reexport.ts": `export { helper as again } from "../helper.ts"`,
        "impl.ts": `export const suffix = "impl"`,
        "a.ts": `export const either = "a"`,
        "b.ts": `export const either = "b"`,
        "late.ts": `export const late = 1`
      })
      const { imports, modules } = yield* snapshot(root, "flow.ts")
      expect([...modules.keys()].map((file) => file.slice(root.length + 1)).sort()).toEqual([
        "a.ts",
        "b.ts",
        "flow.ts",
        "helper.ts",
        "impl.ts",
        "late.ts",
        "lib/reexport.ts",
        "side.ts"
      ])
      expect(linksOf(root, modules, "flow.ts")).toEqual([
        [`"./helper.ts"`, "helper.ts"],
        [`"./side.ts"`, "side.ts"],
        [`'./lib/reexport.ts'`, "lib/reexport.ts"],
        [`"#impl"`, "impl.ts"]
      ])
      // A cycle back to the entry is a link like any other.
      expect(linksOf(root, modules, "helper.ts")).toEqual([[`"./flow.ts"`, "flow.ts"]])
      expect(linksOf(root, modules, "lib/reexport.ts")).toEqual([[`"../helper.ts"`, "helper.ts"]])
      expect(linksOf(root, modules, "late.ts")).toEqual([])
      // The records are the walk's own, over the very bytes kept for loading.
      expect(imports).toEqual(yield* walk(root, "flow.ts"))
      for (const record of imports) {
        expect(Digest.digest(modules.get(`${root}/${record.path}`)!.bytes)).toBe(record.contentDigest)
      }
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("keeps the bytes it measured, not what the path holds afterwards", () =>
    Effect.gen(function*() {
      const root = yield* tree({ "flow.ts": `import "./helper.ts"`, "helper.ts": `export const v = 7` })
      const { imports, modules } = yield* snapshot(root, "flow.ts")
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(`${root}/helper.ts`, `export const v = 9`)
      expect(new TextDecoder().decode(modules.get(`${root}/helper.ts`)!.bytes)).toBe(`export const v = 7`)
      expect(imports[0]!.contentDigest).toBe(Digest.digest(new TextEncoder().encode(`export const v = 7`)))
    }).pipe(Effect.scoped, Effect.provide(platform)))
})
