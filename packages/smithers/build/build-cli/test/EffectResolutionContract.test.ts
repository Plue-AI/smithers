import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { createRequire, findPackageJSON } from "node:module"
import * as Os from "node:os"
import * as Path from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { installEffectResolution } from "../src/effect-resolution.js"
import { assertDeclarationDependencies } from "../src/internal/DeclarationDependencies.ts"
import { PackageError } from "../src/PackageError.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

const dependencies = ["effect", "@smthrs/targets", "@smthrs/plan", "@smthrs/core", "@smthrs/flow"]
let root: string

const fixture = async (installed: boolean): Promise<string> => {
  const directory = await Fs.mkdtemp(Path.join(root, "workspace-"))
  await Fs.writeFile(Path.join(directory, "package.json"), "{\"type\":\"module\"}")
  if (installed) {
    for (const dependency of dependencies) {
      const destination = Path.join(directory, "node_modules", dependency)
      await Fs.mkdir(Path.dirname(destination), { recursive: true })
      await Fs.symlink(Path.dirname(findPackageJSON(dependency, import.meta.url)!), destination, "dir")
    }
  }
  return directory
}

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-declaration-contract-")))
})

afterAll(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("declaration dependency preflight", () => {
  it("does not provide dependency-free CommonJS aliases", async () => {
    const directory = await fixture(false)
    // Run outside Vitest's module runner: this contract is ordinary Node
    // require resolution, which Vitest may redirect through its own graph.
    // pnpm can expose workspace dependencies through NODE_PATH; remove that
    // ambient installation from this deliberately dependency-free fixture.
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { installEffectResolution } from ${
        JSON.stringify(new URL("../src/effect-resolution.js", import.meta.url).href)
      };
      installEffectResolution();
      const require = createRequire(${JSON.stringify(Path.join(directory, "PACKAGE.ts"))});
      for (const dependency of ["effect", "@smthrs/targets"]) {
        let resolved;
        try { resolved = require.resolve(dependency); } catch (error) { assert.equal(error.code, "MODULE_NOT_FOUND"); continue; }
        assert.fail(dependency + " resolved unexpectedly to " + resolved);
      }
    `
    ], { encoding: "utf8", cwd: directory, env: { ...process.env, NODE_PATH: "" } })
    expect(child.status, child.stderr).toBe(0)
  })

  it("pins an explicitly CLI-owned agent package despite a conflicting project installation", async () => {
    const directory = await fixture(false)
    const agent = Path.join(directory, "node_modules", "@smthrs", "agent")
    await Fs.mkdir(agent, { recursive: true })
    await Fs.writeFile(
      Path.join(agent, "package.json"),
      JSON.stringify({ name: "@smthrs/agent", type: "module", exports: { "./AgentAction": "./AgentAction.js" } })
    )
    await Fs.writeFile(Path.join(agent, "AgentAction.js"), "throw new Error(\"conflicting project agent loaded\")")
    const declaration = Path.join(directory, "flows/probe/flow.ts")
    await Fs.mkdir(Path.dirname(declaration), { recursive: true })
    await Fs.writeFile(
      declaration,
      "import * as AgentAction from \"@smthrs/agent/AgentAction\"; export default AgentAction.make"
    )
    const owner = new URL("../../../src/bin.ts", import.meta.url).href
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { installEffectResolution, importDeclarationModule } from ${
        JSON.stringify(new URL("../src/effect-resolution.js", import.meta.url).href)
      };
      installEffectResolution();
      installEffectResolution({ "@smthrs/agent": ${JSON.stringify(owner)} });
      const outer = await import("@smthrs/agent/AgentAction");
      const first = await importDeclarationModule(${JSON.stringify(pathToFileURL(declaration).href)}, ${
        JSON.stringify(owner)
      });
      const second = await importDeclarationModule(${JSON.stringify(pathToFileURL(declaration).href)}, ${
        JSON.stringify(owner)
      });
      assert.equal(first.default, outer.make);
      assert.equal(second.default, outer.make);
    `
    ], { encoding: "utf8", cwd: directory, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000 })
    expect(child.status, child.stdout + child.stderr).toBe(0)
  })

  it("accepts ordinary shared packages, including repeated files in one directory", async () => {
    const directory = await fixture(true)
    expect(() =>
      assertDeclarationDependencies([Path.join(directory, "WORKSPACE.ts"), Path.join(directory, "PACKAGE.ts")], {
        bootstrap: false
      })
    ).not.toThrow()
  })

  it("requires installation unless the caller explicitly selects bootstrap", async () => {
    const directory = await fixture(false)
    const file = Path.join(directory, "WORKSPACE.ts")
    expect(() => assertDeclarationDependencies([file], { bootstrap: true })).not.toThrow()
    expect(() => assertDeclarationDependencies([file], { bootstrap: false })).toThrowError(
      expect.objectContaining({
        code: "declaration_dependency_unresolved",
        path: file,
        cause: expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }),
        // The cause travels in the message as well as in the field: a refusal
        // rendered from `code` and `message` alone is unfixable on a host the
        // author cannot reach.
        message: expect.stringContaining("ERR_MODULE_NOT_FOUND")
      })
    )
  })

  it.each(dependencies)("refuses a second physical %s even after the aliases are installed", async (dependency) => {
    const directory = await fixture(true)
    const destination = Path.join(directory, "node_modules", dependency)
    await Fs.unlink(destination)
    // Resolution examines the actual installed manifest without executing it.
    await Fs.mkdir(destination, { recursive: true })
    await Fs.copyFile(findPackageJSON(dependency, import.meta.url)!, Path.join(destination, "package.json"))
    const file = Path.join(directory, "PACKAGE.ts")
    installEffectResolution()
    for (const bootstrap of [false, true]) {
      try {
        assertDeclarationDependencies([file], { bootstrap })
        throw new Error("accepted a conflicting runtime")
      } catch (cause) {
        expect(cause).toBeInstanceOf(PackageError)
        expect(cause).toMatchObject({ code: "declaration_dependency_mismatch", path: file })
        expect((cause as Error).message).toContain(dependency)
        expect((cause as Error).message).toContain(await Fs.realpath(Path.join(destination, "package.json")))
        expect((cause as Error).message).toContain("workspace-local CLI")
      }
    }
  })

  /**
   * A declaration that lives inside one of the shared packages names that
   * package, and the enclosing scope is the answer.
   * `packages/smithers/build/targets/PACKAGE.ts` is the real instance, and it
   * is the file the advisory Windows row refuses with
   * `declaration_dependency_unresolved: cannot resolve @smthrs/targets`. This
   * pins what every other host answers for it.
   */
  it("accepts a declaration that lives inside the shared package it names", () => {
    const manifest = findPackageJSON("@smthrs/targets", import.meta.url)!
    const file = Path.join(Path.dirname(manifest), "PACKAGE.ts")
    expect(() => assertDeclarationDependencies([file], { bootstrap: false })).not.toThrow()
  })

  it.runIf(process.platform === "win32")(
    "accepts the extended Windows spelling of a shared package declaration",
    () => {
      const manifest = findPackageJSON("@smthrs/targets", import.meta.url)!
      const file = Path.toNamespacedPath(Path.join(Path.dirname(manifest), "PACKAGE.ts"))
      expect(file.startsWith("\\\\?\\")).toBe(true)
      expect(() => assertDeclarationDependencies([file], { bootstrap: false })).not.toThrow()
    }
  )

  it("refuses a foreign installation even when its metadata cannot be parsed", async () => {
    const directory = await fixture(false)
    await Fs.mkdir(Path.join(directory, "node_modules/effect"), { recursive: true })
    await Fs.writeFile(Path.join(directory, "node_modules/effect/package.json"), "{")
    expect(() => assertDeclarationDependencies([Path.join(directory, "WORKSPACE.ts")], { bootstrap: true }))
      .toThrowError(expect.objectContaining({
        code: "declaration_dependency_mismatch"
      }))
  })

  it("checks imported helpers before workspace evaluation and preserves the typed refusal", async () => {
    const directory = await fixture(true)
    const helper = Path.join(directory, "nested")
    await Fs.mkdir(Path.join(helper, "node_modules/effect"), { recursive: true })
    await Fs.copyFile(
      findPackageJSON("effect", import.meta.url)!,
      Path.join(helper, "node_modules/effect/package.json")
    )
    await Fs.writeFile(Path.join(helper, "helper.ts"), "throw new Error(\"helper must not evaluate\")\n")
    await Fs.writeFile(Path.join(directory, "WORKSPACE.ts"), "import \"./nested/helper.js\"\n")
    await expect(PackageLoader.loadWorkspaceDeclaration(directory, "WORKSPACE.ts")).rejects.toMatchObject({
      code: "declaration_dependency_mismatch",
      path: Path.join(helper, "helper.ts")
    })
  })

  it("checks the full package closure even when the workspace does not import the package", async () => {
    const directory = await fixture(true)
    const child = Path.join(directory, "child")
    await Fs.mkdir(Path.join(child, "node_modules/effect"), { recursive: true })
    await Fs.copyFile(findPackageJSON("effect", import.meta.url)!, Path.join(child, "node_modules/effect/package.json"))
    await Fs.writeFile(Path.join(directory, "WORKSPACE.ts"), "throw new Error(\"workspace must not evaluate\")\n")
    await Fs.writeFile(Path.join(child, "PACKAGE.ts"), "throw new Error(\"package must not evaluate\")\n")
    await expect(PackageLoader.load({
      root: directory,
      workspaceFile: "WORKSPACE.ts",
      packageFiles: ["child/PACKAGE.ts"],
      cacheDirectory: ".flows",
      repositories: [],
      pruned: [],
      directories: 0
    })).rejects.toMatchObject({ code: "declaration_dependency_mismatch", path: Path.join(child, "PACKAGE.ts") })
  })
})

