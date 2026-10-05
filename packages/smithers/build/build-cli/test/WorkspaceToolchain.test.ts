/**
 * Reading the workspace's package manager and runtime, and filling them into
 * the rules that named them.
 *
 * A PACKAGE.ts no longer restates the workspace toolchain, so the planner is
 * the only place that can supply it. Two failures would be silent without
 * these cases: filling an attr a rule never named would change that target's
 * key material for nothing, and overwriting a declared attr would take the Bun
 * compatibility matrix off Bun.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import type * as Typecheck from "@smthrs/targets/Typecheck"
import type * as Vitest from "@smthrs/targets/Vitest"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as WorkspaceToolchain from "../src/WorkspaceToolchain.ts"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })
const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })
const bun = S.Runtime.Bun({ version: ">=1.4.0" })

const workspaceOf = (fields: Record<string, unknown>): WorkspaceDeclaration.WorkspaceDeclaration =>
  fields as unknown as WorkspaceDeclaration.WorkspaceDeclaration

describe("reading the workspace declaration", () => {
  it("takes the legacy record form as it stands", () => {
    const toolchain = WorkspaceToolchain.of(workspaceOf({ runtime, packageManager }))
    expect(toolchain.runtime).toBe(runtime)
    expect(toolchain.packageManager).toBe(packageManager)
  })

  it("preserves a classic manager's embedded runtime when the reader receives no separate runtime", () => {
    const toolchain = WorkspaceToolchain.of(workspaceOf({ packageManager }))
    expect(toolchain.runtime).toBeUndefined()
    expect(toolchain.packageManager).toBe(packageManager)
    expect(toolchain.packageManager?.runtime).toEqual(runtime)
  })

  it("lowers the WORKSPACE.ts pnpm declaration onto the record legacy rules take", () => {
    const declaration = S.PackageManager.Pnpm({
      manifest: S.file("//package.json"),
      lockfile: S.file("//pnpm-lock.yaml"),
      version: "11.21.0"
    })
    const toolchain = WorkspaceToolchain.of(workspaceOf({ runtime, packageManager: declaration }))
    expect(toolchain.packageManager?.name).toBe("pnpm")
    expect(toolchain.packageManager?.version).toBe("11.21.0")
    expect(toolchain.packageManager?.executable).toBe("pnpm")
  })

  it("leaves a manifest-derived manager unresolved in the synchronous reader", () => {
    const declaration = S.PackageManager.Pnpm({
      manifest: S.file("//package.json"),
      lockfile: S.file("//pnpm-lock.yaml")
    })
    expect(
      WorkspaceToolchain.of(workspaceOf({ runtime, packageManager: declaration }))
        .packageManager?.version
    ).toBeUndefined()
  })

  it("lowers nothing a legacy rule cannot run", () => {
    const yarn = S.PackageManager.Yarn({
      manifest: S.file("//package.json"),
      lockfile: S.file("//yarn.lock")
    })
    expect(WorkspaceToolchain.of(workspaceOf({ runtime, packageManager: yarn })).packageManager).toBeUndefined()
    const pnpm = S.PackageManager.Pnpm({
      manifest: S.file("//package.json"),
      lockfile: S.file("//pnpm-lock.yaml")
    })
    // No workspace runtime: the record form requires one, so there is nothing
    // to lower onto and the rules refuse by name instead.
    expect(WorkspaceToolchain.of(workspaceOf({ packageManager: pnpm })).packageManager).toBeUndefined()
  })

  it("a workspace that declares neither reports neither", () => {
    const toolchain = WorkspaceToolchain.of(workspaceOf({}))
    expect(toolchain.runtime).toBeUndefined()
    expect(toolchain.packageManager).toBeUndefined()
  })
})

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const directory = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-workspace-toolchain-")))
  temporary.push(root)
  return root
}

const manifestWorkspace = (
  options: Partial<WorkspaceDeclaration.WorkspaceOptions> = {}
): WorkspaceDeclaration.WorkspaceDeclaration => {
  const manifest = S.file("//package.json")
  return S.Workspace("manifest-toolchain", {
    repository: "git+https://example.invalid/manifest-toolchain.git",
    cache: S.Cache({ directory: ".flows" }),
    runtime: S.Runtime.Node({ manifest }),
    packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
    ...options
  })
}

/** Runs the actual target schema after resolution, which a field-only lowering assertion cannot cover. */
const assertTypecheckPlan = (toolchain: WorkspaceToolchain.WorkspaceToolchain): void => {
  const target = S.Typecheck({
    srcs: [],
    deps: [],
    tsconfig: S.file("tsconfig.json"),
    buildMode: false,
    incremental: false
  })
  const metadata = Target.metadata(target)
  const attrs = WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, toolchain)
  expect(PackageManager.isPackageManager(toolchain.packageManager)).toBe(true)
  expect(Runtime.isRuntime(toolchain.runtime)).toBe(true)
  expect(() => Target.plan(target, attrs as Typecheck.Attrs)).not.toThrow()
}

