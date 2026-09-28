import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NotFound, run, spawn } from "../src/internal/backend/Process.ts"

const dirs: Array<string> = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const env = { PATH: process.env.PATH }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (condition: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
// A shell that leaves a grandchild running and records its pid.
const orphaning = async () => {
  const dir = await mkdtemp(join(tmpdir(), "backend-process-"))
  dirs.push(dir)
  const file = join(dir, "pid")
  const script = `sleep 30 & echo $! > ${JSON.stringify(file)}; wait`
  const grandchild = async () => {
    await until(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "")
    return Number(readFileSync(file, "utf8").trim())
  }
  return { script, grandchild }
}

describe.skipIf(process.platform === "win32")("backend processes", () => {
  it("buffers output, feeds stdin and reports the exit code", async () => {
    expect(await run("sh", ["-c", "cat; echo err >&2; exit 3"], { env, input: "hello\n", timeoutMs: 10_000 }))
      .toEqual({ code: 3, stdout: "hello\n", stderr: "err\n" })
  })

  it("reports a missing program as NotFound", async () => {
    await expect(run("smithers-no-such-program", [], { env, timeoutMs: 10_000 })).rejects.toBeInstanceOf(NotFound)
  })

  it("stops a cancelled command's descendants", async () => {
    const { grandchild, script } = await orphaning()
    const abort = new AbortController()
    const running = run("sh", ["-c", script], { env, timeoutMs: 60_000, signal: abort.signal })
    const pid = await grandchild()
    abort.abort()
    await expect(running).rejects.toThrow("sh was cancelled")
    await until(() => !alive(pid))
  })

  it("stops a timed-out command's descendants", async () => {
    const { grandchild, script } = await orphaning()
    const running = run("sh", ["-c", script], { env, timeoutMs: 3_000 })
    const pid = await grandchild()
    await expect(running).rejects.toThrow("sh timed out")
    await until(() => !alive(pid))
  })

  it("streams through a killed child and stops its descendants", async () => {
    const { grandchild, script } = await orphaning()
    const child = spawn("sh", ["-c", script], { env, stdio: "pipe" })
    child.stdout!.resume()
    child.stderr!.resume()
    const pid = await grandchild()
    child.kill()
    await expect(child.exited).rejects.toThrow("sh was stopped")
    await until(() => !alive(pid))
  })
})
