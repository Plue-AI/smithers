import type * as Dprint from "@smthrs/targets/Dprint"
import type * as EsLint from "@smthrs/targets/EsLint"
import * as Filegroup from "@smthrs/targets/Filegroup"
import * as Input from "@smthrs/targets/Input"
import * as NodeTest from "@smthrs/targets/NodeTest"
import * as Target from "@smthrs/targets/Target"
import * as TsBuild from "@smthrs/targets/TsBuild"
import type * as Typecheck from "@smthrs/targets/Typecheck"
import type * as Vitest from "@smthrs/targets/Vitest"
import { globSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Package as PluginPackage } from "../../smithers/agent/plugin/PACKAGE.ts"
import { BuildAndCheckTypeScriptPackage } from "../src/BuildAndCheckTypeScriptPackage.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

describe("BuildAndCheckTypeScriptPackage docsFiles", () => {
  const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/plan" })

  it("emits a Filegroup over the package's documentation beside the verb targets", () => {
    const metadata = Target.metadata(targets.docsFiles)
    expect(metadata.target).toBe("Filegroup")
    expect(metadata.kinds).toEqual([])
    expect(Filegroup.isFilegroup(targets.docsFiles)).toBe(true)
  })

  it("names the colocated docs, the README, and the manifest under the package cwd", () => {
    expect(Filegroup.sources(Target.metadata(targets.docsFiles).attrs as Filegroup.Attrs)).toEqual([
      { _tag: "Glob", pattern: "packages/smithers/flows/plan/docs/**/*.md", exclude: [] },
      { _tag: "File", path: "packages/smithers/flows/plan/README.md" },
      { _tag: "File", path: "packages/smithers/flows/plan/package.json" }
    ])
  })

  it("follows a readme override", () => {
    const overridden = BuildAndCheckTypeScriptPackage({
      packageManager,
      deps: [],
      cwd: "packages/x",
      readme: { _tag: "File", path: "docs/README.md" }
    })
    expect(Filegroup.sources(Target.metadata(overridden.docsFiles).attrs as Filegroup.Attrs)).toContainEqual(
      { _tag: "File", path: "packages/x/docs/README.md" }
    )
  })
})

const attrsOf = <A>(target: Target.AnyTarget): A => Target.metadata(target).attrs as A

describe("BuildAndCheckTypeScriptPackage leaves the manager to the workspace", () => {
  it("every emitted target declares none and expects one filled in", () => {
    const standard = BuildAndCheckTypeScriptPackage({ cwd: "packages/example" })
    for (const target of [standard.lib, standard.check, standard.test, standard.lint, standard.fmt]) {
      const metadata = Target.metadata(target)
      expect((metadata.attrs as { readonly packageManager?: unknown }).packageManager).toBeUndefined()
      expect([...metadata.workspaceAttrs]).toContain("packageManager")
    }
    expect((Target.metadata(standard.circular).attrs as { readonly runtime?: unknown }).runtime).toBeUndefined()
    expect([...Target.metadata(standard.circular).workspaceAttrs]).toEqual(["runtime"])
  })

  it("a caller that names a manager still gets it", () => {
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(plannedArgv(standard.check)).toEqual([
      "pnpm",
      "exec",
      "tsc",
      "-p",
      "tsconfig.test.json",
      "--noEmit"
    ])
  })
})

describe("BuildAndCheckTypeScriptPackage circular guard", () => {
  /**
   * `pnpm run circular` fanned out to a per-package script the target graph did
   * not know about, so `smithers-build ci` was not gate-equivalent to the pnpm scripts
   * it was meant to replace. The macro emits it now.
   */
  it("emits the conventional per-package circular-dependency guard", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/smithers/flows/plan" })
    const attrs = attrsOf<NodeTest.Attrs>(targets.circular)
    expect(NodeTest.runArgv(attrs)).toEqual(["node", "scripts/circular.mjs"])
    expect(attrs.cwd).toBe("packages/smithers/flows/plan")
    // The interpreter is the one the declared manager runs under, not a
    // hardcoded `node`.
    expect(attrs.runtime).toEqual(packageManager.runtime)
  })

  it("takes another guard when a package keeps one elsewhere", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/smithers/flows/plan",
      circularScript: Input.file("tools/cycles.mjs")
    })
    expect(NodeTest.runArgv(attrsOf<NodeTest.Attrs>(targets.circular)))
      .toEqual(["node", "tools/cycles.mjs"])
  })
})

