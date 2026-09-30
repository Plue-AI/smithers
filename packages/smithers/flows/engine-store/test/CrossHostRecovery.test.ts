/**
 * The cross-host recovery drill (#2784): two durable engines in two
 * processes. The caller process drives `PlacedParent` over its own SQLite
 * journal, and its `Hosts` table places the `RemoteWrite` child on a serving
 * process with its own SQLite journal, reached over HTTP through the public
 * `FlowProxy` protocol. Each case SIGKILLs a host while the placed child is
 * running, restarts it on the same journal, and asks the caller again under
 * the same execution id. The parent must settle with the child's one result:
 * the serving engine keeps exactly one run for the id the parent derived.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Interpreter } from "@smthrs/flow"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RemoteWrite } from "./fixtures/RemoteCeilingFlow.ts"

const servingFixture = fileURLToPath(new URL("./fixtures/remote-ceiling-engine.ts", import.meta.url))
const callerFixture = fileURLToPath(new URL("./fixtures/placed-caller-engine.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const childEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }
/** Booting a child engine under a loaded suite can take many seconds. */
const bootBudget = 120_000

interface Host {
  readonly child: ChildProcessWithoutNullStreams
  readonly events: Array<Record<string, unknown>>
  readonly output: () => string
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => typeof address === "object" && address !== null ? resolve(address.port) : reject())
    })
  })

const launch = (argv: ReadonlyArray<string>): Host => {
  const child = spawn(process.execPath, argv, { cwd: repositoryRoot, env: childEnv })
  const events: Array<Record<string, unknown>> = []
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => (stderr += chunk))
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
    for (const text of chunk.split("\n")) {
      if (text.startsWith("{\"event\"")) events.push(JSON.parse(text) as Record<string, unknown>)
    }
  })
  return { child, events, output: () => `${stderr.slice(-4096)}\n${stdout.slice(-4096)}` }
}

const waitFor = async (host: Host, predicate: (event: Record<string, unknown>) => boolean) => {
  const deadline = Date.now() + bootBudget
  while (!host.events.some(predicate)) {
    if (host.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`host never reported the event\n${host.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return host.events.find(predicate)!
}

const kill = async (host: Host) => {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return
  const exited = once(host.child, "exit")
  host.child.kill("SIGKILL")
  await exited
}

let directory: string
let root: string
let servingFile: string
let port: number
let serving: Host

const serve = async () => {
  serving = launch([servingFixture, servingFile, root, String(port)])
  await waitFor(serving, (event) => event.event === "listening")
}

const call = (callerFile: string, executionId: string, name: string, waitMs: number) =>
  launch([callerFixture, callerFile, String(port), executionId, name, String(waitMs)])

const settled = (caller: Host) => waitFor(caller, (event) => event.event === "result" || event.event === "failure")

const runs = (filename: string, where: string, value: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql.unsafe<{ run_id: string; status: string }>(
        `SELECT run_id, status FROM flows_runs WHERE ${where}`,
        [value]
      )
      return rows.map((row) => ({ runId: row.run_id, status: row.status }))
    }).pipe(Effect.provide(NodeDatabase.layer({ filename })))
  )

/** The serving engine's runs of the placed child that wrote `name`. */
const servedRuns = (name: string) => runs(servingFile, "state_json LIKE ?", `%"name":"${name}"%`)

/** The id the caller's parent derives for its placed child. */
const childId = (parentId: string, name: string, waitMs: number) =>
  Effect.runPromise(
    Interpreter.childExecutionId(parentId, "root.flow.map", RemoteWrite._tag, { name, waitMs }).pipe(
      Effect.provide(NodeCrypto.layer)
    )
  )

const runningEvents = (name: string) =>
  serving.events.filter((event) => event.event === "running" && event.name === name).length

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "smithers-cross-host-recovery-"))
  root = join(directory, "workspace")
  await mkdir(root, { recursive: true })
  servingFile = join(directory, "serving.sqlite")
  port = await freePort()
  await serve()
}, bootBudget)

afterAll(async () => {
  await kill(serving)
  await rm(directory, { recursive: true, force: true })
})

describe("cross-host recovery drill", () => {
  it("settles a parent whose caller died while its placed child ran, from the child's one run", async () => {
    const callerFile = join(directory, "caller-dies.sqlite")
    const name = "caller-dies.txt"
    const first = call(callerFile, "caller-dies", name, 1_500)
    await waitFor(serving, (event) => event.event === "running" && event.name === name)
    await kill(first)

    // The serving host finishes the child while no caller is connected.
    const deadline = Date.now() + bootBudget
    while ((await servedRuns(name)).some((run) => run.status !== "completed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(readFileSync(join(root, name), "utf8")).toBe("written")
    const entered = runningEvents(name)

    const second = call(callerFile, "caller-dies", name, 1_500)
    expect(await settled(second)).toEqual({ event: "result", value: "parent saw written" })
    await once(second.child, "exit")

    // The restarted caller read the recorded result: the body never ran again.
    expect(runningEvents(name)).toBe(entered)
    expect(await servedRuns(name)).toEqual([
      { runId: await childId("caller-dies", name, 1_500), status: "completed" }
    ])
    expect(await runs(callerFile, "run_id = ?", "caller-dies")).toEqual([
      { runId: "caller-dies", status: "completed" }
    ])
  }, bootBudget * 2)

  it("settles a parent after both hosts died mid-child and restarted on their journals", async () => {
    const callerFile = join(directory, "both-die.sqlite")
    const name = "both-die.txt"
    const first = call(callerFile, "both-die", name, 3_000)
    await waitFor(serving, (event) => event.event === "running" && event.name === name)
    await Promise.all([kill(first), kill(serving)])
    expect(existsSync(join(root, name))).toBe(false)
    expect(await servedRuns(name)).toEqual([{ runId: await childId("both-die", name, 3_000), status: "running" }])

    await serve()
    const second = call(callerFile, "both-die", name, 3_000)
    expect(await settled(second)).toEqual({ event: "result", value: "parent saw written" })
    await once(second.child, "exit")

    expect(readFileSync(join(root, name), "utf8")).toBe("written")
    // One run under the id the parent derived, recovered, never a second one.
    expect(await servedRuns(name)).toEqual([{ runId: await childId("both-die", name, 3_000), status: "completed" }])
    expect(await runs(callerFile, "run_id = ?", "both-die")).toEqual([{ runId: "both-die", status: "completed" }])
  }, bootBudget * 3)
})
