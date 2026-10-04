import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Audience from "@smthrs/build-cli/Audience"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-audience-cli-"))
  roots.push(root)
  return root
}
const invoke = async (args: Array<string>, env: Record<string, string>, terminal = true) => {
  const result = { stdout: "", stderr: "", code: 0 }
  const presentation = Audience.fromArguments(args, { env, stdin: terminal, stdout: terminal, stderr: terminal })
  const stdout = {
    isTTY: terminal,
    columns: 80,
    write: (text: string) => {
      result.stdout += text
    }
  }
  const stderr = {
    isTTY: terminal,
    columns: 80,
    write: (text: string) => {
      result.stderr += text
    }
  }
  const exit = (code: number) => {
    if (code !== 0) result.code = code
  }
  await makeCli({ evaluator: ScriptedJudge.layer, environment: env, presentation, stdout, stderr, exit }).serve(
    Audience.incurArguments(args, presentation),
    {
      env,
      exit,
      stdout: stdout.write
    }
  )
  return result
}

describe("audience-aware public CLI", { timeout: 90_000 }, () => {
  it("omits deferred groups from discovery while explicit help still resolves", async () => {
    const help = await invoke(["--help"], {})
    const manifest = await invoke(["--llms-full", "--format", "json"], {})
    const commands = JSON.parse(manifest.stdout).commands as Array<{ name: string }>
    for (const group of ["tui", "triggers", "org"]) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+${group}\\s`, "m"))
      expect(commands.some(command => command.name === group || command.name.startsWith(group + " "))).toBe(false)
      const explicit = await invoke([group, "--help"], {})
      expect(explicit.code, explicit.stdout + explicit.stderr).toBe(0)
      expect(explicit.stdout).toContain(group)
    }
  })

  it("returns compact Incur data and next actions to a harness with a PTY", async () => {
    const root = await fixture()
    const result = await invoke(["flow", "list", "--root", root], { CLAUDECODE: "1" })
    expect(result.code, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain("cta:")
    expect(result.stdout).toContain("flow plan --help")
    expect(result.stdout).not.toContain("\u001b")
    expect(result.stderr).toBe("")
  })
  it("gives a human a readable result without progress when silent", async () => {
    const root = await fixture()
    const result = await invoke(["flow", "list", "--root", root, "--audience", "human", "--silent"], {
      CLAUDECODE: "1"
    })
    expect(result.code, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain("flow list")
    expect(result.stdout).toContain("No flows discovered under flows/.")
    expect(result.stdout).toContain("Next:")
    expect(result.stdout).not.toContain("cta:")
    expect(result.stderr).toBe("")
  })
  it("keeps explicit JSON machine-readable for humans and leaves help inert", async () => {
    const root = await fixture()
    const help = await invoke(["runs", "logs", "--help"], {})
    expect(help.stdout).toContain("--limit")
    expect(await readdir(root)).toEqual([])
    const result = await invoke(["flow", "list", "--root", root, "--audience", "human", "--json"], {})
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows", items: [] })
    expect(result.stdout).not.toContain("\u001b")
  })
})