describe("BuildAndCheckTypeScriptPackage lib", () => {
  it("builds the dual distribution the published manifests describe", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    const metadata = Target.metadata(targets.lib)
    expect(metadata.attrs).toMatchObject({
      format: "dual",
      outDir: "dist",
      tool: { name: "program", entry: { _tag: "File", path: "scripts/build.mjs" } }
    })
    expect(metadata.outputs).toEqual({ cwd: "packages/example", paths: ["dist/esm", "dist/cjs"] })
  })

  it("takes another build program without replacing the macro", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      buildProgram: Input.file("scripts/dist.mjs")
    })
    expect(Target.metadata(targets.lib).attrs).toMatchObject({
      tool: { name: "program", entry: { _tag: "File", path: "scripts/dist.mjs" } }
    })
  })
})

describe("BuildAndCheckTypeScriptPackage", () => {
  const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/plan" })

  it("changes only the outer test deadline when a package needs a larger suite budget", () => {
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    const extended = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      testTimeoutMs: 2_400_000
    })
    expect(plannedCalls(standard.test)[0]?.payload).toMatchObject({ timeoutMs: 1_200_000 })
    expect(plannedCalls(extended.test)[0]?.payload).toMatchObject({ timeoutMs: 2_400_000 })
    expect(plannedArgv(extended.test)).toEqual(plannedArgv(standard.test))
    expect(Target.metadata(extended.test).attrs).toEqual({
      ...attrsOf<Vitest.Attrs>(standard.test),
      timeoutMs: 2_400_000
    })
  })

  it("emits a docs target beside lib, test, and lint", () => {
    expect(Target.metadata(targets.docs).target).toBe("DocsParity")
    expect(Target.metadata(targets.docs).kinds).toEqual(["docs"])
  })

  it("keeps docs as a separately planned target kind", () => {
    for (const target of [targets.lib, targets.test, targets.lint]) {
      expect(Target.metadata(target).kinds).not.toContain("docs")
    }
  })

  it("requires cwd, since every default input is package-shaped", () => {
    expectTypeOf(() =>
      // @ts-expect-error cwd is required.
      BuildAndCheckTypeScriptPackage({ packageManager })
    ).toBeFunction()
  })

  it("roots an explicit '.' cwd at the workspace and explicitly disables a config when asked", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: ".", vitestConfig: null })
    expect(Filegroup.sources(Target.metadata(targets.docsFiles).attrs as Filegroup.Attrs)).toEqual([
      Input.glob("docs/**/*.md"),
      Input.file("README.md"),
      Input.file("package.json")
    ])
    expect(plannedArgv(targets.test)).toEqual(["pnpm", "exec", "vitest", "run", "--environment", "node"])
  })

  it("runs the explicitly selected Vitest config from the declaring package", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      vitestConfig: Input.file("config/coverage.ts")
    })
    expect(Target.metadata(targets.test).attrs).toMatchObject({ cwd: "packages/example" })
    expect(plannedArgv(targets.test)).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--config",
      "config/coverage.ts",
      "--environment",
      "node"
    ])
  })
})

describe("package formatting", () => {
  it("joins BuildAndCheckTypeScriptPackage as the fmt target alongside check", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(Target.metadata(targets.fmt).target).toBe("Dprint")
    expect(Target.metadata(targets.fmt).kinds).toEqual(["lint"])
    expect(Target.metadata(targets.check).target).toBe("Typecheck")
    expect(Target.metadata(targets.check).kinds).toEqual(["build"])
    // check resolves workspace dependencies through built declarations, so
    // it must schedule after the package's own lib target.
    expect(Target.metadata(targets.check).dependencies).toContain(targets.lib)
  })
})

