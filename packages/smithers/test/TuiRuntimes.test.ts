/**
 * `smthrs tui -p` end to end on each runtime the TUI supports.
 *
 * The CLI starts the real TUI in print mode under Node >= 26.4 (the bundle,
 * with FFI enabled) and under Bun (the checkout source). The model is the
 * TUI's replay seat over `apps/tui/test/fixtures/pong.jsonl`, whose one reply
 * is a cell that answers `pong`, so no credentials or network are needed.
 * Node runs without Bun on `PATH`. Both runtimes must keep `--approve` and
 * `SMITHERS_TUI_APPROVE`, which only the TUI parses.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const bin = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
const fixture = fileURLToPath(new URL("../../../apps/tui/test/fixtures/pong.jsonl", import.meta.url))
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
const nodeHasFfi = major > 26 || (major === 26 && minor >= 4)
const bun = spawnSync("bun", ["--version"]).status === 0 ? "bun" : undefined
const nodePath = (process.env["PATH"] ?? "").split(delimiter).filter((entry) => !/\.bun\b/.test(entry)).join(delimiter)

const staged: Array<string> = []
afterEach(() => {
  for (const root of staged.splice(0)) rmSync(root, { recursive: true, force: true })
})

const print = (environment: Record<string, string>, args: ReadonlyArray<string> = []) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-tui-e2e-"))
  staged.push(root)
  return spawnSync(process.execPath, [bin, "tui", root, "-p", "Reply with the single word pong", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      HOME: process.env["HOME"] ?? root,
      SMITHERS_TUI_REPLAY: fixture,
      SMITHERS_TUI_SESSION_DIR: join(root, ".sessions"),
      ...environment
    }
  })
}

describe("smthrs tui -p on each runtime", () => {
  it.skipIf(!nodeHasFfi)("answers under Node >= 26.4 without Bun", () => {
    const result = print({ PATH: nodePath })
    expect(result.stderr).toBe("")
    expect(result.stdout.trim()).toBe("pong")
    expect(result.status).toBe(0)
  }, 150_000)

  it.skipIf(bun === undefined)("answers under Bun", () => {
    const result = print({ PATH: process.env["PATH"] ?? "", SMITHERS_BUN: bun! })
    expect(result.stdout.trim()).toBe("pong")
    expect(result.status).toBe(0)
  }, 150_000)

  const runtimes = [
    { name: "Node", skip: !nodeHasFfi, environment: () => ({ PATH: nodePath }) },
    {
      name: "Bun",
      skip: bun === undefined,
      environment: () => ({ PATH: process.env["PATH"] ?? "", SMITHERS_BUN: bun! })
    }
  ]
  for (const runtime of runtimes) {
    it.skipIf(runtime.skip)(
      `forwards approval modes and retains the TUI's headless refusal under ${runtime.name}`,
      () => {
        const environment = runtime.environment()
        const denied = print(environment, ["--approve", "deny"])
        expect(denied.status, denied.stderr).toBe(0)
        expect(denied.stdout.trim()).toBe("pong")
        const ask = print(environment, ["--approve", "ask"])
        expect(ask.status).toBe(1)
        expect(ask.stderr).toContain("--approve ask needs the interactive TUI")
        expect(ask.stdout).toBe("")
        const configured = print({ ...environment, SMITHERS_TUI_APPROVE: "ask" })
        expect(configured.status).toBe(1)
        expect(configured.stderr).toContain("SMITHERS_TUI_APPROVE=ask needs the interactive TUI")
        const overridden = print({ ...environment, SMITHERS_TUI_APPROVE: "ask" }, ["--approve", "deny"])
        expect(overridden.status, overridden.stderr).toBe(0)
        const invalid = print(environment, ["--approve", "sometimes"])
        expect(invalid.status).not.toBe(0)
        expect(invalid.stdout).toContain("approve")
      },
      150_000
    )
  }
})
