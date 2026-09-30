import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import * as Vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as ModelEngine from "../src/ModelEngine.ts"
import {
  assertPackageName,
  diffFields,
  fieldCacheDirectory,
  generated,
  generationContext,
  maximumFieldCacheBytes,
  maximumGeneratedResponseBytes,
  maximumManifestBytes,
  merge,
  PackageJson,
  PackageJsonCheck,
  parseGenerated,
  publishFields,
  render,
  scriptCommand,
  sync,
  SyncPayload,
  targets
} from "../src/PackageJson.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"
import * as Target from "../src/Target.ts"
import { Attrs as TsBuildAttrs, distributionLayout, type Tool, TsBuild } from "../src/TsBuild.ts"
import { Vitest } from "../src/Vitest.ts"
import { plannedCalls } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-packagejson-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/**
 * A conventional dual-format build target for a package at `cwd`.
 *
 * The tool is the package's own build program because that is what produces
 * both halves: one `tsc -p` invocation emits one module format, and `TsBuild`
 * refuses to declare `dual` over it.
 */
const build = (
  cwd: string,
  format: "esm" | "cjs" | "dual" = "dual",
  tool: Tool = { name: "program", entry: Input.file("scripts/build.mjs") }
) =>
  TsBuild({
    packageManager,
    srcs: [Input.glob("src/**/*.ts")],
    entries: [Input.file("src/index.ts")],
    deps: [],
    tsconfig: Input.file("tsconfig.json"),
    tool,
    format,
    outDir: "dist",
    cwd
  })

const tests = (cwd: string) =>
  Vitest({
    packageManager,
    tests: [Input.glob("test/**/*.test.ts")],
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    config: Input.file("vitest.config.ts"),
    environment: "node",
    passWithNoTests: false,
    cwd
  })

/** Resolves every declared target to a fixed label, as the workspace would. */
const labeller = (entries: ReadonlyArray<readonly [Target.AnyTarget, string]>) => {
  const known = new Map(entries)
  return (target: Target.AnyTarget): string => {
    const label = known.get(target)
    if (label === undefined) throw new Error("target is not in the graph")
    return label
  }
}

/** The rendered manifest a declaration produces at `packages/widget`. */
const manifest = (
  declaration: ReturnType<typeof PackageJson>,
  entries: ReadonlyArray<readonly [Target.AnyTarget, string]>
): Record<string, unknown> => {
  const expanded = targets(declaration, "packages/widget", labeller(entries))
  return (Target.metadata(expanded.check).attrs as { readonly fields: Record<string, unknown> }).fields
}

