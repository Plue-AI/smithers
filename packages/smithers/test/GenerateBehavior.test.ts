import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import * as Node from "@smthrs/plan/Node"
import * as Target from "@smthrs/targets/Target"
import { Schema } from "effect"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createGenerateCli, initialize } from "../src/cli/Generate.ts"

const ports = vi.hoisted(() => ({
  openPackageIndex: vi.fn(),
  runPackageVerb: vi.fn(),
  writeFailure: vi.fn()
}))
vi.mock("@smthrs/build-cli/Cli", async (load) => ({
  ...await load<typeof import("@smthrs/build-cli/Cli")>(),
  openPackageIndex: ports.openPackageIndex,
  runPackageVerb: ports.runPackageVerb
}))
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>()
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      const failure = ports.writeFailure(...args)
      return failure === undefined ? actual.writeFile(...args) : Promise.reject(failure)
    }
  }
})

const roots: Array<string> = []
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-generate-behavior-"))
  roots.push(root)
  return root
}
beforeEach(() => {
  ports.openPackageIndex.mockReset().mockResolvedValue({ targets: () => [] })
  ports.runPackageVerb.mockReset().mockResolvedValue({ ok: true, generated: ["result.ts"] })
  ports.writeFailure.mockReset()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const invoke = async (args: Array<string>, overrides: RuntimeConfig = {}) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const config: RuntimeConfig = {
    environment: {},
    stdout: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    exit: (code) => {
      result.codes.push(code)
    },
    ...overrides
  }
  await createGenerateCli(config).serve([...args, "--json"], {
    env: config.environment,
    stdout: (text) => {
      result.stdout += text
    },
    exit: (code) => {
      result.codes.push(code)
    }
  })
  return { ...result, config }
}

const declaration = (rule: string, label: string) => ({
  label,
  target: Target.make(rule, {
    attrs: Schema.Struct({}),
    kinds: ["build"],
    implementation: () => Node.succeed(undefined)
  })({})
})

describe("workspace initialization behavior", () => {
  it("creates a usable default workspace, target declaration and selected-provider flow", async () => {
    const root = await directory()
    const result = await initialize(root, "example", { OPENAI_API_KEY: "fixture" })
    expect(result.created).toEqual(["package.json", "WORKSPACE.ts", "PACKAGE.ts"])
    expect(result.retained).toEqual([])
    expect(result.next).toEqual(["smthrs targets", "smthrs flow plan example"])
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({
      name: "example",
      private: true,
      type: "module",
      packageManager: "pnpm@11.25.0"
    })
    const workspace = await readFile(join(root, "WORKSPACE.ts"), "utf8")
    expect(workspace).toContain(`repository: ${JSON.stringify(pathToFileURL(root).href)}`)
    expect(workspace).toContain("S.Runtime.Node")
    expect(workspace).toContain("S.PackageManager.Pnpm")
    expect(workspace).toContain("S.file(\"//pnpm-lock.yaml\")")
    expect(await readFile(join(root, "PACKAGE.ts"), "utf8")).toContain("S.glob([\"src/**\"])")
    expect(await readFile(result.flow.flowFile, "utf8")).toContain("model: openai:gpt-6-sol")
    expect(existsSync(join(root, ".flows"))).toBe(true)
    expect(existsSync(join(root, ".gitignore"))).toBe(false)
  })

  it("uses the default toolchain while preserving an existing manifest that omits packageManager", async () => {
    const root = await directory()
    const original = "{\"name\":\"authored\",\"private\":true}"
    await writeFile(join(root, "package.json"), original)
    const result = await initialize(root, "example", {})
    expect(result.retained).toEqual(["package.json"])
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(original)
    const workspace = await readFile(join(root, "WORKSPACE.ts"), "utf8")
    expect(workspace).toContain("S.PackageManager.Pnpm")
    expect(workspace).toContain("version: \"11.25.0\"")
  })

  it.each([
    ["pnpm@10.20.0", "https://example.test/pnpm", "S.PackageManager.Pnpm", "pnpm-lock.yaml", "S.Runtime.Node"],
    ["yarn@4.9.0", { url: "https://example.test/yarn" }, "S.PackageManager.Yarn", "yarn.lock", "S.Runtime.Node"]
  ])(
    "keeps %s and repository identity from the existing package manifest",
    async (manager, repository, constructor, lockfile, runtime) => {
      const root = await directory()
      const original = JSON.stringify({
        name: "authored",
        packageManager: manager,
        repository,
        scripts: { lint: "custom" }
      })
      await writeFile(join(root, "package.json"), original)
      const result = await initialize(root, "example", {})
      expect(result.retained).toEqual(["package.json"])
      expect(await readFile(join(root, "package.json"), "utf8")).toBe(original)
      const workspace = await readFile(join(root, "WORKSPACE.ts"), "utf8")
      expect(workspace).toContain(constructor)
      expect(workspace).toContain(runtime)
      expect(workspace).toContain(
        JSON.stringify(typeof repository === "string" ? repository : repository?.url ?? pathToFileURL(root).href)
      )
      if (lockfile !== undefined) expect(workspace).toContain(`S.file("//${lockfile}")`)
      expect(workspace).toContain(`version: ${JSON.stringify(manager.slice(5))}`)
    }
  )

  it("refuses a package.json that is not JSON by name, never the parser's text", async () => {
    const root = await directory()
    await writeFile(join(root, "package.json"), "{ \"name\": ghp_fixture-token")
    await expect(initialize(root, "example", {})).rejects.toMatchObject({
      _tag: "/cli/Refused",
      fault: "user",
      code: "package_json_invalid",
      message: "package.json is not valid JSON"
    })
  })

  it("refuses to generate a Bun workspace, whose install is unsupported", async () => {
    const root = await directory()
    const original = JSON.stringify({ name: "authored", packageManager: "bun@1.4.2" })
    await writeFile(join(root, "package.json"), original)
    await expect(initialize(root, "example", {})).rejects.toMatchObject({
      _tag: "/cli/Refused",
      fault: "user",
      code: "unsupported_toolchain",
      message: expect.stringMatching(/unsupported: Install cannot use the Bun package manager/)
    })
    expect(existsSync(join(root, "WORKSPACE.ts"))).toBe(false)
    expect(existsSync(join(root, "PACKAGE.ts"))).toBe(false)
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(original)
  })

  it.each(["WORKSPACE.ts", ".smithers/WORKSPACE.ts"])(
    "preserves authored %s, PACKAGE.ts and flow even with an unsupported inferred toolchain",
    async (workspacePath) => {
      const root = await directory()
      await mkdir(join(root, ".smithers"))
      await mkdir(join(root, "flows", "example"), { recursive: true })
      await writeFile(join(root, "package.json"), "{\"packageManager\":\"npm@10.9.0\"}")
      const originals = {
        [workspacePath]: "authored workspace",
        "PACKAGE.ts": "authored targets",
        "flows/example/flow.mdx": "authored flow"
      }
      for (const [path, body] of Object.entries(originals)) await writeFile(join(root, path), body)
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = await initialize(root, "example", {})
        expect(result.created).toEqual([])
        expect(result.retained).toEqual([workspacePath, "PACKAGE.ts"])
        expect(result.flow.created).toBe(false)
        for (const [path, body] of Object.entries(originals)) {
          expect(await readFile(join(root, path), "utf8")).toBe(body)
        }
      }
      expect(await readFile(join(root, "package.json"), "utf8")).toBe("{\"packageManager\":\"npm@10.9.0\"}")
      if (workspacePath.startsWith(".smithers/")) expect(existsSync(join(root, "WORKSPACE.ts"))).toBe(false)
    }
  )

  it("rejects invalid names before creating even the requested root directory", async () => {
    const parent = await directory()
    const root = join(parent, "uncreated")
    await expect(initialize(root, "../escape", {})).rejects.toThrow("one path segment")
    expect(await readdir(parent)).toEqual([])
  })

  it.each(["npm@10.9.0", "pnpm", "pnpm@invalid version", "custom@1"])(
    "refuses unsupported %s before authored files change or new files appear",
    async (packageManager) => {
      const root = await directory()
      const original = JSON.stringify({ name: "mine", packageManager })
      await writeFile(join(root, "package.json"), original)
      await expect(initialize(root, "example", {})).rejects.toThrow(
        "declare WORKSPACE.ts explicitly or use smthrs generate flow"
      )
      expect(await readdir(root)).toEqual(["package.json"])
      expect(await readFile(join(root, "package.json"), "utf8")).toBe(original)
    }
  )

  it("refuses malformed JSON and genuine manifest-read I/O errors without generating files", async () => {
    const malformed = await directory()
    await writeFile(join(malformed, "package.json"), "{")
    await expect(initialize(malformed, "example", {})).rejects.toThrow()
    expect(await readdir(malformed)).toEqual(["package.json"])
    expect(await readFile(join(malformed, "package.json"), "utf8")).toBe("{")
    const unreadable = await directory()
    await mkdir(join(unreadable, "package.json"))
    await expect(initialize(unreadable, "example", {})).rejects.toMatchObject({ code: "EISDIR" })
    expect(await readdir(unreadable)).toEqual(["package.json"])
  })

  it("propagates a write failure and leaves later declarations and flow uncreated", async () => {
    const root = await directory()
    const failure = Object.assign(new Error("fixture disk full"), { code: "ENOSPC" })
    ports.writeFailure.mockImplementation((path) => path === join(root, "WORKSPACE.ts") ? failure : undefined)
    await expect(initialize(root, "example", {})).rejects.toBe(failure)
    expect(await readdir(root)).toEqual(["package.json"])
    expect(existsSync(join(root, "PACKAGE.ts"))).toBe(false)
    expect(existsSync(join(root, "flows"))).toBe(false)
  })
})

