import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { discover, discoveryDeadlineMs } from "./helpers/discover.ts"

const root = mkdtempSync(join(tmpdir(), "smthrs-discovery-"))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ESRCH"
  }
}

// The real-provider suites probe their CLIs while Vitest imports them, where no
// test or hook deadline applies; this bound is all that keeps collection finite.
describe("real-provider capability discovery", () => {
  it("keeps a finite deadline", () => {
    expect(Number.isFinite(discoveryDeadlineMs) && discoveryDeadlineMs > 0).toBe(true)
  })

  it("reports a command's exit status and stdout", () => {
    expect(discover("sh", ["-c", "printf 'hv 1'; exit 0"])).toEqual({ status: 0, stdout: "hv 1" })
    expect(discover("sh", ["-c", "exit 3"])).toEqual({ status: 3, stdout: "" })
  })

  it("reads a command that cannot start as an absent capability, not a stall", () => {
    const answer = discover(join(root, "no-such-cli"), ["--version"])
    expect(answer.status).toBeNull()
  })

  it("fails a probe that outlives its deadline and kills the probe it started", () => {
    const pidFile = join(root, "stalled.pid")
    const started = Date.now()
    expect(() => discover("sh", ["-c", `echo $$ > '${pidFile}'; exec sleep 30`], 300)).toThrow(
      "capability discovery `sh -c"
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    expect(Number.isInteger(pid)).toBe(true)
    expect(gone(pid)).toBe(true)
  })
})