describe("resolving workspace manifest declarations", () => {
  it("derives both requirements from the same measured manifest and passes the real target schema", async () => {
    const root = await directory()
    const text = JSON.stringify({ engines: { node: ">=26.4.0" }, packageManager: "pnpm@11.25.0" })
    await Fs.writeFile(Path.join(root, "package.json"), text)
    const toolchain = await WorkspaceToolchain.resolve(manifestWorkspace(), { root })
    expect(toolchain.runtime).toMatchObject({ name: "node", version: ">=26.4.0", executable: "node" })
    expect(toolchain.packageManager).toMatchObject({ name: "pnpm", version: "11.25.0", executable: "pnpm" })
    expect(toolchain.manifestDigests).toEqual([{ path: "package.json", digest: Input.digestText(text) }])
    assertTypecheckPlan(toolchain)
  })

  it("measures distinct runtime and manager manifests in stable workspace-relative order", async () => {
    const root = await directory()
    const nodeText = JSON.stringify({ engines: { node: "22.19.0" } })
    const managerText = JSON.stringify({ packageManager: "pnpm@11.25.0" })
    await Fs.mkdir(Path.join(root, "config"))
    await Fs.writeFile(Path.join(root, "config/node.json"), nodeText)
    await Fs.writeFile(Path.join(root, "package.json"), managerText)
    const toolchain = await WorkspaceToolchain.resolve(
      manifestWorkspace({
        runtime: S.Runtime.Node({ manifest: S.file("//config/node.json") })
      }),
      { root }
    )
    expect(toolchain.manifestDigests).toEqual([
      { path: "config/node.json", digest: Input.digestText(nodeText) },
      { path: "package.json", digest: Input.digestText(managerText) }
    ])
    assertTypecheckPlan(toolchain)
  })

  it.each(
    [
      ["classic Node floor", S.Runtime.Node({ version: ">=26.4.0" })],
      ["exact Node", S.Runtime.Node({ version: "22.19.0" })],
      ["exact Bun", S.Runtime.Bun({ version: "1.4.1" })]
    ] as const
  )("normalizes %s with a manifest-derived pnpm without inventing a requirement", async (_, runtime) => {
    const root = await directory()
    await Fs.writeFile(Path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.25.0" }))
    const toolchain = await WorkspaceToolchain.resolve(manifestWorkspace({ runtime }), { root })
    expect(toolchain.runtime?.version).toBe("version" in runtime ? runtime.version : undefined)
    expect(toolchain.packageManager?.version).toBe("11.25.0")
    assertTypecheckPlan(toolchain)
  })

  it("uses an explicit manager requirement while measuring a manifest that omits its pin", async () => {
    const root = await directory()
    const manifest = S.file("//package.json")
    const text = "{}"
    await Fs.writeFile(Path.join(root, "package.json"), text)
    const toolchain = await WorkspaceToolchain.resolve(
      manifestWorkspace({
        runtime: S.Runtime.Node({ version: "22.19.0" }),
        packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml"), version: "11.21.0" })
      }),
      { root }
    )
    expect(toolchain.packageManager?.version).toBe("11.21.0")
    expect(toolchain.manifestDigests).toEqual([{ path: "package.json", digest: Input.digestText(text) }])
    assertTypecheckPlan(toolchain)
  })

  it("deduplicates equivalent manifest paths while an explicit manager requirement overrides its field", async () => {
    const root = await directory()
    const text = JSON.stringify({ engines: { node: ">=26.4.0" }, packageManager: "npm@99.0.0" })
    await Fs.writeFile(Path.join(root, "package.json"), text)
    const toolchain = await WorkspaceToolchain.resolve(
      manifestWorkspace({
        runtime: S.Runtime.Node({ manifest: S.file("./package.json") }),
        packageManager: S.PackageManager.Pnpm({
          manifest: S.file("//./package.json"),
          lockfile: S.file("//pnpm-lock.yaml"),
          version: "11.21.0"
        })
      }),
      { root }
    )
    expect(toolchain.packageManager?.version).toBe("11.21.0")
    expect(toolchain.manifestDigests).toEqual([{ path: "package.json", digest: Input.digestText(text) }])
    assertTypecheckPlan(toolchain)
  })

  it("preserves explicit target overrides after resolving the workspace", async () => {
    const root = await directory()
    await Fs.writeFile(
      Path.join(root, "package.json"),
      JSON.stringify({
        engines: { node: ">=26.4.0" },
        packageManager: "pnpm@11.25.0"
      })
    )
    const toolchain = await WorkspaceToolchain.resolve(manifestWorkspace(), { root })
    const override = S.PackageManager.BunPackages({ runtime: bun })
    const attrs = WorkspaceToolchain.fill(
      ["packageManager", "runtime"],
      { packageManager: override, runtime: bun },
      toolchain
    )
    expect(attrs).toEqual({ packageManager: override, runtime: bun })
  })

  it("accepts an exact Bun target override through construction, workspace fill and planning", async () => {
    const root = await directory()
    await Fs.writeFile(
      Path.join(root, "package.json"),
      JSON.stringify({
        engines: { node: ">=26.4.0" },
        packageManager: "pnpm@11.25.0"
      })
    )
    const toolchain = await WorkspaceToolchain.resolve(manifestWorkspace(), { root })
    const exact = S.Runtime.Bun({ version: "1.4.1", executable: "owned-bun" })
    const target = S.Vitest({
      runtime: exact,
      tests: [],
      sources: [],
      deps: [],
      config: null,
      environment: "node",
      coverage: false,
      passWithNoTests: false
    })
    const metadata = Target.metadata(target)
    const filled = WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, toolchain) as Vitest.Attrs
    expect(filled.runtime).toEqual(exact)
    expect(filled.runtime?.version).toBe("1.4.1")
    expect(filled.runtime?.executable).toBe("owned-bun")
    expect(filled.packageManager).toEqual(toolchain.packageManager)
    expect(() => Target.plan(target, filled)).not.toThrow()
  })

  it("re-reads changed manifest bytes and preserves the exact runtime requirement", async () => {
    const root = await directory()
    const workspace = manifestWorkspace()
    const first = JSON.stringify({ engines: { node: ">22.19.0" }, packageManager: "pnpm@11.21.0" })
    await Fs.writeFile(Path.join(root, "package.json"), first)
    const before = await WorkspaceToolchain.resolve(workspace, { root })
    const second = first.replace("11.21.0", "11.25.0")
    await Fs.writeFile(Path.join(root, "package.json"), second)
    const after = await WorkspaceToolchain.resolve(workspace, { root })
    expect(before.runtime?.version).toBe(">22.19.0")
    expect(after.runtime?.version).toBe(before.runtime?.version)
    expect(before.packageManager?.version).toBe("11.21.0")
    expect(after.packageManager?.version).toBe("11.25.0")
    expect(before.manifestDigests).toEqual([{ path: "package.json", digest: Input.digestText(first) }])
    expect(after.manifestDigests).toEqual([{ path: "package.json", digest: Input.digestText(second) }])
    assertTypecheckPlan(before)
    assertTypecheckPlan(after)
  })

  it.each(
    [
      ["malformed JSON", "{", /JSON|manifest/i],
      ["null manifest", "null", /object/i],
      ["array manifest", "[]", /object/i],
      ["missing Node requirement", JSON.stringify({ packageManager: "pnpm@11.25.0" }), /engines\.node/i],
      [
        "non-string Node requirement",
        JSON.stringify({ engines: { node: 22 }, packageManager: "pnpm@11.25.0" }),
        /engines\.node/i
      ],
      [
        "unsupported Node requirement",
        JSON.stringify({ engines: { node: "latest" }, packageManager: "pnpm@11.25.0" }),
        /requirement|version/i
      ],
      [
        "compound Node requirement",
        JSON.stringify({ engines: { node: "^26.4.0 || >=27.0.0" }, packageManager: "pnpm@11.25.0" }),
        /requirement|version/i
      ],
      ["missing manager pin", JSON.stringify({ engines: { node: ">=26.4.0" } }), /packageManager/i],
      ["wrong manager", JSON.stringify({ engines: { node: ">=26.4.0" }, packageManager: "npm@11.25.0" }), /pnpm/i],
      [
        "empty manager version",
        JSON.stringify({ engines: { node: ">=26.4.0" }, packageManager: "pnpm@" }),
        /packageManager|version|pnpm/i
      ],
      [
        "unsupported manager version",
        JSON.stringify({ engines: { node: ">=26.4.0" }, packageManager: "pnpm@latest" }),
        /requirement|version/i
      ]
    ] as const
  )("refuses %s instead of using an ambient toolchain", async (_, text, refusal) => {
    const root = await directory()
    await Fs.writeFile(Path.join(root, "package.json"), text)
    await expect(WorkspaceToolchain.resolve(manifestWorkspace(), { root })).rejects.toThrow(refusal)
  })

  it("refuses a missing declared manifest", async () => {
    const root = await directory()
    await expect(WorkspaceToolchain.resolve(manifestWorkspace(), { root })).rejects.toThrow(/ENOENT|missing|not found/i)
  })

  it("bounds declared manifest bytes before parsing JSON", async () => {
    const root = await directory()
    await Fs.writeFile(Path.join(root, "package.json"), " ".repeat(1024 * 1024 + 1))
    await expect(WorkspaceToolchain.resolve(manifestWorkspace(), { root })).rejects.toThrow(
      /large|limit|bytes|maximum/i
    )
  })

  it("refuses malformed UTF-8 even in an otherwise unused manifest field", async () => {
    const root = await directory()
    // Replacement decoding would leave valid JSON and valid version pins, so
    // only strict decoding can refuse these bytes before they become identity.
    await Fs.writeFile(
      Path.join(root, "package.json"),
      Buffer.concat([
        Buffer.from("{\"engines\":{\"node\":\">=26.4.0\"},\"packageManager\":\"pnpm@11.25.0\",\"description\":\""),
        Buffer.from([0xc3, 0x28]),
        Buffer.from("\"}")
      ])
    )
    await expect(WorkspaceToolchain.resolve(manifestWorkspace(), { root })).rejects.toThrow(/UTF-8/i)
  })

  it("refuses a manifest path outside the workspace", async () => {
    const root = await directory()
    const workspace = manifestWorkspace({ runtime: S.Runtime.Node({ manifest: S.file("../outside.json") }) })
    await expect(WorkspaceToolchain.resolve(workspace, { root })).rejects.toThrow(/workspace|escape|outside|parent/i)
  })

  it.skipIf(process.platform === "win32")("refuses a symlinked manifest outside the workspace", async () => {
    const root = await directory()
    const outside = await directory()
    await Fs.writeFile(
      Path.join(outside, "package.json"),
      JSON.stringify({
        engines: { node: ">=26.4.0" },
        packageManager: "pnpm@11.25.0"
      })
    )
    await Fs.symlink(Path.join(outside, "package.json"), Path.join(root, "package.json"))
    await expect(WorkspaceToolchain.resolve(manifestWorkspace(), { root })).rejects.toThrow(
      /workspace|escape|outside|symlink/i
    )
  })

  it("preserves cancellation before reading a declared manifest", async () => {
    const root = await directory()
    const controller = new AbortController()
    controller.abort(new Error("manifest resolution aborted"))
    await expect(WorkspaceToolchain.resolve(manifestWorkspace(), { root, signal: controller.signal }))
      .rejects.toThrow(/abort/i)
  })
})

