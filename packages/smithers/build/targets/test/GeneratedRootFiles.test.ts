import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Yaml from "yaml"
import * as Install from "../src/Install.ts"
import * as Lockfile from "../src/Lockfile.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as PnpmWorkspaceFile from "../src/PnpmWorkspaceFile.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Target from "../src/Target.ts"
import * as Tsconfig from "../src/Tsconfig.ts"
import { packageManager, runtime } from "./toolchain.ts"

// The repository root, five levels up: this package nests two deep.
const workspaceRoot = NodePath.resolve(import.meta.dirname, "../../../../..")

describe("Tsconfig", () => {
  it("renders only the sections a declaration fills", () => {
    expect(Tsconfig.render(Tsconfig.Attrs.make({}))).toBe("{}\n")
  })

  it("renders each section in the documented order", () => {
    const rendered = Tsconfig.render(Tsconfig.Attrs.make({
      extends: { _tag: "File", path: "tsconfig.base.json" },
      compilerOptions: { noEmit: true, module: "NodeNext" },
      include: ["src/**/*"],
      exclude: ["**/dist/**"],
      references: ["../plan"]
    }))
    expect(rendered).toBe(`{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "module": "NodeNext"
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "**/dist/**"
  ],
  "references": [
    {
      "path": "../plan"
    }
  ]
}
`)
  })

  it("gives a bare extends path the relative prefix the compiler needs", () => {
    const relative = (path: string) =>
      JSON.parse(Tsconfig.render(Tsconfig.Attrs.make({ extends: { _tag: "File", path } })))["extends"]
    expect(relative("tsconfig.base.json")).toBe("./tsconfig.base.json")
    expect(relative("//tsconfig.base.json")).toBe("./tsconfig.base.json")
    expect(relative("./already.json")).toBe("./already.json")
    expect(relative("../sibling.json")).toBe("../sibling.json")
  })

  it("refuses compiler options that are not plain JSON", () => {
    expect(() =>
      Tsconfig.render(Tsconfig.Attrs.make({
        compilerOptions: { paths: new Proxy({}, {}) } as never
      }))
    ).toThrow()
  })

  it("checks by default and writes only when asked", () => {
    expect(Target.metadata(Tsconfig.Tsconfig({})).attrs).toMatchObject({ mode: "check", path: "tsconfig.json" })
    expect(Target.metadata(Tsconfig.Tsconfig({ mode: "write" })).outputs)
      .toEqual({ cwd: ".", paths: ["tsconfig.json"] })
    expect(Target.metadata(Tsconfig.Tsconfig({})).outputs).toEqual({ cwd: ".", paths: [] })
    expect(Target.metadata(Tsconfig.Tsconfig({})).cacheable).toBe(false)
  })

  it("forces the non-writing view under the lint verb", () => {
    const metadata = Target.metadata(Tsconfig.Tsconfig({ mode: "write" }))
    expect((metadata.forKind("lint").attrs as Tsconfig.Attrs).mode).toBe("check")
    expect((metadata.forKind("build").attrs as Tsconfig.Attrs).mode).toBe("write")
  })
})

describe("PnpmWorkspace", () => {
  it("refuses additional settings that repeat modeled workspace keys", () => {
    for (
      const [name, value] of [
        ["packages", "packages/*"],
        ["allowBuilds", false],
        ["linkWorkspacePackages", false]
      ] as const
    ) {
      expect(() =>
        PnpmWorkspaceFile.PnpmWorkspace({
          packageManager,
          packages: ["packages/*"],
          allowBuilds: { esbuild: false },
          settings: { [name]: value }
        })
      ).toThrow(`PnpmWorkspace settings cannot contain ${name}`)
      expect(() =>
        PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
          packages: ["packages/*"],
          settings: { [name]: value }
        }))
      ).toThrow(`PnpmWorkspace settings cannot contain ${name}`)
    }
  })

  it("emits valid YAML for additional settings through the public target", () => {
    const attrs = Target.metadata(PnpmWorkspaceFile.PnpmWorkspace({
      packageManager,
      packages: ["packages/*"],
      allowBuilds: { esbuild: false },
      settings: { verifyDepsBeforeRun: "always" }
    })).attrs as PnpmWorkspaceFile.Attrs
    const document = Yaml.parseDocument(PnpmWorkspaceFile.render(attrs), { uniqueKeys: true })
    expect(document.errors).toEqual([])
    expect(document.toJS()).toEqual({
      packages: ["packages/*"],
      allowBuilds: { esbuild: false },
      linkWorkspacePackages: true,
      verifyDepsBeforeRun: "always"
    })
  })

  it("renders packages, sorted allowBuilds, and the link policy", () => {
    const rendered = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packageManager,
      packages: ["packages/*", "apps/*"],
      allowBuilds: { sharp: false, esbuild: false },
      linkWorkspacePackages: true
    }))
    expect(rendered).toBe(`packages:
  - "packages/*"
  - "apps/*"

allowBuilds:
  esbuild: false
  sharp: false

linkWorkspacePackages: true
`)
  })

  it("renders settings after the link policy, sorted, with quoted strings and bare booleans", () => {
    const rendered = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packageManager,
      packages: ["packages/*"],
      settings: {
        verifyDepsBeforeRun: "install",
        autoInstallPeers: false,
        no: true,
        "1.0": "one",
        Zebra: "z"
      }
    }))
    expect(rendered).toBe(`packages:
  - "packages/*"

linkWorkspacePackages: true
"1.0": "one"
Zebra: "z"
autoInstallPeers: false
"no": true
verifyDepsBeforeRun: "install"
`)
  })

  it("sorts allowBuilds so reordering a literal is not drift", () => {
    const one = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packageManager,
      packages: ["packages/*"],
      allowBuilds: { a: true, z: false }
    }))
    const other = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packageManager,
      packages: ["packages/*"],
      allowBuilds: { z: false, a: true }
    }))
    expect(one).toBe(other)
  })

  it("quotes a mapping key YAML would otherwise read as another type", () => {
    const rendered = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packageManager,
      packages: ["plain"],
      allowBuilds: { "@scope/name": false, no: true, "1.0": true, "with space": false, "es5-ext": true }
    }))
    // Sequence entries are always quoted; mapping keys only when YAML needs it.
    expect(rendered).toContain("  - \"plain\"\n")
    expect(rendered).toContain("  es5-ext: true\n")
    expect(rendered).toContain("  \"@scope/name\": false\n")
    expect(rendered).toContain("  \"no\": true\n")
    expect(rendered).toContain("  \"1.0\": true\n")
    expect(rendered).toContain("  \"with space\": false\n")
  })

  it("omits allowBuilds entirely when nothing is declared", () => {
    const rendered = PnpmWorkspaceFile.render(PnpmWorkspaceFile.Attrs.make({
      packageManager,
      packages: ["packages/*"]
    }))
    expect(rendered).not.toContain("allowBuilds")
  })

  it("refuses a manager that does not write this file", () => {
    const bun = PackageManager.BunPackages({ runtime: Runtime.Bun({ version: ">=1.4.0" }) })
    expect(() => PnpmWorkspaceFile.PnpmWorkspace({ packageManager: bun, packages: ["packages/*"] }))
      .toThrow(/requires the pnpm declaration; this workspace declares bun/)
  })
})

