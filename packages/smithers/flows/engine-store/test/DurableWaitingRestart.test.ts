import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"

const fixture = fileURLToPath(new URL("./fixtures/durable-wait-child.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))

interface ChildResult {
  readonly stdout: string
  readonly stderr: string
}

/**
 * The fixture's protocol lines are single-line JSON objects. The driver may
 * also log to stdout (e.g. the issue #62 unregistered-flow warning fires by
 * design in the `wait-complete-unregistered` mode), so parse only the lines
 * that are protocol JSON.
 */
const jsonLines = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)

const lastJsonLine = (stdout: string): Record<string, unknown> => {
  const lines = jsonLines(stdout)
  const last = lines[lines.length - 1]
  if (last === undefined) throw new Error(`child produced no JSON line\n${stdout}`)
  return last
}

/**
 * The children need only argv and a SQLite path, so they get this allowlist
 * instead of the parent's environment and its exported credentials.
 */
const childEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }

/** Keep only the last 4 KiB of child output in an error message. */
const outputTailBytes = 4096
const tail = (text: string): string => text.length > outputTailBytes ? `...${text.slice(-outputTailBytes)}` : text

/** Every child a case starts; `afterEach` kills and awaits any still alive. */
const liveChildren = new Set<ChildProcessWithoutNullStreams>()

const spawnChild = (args: ReadonlyArray<string>): ChildProcessWithoutNullStreams => {
  const child = spawn(process.execPath, [fixture, ...args], { cwd: repositoryRoot, env: childEnv })
  liveChildren.add(child)
  child.once("close", () => liveChildren.delete(child))
  return child
}

const runChild = (
  mode: string,
  filename: string,
  executionId: string,
  value?: string,
  options: {
    readonly deadlineMs?: number
    readonly onSpawn?: (child: ChildProcessWithoutNullStreams) => void
  } = {}
): Promise<ChildResult> =>
  new Promise((resolve, reject) => {
    const child = spawnChild([mode, filename, executionId, ...(value === undefined ? [] : [value])])
    options.onSpawn?.(child)
    let stdout = ""
    let stderr = ""
    let expired = false
    const onStdout = (chunk: string) => {
      stdout += chunk
    }
    const onStderr = (chunk: string) => {
      stderr += chunk
    }
    const settle = (error: Error | undefined) => {
      clearTimeout(deadline)
      child.stdout.off("data", onStdout)
      child.stderr.off("data", onStderr)
      child.off("error", onError)
      child.off("close", onClose)
      if (error === undefined) resolve({ stdout, stderr })
      else reject(error)
    }
    const onError = (cause: Error) => {
      child.kill("SIGKILL")
      settle(cause)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (expired) {
        settle(
          new Error(
            `child ${mode} missed its ${options.deadlineMs ?? restartBudget} ms deadline\n${tail(stderr)}\n${
              tail(stdout)
            }`
          )
        )
      } else if (code === 0) {
        settle(undefined)
      } else {
        settle(new Error(`child ${mode} exited with ${code ?? signal}\n${tail(stderr)}\n${tail(stdout)}`))
      }
    }
    const deadline = setTimeout(() => {
      expired = true
      child.kill("SIGKILL")
    }, options.deadlineMs ?? restartBudget)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", onStdout)
    child.stderr.on("data", onStderr)
    child.once("error", onError)
    child.once("close", onClose)
  })

const startChild = (
  mode: string,
  filename: string,
  executionId: string
): ChildProcessWithoutNullStreams => spawnChild([mode, filename, executionId])

/**
 * Wall-clock budget for every case here, and for the in-test guard below.
 *
 * These cases spawn real Node processes and wait for them to boot an engine,
 * which is most of the suite's 2.7-3.8 s idle runtime. The in-test guard is a
 * timer the package `testTimeout` cannot cover, so at its old 10 s it fired
 * first and reported a merely-booting child as a silent one once the other
 * workspaces ran concurrently. Budget for that same ~12x load multiplier —
 * finite, so a child that genuinely never speaks still fails the gate.
 */
const restartBudget = 120_000

