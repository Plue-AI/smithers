import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as DtsBuild from "../src/DtsBuild.ts"
import * as Input from "../src/Input.ts"
import * as Install from "../src/Install.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as SortPackageJson from "../src/SortPackageJson.ts"
import * as Target from "../src/Target.ts"
import * as TsBuild from "../src/TsBuild.ts"
import * as TypedocDocs from "../src/TypedocDocumentation.ts"
import { packageManager, runtime } from "./toolchain.ts"

describe("Install declared inputs", () => {
  it("declares the manager's lockfile, npmrc, root manifest, and pnpm hook", () => {
    const metadata = Target.metadata(Install.Install({ packageManager }))
    expect(metadata.inputs).toEqual([
      { _tag: "File", path: "pnpm-lock.yaml" },
      { _tag: "File", path: ".npmrc" },
      { _tag: "File", path: "package.json" },
      { _tag: "File", path: ".pnpmfile.mjs" }
    ])
    expect(metadata.inputs).toHaveLength(4)
    expect(metadata.inputs.map((input) => input._tag === "File" ? Input.resolvePath("", input.path) : input._tag))
      .toEqual(["pnpm-lock.yaml", ".npmrc", "package.json", ".pnpmfile.mjs"])
    expect(metadata.cacheable).toBe(false)
  })

  it("refuses the Bun package manager as unsupported when the target is declared", () => {
    const bun = PackageManager.BunPackages({ runtime: Runtime.Bun({ version: ">=1.4.0" }) })
    expect(() => Install.Install({ packageManager: bun })).toThrow(
      /unsupported: Install cannot use the Bun package manager/
    )
  })

  it("rejects a bare string where the manager declaration belongs", () => {
    expect(() => Install.Install({ packageManager: "pnpm@11.21.0" } as never)).toThrow()
  })
})

describe("entry-point file attrs", () => {
  const entry = Input.file("src/index.ts")
  const tsconfig = Input.file("tsconfig.json")

  it("accepts Input.File and rejects strings for TsBuild entries", () => {
    const attrs = {
      packageManager,
      srcs: [],
      entries: [entry],
      deps: [],
      tsconfig,
      tool: { name: "tsup" as const, external: [] },
      format: "esm" as const,
      outDir: "dist"
    }
    expect(Target.metadata(TsBuild.TsBuild(attrs)).inputs).toEqual([entry, tsconfig])
    expect(() => TsBuild.TsBuild({ ...attrs, entries: ["src/index.ts"] } as never)).toThrow()
  })

  it("accepts Input.File and rejects strings for DtsBuild entries", () => {
    const attrs = {
      packageManager,
      srcs: [],
      entries: [entry],
      deps: [],
      tsconfig,
      tool: { name: "tsup" as const },
      outDir: "dist"
    }
    expect(Target.metadata(DtsBuild.DtsBuild(attrs)).inputs).toEqual([entry, tsconfig])
    expect(() => DtsBuild.DtsBuild({ ...attrs, entries: ["src/index.ts"] } as never)).toThrow()
  })

  it("accepts Input.File and rejects strings for TypeDoc entry points", () => {
    const attrs = {
      packageManager,
      sources: [],
      deps: [],
      tsconfig,
      config: null,
      entryPoints: [entry],
      outDir: "docs/api",
      plugin: []
    }
    const metadata = Target.metadata(TypedocDocs.TypedocDocs(attrs))
    expect(metadata.inputs).toEqual([tsconfig, entry])
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["docs/api"] })
    expect(() => TypedocDocs.TypedocDocs({ ...attrs, entryPoints: ["src/index.ts"] } as never)).toThrow()
  })
})

describe("LlmLint typed glob attrs", () => {
  const attrs = {
    changes: Input.gitDiff("HEAD"),
    include: [Input.glob("//packages/*/src/**")],
    context: [Input.glob("//docs/reference/*.md")],
    deps: [],
    prompt: "p",
    rubric: "r",
    model: "claude-opus-5",
    batchSize: 4
  }

  it("accepts globs, rejects strings, and collects each declaration once", () => {
    const metadata = Target.metadata(LlmLint.LlmLint(attrs))
    expect(metadata.inputs).toEqual([attrs.changes, ...attrs.include, ...attrs.context])
    expect(() => LlmLint.LlmLint({ ...attrs, include: ["packages/*/src/**"] } as never)).toThrow()
    expect(() => LlmLint.LlmLint({ ...attrs, context: ["README.md"] } as never)).toThrow()
  })
})

describe("SortPackageJson declared manifests", () => {
  it("requires caller-declared files and collects each manifest once", () => {
    const manifest = Input.file("package.json")
    const target = SortPackageJson.SortPackageJson({ packageManager, manifests: [manifest], deps: [], check: true })
    const metadata = Target.metadata(target)
    expect(metadata.inputs).toEqual([manifest])
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["package.json"] })
    expect(() =>
      SortPackageJson.SortPackageJson({ packageManager, manifests: ["package.json"], deps: [], check: true } as never)
    )
      .toThrow()
    expect(() => SortPackageJson.SortPackageJson({ packageManager, manifests: [], deps: [], check: true } as never))
      .toThrow()
  })
})

describe("Target.make input collection", () => {
  const Attrs = Schema.Struct({ input: Input.File })
  const WithInputCallback = Target.make("WithInputCallback", {
    attrs: Attrs,
    kinds: [],
    inputs: (attrs) => [attrs.input],
    implementation: () => Target.notImplemented("WithInputCallback")
  })

  it("deduplicates one attr declaration returned by an inputs callback", () => {
    const input = Input.file("input.txt")
    expect(Target.metadata(WithInputCallback({ input })).inputs).toEqual([input])
  })
})