describe("Lockfile", () => {
  it("resolves without linking and declares the manager's lockfile as its output", () => {
    const metadata = Target.metadata(Lockfile.Lockfile({ packageManager }))
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["pnpm-lock.yaml"] })
    expect(metadata.kinds).toEqual(["build"])
  })

  it("is never cacheable, because resolution reaches the network", () => {
    expect(Target.metadata(Lockfile.Lockfile({ packageManager })).cacheable).toBe(false)
  })

  it("declares the package manifests whose change marks it affected", () => {
    const metadata = Target.metadata(Lockfile.Lockfile({ packageManager }))
    expect(metadata.inputs).toEqual([
      { _tag: "Glob", pattern: "packages/*/package.json", exclude: [] }
    ])
  })

  it("writes the lockfile the declared manager writes", () => {
    const bun = PackageManager.BunPackages({ runtime: Runtime.Bun({ version: ">=1.4.0" }) })
    expect(Target.metadata(Lockfile.Lockfile({ packageManager: bun })).outputs)
      .toEqual({ cwd: ".", paths: ["bun.lock"] })
  })
})

describe("Install", () => {
  it("is a run target that never caches its own result", () => {
    const metadata = Target.metadata(Install.Install({ packageManager }))
    expect(metadata.kinds).toEqual(["run"])
    expect(metadata.cacheable).toBe(false)
  })

  it("takes the lockfile as a dependency edge and its content as key material", () => {
    const lockfile = Lockfile.Lockfile({ packageManager })
    const metadata = Target.metadata(Install.Install({ packageManager, lockfile }))
    expect(metadata.dependencies).toHaveLength(1)
    expect(metadata.inputs.map((input) => (input as { readonly path: string }).path))
      .toEqual(["pnpm-lock.yaml", ".npmrc", "package.json", ".pnpmfile.mjs"])
  })

  it("defaults every generated-file dependency to absent", () => {
    const attrs = Target.metadata(Install.Install({ packageManager })).attrs as Install.Attrs
    expect(attrs.lockfile).toBe(null)
    expect(attrs.manifest).toBe(null)
    expect(attrs.workspace).toBe(null)
    expect(Target.metadata(Install.Install({ packageManager })).dependencies).toEqual([])
  })
})

describe("the checked-in root files match the declarations", () => {
  // These are the drift checks `smithers-build lint` runs. Keeping them here means a
  // change to a generator, or a hand edit to a generated file, fails in this
  // package's own suite rather than only in a workspace-wide run.
  it("renders the checked-in tsconfig.json", async () => {
    const declared = Tsconfig.render(Tsconfig.Attrs.make({
      extends: { _tag: "File", path: "tsconfig.base.json" },
      compilerOptions: {
        noEmit: true,
        lib: ["ES2024"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: { "*": ["./*"] }
      },
      include: [
        "PACKAGE.ts",
        "apps/*/PACKAGE.ts",
        "crates/*/PACKAGE.ts",
        "evals/*/PACKAGE.ts",
        "scripts/PACKAGE.ts",
        "scripts/*/PACKAGE.ts",
        "flows/PACKAGE.ts",
        "examples/PACKAGE.ts",
        "apps/docs/*/PACKAGE.ts",
        "packages/*/PACKAGE.ts",
        "packages/*/*/PACKAGE.ts",
        "packages/*/*/*/PACKAGE.ts"
      ],
      exclude: ["**/dist/**", "packages/coding-agent/examples/extensions/gondolin/**"]
    }))
    const actual = await Fs.readFile(NodePath.join(workspaceRoot, "tsconfig.json"), "utf8")
    expect(declared).toBe(actual)
  })
})
