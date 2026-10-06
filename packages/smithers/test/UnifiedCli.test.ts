import { spawn } from "node:child_process"
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { legacyArguments } from "../src/cli/Compatibility.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-unified-cli-"))
  roots.push(root)
  return root
}
const serve = async (args: Array<string>) => {
  const result = await run(await fixture(), args)
  return { code: result.code, output: result.stdout, stderr: result.stderr }
}
const initialize = async (root: string, name: string) => {
  const result = await run(root, ["init", name, "--root", root, "--json"])
  expect(result.code, result.stdout + result.stderr).toBe(0)
  return JSON.parse(result.stdout) as { retained: Array<string> }
}
const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const run = (root: string, args: Array<string>, environment: Record<string, string> = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
      cwd: root,
      env: { ...process.env, SMITHERS_REMOTE: "", ...environment }
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000)
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })

describe("unified CLI", { timeout: 240_000 }, () => {
  it("advertises canonical groups without old unsupported tombstones", async () => {
    const result = await serve(["--help"])
    expect(result.code, result.output).toBe(0)
    for (
      const name of [
        "build",
        "targets",
        "affected",
        "watch",
        "cache",
        "flow",
        "runs",
        "approvals",
        "generate",
        "eval",
        "triggers",
        "integrations",
        "credentials"
      ]
    ) expect(result.output).toContain(name)
    for (const name of ["hijack", "timetravel", "retry-task", "claude"]) expect(result.output).not.toContain(name)
  })

  it("keeps help, schema and invalid invocations file-free through the executable", async () => {
    const root = await fixture()
    for (
      const args of [["--help"], ["flow", "start", "--schema"], ["runs", "inspect", "--help"], ["runs", "unknown"], [
        "runs",
        "fork",
        "run-1",
        "--at",
        "0"
      ], ["runs", "rewind", "run-1", "--at", "0", "--yes"]]
    ) {
      const result = await run(root, args)
      expect(result.code, result.stderr + result.stdout).toBe(
        args.at(-1) === "unknown" || args[1] === "fork" || args[1] === "rewind" ? 1 : 0
      )
      expect(await readdir(root)).toEqual([])
    }
  })

  it("migration scan does not initialize execution databases", async () => {
    const root = await fixture()
    const original = JSON.stringify({ name: "migration-inspection", private: true, type: "module" })
    await writeFile(join(root, "package.json"), original)
    const result = await run(root, ["migrate", root, "--scan", "--json", "--root", root])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(result.stdout + result.stderr).not.toContain("Service not found")
    expect(await readdir(root)).not.toContain(".flows")
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(original)
  })

  it("explicit npm init refuses before writes and flow generation preserves the package manager", async () => {
    const root = await fixture()
    const original = JSON.stringify({ name: "npm-project", private: true, packageManager: "npm@10.9.0" })
    await writeFile(join(root, "package.json"), original)
    const refused = await run(root, ["init", "hello", "--root", root, "--json"])
    expect(refused.code).not.toBe(0)
    expect(refused.stdout + refused.stderr).toContain("generate flow")
    expect(await readdir(root)).toEqual(["package.json"])
    const generated = await run(root, ["generate", "flow", "hello", "--root", root, "--json"])
    expect(generated.code, generated.stdout + generated.stderr).toBe(0)
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(original)
    await access(join(root, "flows/hello/flow.mdx"))
  })

  it("initializes one workspace and preserves existing declarations on repeat", async () => {
    const root = await fixture()
    await initialize(root, "hello")
    await writeFile(
      join(root, "PACKAGE.ts"),
      "import { Smithers as S } from \"@smthrs/targets\"\nexport const Package = S.Package({targets:{sources:S.Filegroup({srcs:[]})}})\n"
    )
    const repeated = await initialize(root, "hello")
    expect(repeated.retained).toContain("PACKAGE.ts")
    expect(await readFile(join(root, "PACKAGE.ts"), "utf8")).toContain("srcs:[]")
    const targets = await serve(["targets", "--root", root, "--json"])
    expect(targets.code, targets.output).toBe(0)
    expect(targets.output).toContain("//:sources")
    await access(join(root, "flows", "hello", "flow.mdx"))
  })

  it("reads the actual flow catalog and preserves usage failures at the command bridge", async () => {
    const root = await fixture()
    await initialize(root, "hello")
    const listed = await serve(["flow", "list", "--root", root, "--json"])
    expect(listed.code, listed.output).toBe(0)
    expect(listed.output).toContain("hello")
    const planned = await serve(["flow", "plan", "hello", "--data", "{", "--root", root, "--json"])
    expect(planned.code, planned.output).toBe(2)
    const runs = await serve(["runs", "list", "--root", root, "--json"])
    expect(runs.code, runs.output).toBe(0)
    expect((await serve(["approvals", "list", "--root", root, "--json"])).code).toBe(0)
  })

  it("routes only unambiguous legacy spellings", () => {
    expect(legacyArguments(["--root", "/fixture", "up", "hello"])).toEqual(["--root", "/fixture", "up", "hello"])
    expect(legacyArguments(["internal", "claude", "tick"])).toEqual(["claude", "tick"])
    expect(legacyArguments(["run", "{\"planId\":\"id\"}"])).toBeDefined()
    expect(legacyArguments(["run", "--resume", "id"])).toBeDefined()
    expect(legacyArguments(["run", "//app:serve"])).toBeUndefined()
    expect(legacyArguments(["flow", "start", "hello"])).toBeUndefined()
    for (
      const args of [
        ["gateway"],
        ["gateway", "--port", "0"],
        ["init", "--global"],
        ["memory"],
        ["memory", "get"],
        ["memory", "set", "key"],
        ["mcp"],
        ["mcp", "add", "--agent", "claude"]
      ]
    ) {
      expect(legacyArguments(args), args.join(" ")).toBeUndefined()
    }
    expect(legacyArguments(["gateway", "status"])).toEqual(["gateway", "status"])
  })

  it("accepts canonical log formatting through the flat alias", async () => {
    const root = await fixture()
    const flags = [
      "missing-run",
      "--root",
      root,
      "--audience",
      "human",
      "--format",
      "jsonl",
      "--after",
      "0",
      "--limit",
      "2"
    ]
    const canonical = await run(root, ["runs", "logs", ...flags])
    const alias = await run(root, ["logs", ...flags])
    for (const result of [canonical, alias]) {
      expect(result.code, result.stdout + result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        type: "done",
        ok: true,
        meta: { command: "runs logs", duration: expect.any(String) }
      })
    }
    expect(alias.stderr).toBe(canonical.stderr)
    expect(alias.stdout + alias.stderr).not.toContain("Unknown flag")
  })

  it("explains the removed global initializer through the executable before writing", async () => {
    const root = await fixture()
    const result = await run(root, ["init", "change", "--root", root, "--global"])
    expect(result.code, result.stdout + result.stderr).toBe(1)
    expect(result.stdout + result.stderr).toContain("https://smithers.sh/migration/1.0#init")
    expect(result.stdout + result.stderr).not.toContain("Unknown flag")
    expect(await readdir(root)).toEqual([])
  })

  it("retains the diagnostic report on a blocking problem even with quiet progress", async () => {
    const root = await fixture()
    const result = await run(root, ["doctor", "--root", root, "--json", "--quiet"], { SMITHERS_BACKEND: "legacy" })
    expect(result.code, result.stderr + result.stdout).toBe(1)
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; level: string }> }
    expect(report, result.stdout + result.stderr).toHaveProperty("checks")
    expect(report.checks.some((check) => check.name.includes("backend") && check.level === "fail")).toBe(true)
    expect(await readdir(root)).toEqual([])
  })
})
