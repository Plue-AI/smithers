import { describe, expect, it } from "@effect/vitest"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/projection-rebuild-child.ts", import.meta.url))
const branchId = "rebuild-branch"
const branchRun = "flows/branch/rebuild-branch"
const workspaceRun = "rebuild-workspace"
const start = (mode: string, directory: string, count: number) => {
  const child = spawn(process.execPath, [fixture, mode, directory, String(count)])
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
    child.once("error", () => resolve({ code: -1, signal: null }))
  })
  const message = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`No ${mode} barrier: ${stderr}`))
    }, 30_000)
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      if (!stdout.includes("\n")) return
      clearTimeout(timeout)
      try {
        resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n"))))
      } catch (cause) {
        reject(cause)
      }
    })
    child.once("exit", () => {
      clearTimeout(timeout)
      reject(new Error(`${mode}: ${stderr}\n${stdout}`))
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
  return { child, message, exited, stderr: () => stderr }
}
const kill = async (process: ReturnType<typeof start>) => {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL")
  return await process.exited
}

// Independent full-history oracle, constructed from the submitted commands rather
// than BranchProjection, the checkpoint, or the observed consumer values.
const expected = (count: number) => {
  const commands = Array.from({ length: count }, (_, seq) => ({
    seq,
    commandId: `command-${seq}`,
    participantId: seq % 2 === 0 ? "alice" : "bob",
    capabilityId: "branch-reader",
    name: seq % 3 === 0 ? "branch.say" : "branch.edit",
    args: `value-${seq}-é😀`,
    target: seq % 3 === 0 ? "" : `field-${seq % 2}`
  }))
  const fields = new Map<string, unknown>()
  for (const command of commands) {
    if (command.target !== "") {
      fields.set(command.target, {
        target: command.target,
        value: command.args,
        seq: command.seq,
        participantId: command.participantId,
        capabilityId: command.capabilityId
      })
    }
  }
  return [
    {
      runId: branchRun,
      seq: count - 1,
      state: {
        branchId,
        seq: count - 1,
        commands,
        messages: commands.filter((command) => command.name === "branch.say").map((command) => ({
          seq: command.seq,
          commandId: command.commandId,
          participantId: command.participantId,
          capabilityId: command.capabilityId,
          text: command.args
        })),
        fields: [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
      }
    },
    { runId: workspaceRun, seq: count - 1, state: { total: count * (count + 1) / 2, count } }
  ]
}
const withDb = <A>(directory: string, filename: string, use: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(join(directory, filename))
  try {
    return use(db)
  } finally {
    db.close()
  }
}

describe("concrete projection drop/rebuild across SIGKILL", () => {
  for (const count of [17, 33, 257]) {
    for (const crash of ["crash", "crash-workspace"]) {
      it(`rebuilds ${count} entries after dropping state and public snapshots (${crash})`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "sync-projection-rebuild-"))
        const children: Array<ReturnType<typeof start>> = []
        const run = (mode: string) => {
          const child = start(mode, directory, count)
          children.push(child)
          return child
        }
        const complete = async (mode: string) => {
          const child = run(mode)
          const result = await child.message
          expect(await child.exited, child.stderr()).toEqual({ code: 0, signal: null })
          return result
        }
        try {
          const floor = count === 17 ? count - 1 : Math.floor((count - 1) / 2)
          expect(await complete("seed")).toEqual({ phase: "seeded", count, floor, projections: expected(count) })
          const before = await complete("finish")
          expect(before.projections).toEqual(expected(count))
          expect(before.privateOnWire).toBe(false)
          expect(withDb(directory, "history.sqlite", (db) =>
            db.prepare(
              "SELECT run_id, MIN(seq) AS floor, COUNT(*) AS retained FROM flows_journal_events GROUP BY run_id ORDER BY run_id"
            ).all())).toEqual([
              { run_id: branchRun, floor, retained: count - floor },
              { run_id: workspaceRun, floor, retained: count - floor }
            ])
          withDb(directory, "consumer.sqlite", (db) => db.exec("DROP TABLE projection; DROP TABLE public_snapshots"))
          const child = run(crash)
          expect(await child.message).toEqual({
            phase: "uncommitted-rebuild",
            runId: crash === "crash" ? branchRun : workspaceRun,
            snapshotSeq: floor
          })
          expect(await kill(child)).toEqual({ code: null, signal: "SIGKILL" })
          withDb(directory, "consumer.sqlite", (db) => {
            expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok")
            expect(db.prepare("SELECT * FROM projection WHERE run=?").all(crash === "crash" ? branchRun : workspaceRun))
              .toEqual([])
            // Drop the disposable snapshot cache again before reopening the killed consumer.
            db.exec("DROP TABLE public_snapshots")
          })
          const after = await complete("finish")
          expect(after.projections).toEqual(expected(count))
          expect(after.projections).toEqual(before.projections)
          expect(after.privateOnWire).toBe(false)
        } finally {
          await Promise.all(children.map(kill))
          await rm(directory, { recursive: true, force: true })
        }
      }, 60_000)
    }
  }

  it("survives snapshot collection and a moving compaction floor between capture and transfer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sync-projection-retention-"))
    const children: Array<ReturnType<typeof start>> = []
    try {
      const seed = start("seed", directory, 33)
      children.push(seed)
      await seed.message
      expect(await seed.exited).toEqual({ code: 0, signal: null })
      const moved = start("moving", directory, 33)
      children.push(moved)
      const result = await moved.message
      expect(await moved.exited, moved.stderr()).toEqual({ code: 0, signal: null })
      expect(result.projections).toEqual(expected(33))
      expect(result.restored).toEqual({ [branchRun]: [16, 31], [workspaceRun]: [16, 31] })
      expect(result.privateOnWire).toBe(false)
    } finally {
      await Promise.all(children.map(kill))
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
