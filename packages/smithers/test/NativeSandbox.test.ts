/**
 * A flow's `sandbox:` selection on the executor `smithers run` ships.
 *
 * The host is `NodeControl.layerExecutor` with a real `DirectorySandbox`
 * configured for `provider: directory`, an Undici mock for the provider and
 * the offline judge, so nothing leaves the process. The run writes a file,
 * parks on an ask, and after the approval reads the file back: the machine it
 * wrote to outlives the park, and ends when the run settles.
 */
import { NodeHttpClient } from "@effect/platform-node"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { MockAgent } from "@effect/platform-node/Undici"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlSchema } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { DirectorySandbox, type Sandbox } from "@smthrs/sandbox"
import { Effect, FileSystem, Layer, Schedule, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const roots = new Set<string>()
const agents = new Set<MockAgent>()

afterEach(async () => {
  await Promise.all([...agents].map((agent) => agent.close()))
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })))
  agents.clear()
  roots.clear()
})

const note = "kept across the park"

/** Writes on the machine, parks on an ask, then reads the file back after the approval. */
const cell = [
  `await ctx.call("write", { path: "note.txt", content: ${JSON.stringify(note)} })`,
  `const decision = await ctx.call("ask", { question: "read it back?", options: ["yes", "no"] })`,
  `const read = await ctx.call("read", { path: "note.txt" })`,
  "ctx.done(read.content)"
].join("\n")

