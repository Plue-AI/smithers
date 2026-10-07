/**
 * The operator loop, run as an operator runs it.
 *
 * Every command here is a real `smithers` process against one real project
 * directory: a scaffolded flow, `.flows/control.db` and `.flows/engine.db` on
 * disk, and the run rows, journal events, and approval tokens those files
 * actually hold. Nothing is stubbed, and no in-process composition stands in
 * for the executable — the release policy promises are promises about
 * what the binary does, and a handler-level assertion cannot keep them.
 *
 * The one in-process step is the node approval. Registering an in-run approval
 * is what an executing cell's `ask` does (`AgentSession` calls
 * `ControlRuntime.registerApproval` with the ask envelope), and reaching that
 * state through the agent needs a live model seat. Registering it directly
 * against the same SQLite file leaves the durable state identical, so the
 * `approve` verb still crosses a process boundary to decide a token another
 * process wrote.
 *
 * A registered module flow holds a real native action until cancellation.
 * Its marker proves the executor entered that action; no model seat is used.
 */
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import * as UnsupportedBackend from "@smthrs/database/UnsupportedBackend"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as Detached from "../src/Detached.ts"
import * as NodeControl from "../src/NodeControl.ts"

const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const idleFixture = fileURLToPath(new URL("./fixtures/idle/flow.ts", import.meta.url))
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

// Outside the repository: `Project.root` walks up for `.flows/`, and this
// checkout grows one as soon as any command runs in it. Resolved through
// `realpathSync` because the CLI reports the paths it actually opened, and on
// macOS the system temporary directory is a symlink.
const project = realpathSync(mkdtempSync(join(tmpdir(), "smithers-cli-e2e-")))

// This fixture owns local SQLite stores. The package's PostgreSQL test
// settings and a developer's remote selection must not redirect its commands.
beforeAll(() => {
  vi.stubEnv("SMITHERS_BACKEND", "sqlite")
  vi.stubEnv("SMITHERS_REMOTE", "")
  vi.stubEnv("XDG_CONFIG_HOME", join(project, "config"))
  for (const name of UnsupportedBackend.ignoredNames(process.env)) vi.stubEnv(name, "")
})

