/**
 * The containment matrix, driven through a real durable cancel.
 *
 * `packages/smithers/agent/std`'s `ExecContainment` suite pins the same two shapes directly
 * against a spawner. This one asks the question the release policy actually
 * words: after `smithers cancel`, does the machine still carry anything the
 * run started. So everything here is the production composition:
 * `NodeRuntime.layerHost` over a real SQLite file, a flow body reaching the
 * GUARDED spawner, and a second driver over the same file writing the
 * cancellation request the owner picks up on its heartbeat.
 *
 * Three claims, one per case:
 *
 *  1. A cancelled run leaves no `PPID 1` orphan. The action starts
 *     `<sleeper> & wait`, so the background process is one nothing holds a
 *     handle for; only the process-group kill can reach it.
 *  2. A `SIGTERM`-ignoring group dies inside `forceKillAfter` plus a second.
 *     `containment: { graceMs }` is the deadline `ContainedSpawner` installs
 *     on every command (`forceKillAfter ?? graceMs`), and an ignored
 *     signal behavior is inherited across `exec`, so nothing in the group honours
 *     the signal and the escalation is the only thing that ends it.
 *  3. Every guarded spawn in this composition resolves through the contained
 *     spawner. The evidence is durable rather than structural: the host's
 *     journal carries a `flows.host.process-spawned.v1` record for what the
 *     action started, and only `ContainedSpawner` writes one.
 *
 * The survivor check is a `ps` scan for a uniquely named sleeper script
 * across every process on the machine. Asserting a recorded pid is gone would
 * answer a weaker question than the one containment is about.
 *
 * The forked `Flow.execute` fiber is interrupted at the end of each case, the
 * same way `NodeRuntime.test.ts` does: after a cross-driver cancel the run
 * settles durably but that fiber does not, which is the cancel-durability
 * lane's `RunDriver` defect (N-09) and not a containment claim.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as Heartbeat from "@smthrs/run-store/Heartbeat"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as ProcessTable from "../../../testing/src/ProcessTable.ts"
import { Action, Flow, FlowRuntime, Interpreter, RunStore as RunStorePackage } from "../src/index.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"

const { RunStore } = RunStorePackage

/**
 * How long an owner may take to notice a cancel another process wrote.
 *
 * The cancel poll rides the heartbeat, so this is the whole difference
 * between the flow-level deadline and the Exec-level one.
 */
const heartbeatMs = Duration.toMillis(Heartbeat.heartbeatInterval)

const directory = mkdtempSync(join(tmpdir(), "flows-containment-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A long-running program with a name no other process on this machine has.
 *
 * It loops rather than calling `sleep 300` once, so the process carrying the
 * unique name is the one that has to die: `exec`ing `sleep` would replace the
 * image and the name with it.
 */
const sleeper = (root: string, label: string): string => {
  const path = join(root, `flows-run-orphan-${label}`)
  writeFileSync(path, "#!/bin/sh\nwhile true; do sleep 0.2; done\n")
  chmodSync(path, 0o755)
  return path
}

/** Every process on this machine whose command line names `path`. */
const survivors = (path: string): ReadonlyArray<string> =>
  ProcessTable.query({ columns: ["pid", "ppid", "args"] })
    .split("\n")
    .filter((line) => line.includes(path))

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Waits until nothing names `path` any more, or gives up after `budgetMs`. */
const waitForNoSurvivor = async (path: string, budgetMs: number): Promise<ReadonlyArray<string>> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const found = survivors(path)
    if (found.length === 0) return found
    if (Date.now() > deadline) return found
    await sleep(20)
  }
}

/** Waits for the shell the action started to report its background pid. */
const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text !== "") return text
    } catch {
      // not written yet
    }
    await sleep(10)
  }
  throw new Error(`the action never wrote ${path}`)
}

/**
 * The shell line each case runs: a background sleeper whose pid is reported,
 * and a foreground `wait` so the action stays running until it is cancelled.
 */
const line = (script: string, pidFile: string, prefix: string) => `${prefix}${script} & echo $! > ${pidFile}; wait`