describe("BuildAndCheckTypeScriptPackage test data", () => {
  it("adds optional data globs to test inputs without changing the runner or other targets", () => {
    const options = {
      packageManager,
      cwd: "packages/example",
      testData: ["test/fixtures/*.mjs", "test/fixtures/*.cjs"] as const
    }
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: options.cwd })
    const withData = BuildAndCheckTypeScriptPackage(options)
    expect(Target.metadata(withData.test).inputs).toEqual([
      ...Target.metadata(standard.test).inputs.slice(0, 3),
      Input.glob("test/fixtures/*.mjs"),
      Input.glob("test/fixtures/*.cjs"),
      ...Target.metadata(standard.test).inputs.slice(3)
    ])
    expect(plannedArgv(withData.test)).toEqual(plannedArgv(standard.test))
    for (const name of ["lib", "check", "lint", "fmt", "docs", "circular", "docsFiles"] as const) {
      expect(Target.metadata(withData[name]).inputs).toEqual(Target.metadata(standard[name]).inputs)
    }
    const empty = BuildAndCheckTypeScriptPackage({ ...options, testData: [] })
    expect(Target.metadata(empty.test).inputs).toEqual(Target.metadata(standard.test).inputs)
  })

  it("declares both artifact fixtures executed by the plugin suite", () => {
    const metadata = Target.metadata(PluginPackage.test)
    const cwd = resolve(import.meta.dirname, "../../..", attrsOf<Vitest.Attrs>(PluginPackage.test).cwd)
    const paths = metadata.inputs.flatMap((input) => {
      if (input._tag === "Glob") return globSync(input.pattern, { cwd, exclude: [...input.exclude] })
      if (input._tag === "File") return [input.path]
      return []
    }).map((path) => path.replaceAll("\\", "/"))
    expect(paths).toContain("test/fixtures/artifact-esm.mjs")
    expect(paths).toContain("test/fixtures/artifact-cjs.cjs")
  })
})

describe("BuildAndCheckTypeScriptPackage dependencies", () => {
  const upstream = Filegroup.Filegroup({
    srcs: [Input.file("package.json")],
    cwd: "packages/upstream"
  })
  const second = Filegroup.Filegroup({
    srcs: [Input.file("package.json")],
    cwd: "packages/second"
  })

  /**
   * A package's declared dependencies are what makes `smithers-build ci`
   * order one package's build after the packages it imports. `check` and
   * `test` additionally read the package's own built declarations, so each
   * carries its own `lib` ahead of the caller's list.
   */
  it("hands every declared dependency to lib, check, and test, each behind its own lib", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      deps: [upstream, second]
    })
    expect(Target.metadata(targets.lib).dependencies).toEqual([upstream, second])
    expect(Target.metadata(targets.check).dependencies).toEqual([targets.lib, upstream, second])
    expect(Target.metadata(targets.test).dependencies).toEqual([targets.lib, upstream, second])
    // The gates read the working tree, not a built dependency, so a declared
    // dependency must not serialize them behind a build.
    for (const name of ["lint", "fmt", "docs", "circular", "docsFiles"] as const) {
      expect(Target.metadata(targets[name]).dependencies).toEqual([])
    }
  })

  it("keeps the self-lib edges when a package declares no dependencies", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/example" })
    expect(Target.metadata(targets.lib).dependencies).toEqual([])
    expect(Target.metadata(targets.check).dependencies).toEqual([targets.lib])
    expect(Target.metadata(targets.test).dependencies).toEqual([targets.lib])
  })
})

