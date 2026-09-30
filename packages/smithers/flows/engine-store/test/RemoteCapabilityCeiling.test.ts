/**
 * Two real engines in two processes: this process runs a caller engine whose
 * `Hosts` table places `RemoteWrite` on a serving engine in a child process,
 * reached over HTTP through the public `FlowProxy` protocol (#2852). The
 * serving engine is a durable `EngineStore` over SQLite, and it writes through
 * the kernel's guarded `FileSystem` over a real `GrantStore` that allows its
 * workspace, so only the carried ceiling (or the host's own grants) can refuse.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { FlowEngine, FlowProxy, Hosts } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RemoteWrite } from "./fixtures/RemoteCeilingFlow.ts"

const fixture = fileURLToPath(new URL("./fixtures/remote-ceiling-engine.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const childEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }
/** Booting a child engine under a loaded suite can take many seconds. */
const bootBudget = 120_000

interface Serving {
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

const serve = async (filename: string, root: string, port: number): Promise<Serving> => {
  const child = spawn(process.execPath, [fixture, filename, root, String(port)], {
    cwd: repositoryRoot,
    env: childEnv
  })
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
  const serving: Serving = { child, events, output: () => `${stderr.slice(-4096)}\n${stdout.slice(-4096)}` }
  await waitFor(serving, (event) => event.event === "listening")
  return serving
}

const waitFor = async (serving: Serving, predicate: (event: Record<string, unknown>) => boolean) => {
  const deadline = Date.now() + bootBudget
  while (!serving.events.some(predicate)) {
    if (serving.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`serving engine never reported the event\n${serving.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const stop = async (serving: Serving) => {
  if (serving.child.exitCode !== null || serving.child.signalCode !== null) return
  const exited = once(serving.child, "exit")
  serving.child.kill("SIGKILL")
  await exited
}

const binding = (port: number): Hosts.Binding => ({
  _tag: "Proxy",
  connect: (group) =>
    RpcClient.make(group as never).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}/` }).pipe(
          Layer.provide(RpcSerialization.layerJson),
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
})

const parent = (tag: string, capabilities?: ReadonlyArray<string>) =>
  Flow.make(`remote-ceiling/parent/${tag}`, {
    payload: { name: Schema.String, waitMs: Schema.Number },
    success: Schema.String,
    ...(capabilities === undefined ? {} : { capabilities }),
    body: (payload) => RemoteWrite.child(payload).pipe(Node.map((result) => result))
  })

/** The caller engine: in-memory, with `serving` bound to the child process. */
const caller = (port: number, flow: Flow.Any) =>
  Layer.build(
    Interpreter.layer(flow as ReturnType<typeof parent>).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Hosts.layer({ serving: binding(port) }))
    )
  )

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer)) as Effect.Effect<A, E>)

const onCaller = (context: Context.Context<any>) => <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.provide(effect, context) as Effect.Effect<A, E>

const execute = (port: number, flow: ReturnType<typeof parent>, name: string, executionId: string, waitMs = 0) =>
  run(Effect.gen(function*() {
    const context = yield* caller(port, flow)
    return yield* flow.execute({ name, waitMs }, { executionId }).pipe(onCaller(context))
  }))

const statusOf = (filename: string, name: string): Promise<ReadonlyArray<string>> =>
  run(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ status: string }>`
      SELECT status FROM flows_runs WHERE state_json LIKE ${`%"name":"${name}"%`}
    `
      return rows.map((row) => row.status)
    }).pipe(Effect.provide(NodeDatabase.layer({ filename })))
  )

const pattern = (action: string, resource: string) => new CapabilityPattern({ action: action as never, resource })

const readOnly = [pattern("fs:read", "**")]

