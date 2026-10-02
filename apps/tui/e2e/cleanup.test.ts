/**
 * A test run leaves nothing behind: no temporary folders, no `tmux`.
 *
 * Each case runs real `bun test` children against a private `TMPDIR` and
 * checks it afterwards. The cases they run make scratch folders and never
 * remove them themselves, so this proves the suite-wide root in
 * `test/scratch.ts` does.
 */
import { afterAll, describe, expect, it } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { daemons } from "../test/scratch.ts"

const app = resolve(import.meta.dir, "..")
const env = (base: string) => ({ ...process.env, TMPDIR: base })

// Under `/tmp`, not this run's own root: a child root nested in it would put
// tmux's socket past the 104-byte macOS limit.
const bases: Array<string> = []
const scratch = (prefix: string) => {
  const base = mkdtempSync(join("/tmp", prefix))
  bases.push(base)
  return base
}
afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true })
})

const run = (base: string, ...args: Array<string>) => {
  const result = spawnSync("bun", ["test", ...args], { cwd: app, env: env(base), encoding: "utf8", timeout: 120_000 })
  expect(`${result.stderr}`).toMatch(/\b[1-9]\d* pass\b[\s\S]*\b0 fail\b/)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("test-run cleanup", () => {
  it("an e2e case and a unit case leave no folder and no tmux", () => {
    const base = scratch("tui-cleanup-")
    run(base, "./e2e/tui.test.ts", "-t", "names no mode by default")
    run(base, "./test/cap.test.ts")
    expect(readdirSync(base)).toEqual([])
    expect(daemons(base)).toEqual([])
  }, 180_000)

  it("the next run removes what a killed run left, tmux included", async () => {
    const base = scratch("tui-cleanup-killed-")
    const child = spawn("bun", ["test", "./e2e/tui.test.ts", "-t", "names no mode by default"], {
      cwd: app,
      env: env(base),
      stdio: "ignore"
    })
    const deadline = Date.now() + 60_000
    while (daemons(base).length === 0 && Date.now() < deadline) await sleep(100)
    const orphaned = daemons(base)
    expect(orphaned.length).toBeGreaterThan(0)
    child.kill("SIGKILL")
    await new Promise((done) => child.once("exit", done))
    // SIGKILL runs no hook: the daemon and the run's root outlive it. The
    // daemon's transient descendants may exit on their own meanwhile.
    expect(daemons(base)).toContain(orphaned[0]!)
    expect(readdirSync(base)).toHaveLength(1)

    run(base, "./test/cap.test.ts")
    expect(readdirSync(base)).toEqual([])
    expect(daemons(base)).toEqual([])
  }, 180_000)
})