describe("BuildAndCheckTypeScriptPackage lint and fmt gates", () => {
  /**
   * Both targets are gates rather than fixers: CI fails on a warning and the
   * working tree is never rewritten under them. Asserting the planned argv
   * rather than the target kind is what holds that, since raising the warning
   * budget or enabling fix changes only the argv.
   */
  it("plans ESLint over the sources at zero warnings without fixing", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(plannedArgv(targets.lint)).toEqual([
      "pnpm",
      "exec",
      "eslint",
      "--config",
      "eslint.config.js",
      "--max-warnings",
      "0",
      "src/**/*.ts"
    ])
    const attrs = attrsOf<EsLint.Attrs>(targets.lint)
    expect(attrs.maxWarnings).toBe(0)
    expect(attrs.fix).toBe(false)
    // The jsdoc rules are declared key material even though only the first
    // config reaches the argv, so editing them re-keys the target.
    expect(attrs.configs).toEqual([Input.file("eslint.config.js"), Input.file("//eslint.jsdoc.js")])
  })

  it("plans dprint in check mode over the sources and the test tree", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(plannedArgv(targets.fmt)).toEqual(["pnpm", "exec", "dprint", "check", "--config", "dprint.json"])
    const attrs = attrsOf<Dprint.Attrs>(targets.fmt)
    expect(attrs.fix).toBe(false)
    expect(attrs.sources).toEqual([Input.glob("src/**/*.ts"), Input.glob("test/**/*.ts")])
  })

  it("keeps both gates strict under caller-selected sources and configs", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      sources: Input.glob("lib/**/*.ts"),
      eslintConfigs: [Input.file("//eslint.strict.js")],
      dprintConfig: Input.file("config/dprint.json")
    })
    expect(plannedArgv(targets.lint)).toEqual([
      "pnpm",
      "exec",
      "eslint",
      "--config",
      "../../eslint.strict.js",
      "--max-warnings",
      "0",
      "lib/**/*.ts"
    ])
    expect(plannedArgv(targets.fmt)).toEqual([
      "pnpm",
      "exec",
      "dprint",
      "check",
      "--config",
      "config/dprint.json"
    ])
    expect(attrsOf<EsLint.Attrs>(targets.lint).fix).toBe(false)
    expect(attrsOf<Dprint.Attrs>(targets.fmt).fix).toBe(false)
  })
})