describe("nested CommonJS declaration evaluation", () => {
  it.each(["module", "commonjs", undefined])("handles a typed file-URL import with package type %s", async (type) => {
    const directory = await fixture(true)
    await Fs.writeFile(Path.join(directory, "package.json"), JSON.stringify({ type }))
    await Fs.writeFile(
      Path.join(directory, "PACKAGE.ts"),
      `import * as Schema from ${JSON.stringify(import.meta.resolve("effect/Schema"))}\n` +
        "export const answer: number = Schema.decodeUnknownSync(Schema.Number)(42)\n"
    )
    await Fs.writeFile(Path.join(directory, "bridge.cjs"), "module.exports = require(\"./PACKAGE.ts\")\n")
    await Fs.writeFile(Path.join(directory, "empty.mjs"), "export {}\n")
    const script = `
import { createRequire } from "node:module"
import { importDeclarationModule } from ${JSON.stringify(new URL("../src/effect-resolution.js", import.meta.url).href)}
await importDeclarationModule(${JSON.stringify(pathToFileURL(Path.join(directory, "empty.mjs")).href)}, import.meta.url)
const { answer } = createRequire(import.meta.url)(${JSON.stringify(Path.join(directory, "bridge.cjs"))})
console.log(JSON.stringify({ answer }))
`
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: directory,
      encoding: "utf8"
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ answer: 42 })
  })
})

