/**
 * The facts the checklist reads, for the repositories the fixtures elsewhere
 * do not describe.
 *
 * `Suggest.test.ts` and `SuggestSurface.test.ts` drive the verb through one
 * JavaScript repository each, which leaves the rest of the evidence reader
 * and several rule arms unasserted: the runners named by a script other than
 * vitest, the languages a polyglot checkout declares, a runner configured
 * without a `test` script, a workspace described by `PACKAGE.ts`, and a
 * GitHub repository with no test runner at all. Each one changes what an
 * operator is offered, so each is pinned here against the same public
 * surface.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Checklist from "../src/suggest/Checklist.ts"

const rule = (id: string): Checklist.Rule => {
  const found = Checklist.checks.find((check) => check.id === id)
  if (found === undefined) throw new Error(`no rule ${id}`)
  return found
}

describe("the evidence a repository leaves", () => {
  it("names the runner a test script spells, whichever one it is", () => {
    const jest = Checklist.memoryRepository("/jest", {
      "package.json": JSON.stringify({ scripts: { test: "jest --ci" } })
    })
    const bun = Checklist.memoryRepository("/bun", {
      "package.json": JSON.stringify({ scripts: { test: "bun test --coverage" } })
    })
    const other = Checklist.memoryRepository("/other", {
      "package.json": JSON.stringify({ scripts: { test: "make check" } })
    })
    expect(Checklist.evidence(jest).testRunner).toBe("jest")
    expect(Checklist.evidence(bun).testRunner).toBe("bun test")
    // Nothing recognised: the script itself is the best name available.
    expect(Checklist.evidence(other).testRunner).toBe("make check")
  })

  it("lists every language a polyglot checkout declares", () => {
    const polyglot = Checklist.memoryRepository("/polyglot", {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "tsconfig.json": "{}",
      "Cargo.toml": "[package]\nname = \"x\"\n",
      "go.mod": "module example.com/x\n",
      "pyproject.toml": "[project]\nname = \"x\"\n"
    })
    expect(Checklist.evidence(polyglot).language).toEqual(["javascript", "typescript", "rust", "go", "python"])
  })

  it("cites only the runner's own files when no test script names it", () => {
    const repository = Checklist.memoryRepository("/runner", {
      "package.json": "{}",
      "vitest.config.ts": "export default {}"
    })
    const facts = Checklist.evidence(repository)
    expect(facts.testRunner).toBe("vitest")
    // `package.json` declares no test script, so citing it would send the
    // agent to a file that says nothing about the suggestion.
    expect(rule("test-target").match(facts, repository)).toMatchObject({ files: ["vitest.config.ts"] })
  })

  it("cites PACKAGE.ts as the layout when a build manifest is the only one", () => {
    const repository = Checklist.memoryRepository("/package-ts", {
      "PACKAGE.ts": "export const Package = {}",
      "package.json": JSON.stringify({ scripts: { build: "smthrs ci" } })
    })
    const facts = Checklist.evidence(repository)
    expect(facts.packageFile).toBe(true)
    expect(facts.monorepo).toEqual([])
    expect(rule("agents-md").match(facts, repository)).toMatchObject({ files: ["PACKAGE.ts"] })
  })

  it("offers a sandboxed review to a GitHub repository that has no runner", () => {
    const repository = Checklist.memoryRepository("/no-runner", {
      ".github/workflows/ci.yml": "on: push\n"
    })
    const facts = Checklist.evidence(repository)
    expect(facts).toMatchObject({ github: true, testRunner: undefined })
    const suggestion = rule("sandboxed-review").match(facts, repository)
    expect(suggestion).toMatchObject({ files: [".git/config"] })
    expect(suggestion!.why).toContain("the review can run in a sandbox")
  })
})

const machine = (files: Record<string, string>) => {
  const result = Checklist.evidence(Checklist.memoryRepository("/fixture", files)).machine
  if (result instanceof Checklist.MachineRecipeError) throw result
  return result
}

describe("machine evidence (§8.6.2)", () => {
  it.each([
    [".node-version", "22.14.0", "node", "22.14.0"],
    [".nvmrc", "v22.14.0", "node", "22.14.0"],
    ["package.json", "{\"engines\":{\"node\":\">=22 <23\"}}", "node", ">=22 <23"],
    ["go.mod", "module x\ngo 1.23\ntoolchain go1.23.8\n", "go", "1.23.8"],
    ["rust-toolchain.toml", "[toolchain]\nchannel = \"1.85.0\"", "rust", "1.85.0"],
    ["Cargo.toml", "[package]\nrust-version = \"1.78\"", "rust", ">=1.78"],
    [".python-version", "3.12.9", "python", "3.12.9"],
    ["pyproject.toml", "[project]\nrequires-python = \"==3.12.9\"", "python", "==3.12.9"],
    ["uv.lock", "version = 1", "python", ""],
    ["requirements-dev.txt", "pytest==8.3.5", "python", ""]
  ])("detects %s", (file, body, tool, version) => {
    expect(machine({ [file!]: body! }).tools[tool!]?.version).toBe(version)
  })

  it("uses the winning Node file and ignores invalid overridden versions", () => {
    const files = {
      ".node-version": "v22.14.0",
      ".nvmrc": "lts/*",
      "package.json": "{\"engines\":{\"node\":\"invalid\"}}"
    }
    expect(machine(files).tools.node).toEqual({ version: "22.14.0", file: ".node-version" })
    expect(machine({ ".nvmrc": "20.19.0", "package.json": files["package.json"] }).tools.node?.version).toBe("20.19.0")
  })

  it.each(
    [
      ["pnpm-lock.yaml", "pnpm", ["pnpm", "install", "--frozen-lockfile"]],
      ["package-lock.json", "npm", ["npm", "ci"]],
      ["yarn.lock", "yarn", ["yarn", "install", "--frozen-lockfile"]],
      ["bun.lock", "bun", ["bun", "install", "--frozen-lockfile"]],
      ["bun.lockb", "bun", ["bun", "install", "--frozen-lockfile"]]
    ] as const
  )("selects %s", (file, manager, command) => {
    const recipe = machine({ [file]: "lock" })
    expect(recipe.packageManager).toBe(manager)
    expect(recipe.installs[0]?.command).toEqual(command)
    expect(recipe.installs[0]?.offline).toContain("--offline")
    expect(recipe.installs[0]?.files).toContain(file)
    expect(recipe.installs[0]?.destinations).toContain("registry.npmjs.org")
  })

  it("uses the declaration ahead of conflicting locks, with its integrity suffix", () => {
    const recipe = machine({
      "package.json": "{\"packageManager\":\"pnpm@9.15.5+sha512.abc\"}",
      "pnpm-lock.yaml": "lock",
      "package-lock.json": "lock"
    })
    expect(recipe.tools.pnpm).toEqual({ version: "9.15.5", file: "package.json" })
    expect(recipe.installs).toHaveLength(1)
    expect(recipe.installs[0]?.files).toEqual(["package.json", "pnpm-lock.yaml"])
  })

  it("refuses every different-manager lock pair, naming both", () => {
    const locks = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]
    for (const [i, first] of locks.entries()) {
      for (const second of locks.slice(i + 1)) {
        if (first.startsWith("bun.") && second.startsWith("bun.")) continue
        const result =
          Checklist.evidence(Checklist.memoryRepository("/conflict", { [first]: "lock", [second]: "lock" })).machine
        expect(result).toBeInstanceOf(Checklist.MachineRecipeError)
        expect((result as Checklist.MachineRecipeError).message).toContain(first)
        expect((result as Checklist.MachineRecipeError).message).toContain(second)
      }
    }
    expect(machine({ "bun.lock": "lock", "bun.lockb": "lock" }).installs).toHaveLength(1)
  })

  it("uses npm for a manifest without locks", () => {
    expect(machine({ "package.json": "{}" }).installs[0]?.command).toEqual(["npm", "install"])
  })

  it("has no tools or installs for absent or unsupported files", () => {
    const base = machine({})
    expect(base.tools).toEqual({})
    expect(base.installs).toEqual([])
    expect(
      machine({
        ".tool-versions": "nodejs 22",
        "Gemfile": "ruby '3'",
        ".ruby-version": "invalid",
        "Dockerfile": "FROM node:22",
        "Cargo.lock": "lock"
      })
    ).toEqual(base)
  })

  it("produces ordered offline requirements installs and frozen uv installs", () => {
    const pip = machine({ "requirements-prod.txt": "requests==2", "requirements-dev.txt": "pytest==8" }).installs[0]!
    expect(pip.command).toEqual([
      "python",
      "-m",
      "pip",
      "install",
      "-r",
      "requirements-dev.txt",
      "-r",
      "requirements-prod.txt"
    ])
    expect(pip.offline).toContain("--no-index")
    expect(pip.destinations).toEqual(["files.pythonhosted.org", "pypi.org"])
    const uv = machine({ "pyproject.toml": "[project]", "uv.lock": "version = 1" }).installs[0]!
    expect(uv.command).toEqual(["uv", "sync", "--frozen"])
    expect(uv.offline).toEqual(["uv", "sync", "--frozen", "--offline"])
    expect(machine({ "go.mod": "module x\ngo 1.23\n" }).installs[0]?.command).toEqual(["go", "mod", "download"])
    expect(machine({ "Cargo.toml": "[package]" }).installs[0]?.command).toEqual(["cargo", "fetch"])
  })

  it.each([
    [".node-version", ""],
    [".node-version", "22;id"],
    [".node-version", "22\n20"],
    [".nvmrc", "lts/*"],
    ["package.json", "{"],
    ["package.json", "{\"engines\":{\"node\":22}}"],
    ["package.json", "{\"packageManager\":\"unknown@1\"}"],
    ["package.json", "{\"packageManager\":\"pnpm@^9\"}"],
    ["package.json", "{\"packageManager\":\"pnpm@$(id)\"}"],
    ["go.mod", "module x"],
    ["go.mod", "go 1.23\ngo 1.24\n"],
    ["go.mod", "go 1.23\ntoolchain ../x\n"],
    ["rust-toolchain.toml", "[toolchain"],
    ["rust-toolchain.toml", "[toolchain]\ncomponents = []"],
    ["rust-toolchain.toml", "[toolchain]\nchannel = \"^1.85\""],
    ["Cargo.toml", "[package]\nrust-version = \">=1.78\""],
    [".python-version", "3.12\n3.13"],
    ["pyproject.toml", "[project"],
    ["pyproject.toml", "[project]\nrequires-python = \"^^3.13\""]
  ])("refuses hostile or invalid %s: %s", (file, contents) => {
    const result = Checklist.evidence(Checklist.memoryRepository("/hostile", { [file!]: contents! })).machine
    expect(result).toBeInstanceOf(Checklist.MachineRecipeError)
    expect((result as Checklist.MachineRecipeError).class).toBe("user")
    expect((result as Checklist.MachineRecipeError).fix).toContain(file)
  })
})

it("ships exactly the compiled shared detector", () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-machine-evidence-"))
  try {
    const output = join(temporary, "machine_evidence.js")
    const entry = fileURLToPath(new URL("../scripts/machine-evidence.ts", import.meta.url))
    const built = spawnSync("bun", ["build", entry, "--target=node", "--minify", `--outfile=${output}`], {
      encoding: "utf8"
    })
    expect(built.status, built.stderr).toBe(0)
    expect(readFileSync(output, "utf8")).toBe(
      readFileSync(new URL("../../backend/microsandbox/machine_evidence.js", import.meta.url), "utf8")
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

describe("shared detected check inventory", () => {
  it.each(
    [
      [{
        "package.json":
          "{\"packageManager\":\"pnpm@9.15.4\",\"scripts\":{\"test\":\"vitest\",\"lint\":\"eslint .\",\"typecheck\":\"tsc\",\"build\":\"tsc -b\"}}"
      }, [
        { id: "test", argv: ["pnpm", "test"] },
        { id: "lint", argv: ["pnpm", "lint"] },
        { id: "typecheck", argv: ["pnpm", "typecheck"] },
        { id: "build", argv: ["pnpm", "build"] }
      ]],
      [{ "package.json": "{\"scripts\":{\"test\":\"node --test\",\"build\":\"tsc\"}}" }, [{
        id: "test",
        argv: ["npm", "run", "test"]
      }, { id: "build", argv: ["npm", "run", "build"] }]],
      [{ "go.mod": "module example.test/app\ngo 1.23\n" }, [{ id: "test", argv: ["go", "test", "./..."] }]],
      [{ "Cargo.toml": "[package]\nname='app'\n" }, [{ id: "test", argv: ["cargo", "test"] }]],
      [{ "pyproject.toml": "[project]\nname='app'\n" }, [{ id: "test", argv: ["pytest"] }]],
      [{ "setup.py": "from setuptools import setup" }, [{ id: "test", argv: ["pytest"] }]],
      [{ "pytest.ini": "[pytest]" }, [{ id: "test", argv: ["pytest"] }]],
      [{}, undefined]
    ] as const
  )("retains literal checks from %j", (files, checks) => {
    expect(machine(files as Record<string, string>).checks).toEqual(checks)
  })

  it("retains Makefile checks without adding an image layer", () => {
    const recipe = machine({ Makefile: "build:\n\ttest -s JOURNEY.md\ntest :\n\tgrep -q . JOURNEY.md\n# lint:\n" })
    expect(recipe.checks).toEqual([{ id: "test", argv: ["make", "test"] }, { id: "build", argv: ["make", "build"] }])
    expect(recipe.tools).toEqual({})
    expect(recipe.installs).toEqual([])
  })

  it("prefers package scripts to duplicate Makefile and language checks", () => {
    const recipe = machine({
      "package.json": "{\"scripts\":{\"test\":\"vitest\",\"lint\":\"eslint .\"}}",
      "Makefile": "test:\nlint:\nbuild:\n",
      "go.mod": "module x\ngo 1.23\n"
    })
    expect(recipe.checks).toEqual([{ id: "test", argv: ["npm", "run", "test"] }, {
      id: "lint",
      argv: ["npm", "run", "lint"]
    }, { id: "build", argv: ["make", "build"] }])
    expect(machine({ "package.json": "{\"scripts\":{\"test\":\"echo no test specified\"}}" }).checks).toBeUndefined()
  })
})