afterAll(() => {
  try {
    if (existsSync(join(project, ".flows", "control.db"))) {
      const stopped = smithers("down", "--json")
      expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
}, 300_000)

interface Invocation {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const smithers = (...args: ReadonlyArray<string>): Invocation => {
  const result = spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
    cwd: project,
    encoding: "utf8",
    timeout: 240_000
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const json = (...args: ReadonlyArray<string>): any => {
  const result = smithers(...args, "--json")
  expect({ args, ...result }, JSON.stringify({ args, ...result })).toMatchObject({ status: 0 })
  return JSON.parse(result.stdout)
}

/** The seven statuses the release policy pins `ps --status` to. */
const statuses = ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"]

/**
 * Every case starts real `smithers` processes, and each start parses the whole
 * module graph through Node's type stripping. That is seconds on an idle
 * machine and much longer on a loaded one, so this suite carries its own
 * finite budget rather than the package's 30 s default.
 */
const processBudget = { timeout: 300_000 }

describe("one project, from init to gc", processBudget, () => {
  let runId = ""
  let launchCount = 0
  const launchIdle = () =>
    json(
      "up",
      "idle",
      "--data",
      JSON.stringify({
        marker: join(project, `idle-entered-${++launchCount}`)
      }),
      "-d"
    )

  it("scaffolds a project and discovers the flow in it", () => {
    const scaffolded = json("init", "hello")

    expect(scaffolded).toMatchObject({ flow: { name: "hello", created: true } })
    expect(scaffolded.created).toEqual(expect.arrayContaining(["WORKSPACE.ts", "PACKAGE.ts"]))
    expect(existsSync(join(project, "flows", "hello", "flow.mdx"))).toBe(true)
    // Catalog entries expose the declared input contract so callers can form
    // a valid plan request before executing the scaffolded flow.
    expect(json("ls")).toEqual({
      _tag: "flows",
      items: [{
        flowId: "hello",
        description: expect.any(String),
        inputSchema: {
          dialect: "draft-2020-12",
          schema: {
            type: "object",
            properties: { args: { type: "string" } },
            required: ["args"],
            additionalProperties: true
          },
          definitions: {}
        }
      }]
    })
  })

  it("parks an unapproved plan with the parked exit status", () => {
    const card = json("plan", "hello") as { readonly approval: unknown }
    const approval = JSON.stringify(card.approval)

    const parked = smithers("run", approval, "--json")

    // Exit 3 is the parked status in the release policy table, and it
    // is the one code a caller cannot learn from the payload alone: the run
    // did not fail, it is waiting for a decision.
    expect(parked.status).toBe(3)
    expect(JSON.parse(parked.stdout)).toMatchObject({ _tag: "Parked", status: "waiting-approval" })

    // Approving the same payload launches it, so the park was a gate and not a
    // dead end.
    expect(json("approve", approval, "--scope", "run")).toMatchObject({ _tag: "Accepted" })
    json("down")
  })

  it("launches a real module detached and returns its durable admission receipt", async () => {
    // Written here rather than beside the scaffold so the `ls` assertion above
    // still sees exactly what `init` created.
    mkdirSync(join(project, "flows", "idle"), { recursive: true })
    symlinkSync(nodeModules, join(project, "node_modules"), "dir")
    copyFileSync(idleFixture, join(project, "flows", "idle", "flow.ts"))
    const launched = launchIdle()
    const marker = join(project, `idle-entered-${launchCount}`)
    const deadline = Date.now() + 30_000
    while (!existsSync(marker) || !/^[1-9][0-9]*\n$/.test(readFileSync(marker, "utf8"))) {
      if (Date.now() >= deadline) {
        throw new Error(`Idle action did not start: ${readFileSync(launched.logFile, "utf8")}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const actionPid = readFileSync(marker, "utf8")
    expect(actionPid).toMatch(/^[1-9][0-9]*\n$/)
    expect(Number(actionPid)).not.toBe(process.pid)
    expect(() => process.kill(Number(actionPid), 0)).not.toThrow()

    // The receipt's own field. rc.0 has no `--run-id`, so this is the only
    // place a caller learns which run it started.
    expect(launched.runId).toMatch(/^run-/)
    expect(launched).toMatchObject({
      detached: true,
      logFile: join(project, ".flows", "logs", `${launched.runId}.log`)
    })
    runId = launched.runId

    // The launch returned because the child proved it persisted the run, not
    // because a timer expired: the admission line names this run.
    const log = readFileSync(launched.logFile, "utf8")
    const nonce = log.split("=run:")[1]?.split(" ")[0] ?? ""
    expect(Detached.announcedRunIds(log, nonce)).toEqual([runId])
    // The receipt names a run the parent confirmed in its own store, under
    // the plan this `up` approved.
    const listed = json("ps").items.find((entry: { readonly runId: string }) => entry.runId === runId)
    expect(listed?.planId).toMatch(/^plan-/)
  })

  it("lists the run, filtered by a status from the pinned vocabulary", () => {
    const listed = json("ps")
    const run = listed.items.find((entry: { readonly runId: string }) => entry.runId === runId)

    expect(run).toBeDefined()
    expect(statuses).toContain(run.status)
    expect(run.flowId).toBe("idle")
    expect(json("ps", "--status", run.status).items.map((entry: { readonly runId: string }) => entry.runId))
      .toContain(runId)
    // An eighth status is not a status.
    expect(smithers("ps", "--status", "sleeping", "--json").status).toBe(2)
  })

  it("does not call an executing module an unclaimed run", async () => {
    // Listings allow five seconds for an executor to claim a new run.
    await new Promise((resolve) => setTimeout(resolve, 5_500))
    const run = json("ps").items.find((entry: { readonly runId: string }) => entry.runId === runId)
    expect(run).toBeDefined()
    expect(run.waitingReason).not.toBe("executor")
    const card = smithers("status", runId)
    expect(card.status, card.stdout + card.stderr).toBe(0)
    expect(card.stdout).not.toContain("no executor took the run")
    const log = readFileSync(join(project, ".flows", "logs", `${runId}.log`), "utf8")
    expect(log).not.toContain("no executor took it")
  })

  it("streams the run's own control events", () => {
    const events = json("logs", runId)

    expect(events.map((event: { readonly kind: string }) => event.kind)).toContain("control.run.accepted")
    expect(new Set(events.map((event: { readonly runId: string }) => event.runId))).toEqual(new Set([runId]))
  })

  it("delivers two different signals rather than replaying the first one's receipt", () => {
    const first = json("signal", runId, JSON.stringify({ name: "go", payload: { attempt: 1 } }))
    const replay = json("signal", runId, JSON.stringify({ name: "go", payload: { attempt: 1 } }))
    const second = json("signal", runId, JSON.stringify({ name: "go", payload: { attempt: 2 } }))

    expect(first.receiptId).toMatch(new RegExp(`^cli:signal:${runId}:`))
    // Identical payload, identical mutation: the receipt is replayed.
    expect(replay.receiptId).toBe(first.receiptId)
    // A different payload is a different mutation, and keying on the run alone
    // silently dropped it (the release policy).
    expect(second.receiptId).not.toBe(first.receiptId)
  })

  it.each(["approve", "deny"] as const)(
    "%s: persists the decision for an in-run request from another process",
    async (decision) => {
      const engine = NodeControl.engineDurable(project)
      const target = {
        _tag: "Node" as const,
        runId,
        requestId: `${runId}:ask-${decision}`,
        digest: "e2e-ask-digest",
        envelope: { capabilities: [], flows: ["ask"], budget: {} }
      }

      const registered = await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime.ControlRuntime
          return yield* runtime.registerApproval(target)
        }).pipe(Effect.provide(engine.runtime), Effect.scoped, Effect.orDie)
      )
      expect(registered._tag).toBe("Pending")

      const ownerBefore = json("ps").items.find((entry: { readonly runId: string }) => entry.runId === runId).ownerId
      expect(JSON.parse(ownerBefore).pid).toBe(Number(readFileSync(join(project, "idle-entered-1"), "utf8")))
      const decided = json(
        "approvals",
        decision,
        JSON.stringify({ target, scope: "run", idempotencyKey: `${decision}:${target.requestId}` })
      )
      expect(decided).toMatchObject({ _tag: "Accepted" })
      expect(json("ps").items.find((entry: { readonly runId: string }) => entry.runId === runId).ownerId)
        .toBe(ownerBefore)

      const readBack = await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime.ControlRuntime
          return yield* runtime.registerApproval(target)
        }).pipe(Effect.provide(engine.runtime), Effect.scoped, Effect.orDie)
      )
      // The decision is durable and cross-process: a resumed attempt reads it
      // instead of parking again.
      expect(readBack._tag).toBe(decision === "approve" ? "Approved" : "Denied")
    }
  )

  it("keeps namespaced memory in the control database across processes", () => {
    expect(json("memory", "set", "reviewer", "sol")).toMatchObject({ key: "reviewer", stored: true })
    expect(json("memory", "get", "reviewer")).toMatchObject({ value: "sol" })
    expect(json("memory", "list").map((entry: { readonly key: string }) => entry.key)).toContain("reviewer")

    expect(json("memory", "rm", "reviewer")).toMatchObject({ key: "reviewer", deleted: true })
    expect(json("memory", "list").map((entry: { readonly key: string }) => entry.key)).not.toContain("reviewer")
  })

  it("queues a steer for the run to drain at its turn close", () => {
    json("steer", runId, "--message", "prefer the smaller change")

    const run = json("ps").items.find((entry: { readonly runId: string }) => entry.runId === runId)
    // Durable and attributed: the message is on the notification queue, not in
    // the sending process, so a later `ps` from any process reports it.
    expect(run.steering.pending).toBeGreaterThan(0)
  })

  it("says a run recorded no node output rather than inventing one", () => {
    const result = smithers("runs", "output", runId, "result", "--json")

    // A node id the run does not have is the argument being wrong, so this is
    // the usage status, and the structured refusal names the run.
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "UsageError", message: expect.stringContaining(runId) })
  })

  it("reports the project it resolved, both databases, and the Node floor", () => {
    const report = json("doctor")

    expect(report.root).toBe(project)
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: `database ${join(project, ".flows", "control.db")}`, level: "ok" }),
      expect.objectContaining({ name: `database ${join(project, ".flows", "engine.db")}`, level: "ok" }),
      expect.objectContaining({ name: "node", level: "ok" })
    ]))
  })

  it("cancels the run durably", async () => {
    // Earlier approval denial can settle the shared run; cancel a fresh run.
    const { runId: cancelRunId } = launchIdle()
    const cancelled = smithers("cancel", cancelRunId, "--json")
    // An external cancellation is a request until the owning process settles.
    expect(cancelled.status, cancelled.stdout + cancelled.stderr).toBe(0)
    expect(cancelled.stderr).toBe("")
    expect(JSON.parse(cancelled.stdout)).toMatchObject({ _tag: "Accepted", runId: cancelRunId })
    const deadline = Date.now() + 30_000
    for (;;) {
      const run = json("ps").items.find((entry: { readonly runId: string }) => entry.runId === cancelRunId)
      if (run.status === "cancelled") break
      expect(Date.now(), JSON.stringify(run)).toBeLessThan(deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // A later cancel sees the durable terminal status and reports its exit code.
    const settled = smithers("cancel", cancelRunId, "--json")
    expect(settled.status, settled.stdout + settled.stderr).toBe(130)
    expect(JSON.parse(settled.stdout)).toMatchObject({ _tag: "Terminal", runId: cancelRunId, status: "cancelled" })
  })

  it("takes every remaining run down", () => {
    const launched = launchIdle()
    expect(json("ps").items.some((entry: { readonly status: string }) => entry.status !== "cancelled")).toBe(true)

    json("down")

    // `down` is `Control.list` then `cancel`, so a second one is a no-op
    // rather than an error on runs that are already terminal.
    const after = json("ps").items as ReadonlyArray<{ readonly runId: string; readonly status: string }>
    expect(after.find((entry) => entry.runId === launched.runId)!.status).toBe("cancelled")
    expect(after.every((entry) => entry.status === "cancelled")).toBe(true)
    json("down")
  })

  it("reports what gc would delete, then deletes it", () => {
    // `--older-than 0s` is refused: "delete everything" is not a retention
    // policy, and it is the easiest value to type by accident. A real sweep
    // names a window and waits it out.
    const refused = smithers("gc", "--older-than", "0s", "--dry-run", "--json")
    expect(refused.status).toBe(2)
    expect(JSON.parse(refused.stdout)).toMatchObject({
      code: "UsageError",
      message: expect.stringContaining("--older-than must be a duration")
    })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100)

    const planned = json("gc", "--older-than", "1s", "--dry-run")

    expect(planned.dryRun).toBe(true)
    expect(planned.reports.map((report: { readonly database: string }) => report.database)).toEqual([
      join(project, ".flows", "control.db"),
      join(project, ".flows", "engine.db")
    ])
    const control = planned.reports[0]
    expect(control.runs).toContain(runId)
    // A dry run deletes nothing, which is the whole point of the flag.
    expect(json("ps").items.map((entry: { readonly runId: string }) => entry.runId)).toContain(runId)

    json("gc", "--older-than", "1s")
    expect(json("ps").items).toEqual([])
  })
})