describe("filling a target's workspace attrs", () => {
  const toolchain = WorkspaceToolchain.of(workspaceOf({ runtime, packageManager }))

  it("fills only the attrs the rule named", () => {
    const target = S.Typecheck({
      srcs: [S.glob("src/**/*.ts")],
      deps: [],
      tsconfig: S.file("tsconfig.json"),
      buildMode: false,
      incremental: false
    })
    const metadata = Target.metadata(target)
    const filled = WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, toolchain) as {
      readonly packageManager?: unknown
      readonly runtime?: unknown
    }
    expect(filled.packageManager).toBe(packageManager)
    expect(filled.runtime).toBeUndefined()
  })

  it("leaves a declared attr alone", () => {
    const target = S.Vitest({
      runtime: bun,
      tests: [],
      sources: [],
      deps: [],
      config: null,
      environment: "node",
      coverage: false,
      passWithNoTests: false
    })
    const metadata = Target.metadata(target)
    const filled = WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, toolchain) as {
      readonly runtime?: unknown
      readonly packageManager?: unknown
    }
    expect(filled.runtime).toStrictEqual(bun)
    expect(filled.packageManager).toBe(packageManager)
  })

  it("returns the attrs untouched when the rule named none", () => {
    const target = S.Shell.Test({ shell: "true" })
    const metadata = Target.metadata(target)
    expect(WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, toolchain)).toBe(metadata.attrs)
  })

  it("returns the attrs untouched when the workspace declares nothing", () => {
    const target = S.Typecheck({
      srcs: [S.glob("src/**/*.ts")],
      deps: [],
      tsconfig: S.file("tsconfig.json"),
      buildMode: false,
      incremental: false
    })
    const metadata = Target.metadata(target)
    const empty = WorkspaceToolchain.of(workspaceOf({}))
    expect(WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, empty)).toBe(metadata.attrs)
  })

  it("fills nothing into a value that is not an attrs record", () => {
    expect(WorkspaceToolchain.fill(["packageManager"], null, toolchain)).toBeNull()
  })

  it("skips an attr the workspace does not declare", () => {
    const target = S.Vitest({
      tests: [],
      sources: [],
      deps: [],
      config: null,
      environment: "node",
      coverage: false,
      passWithNoTests: false
    })
    const metadata = Target.metadata(target)
    const managerOnly = WorkspaceToolchain.of(workspaceOf({ packageManager }))
    const filled = WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, managerOnly) as {
      readonly runtime?: unknown
      readonly packageManager?: unknown
    }
    expect(filled.packageManager).toBe(packageManager)
    expect(filled.runtime).toBeUndefined()
  })
})

it("fills the generated deploy guard from the workspace repository declaration", async () => {
  const repository = "git+https://github.com/owner/project.git"
  const toolchain = WorkspaceToolchain.of(workspaceOf({ repository }))
  expect(WorkspaceToolchain.fill(["repository"], {}, toolchain)).toEqual({ repository })
  expect(WorkspaceToolchain.fill([], {}, toolchain)).toEqual({})
})