describe("PackageJson typing and defaults", () => {
  it("defaults the license to MIT and keeps a declared one", () => {
    expect(PackageJson({ name: "widget", version: "0.1.0" }).fields["license"]).toBe("MIT")
    expect(
      PackageJson({ name: "widget", version: "0.1.0", license: "Apache-2.0" }).fields["license"]
    ).toBe("Apache-2.0")
  })

  it("carries the required literal version", () => {
    expect(PackageJson({ name: "widget", version: "1.2.3" }).fields["version"]).toBe("1.2.3")
    expect(() => PackageJson({ name: "widget", version: "" })).toThrow(/empty version/)
    for (const version of ["1", "1.2", "01.2.3", "1.2.3-01", "v1.2.3", "1.2.3+"]) {
      expect(() => PackageJson({ name: "widget", version })).toThrow(/invalid semantic version/)
    }
    expect(PackageJson({ name: "widget", version: "1.2.3-rc.1+build.7" }).fields["version"])
      .toBe("1.2.3-rc.1+build.7")
  })

  it("validates the npm name at declaration time", () => {
    expect(assertPackageName("@smthrs/widget")).toBe("@smthrs/widget")
    expect(() => assertPackageName(7 as never)).toThrow(/not a string/)
    expect(() => assertPackageName("a".repeat(215))).toThrow(/longer than 214/)
    expect(() => PackageJson({ name: "Widget", version: "0.1.0" })).toThrow(/lowercase/)
    expect(() => PackageJson({ name: "wid get", version: "0.1.0" })).toThrow(/not a publishable npm name/)
    expect(() => PackageJson({ name: "", version: "0.1.0" })).toThrow(/empty/)
  })

  it("passes unmodeled fields through and refuses manager-owned ones", () => {
    const declaration = PackageJson({
      name: "widget",
      version: "0.1.0",
      fields: { homepage: "https://example.invalid", private: true }
    })
    expect(declaration.fields["homepage"]).toBe("https://example.invalid")
    expect(declaration.fields["private"]).toBe(true)
    expect(() => PackageJson({ name: "widget", version: "0.1.0", fields: { dependencies: { effect: "4" } } })).toThrow(
      /the package manager owns/
    )
    expect(() => PackageJson({ name: "widget", version: "0.1.0", fields: { name: "other" } })).toThrow(
      /modeled field "name" twice/
    )
  })

  it("refuses hostile or lossy manifest values without invoking accessors", () => {
    let calls = 0
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        calls += 1
        return "secret"
      }
    })
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    const sparse = ["a", "b"]
    delete sparse[0]
    const symbol = { okay: true } as Record<PropertyKey, unknown>
    symbol[Symbol("hidden")] = true
    const values: ReadonlyArray<unknown> = [
      accessor,
      cyclic,
      sparse,
      { value: BigInt(1) },
      { value: Number.NaN },
      { value: -0 },
      { value: undefined },
      { value: new Date(0) },
      symbol,
      new Proxy({ okay: true }, {})
    ]
    for (const custom of values) {
      expect(() => PackageJson({ name: "widget", version: "0.1.0", fields: { custom } })).toThrow()
    }
    expect(calls).toBe(0)
  })

  it("rejects accessor-backed and unknown constructor options without reading them", () => {
    let calls = 0
    const accessor = { version: "0.1.0" }
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get: () => {
        calls += 1
        return "widget"
      }
    })
    expect(() => PackageJson(accessor as never)).toThrow(/accessor/)
    expect(calls).toBe(0)
    expect(() => PackageJson({ name: "widget", version: "0.1.0", typo: true } as never)).toThrow(
      /unknown option "typo"/
    )
  })

  it("validates literal prose and isolates declarations from later mutation", () => {
    expect(() => PackageJson({ name: "widget", version: "0.1.0", description: " bad " })).toThrow(
      /description/
    )
    expect(() => PackageJson({ name: "widget", version: "0.1.0", keywords: ["okay", ""] })).toThrow(
      /keyword 1/
    )
    const custom = { nested: { value: 1 } }
    const declaration = PackageJson({ name: "widget", version: "0.1.0", fields: { custom } })
    custom.nested.value = 2
    expect(declaration.fields["custom"]).toEqual({ nested: { value: 1 } })
    expect(Object.isFrozen(declaration)).toBe(true)
    expect(Object.isFrozen(declaration.fields)).toBe(true)
    expect(PackageJson({ name: "widget", version: "0.1.0", description: "A small widget." }).fields)
      .toMatchObject({ description: "A small widget." })
  })

  it("refuses an engine with the accepted engines its own schema admits", () => {
    let message = ""
    try {
      PackageJson({ name: "widget", version: "0.1.0", engine: "gemini" as never })
    } catch (error) {
      message = (error as TypeError).message
    }
    expect(message).toMatch(/^PackageJson engine must be /)
    for (const engine of ModelEngine.Engine.literals) {
      expect(message).toContain(engine)
      expect(PackageJson({ name: "widget", version: "0.1.0", engine }).engine).toBe(engine)
    }
    for (const word of message.slice("PackageJson engine must be ".length).split(/\W+/).filter(Boolean)) {
      if (word !== "or") expect(ModelEngine.Engine.literals).toContain(word)
    }
  })

  it("validates the model and ignores explicitly undefined optional values", () => {
    expect(() => PackageJson({ name: "widget", version: "0.1.0", model: " bad " })).toThrow(/model/)
    expect(() => PackageJson({ name: "widget", version: "0.1.0", model: "" })).toThrow(/model/)
    const declaration = PackageJson({
      name: "widget",
      version: "0.1.0",
      description: undefined,
      keywords: undefined
    })
    expect(declaration.generated).toEqual([])
    expect(declaration.fields).not.toHaveProperty("description")
    expect(declaration.fields).not.toHaveProperty("keywords")
  })
})

describe("script resolution", () => {
  it("emits smithers build <verb> <label> from the target's own kinds", () => {
    const lib = build("packages/widget")
    const test = tests("packages/widget")
    const declaration = PackageJson({
      name: "widget",
      version: "0.1.0",
      scripts: { build: lib, test }
    })
    const fields = manifest(declaration, [[lib, "//packages/widget:lib"], [test, "//packages/widget:test"]])
    expect(fields["scripts"]).toEqual({
      build: "smithers-build build //packages/widget:lib",
      test: "smithers-build test //packages/widget:test"
    })
  })

  it("fails at analysis time when a script names a target outside the graph", () => {
    const lib = build("packages/widget")
    const declaration = PackageJson({ name: "widget", version: "0.1.0", scripts: { build: lib } })
    expect(() => targets(declaration, "packages/widget", labeller([]))).toThrow(/not in the graph/)
  })

  it("refuses a target whose target runs under no script verb", () => {
    const DocsOnly = Target.make("PackageJsonTestDocsOnly", {
      attrs: Schema.Struct({}),
      kinds: ["docs"],
      implementation: () => Target.notImplemented("PackageJsonTestDocsOnly")
    })
    expect(() => scriptCommand("docs", DocsOnly({}), "//packages/widget:docs")).toThrow(
      /participates in none of build, test, lint, run/
    )
  })

  it("refuses labels that would be interpreted by the npm script shell", () => {
    const lib = build("packages/widget")
    expect(() => scriptCommand("build", lib, "//packages/widget:lib; touch owned")).toThrow(
      /unsafe or non-exact target label/
    )
    expect(() =>
      targets(
        PackageJson({ name: "widget", version: "0.1.0", scripts: { build: lib } }),
        "packages/widget",
        () => "//packages/widget:$lib"
      )
    ).toThrow(/unsafe or non-exact label/)
  })
})