/** One OpenAI Responses stream whose only output is `text`. */
const sse = (text: string): string =>
  [
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: text })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1" })}`,
    "",
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_sandboxed", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
      })
    }`,
    "",
    ""
  ].join("\n")

const flow = (name: string, sandbox: string) =>
  [
    "---",
    `name: ${name}`,
    "description: Keeps a note on its machine.",
    "model: openai:gpt-4o-mini",
    `sandbox: ${sandbox}`,
    "---",
    "",
    "Keep a note, ask before reading it back, and answer with what it says.",
    ""
  ].join("\n")

const project = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-sandbox-")))
  roots.add(root)
  for (const [name, sandbox] of [["scribe", "{provider: directory}"], ["boxed", "{provider: container}"]]) {
    await mkdir(join(root, "flows", name!), { recursive: true })
    await writeFile(join(root, "flows", name!, "flow.mdx"), flow(name!, sandbox!))
  }
  // The engine snapshots the host checkout around a run's steps, sandboxed or not.
  execFileSync("jj", ["git", "init", root], { stdio: "ignore" })
  const machines = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-sandbox-machines-")))
  roots.add(machines)
  return { root, machines }
}

/** The shipped executor over `root`, with `directory` configured and every acquire and release logged. */
const host = async (root: string, machines: string, log: Array<string>) => {
  const agent = new MockAgent()
  agents.add(agent)
  agent.disableNetConnect()
  agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
    200,
    () => sse("```cell\n" + cell + "\n```"),
    { headers: { "content-type": "text/event-stream" } }
  ).persist()
  const client = await Effect.runPromise(
    NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
  )
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
  const logged = (provider: Sandbox.Provider): Sandbox.Provider => ({
    acquire: (session) =>
      Effect.acquireRelease(
        Effect.sync(() => log.push(`acquire ${session}`)),
        () => Effect.sync(() => log.push(`release ${session}`))
      ).pipe(Effect.andThen(provider.acquire(session)))
  })
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const runs = NodeControl.layerExecutor(registry, engine, root, {
    evaluator: ScriptedJudge.layerAll,
    environment: { OPENAI_API_KEY: "test-key" },
    grants: GrantStore.layerNoop,
    requestExecutor: Layer.effect(RequestExecutor.RequestExecutor)(
      RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
    ),
    sandboxProviders: {
      directory: (selection, { spawner }) =>
        logged(DirectorySandbox.make({ fs, spawner, root: machines, network: selection.network }))
    }
  })
  return Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
}

const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])

/** Launches `scribe` and returns once its ask has parked it, with what the host held then. */
const parkedOnAsk = (machines: string, log: Array<string>, key: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const card = yield* control.plan({ flowId: "scribe", input: {} })
    yield* control.approve(card.approval)
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: key
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
      return yield* Effect.die("expected an accepted run")
    }
    const runId = receipt.runId
    const requested = yield* control.watch({ runId, follow: true }).pipe(
      Stream.filter((event) => event.kind === "control.approval.requested"),
      Stream.take(1),
      Stream.runCollect
    )
    const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(
      (requested[0]!.payload as { readonly payload: unknown }).payload
    )
    return { control, runId, approval, log: [...log], sessions: yield* Effect.promise(() => readdir(machines)) }
  })

/** Waits, while the executor is still open, for the machine to be released. */
const released = (log: Array<string>) =>
  Effect.suspend(() => log.some((line) => line.startsWith("release ")) ? Effect.void : Effect.fail("held")).pipe(
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
    Effect.orDie
  )

describe("a sandbox-selected flow on the shipped Node executor", () => {
  it("keeps the run's machine across a park and ends it when the run settles", async () => {
    const { root, machines } = await project()
    const log: Array<string> = []
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const parked = yield* parkedOnAsk(machines, log, "native-sandbox:scribe")
        yield* parked.control.approve(parked.approval)
        yield* parked.control.resume({ runId: parked.runId, idempotencyKey: "native-sandbox:resume" })
        const events = yield* parked.control.watch({ runId: parked.runId, follow: true }).pipe(
          Stream.takeUntil((event) => terminal.has(event.kind)),
          Stream.runCollect
        )
        // Ended by the settlement, not by the executor closing.
        yield* released(log)
        return { parked, events: [...events], sessions: yield* Effect.promise(() => readdir(machines)) }
      }).pipe(Effect.provide(await host(root, machines, log)), Effect.scoped, Effect.orDie)
    )
    const session = log[0]!.slice("acquire ".length)
    // Keyed by the run within this project's state, so another project's run-1 is another machine.
    expect(session).toMatch(new RegExp(`^[0-9a-f]{16}:sandbox:${observed.parked.runId}$`))
    // Parked on the ask: the file is on the machine, which is still held.
    expect(observed.parked.log).toEqual([`acquire ${session}`])
    expect(observed.parked.sessions).toHaveLength(1)
    expect(observed.events.at(-1)!.kind).toBe("control.run.completed")
    // The resumed attempt read what the parked one wrote.
    const reads = observed.events.filter((event) =>
      event.kind === "control.agent.cell-call-settled" &&
      (event.payload as { readonly flowName?: unknown }).flowName === "read"
    )
    expect(JSON.stringify(reads)).toContain(note)
    expect(log).toEqual([`acquire ${session}`, `release ${session}`])
    // The write never touched this host's checkout, and the machine is gone.
    expect(existsSync(join(root, "note.txt"))).toBe(false)
    expect(observed.sessions).toEqual([])
  }, 60_000)

  it("ends the machine of a parked run that is cancelled", async () => {
    const { root, machines } = await project()
    const log: Array<string> = []
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const parked = yield* parkedOnAsk(machines, log, "native-sandbox:cancelled")
        yield* parked.control.cancel({ runId: parked.runId, idempotencyKey: "native-sandbox:cancel" })
        yield* released(log)
        return { parked, sessions: yield* Effect.promise(() => readdir(machines)) }
      }).pipe(Effect.provide(await host(root, machines, log)), Effect.scoped, Effect.orDie)
    )
    expect(observed.parked.sessions).toHaveLength(1)
    const session = log[0]!.slice("acquire ".length)
    expect(log).toEqual([`acquire ${session}`, `release ${session}`])
    expect(observed.sessions).toEqual([])
  }, 60_000)

  it("refuses to move a parked run off its machine when resumed onto code without the selection", async () => {
    const { root, machines } = await project()
    const log: Array<string> = []
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const parked = yield* parkedOnAsk(machines, log, "native-sandbox:drift")
        // The flow no longer selects a sandbox; the operator accepts the drift.
        yield* Effect.promise(() =>
          writeFile(join(root, "flows", "scribe", "flow.mdx"), flow("scribe", "").replace("sandbox: \n", ""))
        )
        // The approval alone would resume unchanged code, which drift refuses.
        yield* Effect.flip(parked.control.approve(parked.approval))
        yield* parked.control.resume({
          runId: parked.runId,
          idempotencyKey: "native-sandbox:drift",
          allowCodeDrift: true
        })
        const events = yield* parked.control.watch({ runId: parked.runId, follow: true }).pipe(
          Stream.takeUntil((event) => terminal.has(event.kind)),
          Stream.runCollect
        )
        yield* released(log)
        return [...events]
      }).pipe(Effect.provide(await host(root, machines, log)), Effect.scoped, Effect.orDie)
    )
    const settled = observed.at(-1)!
    expect(settled.kind).toBe("control.run.failed")
    expect(JSON.stringify(settled.payload)).toContain("changed its sandbox selection")
    // Nothing ran on this host in the machine's place.
    expect(existsSync(join(root, "note.txt"))).toBe(false)
    expect(log).toHaveLength(2)
  }, 60_000)

  it("refuses a provider this host has not configured, before anything runs", async () => {
    const { root, machines } = await project()
    const log: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({ flowId: "boxed", input: {} })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "native-sandbox:boxed"
        })
        return receipt
      }).pipe(Effect.provide(await host(root, machines, log)), Effect.scoped, Effect.exit)
    )
    expect(JSON.stringify(exit)).toContain("this host has no sandbox provider configured for it")
    expect(log).toEqual([])
  }, 60_000)
})
