/**
 * The repository's install is keyed on every dependency patch it applies.
 *
 * The root `nodeModules` target once hand-listed its patch files and fell
 * four behind `patches/` (#3089), so editing an unlisted patch never re-keyed
 * the install. The list now comes from the workspace definition's
 * `patchedDependencies`; this suite fails when a patch file in `patches/` is
 * not among the install's expanded inputs.
 */
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"

const repositoryRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "../../../../..")

describe("the repository install's patch inputs", () => {
  it("cover every patch file in patches/", async () => {
    const patches = (await Fs.readdir(NodePath.join(repositoryRoot, "patches")))
      .filter((name) => name.endsWith(".patch"))
      .map((name) => `patches/${name}`)
      .sort()
    expect(patches).toContain("patches/dprint@0.57.1.patch")

    const inputs = await Input.expandPnpmWorkspace(repositoryRoot, "", Input.pnpmWorkspace("//pnpm-workspace.yaml"))
    expect(patches.filter((patch) => !inputs.includes(patch))).toEqual([])
    expect(inputs.filter((input) => input.startsWith("patches/"))).toEqual(patches)
  })

  it("come from the workspace definition the root install declares, not a hand-kept list", async () => {
    const declaration = await Fs.readFile(NodePath.join(repositoryRoot, "PACKAGE.ts"), "utf8")
    const install = declaration.slice(declaration.indexOf("const nodeModules = Smithers.Install({"))
    const body = install.slice(0, install.indexOf("\n})\n"))
    expect(declaration).toContain(`const workspace = Smithers.pnpmWorkspace("//pnpm-workspace.yaml")`)
    expect(body).toMatch(/\n {2}workspaceManifest: workspace,\n/)
    expect(body).not.toMatch(/\bpatches:/)
  })
})