/** The command line the running action was given, per execution id. */
const commands = new Map<string, string>()

const Spawn = Action.make("flows/containment/spawn", {
  payload: { executionId: Schema.String },
  success: Schema.String
})

const Contained = Flow.make("flows/containment/flow", {
  payload: { executionId: Schema.String },
  success: Schema.String,
  body: (payload) => Spawn.call(payload)
})

/**
 * Runs one shell line through the GUARDED spawner, the way a flow body reaches
 * the host. Nothing here names a kill policy: the containment default is the
 * subject, so a call site that set one would hide it.
 */
const spawn = ({ executionId }: { readonly executionId: string }) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* Effect.orDie(
      spawner.spawn(ChildProcess.make("sh", ["-c", commands.get(executionId)!]))
    )
    yield* Effect.orDie(handle.exitCode)
    return "woke"
  })

const flows = Interpreter.layer(Contained).pipe(
  Layer.provideMerge(Spawn.toLayer(spawn)),
  Layer.provideMerge(Action.layerImplementations)
)

const allowSpawn = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
})

const readBack = <A>(filename: string, query: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    return query(database)
  } finally {
    database.close()
  }
}

/**
 * Drives one case: start the flow, wait until the sleeper is really running,
 * cancel from a SECOND driver over the same file, and hand back what the
 * durable row says plus how long the group took to disappear.
 */
const cancelFromAnotherDriver = (options: {
  readonly label: string
  readonly prefix: string
  readonly graceMs: number
}) =>
  Effect.gen(function*() {
    const root = join(directory, options.label)
    mkdirSync(root, { recursive: true })
    const filename = join(root, "runtime.sqlite")
    const script = sleeper(root, options.label)
    const pidFile = join(root, "background.pid")
    const executionId = `containment-${options.label}`
    commands.set(executionId, line(script, pidFile, options.prefix))

    const host = (hostId: string) =>
      NodeRuntime.layerHost(
        {
          filename,
          workspaceRoot: root,
          owner: { hostId },
          signals: [],
          containment: { graceMs: options.graceMs },
          rules: [
            allowSpawn,
            // The shell reads its sleeper and writes its pid only inside this
            // case's workspace; native confinement remains enabled.
            ...(["fs:read", "fs:write"] as const).map((action) => new Permission.Rule({
              effect: "allow",
              pattern: new Capability.CapabilityPattern({ action, resource: `${root}/**` })
            })),
            new Permission.Rule({
              effect: "allow",
              pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: root })
            })
          ]
        },
        flows
      )

    const outcome = yield* Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const running = yield* Effect.forkChild(
        Effect.exit(Contained.execute({ executionId }, { executionId })),
        { startImmediately: true }
      )

      // The background process is provably running before anything is
      // cancelled, so the survivor check afterwards is about a real process.
      const backgroundPid = Number(yield* Effect.promise(() => waitForFile(pidFile)))
      let row = yield* runs.get(executionId)
      for (let attempt = 0; attempt < 400 && row.status !== "running"; attempt++) {
        yield* Effect.sleep("25 millis")
        row = yield* runs.get(executionId)
      }
      expect(row.status).toBe("running")
      expect(survivors(script).length).toBeGreaterThan(0)

      // A second driver: its own engine, its own owner, the same file. Its
      // `interrupt` writes a durable cancellation request rather than touching
      // a fiber it does not hold, which is the shape an operator's `cancel`
      // has.
      yield* Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.interrupt(Contained, executionId)
      }).pipe(Effect.provide(host(`${options.label}-b`)), Effect.scoped)

      for (let attempt = 0; attempt < 120 && row.status !== "cancelled"; attempt++) {
        yield* Effect.sleep("100 millis")
        row = yield* runs.get(executionId)
      }
      const left = yield* Effect.promise(() => waitForNoSurvivor(script, options.graceMs + 1_000))

      // Measured from the durable cancel REQUEST, which is the row the second
      // driver wrote and the earliest instant the owner could have started
      // killing anything. The obvious clock to start, the moment the row
      // reads `cancelled`, makes the bound vacuous: the owner writes that
      // status after the action's scope has closed, and the scope does not
      // close until the escalation has landed, so the group is always already
      // gone and any budget holds. Same process, so both timestamps come off
      // one clock.
      const clearedMs = Date.now() - (row.cancelRequestedAtMs ?? Number.NaN)

      // The run settled durably. The fiber that asked for it has not, which is
      // the cancel-durability lane's defect and not this suite's subject.
      yield* Effect.exit(Effect.timeout(Fiber.interrupt(running), "5 seconds"))
      return { status: row.status, left, clearedMs, backgroundPid, script, filename }
    }).pipe(Effect.provide(host(`${options.label}-a`)), Effect.scoped)

    return outcome
  })