describe("generator command behavior", () => {
  it.each([["flow"], ["package"], ["ci"]])("keeps %s help inert", async (args) => {
    const result = await invoke([...args, "--help"])
    expect(result.codes).not.toContain(1)
    expect(ports.openPackageIndex).not.toHaveBeenCalled()
    expect(ports.runPackageVerb).not.toHaveBeenCalled()
  })

  it("refuses the retired app generator without running a workspace generator", async () => {
    const root = await directory()
    const result = await invoke(["app", join(root, "my-app")])
    expect(result.codes).toContain(1)
    expect(await readdir(root)).toEqual([])
    expect(ports.openPackageIndex).not.toHaveBeenCalled()
    expect(ports.runPackageVerb).not.toHaveBeenCalled()
  })

  it("writes a requested flow without changing package declarations and preserves it on repeat", async () => {
    const root = await directory()
    await writeFile(join(root, "package.json"), "{\"packageManager\":\"npm@10.9.0\"}")
    const result = await invoke(["flow", "example", "--root", root], { environment: { OPENAI_API_KEY: "fixture" } })
    expect(result.codes).not.toContain(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "example", created: true })
    expect(await readFile(join(root, "flows", "example", "flow.mdx"), "utf8")).toContain("model: openai:gpt-6-sol")
    await writeFile(join(root, "flows", "example", "flow.mdx"), "authored flow")
    expect(JSON.parse((await invoke(["flow", "example", "--root", root])).stdout)).toMatchObject({ created: false })
    expect(await readFile(join(root, "flows", "example", "flow.mdx"), "utf8")).toBe("authored flow")
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{\"packageManager\":\"npm@10.9.0\"}")
    expect(existsSync(join(root, "WORKSPACE.ts"))).toBe(false)
  })

  it("uses the cwd project and process environment only when flow configuration omits them", async () => {
    const root = await directory()
    vi.spyOn(process, "cwd").mockReturnValue(root)
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture")
    const result = await invoke(["flow", "example"], { environment: undefined })
    expect(result.codes).not.toContain(1)
    expect(await readFile(join(root, "flows", "example", "flow.mdx"), "utf8")).toContain(
      "model: anthropic:claude-sonnet-4-5"
    )
  })

  it("rejects a traversal flow name without filesystem or build activity", async () => {
    const root = await directory()
    const result = await invoke(["flow", "../outside", "--root", root])
    // A bad name is fixed by retyping it: a usage error, exit 2.
    expect(result.codes).toContain(2)
    expect(result.stdout).toContain("one path segment")
    expect(await readdir(root)).toEqual([])
    expect(ports.openPackageIndex).not.toHaveBeenCalled()
  })

  it("selects the sole NewPackage rule and forwards the name, plan flag and mandatory write/cache policy", async () => {
    ports.openPackageIndex.mockResolvedValue({
      targets: () => [declaration("Filegroup", "//:sources"), declaration("NewPackage", "//:new-package")]
    })
    const result = await invoke(["package", "library", "--workspace", "/fixture", "--plan"])
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, generated: ["result.ts"] })
    expect(ports.openPackageIndex).toHaveBeenCalledExactlyOnceWith({ workspace: "/fixture", plan: true }, result.config)
    expect(ports.runPackageVerb).toHaveBeenCalledExactlyOnceWith(
      "auto",
      ["//:new-package"],
      {
        workspace: "/fixture",
        plan: true,
        cache: false,
        write: true,
        name: "library"
      },
      result.config,
      expect.any(Object)
    )
  })

  it.each(["Github.Workflow", "GithubCiGen"])("selects %s for CI without passing a package name", async (rule) => {
    ports.openPackageIndex.mockResolvedValue({
      targets: () => [declaration("NewPackage", "//:package"), declaration(rule, "//:ci")]
    })
    const result = await invoke(["ci"])
    expect(result.codes).not.toContain(1)
    expect(ports.runPackageVerb).toHaveBeenCalledExactlyOnceWith(
      "auto",
      ["//:ci"],
      {
        workspace: process.cwd(),
        plan: false,
        cache: false,
        write: true
      },
      result.config,
      expect.any(Object)
    )
  })

  it("uses an explicit declared label to disambiguate candidates", async () => {
    ports.openPackageIndex.mockResolvedValue({
      targets: () => [declaration("NewPackage", "//:one"), declaration("NewPackage", "//:two")]
    })
    const result = await invoke(["package", "chosen", "--target", "//:two", "--workspace", "/fixture"])
    expect(result.codes).not.toContain(1)
    expect(ports.runPackageVerb.mock.calls[0]?.slice(0, 3)).toEqual(["auto", ["//:two"], {
      workspace: "/fixture",
      plan: false,
      cache: false,
      write: true,
      name: "chosen"
    }])
  })

  it.each([["package", "library"], ["ci"]])(
    "refuses missing %s generators before running a target",
    async (...args) => {
      const result = await invoke(args)
      expect(result.codes).toContain(1)
      expect(result.stdout).toContain(`No declared ${args[0]} generator matches`)
      expect(result.stdout).toContain("generator_missing")
      expect(result.stdout).toContain(args[0] === "package" ? "S.NewPackage" : "S.Github.Workflow")
      expect(ports.runPackageVerb).not.toHaveBeenCalled()
    }
  )

  it("refuses ambiguous selection and explicit labels that are not matching generators", async () => {
    ports.openPackageIndex.mockResolvedValue({
      targets: () => [
        declaration("Github.Workflow", "//:one"),
        declaration("GithubCiGen", "//:two"),
        declaration("Filegroup", "//:files")
      ]
    })
    const ambiguous = await invoke(["ci"])
    // Retyping with --target fixes it: a usage error, exit 2.
    expect(ambiguous.codes).toContain(2)
    expect(ambiguous.stdout).toContain("Choose a generator with --target: //:one, //:two")
    const mismatched = await invoke(["ci", "--target", "//:files"])
    expect(mismatched.codes).toContain(1)
    expect(mismatched.stdout).toContain("(//:files)")
    expect(ports.runPackageVerb).not.toHaveBeenCalled()
  })

  it("preserves plan-only outcomes without requiring an execution ok field", async () => {
    ports.openPackageIndex.mockResolvedValue({ targets: () => [declaration("Github.Workflow", "//:ci")] })
    ports.runPackageVerb.mockResolvedValue({ planned: [".github/workflows/ci.yml"] })
    const result = await invoke(["ci", "--plan"], { stderr: undefined, environment: undefined })
    expect(result.codes).not.toContain(1)
    expect(JSON.parse(result.stdout)).toEqual({ planned: [".github/workflows/ci.yml"] })
  })

  it("propagates target discovery and execution transport failures", async () => {
    ports.openPackageIndex.mockRejectedValueOnce(new Error("workspace failed to load"))
    const discovery = await invoke(["ci"])
    expect(discovery.codes).toContain(1)
    expect(discovery.stdout).toContain("workspace failed to load")
    expect(ports.runPackageVerb).not.toHaveBeenCalled()
    ports.openPackageIndex.mockResolvedValue({ targets: () => [declaration("Github.Workflow", "//:ci")] })
    ports.runPackageVerb.mockRejectedValueOnce(new Error("executor unavailable"))
    const execution = await invoke(["ci"])
    expect(execution.codes).toContain(1)
    expect(execution.stdout).toContain("executor unavailable")
  })

  it.each([true, false])("reports unsuccessful execution even when exit hook is present=%s", async (withExit) => {
    ports.openPackageIndex.mockResolvedValue({ targets: () => [declaration("NewPackage", "//:new-package")] })
    ports.runPackageVerb.mockResolvedValue({ ok: false, failures: ["write denied"] })
    const result = await invoke(["package", "example"], withExit ? {} : { exit: undefined })
    expect(result.codes).toContain(1)
    expect(result.stdout).toContain("package generator failed; inspect the target diagnostics")
    expect(result.codes.filter((code) => code === 1)).toHaveLength(withExit ? 2 : 1)
  })
})