it("reproduces why equal-version Effect copies must be refused", async () => {
  const directory = await fixture(true)
  const destination = Path.join(directory, "node_modules/effect")
  await Fs.unlink(destination)
  await Fs.cp(Path.dirname(findPackageJSON("effect", import.meta.url)!), destination, {
    recursive: true,
    dereference: true
  })
  const script = `
import * as CLI from ${JSON.stringify(import.meta.resolve("effect/Schema"))}
import * as Foreign from ${JSON.stringify(pathToFileURL(Path.join(destination, "dist/Schema.js")).href)}
import * as Effect from ${JSON.stringify(pathToFileURL(Path.join(destination, "dist/Effect.js")).href)}
const schema = Foreign.Struct({ name: Foreign.String.pipe(Foreign.withDecodingDefaultKey(Effect.succeed("Ada"))) })
const own = Foreign.decodeUnknownSync(schema)({})
let failure
try { CLI.decodeUnknownSync(schema)({}) } catch (cause) { failure = cause.message }
console.log(JSON.stringify({ own, failure, same: CLI.String === Foreign.String }))
`
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: directory,
    encoding: "utf8"
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    own: { name: "Ada" },
    failure: "Missing key\n  at [\"name\"]",
    same: false
  })
  expect(() => assertDeclarationDependencies([Path.join(directory, "PACKAGE.ts")], { bootstrap: true }))
    .toThrowError(expect.objectContaining({ code: "declaration_dependency_mismatch" }))
})