describe("BuildAndCheckTypeScriptPackage option propagation", () => {
  const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })

  it("narrows the collected suite alone when tests excludes a tier", () => {
    const narrowed = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      tests: Input.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
    })
    expect(attrsOf<Vitest.Attrs>(narrowed.test).tests).toEqual([
      Input.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
    ])
    // The excluded tier stays typechecked and formatted, which is why the
    // suite glob does not reach check or fmt.
    expect(Target.metadata(narrowed.check).inputs).toEqual(Target.metadata(standard.check).inputs)
    expect(Target.metadata(narrowed.fmt).inputs).toEqual(Target.metadata(standard.fmt).inputs)
  })

  it("moves the typechecked and formatted test tree with testSources", () => {
    const relocated = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      tests: Input.glob("spec/**/*.test.ts"),
      testSources: Input.glob("spec/**/*.ts")
    })
    expect(attrsOf<Typecheck.Attrs>(relocated.check).srcs).toEqual([
      Input.glob("src/**/*.ts"),
      Input.glob("spec/**/*.ts"),
      Input.glob("//packages/repo-targets/test-utils/effect-property.*")
    ])
    expect(attrsOf<Dprint.Attrs>(relocated.fmt).sources).toEqual([
      Input.glob("src/**/*.ts"),
      Input.glob("spec/**/*.ts")
    ])
    expect(attrsOf<Vitest.Attrs>(relocated.test).tests).toEqual([Input.glob("spec/**/*.test.ts")])
  })

  it("reaches every source-reading target when sources moves", () => {
    const moved = Input.glob("lib/**/*.ts")
    const relocated = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      sources: moved
    })
    expect(attrsOf<TsBuild.Attrs>(relocated.lib).srcs).toEqual([
      moved,
      Input.file("//packages/repo-targets/scripts/build-library.mjs"),
      Input.file("//packages/smithers/scripts/compile-commonjs.mjs")
    ])
    expect(attrsOf<Typecheck.Attrs>(relocated.check).srcs).toEqual([
      moved, Input.glob("test/**/*.ts"), Input.glob("//packages/repo-targets/test-utils/effect-property.*")
    ])
    expect(attrsOf<Vitest.Attrs>(relocated.test).sources).toEqual([
      moved, Input.glob("//packages/repo-targets/test-utils/effect-property.*")
    ])
    expect(attrsOf<EsLint.Attrs>(relocated.lint).sources).toEqual([moved])
    expect(attrsOf<Dprint.Attrs>(relocated.fmt).sources).toEqual([moved, Input.glob("test/**/*.ts")])
    expect(attrsOf<NodeTest.Attrs>(relocated.circular).srcs).toEqual([moved, Input.file("tsconfig.json")])
    // The published entry is one file, not the glob, so it stays where the
    // caller left it until `entry` moves it.
    expect(attrsOf<TsBuild.Attrs>(relocated.lib).entries).toEqual([Input.file("src/index.ts")])
  })

  it("names the built distribution's entry file from entry", () => {
    const relocated = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      sources: Input.glob("lib/**/*.ts"),
      entry: Input.file("lib/main.ts")
    })
    expect(attrsOf<TsBuild.Attrs>(relocated.lib).entries).toEqual([Input.file("lib/main.ts")])
    expect(TsBuild.distributionLayout(attrsOf<TsBuild.Attrs>(relocated.lib))).toEqual([
      { format: "esm", directory: "dist/esm", entry: "dist/esm/main.js", declaration: "dist/esm/main.d.ts" },
      { format: "cjs", directory: "dist/cjs", entry: "dist/cjs/main.js", declaration: null }
    ])
    expect(attrsOf<TsBuild.Attrs>(standard.lib).entries).toEqual([Input.file("src/index.ts")])
  })
})

describe("BuildAndCheckTypeScriptPackage declaration failures", () => {
  it("rejects a non-integer testTimeoutMs at declaration time, as the README's failure contracts state", () => {
    expect(() => BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/smithers/flows/plan", testTimeoutMs: 1.5 }))
      .toThrow(/declaration.* is invalid/)
  })
})

it("runs a package-owned test matrix with the same source and dependency boundary", () => {
  const targets = BuildAndCheckTypeScriptPackage({
    packageManager, cwd: "packages/example",
    testProgram: Input.file("//scripts/sql-matrix.mjs"),
    testTimeoutMs: 1_800_000,
    testData: ["docs/**/*.md"]
  })
  const attrs = attrsOf<NodeTest.Attrs>(targets.test)
  expect(Target.metadata(targets.test).target).toBe("NodeTest")
  expect(NodeTest.runArgv(attrs)).toEqual(["node", "../../scripts/sql-matrix.mjs"])
  expect(attrs.timeout).toBe("1800000ms")
  expect(Target.metadata(targets.test).dependencies).toEqual([targets.lib])
  expect(attrs.srcs).toContainEqual(Input.glob("docs/**/*.md"))
  expect(attrs.srcs).toContainEqual(Input.file("vitest.config.ts"))
  expect(attrs.srcs).toContainEqual(Input.glob("test/**/*.ts"))
})


it("uses default matrix limits without a package manager or Vitest config", () => {
  const targets = BuildAndCheckTypeScriptPackage({
    cwd: "packages/example",
    testProgram: Input.file("test-matrix.mjs"),
    vitestConfig: null
  })
  const attrs = attrsOf<NodeTest.Attrs>(targets.test)
  expect(attrs.runtime).toBeUndefined()
  expect(attrs.timeout).toBe("1200000ms")
  expect(attrs.srcs).not.toContainEqual(Input.file("vitest.config.ts"))
})
