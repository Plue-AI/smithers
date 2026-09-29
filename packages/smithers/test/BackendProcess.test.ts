import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

  it("names the missing program in a tagged NotFound", async () => {
    const error = await run("smithers-no-such-program", [], { env, timeoutMs: 10_000 }).catch((cause) => cause)
    expect(error).toMatchObject({ _tag: "/backend/NotFound", command: "smithers-no-such-program" })
    expect(error.message).toBe("smithers-no-such-program not found")
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

  it("gives an interactive command no pipes and returns its exit code", async () => {
    const child = spawn("sh", ["-c", "exit 4"], { env, stdio: "inherit" })
    expect([child.stdin, child.stdout, child.stderr]).toEqual([undefined, undefined, undefined])
    expect(await child.exited).toBe(4)
  })

  const script = ["/usr/bin/script", "/bin/script"].find((path) => existsSync(path))
  // A real terminal: `script` gives the CLI a pty. An interactive `ssh -tt`
  // needs that pty as its controlling terminal (to open /dev/tty for prompts)
  // and needs SIGWINCH to forward resizes; a child started in a new session
  // has neither.
  it.skipIf(script === undefined)(
    "hands an interactive command the CLI's controlling terminal, its resizes and its exit code",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "backend-pty-"))
      dirs.push(dir)
      const driver = join(dir, "driver.ts"), ready = join(dir, "ready")
      const child = [
        "trap 'echo WINCH=yes; exit 5' WINCH",
        "echo CHILD_TTY=$(ps -o tty= -p $$ | tr -d ' ')",
        "if : </dev/tty; then echo DEV_TTY=yes; else echo DEV_TTY=no; fi",
        `: > ${JSON.stringify(ready)}`,
        "n=0; while [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done; echo WINCH=no; exit 6"
      ].join("; ")
      await writeFile(
        driver,
        `import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { spawn } from ${JSON.stringify(resolve(import.meta.dirname, "../src/internal/backend/Process.ts"))}
console.log("CLI_TTY=" + execFileSync("ps", ["-o", "tty=", "-p", String(process.pid)], { encoding: "utf8" }).trim())
const child = spawn("sh", ["-c", ${JSON.stringify(child)}], { env: { PATH: process.env.PATH }, stdio: "inherit" })
while (!existsSync(${JSON.stringify(ready)})) await new Promise((resolve) => setTimeout(resolve, 25))
execFileSync("stty", ["rows", "33"], { stdio: ["inherit", "ignore", "ignore"] })
console.log("CODE=" + await child.exited)
`
      )
      const command = [process.execPath, driver]
      const options: SpawnSyncOptionsWithStringEncoding = {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"]
      }
      const result = process.platform === "darwin"
        ? spawnSync(script!, ["-q", "/dev/null", ...command], options)
        : spawnSync(script!, ["-q", "-e", "-c", command.join(" "), "/dev/null"], options)
      const output = result.stdout.replaceAll("\r", "")
      const value = (key: string) => new RegExp(`\\b${key}=(\\S+)`).exec(output)?.[1]
      expect(value("CLI_TTY"), output + result.stderr).toMatch(/^(tty|pts)/)
      expect(value("CHILD_TTY"), output).toBe(value("CLI_TTY"))
      expect(value("DEV_TTY"), output).toBe("yes")
      expect(value("WINCH"), output).toBe("yes")
      expect(value("CODE"), output).toBe("5")
    },
    90_000
  )
})