describe.skipIf(process.platform === "win32")("a cancelled run", () => {
  it("leaves no orphan behind when the child cooperates", async () => {
    const outcome = await Effect.runPromise(
      cancelFromAnotherDriver({ label: "cooperative", prefix: "", graceMs: 400 })
    )

    expect(outcome.status).toBe("cancelled")
    expect(outcome.backgroundPid).toBeGreaterThan(0)
    // Nothing the run started is left anywhere on the machine: not under this
    // process, and not reparented to init.
    expect(outcome.left).toEqual([])
    expect(
      readBack(
        outcome.filename,
        (database) => database.prepare("SELECT status FROM flows_runs WHERE run_id = ?").get("containment-cooperative")
      )
    ).toMatchObject({ status: "cancelled" })
  }, 120_000)

  it("kills a SIGTERM-ignoring group inside the containment grace", async () => {
    // The grace is longer here than in the Exec-level case, and deliberately
    // longer than the heartbeat, because the clock this case can read starts
    // at the durable cancel REQUEST and the owner may take a whole tick to
    // notice it. At 400 ms the poll latency alone satisfied a `>= graceMs`
    // lower bound, so a cooperative child passed it too and the assertion
    // measured the heartbeat rather than the escalation. At 3 s the escalation
    // is the term that dominates, and the bound discriminates again.
    const graceMs = 3_000
    const outcome = await Effect.runPromise(
      cancelFromAnotherDriver({ label: "stubborn", prefix: "trap \"\" TERM; ", graceMs })
    )

    expect(outcome.status).toBe("cancelled")
    expect(outcome.left).toEqual([])
    // The lower bound is what stops this passing vacuously: a group that had
    // honoured `SIGTERM` would be gone within a tick, well before the grace
    // expired. The upper bound is the contract's `forceKillAfter` plus one
    // second, widened by the one heartbeat tick an owner may take to notice a
    // cancel another process wrote, the difference between this case and the
    // Exec-level one, where the interrupt is delivered in-process.
    expect(outcome.clearedMs).toBeGreaterThanOrEqual(graceMs)
    expect(outcome.clearedMs).toBeLessThan(graceMs + heartbeatMs + 1_000)
  }, 120_000)

  it("records what the guarded spawn started, so a crash leaves it discoverable", async () => {
    // The ledger record is what makes a guarded spawn contained: only
    // `ContainedSpawner` writes one, so its presence in the host's own journal
    // run says the flow body's spawn resolved through the contained spawner
    // rather than around it.
    const outcome = await Effect.runPromise(
      cancelFromAnotherDriver({ label: "recorded", prefix: "", graceMs: 400 })
    )

    expect(outcome.left).toEqual([])
    const types = readBack(outcome.filename, (database) =>
      database
        .prepare("SELECT event_type FROM flows_journal_events WHERE run_id = ? ORDER BY seq")
        .all("flows.host:recorded-a")
        .map((row) => String(row["event_type"])))

    expect(types).toContain("flows.host.process-spawned.v1")
    // And retired again when the action's scope closed, so the next
    // incarnation of this host does not try to reap a process that is gone.
    expect(types).toContain("flows.host.process-exited.v1")
  }, 120_000)
})