const firstJsonLine = (
  child: ChildProcessWithoutNullStreams
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      reject(new Error(`child did not produce a JSON line\n${tail(stderr)}\n${tail(stdout)}`))
    }, restartBudget)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf("\n")
      if (newline < 0) return
      clearTimeout(timeout)
      resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>)
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`child exited before its marker with ${code ?? signal}\n${tail(stderr)}\n${tail(stdout)}`))
    })
  })

const killHard = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  child.kill("SIGKILL")
  await once(child, "exit")
}

afterEach(async () => {
  await Promise.all(
    [...liveChildren].map(async (child) => {
      const closed = once(child, "close")
      child.kill("SIGKILL")
      await closed
    })
  )
})

describe("durable waiting across process loss", () => {
  it("picks up a pending deferred wait after a hard process kill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-durable-wait-"))
    const filename = PersistentDatabase.filename(join(directory, "wait.sqlite"))
    const executionId = "hard-kill-wait"
    const first = startChild("wait-start", filename, executionId)
    try {
      expect(await firstJsonLine(first)).toEqual({ status: "suspended" })
      await killHard(first)

      const completion = await runChild(
        "wait-complete-unregistered",
        filename,
        executionId
      )
      expect(lastJsonLine(completion.stdout)).toEqual({
        status: "completion-recorded"
      })

      const restarted = await runChild("wait-restart", filename, executionId)
      const result = lastJsonLine(restarted.stdout) as unknown as {
        readonly status: string
        readonly state: { readonly result?: unknown }
      }
      expect(result.status).toBe("completed")
      expect(result.state.result).toEqual({
        _tag: "Complete",
        exit: { _tag: "Success", value: "resumed-after-kill" }
      })
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        await killHard(first)
      }
      await PersistentDatabase.remove(filename)
      await rm(directory, { recursive: true, force: true })
    }
  }, restartBudget)

  it("re-arms a future timer after restart and fires at its stored deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-durable-timer-"))
    const filename = PersistentDatabase.filename(join(directory, "timer.sqlite"))
    const executionId = "future-timer"
    const first = startChild("timer-start", filename, executionId)
    try {
      expect(await firstJsonLine(first)).toEqual({ status: "suspended" })
      await killHard(first)

      const restarted = await runChild("timer-restart", filename, executionId)
      const lines = jsonLines(restarted.stdout)
      expect(lines[0]).toEqual({
        status: "restarted",
        completedAtMs: null
      })
      expect(lines[1]?.status).toBe("completed")
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        await killHard(first)
      }
      await PersistentDatabase.remove(filename)
      await rm(directory, { recursive: true, force: true })
    }
  }, restartBudget)

  it("allows only one deferred completion winner across two processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-durable-race-"))
    const filename = PersistentDatabase.filename(join(directory, "race.sqlite"))
    const executionId = "process-race"
    try {
      await runChild("state-init", filename, executionId)
      const results = await Promise.all([
        runChild("state-complete", filename, executionId, "left"),
        runChild("state-complete", filename, executionId, "right")
      ])
      const outcomes = results.map((result) =>
        lastJsonLine(result.stdout) as unknown as {
          readonly tag: string
          readonly row: unknown
        }
      )
      expect(outcomes.map((outcome) => outcome.tag).sort()).toEqual([
        "Completed",
        "Existing"
      ])
      expect(outcomes[0]?.row).toEqual(outcomes[1]?.row)
    } finally {
      await PersistentDatabase.remove(filename)
      await rm(directory, { recursive: true, force: true })
    }
  }, restartBudget)

  it("kills a child that misses its deadline and rejects with its output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-durable-deadline-"))
    const filename = PersistentDatabase.filename(join(directory, "deadline.sqlite"))
    let pid: number | undefined
    try {
      // `wait-start` suspends and then waits forever, so it cannot finish.
      await expect(
        runChild("wait-start", filename, "never-finishes", undefined, {
          deadlineMs: 2_000,
          onSpawn: (child) => {
            pid = child.pid
          }
        })
      ).rejects.toThrow(/missed its 2000 ms deadline/)
      expect(pid).toBeTypeOf("number")
      expect(() => process.kill(pid as number, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      expect(liveChildren.size).toBe(0)
    } finally {
      await PersistentDatabase.remove(filename)
      await rm(directory, { recursive: true, force: true })
    }
  }, restartBudget)
})