describe("publish derivation", () => {
  it.each(["esm", "cjs", "dual"] as const)("refuses tsup %s without declared types", (format) => {
    const lib = build("packages/widget", format, { name: "tsup", external: [] })
    expect(Target.metadata(lib).outputs).toEqual({ cwd: "packages/widget", paths: ["dist"] })
    const layout = distributionLayout(Schema.decodeUnknownSync(TsBuildAttrs)(Target.metadata(lib).attrs))
    expect(layout.map((output) => output.directory)).toEqual(format === "dual" ? ["dist", "dist"] : ["dist"])
    expect(layout.every((output) => output.entry === null && output.declaration === null)).toBe(true)
    expect(() => publishFields(lib, "//packages/widget:lib", { access: "public", provenance: true }))
      .toThrow(/publish entry .*lib.*no declarations/)
    expect(() =>
      manifest(
        PackageJson({ name: "widget", version: "0.1.0", publish: { entry: lib } }),
        [[lib, "//packages/widget:lib"]]
      )
    ).toThrow(/no declarations/)
  })

  it.each(
    [
      ["tsc", "esm"],
      ["tsc", "cjs"],
      ["program", "esm"],
      ["program", "cjs"],
      ["program", "dual"]
    ] as const
  )("derives %s %s entry paths within the build outputs", (name, format) => {
    const tool: Tool = name === "tsc" ? { name } : { name, entry: Input.file("scripts/build.mjs") }
    const lib = build("packages/widget", format, tool)
    const fields = publishFields(lib, "//packages/widget:lib", { access: "public", provenance: true })
    const conditions = (fields["exports"] as Record<string, Record<string, string>>)["."]!
    const paths = [fields["main"], fields["module"], fields["types"], ...Object.values(conditions)]
      .filter((path): path is string => typeof path === "string")
    const outputs = Target.metadata(lib).outputs!.paths
    const layout = distributionLayout(Schema.decodeUnknownSync(TsBuildAttrs)(Target.metadata(lib).attrs))
    const declaredEntries = layout.flatMap((output) => [output.entry, output.declaration])
      .filter((path): path is string => path !== null).map((path) => `./${path}`)
    for (const path of paths) {
      expect(outputs.some((output) => path.startsWith(`./${output}/`))).toBe(true)
      expect(declaredEntries).toContain(path)
    }
    expect(conditions["types"]).toBe(`./dist/${format === "cjs" ? "cjs" : "esm"}/index.d.ts`)
  })

  it("derives dual entry points from the build target's own attrs", () => {
    const lib = build("packages/widget")
    const fields = manifest(
      PackageJson({ name: "widget", version: "0.1.0", publish: { entry: lib } }),
      [[lib, "//packages/widget:lib"]]
    )
    expect(fields["main"]).toBe("./dist/cjs/index.js")
    expect(fields["module"]).toBe("./dist/esm/index.js")
    expect(fields["types"]).toBe("./dist/esm/index.d.ts")
    expect(fields["exports"]).toEqual({
      "./package.json": "./package.json",
      ".": {
        types: "./dist/esm/index.d.ts",
        import: "./dist/esm/index.js",
        require: "./dist/cjs/index.js"
      }
    })
    expect(fields["publishConfig"]).toEqual({ access: "public", provenance: true })
  })

  it("drops the import condition for cjs and the require condition for esm", () => {
    const esm = build("packages/widget", "esm")
    const esmFields = manifest(
      PackageJson({ name: "widget", version: "0.1.0", publish: { entry: esm } }),
      [[esm, "//packages/widget:lib"]]
    )
    expect(esmFields["main"]).toBe("./dist/esm/index.js")
    expect(esmFields["exports"]).toEqual({
      "./package.json": "./package.json",
      ".": { types: "./dist/esm/index.d.ts", import: "./dist/esm/index.js" }
    })
    const cjs = build("packages/widget", "cjs")
    const cjsFields = manifest(
      PackageJson({ name: "widget", version: "0.1.0", publish: { entry: cjs } }),
      [[cjs, "//packages/widget:lib"]]
    )
    expect(cjsFields["module"]).toBeUndefined()
    expect(cjsFields["types"]).toBe("./dist/cjs/index.d.ts")
  })

  it("lets a declared exports map win over the derivation", () => {
    const lib = build("packages/widget")
    const fields = manifest(
      PackageJson({
        name: "widget",
        version: "0.1.0",
        publish: { entry: lib },
        fields: { exports: { ".": "./src/index.ts" } }
      }),
      [[lib, "//packages/widget:lib"]]
    )
    expect(fields["exports"]).toEqual({ "./package.json": "./package.json", ".": "./src/index.ts" })
  })

  it("defaults explicitly undefined publish options", () => {
    const lib = build("packages/widget")
    const fields = manifest(
      PackageJson({
        name: "widget",
        version: "0.1.0",
        publish: { entry: lib, access: undefined, provenance: undefined }
      }),
      [[lib, "//packages/widget:lib"]]
    )
    expect(fields["publishConfig"]).toEqual({ access: "public", provenance: true })
  })

  it("fails precisely when the entry declares no outDir, no format, or no entries", () => {
    const Fake = Target.make("PackageJsonTestPublishFake", {
      attrs: Schema.Struct({
        outDir: Schema.optional(Schema.String),
        format: Schema.optional(Schema.String),
        entries: Schema.optional(Schema.Array(Schema.String))
      }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("PackageJsonTestPublishFake")
    })
    const named = (attrs: {
      readonly outDir?: string
      readonly format?: string
      readonly entries?: ReadonlyArray<string>
    }): Target.AnyTarget => Fake(attrs)
    const options = { access: "public", provenance: true } as const
    expect(() => publishFields(named({ format: "dual" }), "//p:lib", options)).toThrow(/declares no outDir attr/)
    expect(() => publishFields(named({ outDir: "dist" }), "//p:lib", options)).toThrow(/declares the format/)
    expect(() => publishFields(named({ outDir: "dist", format: "iife" }), "//p:lib", options)).toThrow(
      /declares the format "iife"/
    )
    expect(() => publishFields(named({ outDir: "dist", format: "dual" }), "//p:lib", options)).toThrow(
      /declares no entries/
    )
    expect(() => publishFields(named({ outDir: "dist", format: "dual", entries: [""] }), "//p:lib", options))
      .toThrow(/entry without a path/)
    expect(() =>
      publishFields(named({ outDir: "dist", format: "dual", entries: ["src/index.ts"] }), "//p:lib", options)
    )
      .toThrow(/no supported TsBuild distribution layout/)
  })
})

describe("template merge", () => {
  const template = PackageJsonTemplate.make({
    type: "module",
    license: "MIT",
    author: "flows",
    engines: { node: ">=26.4.0" },
    scripts: PackageJsonTemplate.standardScripts
  })

  it("merges the package over the template and merges scripts by key", () => {
    const lib = build("packages/widget")
    const fields = manifest(
      PackageJson({
        name: "widget",
        version: "0.1.0",
        license: "Apache-2.0",
        template,
        scripts: { build: lib }
      }),
      [[lib, "//packages/widget:lib"]]
    )
    expect(fields["author"]).toBe("flows")
    expect(fields["engines"]).toEqual({ node: ">=26.4.0" })
    // The package wins on license; scripts merge rather than replace.
    expect(fields["license"]).toBe("Apache-2.0")
    expect(fields["scripts"]).toEqual({
      test: "vitest run",
      "test:coverage": "vitest run --coverage",
      build: "smithers-build build //packages/widget:lib"
    })
  })

  it("replaces arrays wholesale and descends into plain objects", () => {
    expect(merge({ files: ["a", "b"] }, { files: ["c"] })).toEqual({ files: ["c"] })
    expect(merge({ engines: { node: "22", bun: "1" } }, { engines: { node: "24" } })).toEqual({
      engines: { node: "24", bun: "1" }
    })
  })

  it("refuses a manager-owned field in a template", () => {
    expect(() => PackageJsonTemplate.make({ fields: { devDependencies: {} } })).toThrow(
      /the package manager owns/
    )
  })

  it("validates template option shapes and nested string records", () => {
    expect(() => PackageJsonTemplate.make(null as never)).toThrowError(
      new TypeError("PackageJsonTemplate options must be a plain object")
    )
    expect(() => PackageJsonTemplate.make(Object.create({ inherited: true }) as never)).toThrowError(
      new TypeError("PackageJsonTemplate options must be a plain object")
    )
    expect(() => PackageJsonTemplate.make({ [Symbol("option")]: true } as never)).toThrowError(
      new TypeError("PackageJsonTemplate options must not carry symbol-keyed properties")
    )
    expect(() => PackageJsonTemplate.make({ type: "script" })).toThrow(/module.*commonjs/)
    expect(() => PackageJsonTemplate.make({ engines: { node: 22 } as never })).toThrow(/must be a non-empty/)
    expect(() => PackageJsonTemplate.make({ fields: { scripts: {} } })).toThrow(
      /modeled field "scripts" twice/
    )
    expect(() => PackageJsonTemplate.make({ typo: true } as never)).toThrow(/unknown option "typo"/)
    expect(PackageJsonTemplate.make({ author: undefined }).fields).not.toHaveProperty("author")
    expect(PackageJsonTemplate.make({ fields: { custom: true } }).fields).toMatchObject({ custom: true })
  })
})

describe("__proto__ manifest keys", () => {
  const own = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>
  const rendered = (declaration: ReturnType<typeof PackageJson>, entries = [] as Array<[Target.AnyTarget, string]>) =>
    own(render(manifest(declaration, entries)))

  it.each([
    ["string", "{\"ordinary\":\"kept\",\"__proto__\":\"kept\"}"],
    ["object", "{\"ordinary\":{\"nested\":\"kept\"},\"__proto__\":{\"nested\":\"kept\"}}"]
  ])("keeps a %s __proto__ field through the package constructor and template", (_kind, json) => {
    const expected = own(json)
    const direct = rendered(PackageJson({ name: "widget", version: "0.1.0", fields: own(json) }))
    expect(Object.hasOwn(direct, "__proto__")).toBe(true)
    expect(direct["__proto__"]).toEqual(expected["__proto__"])
    expect(direct["ordinary"]).toEqual(expected["ordinary"])
    const template = PackageJsonTemplate.make({ fields: own(json) })
    expect(Object.getPrototypeOf(template.fields)).toBe(null)
    expect(Object.keys(template.fields)).toEqual(["ordinary", "__proto__"])
    const merged = rendered(PackageJson({ name: "widget", version: "0.1.0", template }))
    expect(Object.hasOwn(merged, "__proto__")).toBe(true)
    expect(merged["__proto__"]).toEqual(expected["__proto__"])
    expect(merged["ordinary"]).toEqual(expected["ordinary"])
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it("resolves a script named __proto__ beside an ordinary script", () => {
    const lib = build("packages/widget")
    const declaration = PackageJson({ name: "widget", version: "0.1.0", scripts: { build: lib, ["__proto__"]: lib } })
    const scripts = rendered(declaration, [[lib, "//packages/widget:lib"]])["scripts"] as Record<string, unknown>
    expect(Object.keys(scripts).sort()).toEqual(["__proto__", "build"])
    expect(scripts["__proto__"]).toBe("smithers-build build //packages/widget:lib")
    expect(scripts["build"]).toBe("smithers-build build //packages/widget:lib")
  })
})

describe("render", () => {
  it("orders keys by the sort-package-json convention and sorts scripts", () => {
    const text = render({
      scripts: { lint: "b", build: "a" },
      version: "0.1.0",
      zzz: 1,
      aaa: 2,
      name: "widget",
      license: "MIT"
    })
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["name", "version", "license", "scripts", "aaa", "zzz"])
    expect(Object.keys((JSON.parse(text) as { scripts: object }).scripts)).toEqual(["build", "lint"])
    expect(text.endsWith("}\n")).toBe(true)
    expect(Object.keys(JSON.parse(render({ aaa: 1, zzz: 2 })) as object)).toEqual(["aaa", "zzz"])
  })

  it("preserves __proto__ as data and refuses values JSON would change", () => {
    const text = render(JSON.parse("{\"name\":\"widget\",\"__proto__\":{\"safe\":true}}") as Record<string, unknown>)
    expect(JSON.parse(text)).toEqual(JSON.parse("{\"name\":\"widget\",\"__proto__\":{\"safe\":true}}"))
    expect(() => render({ value: undefined })).toThrow(/undefined/)
    expect(() => render({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite/)
  })

  it("bounds the final encoded manifest after deterministic ordering", () => {
    let nested: unknown = Array.from({ length: 70_000 }, () => 0)
    for (let depth = 0; depth < 32; depth += 1) nested = [nested]
    expect(() => render({ nested })).toThrow(
      `manifest fields exceed the ${maximumManifestBytes}-byte rendered manifest limit`
    )
  })
})

describe("diffFields", () => {
  it("names every differing field", () => {
    expect(diffFields({ name: "a", version: "2" }, { name: "a", version: "1", extra: true })).toEqual([
      `version: expected "2", found "1"`,
      "extra: unexpected true"
    ])
    expect(diffFields({ name: "a" }, {})).toEqual([`name: missing, expected "a"`])
    expect(diffFields({ nullable: null }, {})).toEqual(["nullable: missing, expected null"])
    expect(diffFields({}, { nullable: null })).toEqual(["nullable: unexpected null"])
    const [bounded] = diffFields({ custom: "a".repeat(200) }, { custom: "b".repeat(200) })
    expect(bounded).toContain("...")
    expect(bounded?.length).toBeLessThan(300)
  })
})

/** A sync payload for a manifest at `package.json` in the temp workspace. */
const payload = (over: Partial<SyncPayload> = {}): SyncPayload => ({
  path: "package.json",
  mode: "check",
  fields: { name: "widget", version: "0.1.0", license: "MIT" },
  generated: [],
  readme: null,
  sources: null,
  promptVersion: "1",
  engine: "claude",
  model: "sonnet",
  ...over
})

const run = (value: SyncPayload, executable?: string): Promise<void> =>
  Effect.runPromise(sync({ workspaceRoot: root, cacheDirectory: ".flows", executable }, value))

const failure = (value: SyncPayload, executable?: string): Promise<{ readonly message: string }> =>
  Effect.runPromise(Effect.flip(sync({ workspaceRoot: root, cacheDirectory: ".flows", executable }, value)))

describe("check and write roundtrip", () => {
  it("writes a manifest the check then accepts", async () => {
    await run(payload({ mode: "write" }))
    const written = await Fs.readFile(NodePath.join(root, "package.json"), "utf8")
    expect(JSON.parse(written)).toEqual({ name: "widget", version: "0.1.0", license: "MIT" })
    await run(payload())
  })

  it("fails the check with a field-level diff", async () => {
    await Fs.writeFile(
      NodePath.join(root, "package.json"),
      `${JSON.stringify({ name: "widget", version: "0.0.9", license: "MIT" }, undefined, 2)}\n`,
      "utf8"
    )
    const drift = await failure(payload())
    expect(drift.message).toContain(`version: expected "0.1.0", found "0.0.9"`)
  })

  it("reports formatting drift when every field already matches", async () => {
    await Fs.writeFile(
      NodePath.join(root, "package.json"),
      `${JSON.stringify({ license: "MIT", version: "0.1.0", name: "widget" })}\n`,
      "utf8"
    )
    const drift = await failure(payload())
    expect(drift.message).toContain("key order or formatting")
  })

  it("reports a missing manifest", async () => {
    const drift = await failure(payload())
    expect(drift.message).toContain("missing")
  })

  it("carries manager-owned dependency blocks through instead of generating them", async () => {
    await Fs.writeFile(
      NodePath.join(root, "package.json"),
      `${
        JSON.stringify(
          {
            name: "widget",
            version: "0.1.0",
            license: "MIT",
            dependencies: { effect: "4.0.0" },
            devDependencies: { vitest: "4" }
          },
          undefined,
          2
        )
      }\n`,
      "utf8"
    )
    await run(payload())
    await run(payload({ mode: "write" }))
    const written = JSON.parse(await Fs.readFile(NodePath.join(root, "package.json"), "utf8")) as {
      dependencies: unknown
      devDependencies: unknown
    }
    expect(written.dependencies).toEqual({ effect: "4.0.0" })
    expect(written.devDependencies).toEqual({ vitest: "4" })
  })

  it("refuses a checked-in manifest that is not valid JSON", async () => {
    await Fs.writeFile(NodePath.join(root, "package.json"), "{ not json", "utf8")
    const drift = await failure(payload())
    expect(drift.message).toContain("not valid JSON")
  })

  it("bounds and strictly decodes the checked-in manifest", async () => {
    await Fs.writeFile(NodePath.join(root, "package.json"), Buffer.alloc(maximumManifestBytes + 1, 0x20))
    expect((await failure(payload())).message).toContain(`larger than ${maximumManifestBytes} bytes`)
    await Fs.writeFile(NodePath.join(root, "package.json"), Buffer.from([0xff]))
    expect((await failure(payload())).message).toContain("not valid UTF-8")
  })

  it("never follows a final manifest symlink", async () => {
    await Fs.writeFile(NodePath.join(root, "actual.json"), render(payload().fields), "utf8")
    await Fs.symlink("actual.json", NodePath.join(root, "package.json"))
    expect((await failure(payload())).message).toContain("symbolic link")
  })

  it("reports non-JSON declared fields through the typed failure channel", async () => {
    const invalid = payload({ fields: { name: "widget", custom: BigInt(1) } })
    expect((await failure(invalid)).message).toContain("declared manifest fields are invalid")
  })

  it("rejects duplicate generated fields through the sync failure channel", async () => {
    const drift = await failure(payload({ generated: ["description", "description"] }))
    expect(drift.message).toContain("generated field list contains duplicates")
  })
})

describe("generated fields, cache, and refresh", () => {
  /** A fake engine CLI that answers with one claude-shaped JSON envelope. */
  const fakeClaude = async (answer: string): Promise<string> => {
    const path = NodePath.join(root, "fake-claude.mjs")
    await Fs.writeFile(
      path,
      `process.stdout.write(JSON.stringify({ result: ${JSON.stringify(answer)} }))\n`,
      "utf8"
    )
    const shim = NodePath.join(root, "fake-claude")
    await Fs.writeFile(shim, `#!/bin/sh\nexec node ${JSON.stringify(path)}\n`, "utf8")
    await Fs.chmod(shim, 0o755)
    return shim
  }

  const withGenerated = (over: Partial<SyncPayload> = {}): SyncPayload =>
    payload({
      generated: ["description", "keywords"],
      readme: Input.file("//README.md"),
      sources: Input.glob("//src/**/*.ts"),
      ...over
    })

  beforeEach(async () => {
    await Fs.writeFile(NodePath.join(root, "README.md"), "# widget\n", "utf8")
    await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "src/index.ts"), "export const widget = 1\n", "utf8")
  })

  it("accepts only an exact, bounded model JSON object", () => {
    expect(parseGenerated(
      "{\"description\":\"a widget\",\"keywords\":[\"widget\",\"test\",\"typescript\"]}",
      ["description", "keywords"]
    )).toEqual({ description: "a widget", keywords: ["widget", "test", "typescript"] })
    for (
      const answer of [
        "prose {\"description\":\"a widget\"}",
        "```json\n{\"description\":\"a widget\"}\n```",
        "{\"description\":\"a widget\",\"extra\":true}",
        "{\"description\":\" a widget \"}",
        "{\"keywords\":[\"widget\",\"widget\",\"typescript\"]}"
      ]
    ) {
      expect(() => parseGenerated(answer, answer.includes("keywords") ? ["keywords"] : ["description"]))
        .toThrow()
    }
    expect(() => parseGenerated("{}", [])).toThrow(/empty or contains duplicates/)
    expect(() => parseGenerated("{\"description\":\"a widget\"}", ["description", "description"])).toThrow(
      /empty or contains duplicates/
    )
    expect(() => parseGenerated("x".repeat(maximumGeneratedResponseBytes + 1), ["description"])).toThrow(
      `exceeds ${maximumGeneratedResponseBytes} bytes`
    )
    expect(() => parseGenerated("   ", ["description"])).toThrow(/response is empty/)
    expect(() => parseGenerated("[]", ["description"])).toThrow(/not a JSON object/)
    expect(() => parseGenerated("{\"keywords\":[\"one\",\"two\"]}", ["keywords"]))
      .toThrow(/invalid keywords array/)
    expect(() =>
      parseGenerated(
        "{\"keywords\":[\"one\",\"two\",\"three\",\"four\",\"five\",\"six\",\"seven\",\"eight\",\"nine\"]}",
        ["keywords"]
      )
    ).toThrow(/invalid keywords array/)
  })

  it("keys generated prose by package, engine, model, prompt, and declared inputs", async () => {
    const base = withGenerated()
    const contexts = await Promise.all([
      generationContext(root, base, { cacheDirectory: ".flows" }),
      generationContext(root, { ...base, fields: { ...base.fields, name: "other" } }, { cacheDirectory: ".flows" }),
      generationContext(root, { ...base, engine: "codex" }, { cacheDirectory: ".flows" }),
      generationContext(root, { ...base, model: "another" }, { cacheDirectory: ".flows" }),
      generationContext(root, { ...base, promptVersion: "2" }, { cacheDirectory: ".flows" })
    ])
    expect(new Set(contexts.map((context) => context.digest)).size).toBe(contexts.length)
  })

  it("builds a stable generation context when optional inputs are absent", async () => {
    const context = await generationContext(root, payload(), { cacheDirectory: ".flows" })
    expect(context.readme).toBe("")
    expect(context.sources).toEqual([])
    expect(context.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("fails when a declared generation README is missing", async () => {
    await Fs.unlink(NodePath.join(root, "README.md"))
    expect((await failure(withGenerated({ mode: "write" }))).message).toContain("README is missing")
  })

  it("leaves a generated field out when nothing is cached and nothing is on disk", async () => {
    await run(withGenerated({ mode: "write" }))
    const written = JSON.parse(await Fs.readFile(NodePath.join(root, "package.json"), "utf8")) as object
    expect("description" in written).toBe(false)
    expect("keywords" in written).toBe(false)
  })

  it("retains the on-disk value optimistically with no cache and no model", async () => {
    await Fs.writeFile(
      NodePath.join(root, "package.json"),
      `${
        JSON.stringify(
          {
            name: "widget",
            version: "0.1.0",
            description: "hand written",
            keywords: ["existing"],
            license: "MIT"
          },
          undefined,
          2
        )
      }\n`,
      "utf8"
    )
    // The check passes: an unrefreshed prose field is never a drift.
    await run(withGenerated())
  })

  it("refresh calls the model, caches the answer, and later checks offline", async () => {
    const executable = await fakeClaude(
      `{"description": "a widget", "keywords": ["widget", "test", "typescript"]}`
    )
    await run(withGenerated({ mode: "refresh" }), executable)
    const written = JSON.parse(await Fs.readFile(NodePath.join(root, "package.json"), "utf8")) as {
      description: string
      keywords: ReadonlyArray<string>
    }
    expect(written.description).toBe("a widget")
    expect(written.keywords).toEqual(["widget", "test", "typescript"])
    const cache = await Fs.readdir(NodePath.join(root, ".flows", fieldCacheDirectory))
    expect(cache).toHaveLength(1)
    // The check reuses the cached answer without an executable in reach.
    await run(withGenerated())
  })

  it("re-keys the cached answer when a declared input changes", async () => {
    const executable = await fakeClaude(
      `{"description": "a widget", "keywords": ["widget", "package", "typescript"]}`
    )
    await run(withGenerated({ mode: "refresh" }), executable)
    await Fs.writeFile(NodePath.join(root, "README.md"), "# widget, rewritten\n", "utf8")
    // The digest moved, so the cached answer no longer applies; the check falls
    // back to what is already on disk and still passes.
    await run(withGenerated())
    await run(withGenerated({ mode: "refresh" }), executable)
    const cache = await Fs.readdir(NodePath.join(root, ".flows", fieldCacheDirectory))
    expect(cache).toHaveLength(2)
  })

  it("treats malformed, oversized, and link-substituted cache rows as misses", async () => {
    const executable = await fakeClaude(
      `{"description": "a widget", "keywords": ["widget", "cache", "typescript"]}`
    )
    await run(withGenerated({ mode: "refresh" }), executable)
    const directory = NodePath.join(root, ".flows", fieldCacheDirectory)
    const [entry] = await Fs.readdir(directory)
    expect(entry).toBeDefined()
    const path = NodePath.join(directory, entry!)

    const original = JSON.parse(await Fs.readFile(path, "utf8")) as {
      readonly version: number
      readonly contextDigest: string
      readonly fields: Record<string, unknown>
    }
    const different = { description: "different", keywords: ["other", "cache", "value"] }
    const invalidEnvelopes: ReadonlyArray<unknown> = [
      { ...original, extra: true, fields: different },
      { ...original, version: 2, fields: different },
      { ...original, contextDigest: "wrong-digest", fields: different },
      { ...original, fields: [] },
      { ...original, fields: { ...different, extra: true } },
      { ...original, fields: { description: "", keywords: different.keywords } }
    ]
    for (const envelope of invalidEnvelopes) {
      await Fs.writeFile(path, JSON.stringify(envelope), "utf8")
      await run(withGenerated())
    }

    await Fs.writeFile(path, "{ malformed", "utf8")
    await run(withGenerated())
    await Fs.writeFile(path, Buffer.alloc(maximumFieldCacheBytes + 1, 0x20))
    await run(withGenerated())

    await Fs.unlink(path)
    await Fs.writeFile(NodePath.join(root, "cache-target.json"), "{}", "utf8")
    await Fs.symlink(NodePath.relative(directory, NodePath.join(root, "cache-target.json")), path)
    await run(withGenerated())
  })

  it("fails refresh with a precise message when the model answers with prose", async () => {
    const executable = await fakeClaude("I cannot help with that.")
    const error = await failure(withGenerated({ mode: "refresh" }), executable)
    expect(error.message).toContain("not strict JSON")
  })
})

describe("target synthesis", () => {
  it("produces one cacheable lint target and two run targets", () => {
    const lib = build("packages/widget")
    const expanded = targets(
      PackageJson({ name: "widget", version: "0.1.0", publish: { entry: lib } }),
      "packages/widget",
      labeller([[lib, "//packages/widget:lib"]])
    )
    const check = Target.metadata(expanded.check)
    expect(check.target).toBe("PackageJsonCheck")
    expect(check.kinds).toEqual(["lint"])
    expect(check.cacheable).toBe(true)
    expect(check.inputs).toContainEqual(Input.file("//packages/widget/package.json"))
    for (const target of [expanded.write, expanded.refresh]) {
      const metadata = Target.metadata(target)
      expect(metadata.target).toBe("PackageJsonWrite")
      expect(metadata.kinds).toEqual(["run"])
      expect(metadata.cacheable).toBe(false)
    }
    expect((Target.metadata(expanded.refresh).attrs as { mode: string }).mode).toBe("refresh")
  })

  it.each(["write", "refresh"] as const)("coerces %s to check in lint metadata", (mode) => {
    const target = PackageJsonCheck({
      output: "//package.json",
      fields: payload().fields,
      generated: [],
      readme: null,
      sources: null,
      mode
    })
    expect(Target.metadata(target).forKind("lint").attrs).toMatchObject({ mode: "check" })
  })

  it.each(["write", "refresh"] as const)("forces %s to check in the action payload", async (mode) => {
    const target = PackageJsonCheck({
      output: "//package.json",
      fields: payload().fields,
      generated: ["description"],
      readme: null,
      sources: null,
      mode
    })
    const value = Schema.decodeUnknownSync(SyncPayload)(plannedCalls(target)[0]!.payload)
    expect(value.mode).toBe("check")
    const original = render({ name: "widget", version: "0.0.9", description: "A widget." })
    await Fs.writeFile(NodePath.join(root, "package.json"), original)
    expect((await failure(value, "missing-package-json-model")).message).toContain("version: expected")
    expect(await Fs.readFile(NodePath.join(root, "package.json"), "utf8")).toBe(original)
  })

  it.each(["check", "write", "refresh"] as const)(
    "keys %s generation on sources within the declaring package",
    async (kind) => {
      const directory = NodePath.join(root, "packages/widget")
      await Fs.mkdir(NodePath.join(directory, "src/nested"), { recursive: true })
      await Fs.writeFile(NodePath.join(directory, "PACKAGE.ts"), "// package boundary\n")
      await Fs.writeFile(NodePath.join(directory, "README.md"), "# widget\n")
      await Fs.writeFile(NodePath.join(directory, "src/index.ts"), "export const widget = 1\n")
      await Fs.writeFile(NodePath.join(directory, "src/nested/PACKAGE.ts"), "// nested boundary\n")
      await Fs.writeFile(NodePath.join(directory, "src/nested/hidden.ts"), "export const hidden = 1\n")
      const expanded = targets(
        PackageJson({ name: "widget", version: "0.1.0", description: generated }),
        "packages/widget",
        labeller([])
      )
      const value = Schema.decodeUnknownSync(SyncPayload)(plannedCalls(expanded[kind])[0]!.payload)
      const first = await generationContext(root, value)
      expect(first.sources).toEqual(["packages/widget/src/index.ts"])
      await Fs.writeFile(NodePath.join(directory, "src/added.ts"), "export const added = 1\n")
      const added = await generationContext(root, value)
      expect(added.sources).toEqual(["packages/widget/src/added.ts", "packages/widget/src/index.ts"])
      expect(added.digest).not.toBe(first.digest)
      await Fs.writeFile(NodePath.join(directory, "src/index.ts"), "export const widget = 2\n")
      await Fs.writeFile(NodePath.join(directory, "src/nested/another.ts"), "export const another = 1\n")
      expect((await generationContext(root, value)).digest).toBe(added.digest)
      await Fs.unlink(NodePath.join(directory, "src/added.ts"))
      expect((await generationContext(root, value)).digest).toBe(first.digest)
    }
  )

  it("carries the declaration context when a check target is constructed directly", async () => {
    const directory = NodePath.join(root, "packages/widget")
    await Fs.mkdir(NodePath.join(directory, "src"), { recursive: true })
    await Fs.writeFile(NodePath.join(directory, "PACKAGE.ts"), "// package boundary\n")
    await Fs.writeFile(NodePath.join(directory, "src/index.ts"), "export const widget = 1\n")
    const declare = Vm.compileFunction("return make(attrs)", ["make", "attrs"], {
      filename: NodePath.join(directory, "PACKAGE.ts")
    })
    const target: Target.AnyTarget = declare(PackageJsonCheck, {
      output: "//package.json",
      fields: payload().fields,
      generated: ["description"],
      readme: null,
      sources: Input.glob("//packages/widget/src/**/*.ts"),
      mode: "check"
    })
    expect(Target.metadata(target).sourceFile).toBe(NodePath.join(directory, "PACKAGE.ts"))
    const value = Schema.decodeUnknownSync(SyncPayload)(plannedCalls(target)[0]!.payload)
    expect((await generationContext(root, value)).sources).toEqual(["packages/widget/src/index.ts"])
  })

  it("anchors the manifest, README, and source glob at the workspace root", () => {
    const expanded = targets(
      PackageJson({ name: "widget", version: "0.1.0", description: generated }),
      "packages/widget",
      labeller([])
    )
    const attrs = Target.metadata(expanded.check).attrs as {
      output: string
      readme: Input.File
      sources: Input.Glob
    }
    expect(attrs.output).toBe("//packages/widget/package.json")
    expect(attrs.readme.path).toBe("//packages/widget/README.md")
    expect(attrs.sources.pattern).toBe("//packages/widget/src/**/*.ts")
  })
})