/** Runs `RemoteWrite` straight from the caller engine, under `ceiling` when given. */
const direct = (name: string, executionId: string, ceiling?: ReadonlyArray<CapabilityPattern>, waitMs = 0) =>
  run(Effect.gen(function*() {
    const context = yield* caller(port, parent("direct"))
    const effect = RemoteWrite.execute({ name, waitMs }, { executionId })
    return yield* Effect.exit(
      (ceiling === undefined ? effect : CapabilitySet.attenuate(ceiling)(effect)).pipe(onCaller(context))
    )
  }))

let directory: string
let root: string
let filename: string
let port: number
let serving: Serving

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "smithers-remote-ceiling-"))
  root = join(directory, "workspace")
  await mkdir(join(root, "allowed"), { recursive: true })
  filename = join(directory, "serving.sqlite")
  port = await freePort()
  serving = await serve(filename, root, port)
}, bootBudget)

afterAll(async () => {
  await stop(serving)
  await rm(directory, { recursive: true, force: true })
})

describe("remote execution under a carried capability ceiling", () => {
  it("enforces empty, narrowed, wildcard and omitted ceilings on the serving host", async () => {
    const narrowed = [`fs:write:${root}/allowed/**`]
    const cases = [
      ["omitted", undefined, "omitted.txt", "written"],
      ["wildcard", ["*"], "wildcard.txt", "written"],
      ["narrowed-inside", narrowed, "allowed/narrowed.txt", "written"],
      ["narrowed-outside", narrowed, "narrowed.txt", "denied:PermissionDenied"],
      ["empty", [], "empty.txt", "denied:PermissionDenied"],
      // A wildcard ceiling cannot reach past the serving host's own grants.
      ["wildcard-host", ["*"], "../escaped.txt", "denied:PermissionDenied"]
    ] as const
    for (const [tag, capabilities, name, expected] of cases) {
      expect([tag, await execute(port, parent(tag, capabilities), name, `matrix-${tag}`)]).toEqual([tag, expected])
      expect([tag, existsSync(join(root, name))]).toEqual([tag, expected === "written"])
    }
  }, bootBudget)

  it("bounds a request that carries no ceiling by the serving host alone", async () => {
    const result = await run(Effect.gen(function*() {
      const connect = binding(port)
      if (connect._tag !== "Proxy") throw new Error("unreachable")
      const client = (yield* connect.connect(FlowProxy.toRpcGroup([RemoteWrite]) as never)) as Record<
        string,
        (request: object) => Effect.Effect<string>
      >
      const execute = client[FlowProxy.operationAddresses(RemoteWrite._tag).execute]!
      return [
        yield* execute({ payload: { name: "bare.txt", waitMs: 0 }, executionId: "bare" }),
        yield* execute({ payload: { name: "../bare-escaped.txt", waitMs: 0 }, executionId: "bare-escaped" })
      ]
    }))
    expect(result).toEqual(["written", "denied:PermissionDenied"])
    expect(existsSync(join(root, "bare.txt"))).toBe(true)
    expect(existsSync(join(root, "../bare-escaped.txt"))).toBe(false)
  }, bootBudget)

  it("refuses a narrower caller the result a wider remote run produced, and lets a wider caller join", async () => {
    const wide = await direct("joined-wide.txt", "joined-wide")
    expect(wide).toEqual(Exit.succeed("written"))
    const refused = await direct("joined-wide.txt", "joined-wide", readOnly)
    expect(Exit.isFailure(refused)).toBe(true)
    // The serving engine's refusal crosses as its redacted handler defect.
    const defect = Exit.isFailure(refused) ? Cause.squash(refused.cause) : undefined
    expect(defect).toMatchObject({ name: "@smthrs/engine/FlowHandlerDefect" })
    expect(String((defect as { message: string }).message)).toContain("ExecutionIdentityConflict")
    expect(String((defect as { message: string }).message)).toContain("capabilities")

    // A remote resume is refused on the serving engine the same way.
    const resumed = await run(Effect.gen(function*() {
      const context = yield* caller(port, parent("resume"))
      const runtime = Context.get(context as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
      return yield* Effect.exit(
        CapabilitySet.attenuate(readOnly)(runtime.resume(RemoteWrite, "joined-wide")).pipe(onCaller(context))
      )
    }))
    const resumeRefusal = String(Exit.isFailure(resumed) ? Cause.squash(resumed.cause) : undefined)
    expect(resumeRefusal).toContain("ExecutionIdentityConflict")
    expect(resumeRefusal).toContain("capability ceiling does not cover")

    expect(await direct("joined-narrow.txt", "joined-narrow", readOnly)).toEqual(
      Exit.succeed("denied:PermissionDenied")
    )
    // The wider caller reads the recorded result; it does not rerun the write.
    expect(await direct("joined-narrow.txt", "joined-narrow")).toEqual(Exit.succeed("denied:PermissionDenied"))
    expect(existsSync(join(root, "joined-narrow.txt"))).toBe(false)
  }, bootBudget)

  it("keeps the admitted ceiling across a serving-engine restart while callers retry", async () => {
    const restricted = parent("restart-restricted", [`fs:write:${root}/allowed/**`])
    const wide = parent("restart-wide", ["*"])
    const pending = Promise.all([
      execute(port, restricted, "restart-restricted.txt", "restart-restricted", 2_000),
      execute(port, wide, "allowed/restart-wide.txt", "restart-wide", 2_000)
    ])
    await waitFor(serving, (event) => event.name === "restart-restricted.txt")
    await waitFor(serving, (event) => event.name === "allowed/restart-wide.txt")
    await stop(serving)
    serving = await serve(filename, root, port)
    expect(await pending).toEqual(["denied:PermissionDenied", "written"])
    expect(existsSync(join(root, "restart-restricted.txt"))).toBe(false)
    expect(existsSync(join(root, "allowed/restart-wide.txt"))).toBe(true)
    expect(await statusOf(filename, "allowed/restart-wide.txt")).toEqual(["completed"])
    // The recovered rows kept their admitted authority: a narrower caller still
    // cannot join the wide run, and a wider one reads the restricted refusal.
    const childOf = (parentId: string, name: string) =>
      run(Interpreter.childExecutionId(parentId, "root.flow.map", RemoteWrite._tag, { name, waitMs: 2_000 }))
    const wideChild = await childOf("restart-wide", "allowed/restart-wide.txt")
    const restrictedChild = await childOf("restart-restricted", "restart-restricted.txt")
    expect(Exit.isFailure(await direct("allowed/restart-wide.txt", wideChild, readOnly, 2_000))).toBe(true)
    expect(await direct("restart-restricted.txt", restrictedChild, undefined, 2_000))
      .toEqual(Exit.succeed("denied:PermissionDenied"))
  }, bootBudget * 2)

  it("forwards a restricted parent's cancellation to the serving engine", async () => {
    const Parent = parent("cancel", [`fs:write:${root}/**`])
    const status = await run(Effect.gen(function*() {
      const context = yield* caller(port, Parent)
      const fiber = yield* Effect.forkChild(
        Effect.exit(Parent.execute({ name: "cancelled.txt", waitMs: 600_000 }, { executionId: "cancel-parent" }))
          .pipe(onCaller(context))
      )
      yield* Effect.promise(() => waitFor(serving, (event) => event.name === "cancelled.txt"))
      const runtime = Context.get(context as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
      yield* runtime.interrupt(Parent, "cancel-parent").pipe(Effect.orDie)
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      for (let attempt = 0; attempt < 600; attempt++) {
        const statuses = yield* Effect.promise(() => statusOf(filename, "cancelled.txt"))
        if (statuses.includes("cancelled")) return statuses
        yield* Effect.sleep("50 millis")
      }
      return yield* Effect.promise(() => statusOf(filename, "cancelled.txt"))
    }))
    expect(status).toEqual(["cancelled"])
    expect(existsSync(join(root, "cancelled.txt"))).toBe(false)
  }, bootBudget)
})
