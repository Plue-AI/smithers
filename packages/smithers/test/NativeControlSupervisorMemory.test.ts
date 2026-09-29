/**
 * The supervisor's memory through the executor the CLI ships.
 *
 * `SupervisorMemory.test.ts` holds the layer `SupervisorMemory` builds to its
 * promises, but it builds that layer itself, so an executor that stopped
 * providing it (the `Recall.layerNoop` this replaced) left every one of its
 * cases green. These runs go through `NodeControl.layerExecutor`, the
 * composition `smithers run` uses: a real flow, planned, approved and run
 * twice over one `SMITHERS_MEMORY_DB`. The provider is an Undici mock and the
 * judge is scripted, so nothing leaves the process. No other environment arms
 * delivery: the judge the host requires does.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import { Control } from "@smthrs/control"
import type * as Relevance from "@smthrs/harness/Relevance"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
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

const sentence = "The repository runs its suite through tox, never pytest directly."

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
        response: { id: "resp_memory", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
      })
    }`,
    "",
    ""
  ].join("\n")

const cell = (source: string): string => `\`\`\`cell\n${source}\n\`\`\``

describe("the shipped Node executor's supervisor memory", () => {
  it("recalls a note run 1 remembered into run 2's supervisor snapshot and delivers it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-memory-")))
    roots.add(root)
    const directory = join(root, "flows", "tox")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "flow.mdx"),
      [
        "---",
        "name: tox",
        "description: Makes the tox suite pass.",
        "model: openai:gpt-4o-mini",
        "---",
        "",
        "Make the tox suite pass.",
        ""
      ].join("\n")
    )

    // Which run the provider and the judge are answering, and how many model
    // calls that run has made. Run 1 says the sentence on its first frame and
    // finishes on its second; run 2 says something else, looks again, and
    // finishes on its third, which is the first to read frame 0's reading.
    type Phase = "run-1" | "run-2"
    let phase: Phase = "run-1"
    let frame = 0
    const snapshots: Record<Phase, Array<Supervisor.Snapshot>> = { "run-1": [], "run-2": [] }
    const recalled: Record<Phase, Array<Relevance.Item>> = { "run-1": [], "run-2": [] }
    const mined: Record<Phase, Array<string>> = { "run-1": [], "run-2": [] }
    const requests: Record<Phase, Array<string>> = { "run-1": [], "run-2": [] }
    const reads: Record<Phase, Deferred.Deferred<void>> = {
      "run-1": Deferred.makeUnsafe<void>(),
      "run-2": Deferred.makeUnsafe<void>()
    }

    const agent = new MockAgent()
    agents.add(agent)
    agent.disableNetConnect()
    agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
      200,
      (request) => {
        requests[phase].push(new TextDecoder().decode(request.body as Uint8Array))
        const index = frame++
        const prose = phase === "run-1" ? sentence : "Looking around first."
        const last = phase === "run-1" ? 1 : 2
        return sse(
          index === 0
            ? `${prose}\n\n${cell("console.log('observed')")}`
            : cell(index < last ? "console.log('again')" : "ctx.done('done')")
        )
      },
      { headers: { "content-type": "text/event-stream" } }
    ).persist()
    const client = await Effect.runPromise(
      NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
    )
    const inner = await Effect.runPromise(
      RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
    )
    // Each run's second frame waits for the supervisor to read its first, so
    // the reading, the note it writes and the row it shows happen inside
    // the run, with a moment for the verdict to reach the mailbox.
    const executor = Layer.succeed(RequestExecutor.RequestExecutor, {
      execute: (request, options) =>
        (frame === 1 ? Deferred.await(reads[phase]).pipe(Effect.andThen(Effect.sleep("100 millis"))) : Effect.void)
          .pipe(
            Effect.andThen(inner.execute(request, options))
          )
    })

    // Finishes every completion, accepts every sentence the miner offers, and keeps
    // every item relevance is asked about.
    const judge = Evaluator.layerScripted((request) => {
      if (Object.hasOwn(request.questions, "unnecessary_0")) {
        const items = (request.state as { readonly items: ReadonlyArray<Relevance.Item> }).items
        recalled[phase].push(...items.filter((item) => item.kind === "memory"))
        return Object.fromEntries(items.map((_, index) => [`unnecessary_${index}`, { probability: 0.01 }]))
      }
      // The opening `memory({ task })` call: nothing in the fixture is needed.
      if (Object.keys(request.questions).every((id) => /^(?:needed|descend)_\d+$/.test(id))) {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: 0.05 }]))
      }
      if (Object.hasOwn(request.questions, "durable_0")) {
        const items = (request.state as { readonly items: ReadonlyArray<{ readonly text: string }> }).items
        mined[phase].push(...items.map((item) => item.text))
        return Object.fromEntries(
          items.flatMap((
            _,
            index
          ) => [[`durable_${index}`, { probability: 0.99 }], [`issue_${index}`, { probability: 0.01 }]])
        )
      }
      if (!Object.hasOwn(request.questions, "thrashing")) {
        return { complete: { probability: 0.99 }, overclaims: { probability: 0.01 }, invented: { probability: 0.01 } }
      }
      snapshots[phase].push(Schema.decodeUnknownSync(Supervisor.Snapshot)(request.state))
      Deferred.doneUnsafe(reads[phase], Effect.void)
      return Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          key === "needs_help"
            ? { choice: "none" }
            : ["frustrated", "anxious", "scared", "confused", "confident"].includes(key)
            ? { score: 0 }
            : { probability: key === "on_target" ? 0.99 : 0.01 }
        ])
      )
    })

    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    const runs = NodeControl.layerExecutor(registry, engine, root, {
      evaluator: judge,
      environment: { OPENAI_API_KEY: "test-key", SMITHERS_MEMORY_DB: join(root, "memory", "tox.db") },
      grants: GrantStore.layerNoop,
      requestExecutor: executor
    })
    const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>

    const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])
    const run = (ordinal: number) =>
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({ flowId: "tox", input: { ordinal } })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `native-memory:${ordinal}`
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
          Stream.takeUntil((event) => terminal.has(event.kind)),
          Stream.runCollect
        )
      })

    const outcomes = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* run(1)
        phase = "run-2"
        frame = 0
        const second = yield* run(2)
        return [first, second]
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
    )

    expect(outcomes.map((events) => events.at(-1)?.kind)).toEqual(["control.run.completed", "control.run.completed"])
    for (const events of outcomes) {
      expect(events.find((event) => event.kind === "control.agent.discipline-armed")?.payload).toMatchObject({
        judged: true
      })
    }
    // Run 1's transcript is mined once, at its end; run 2 recalls what it kept.
    expect(mined["run-1"]).toEqual([sentence])
    expect(recalled["run-1"]).toEqual([])
    expect(recalled["run-2"].map((item) => item.text)).toContain(sentence)
    // Run 2's third frame reads the recalled row, with no env arming it. No
    // frame moves the tree (the note is written after the run), so each run's
    // first completion is bounced once and it completes a frame later.
    expect(requests["run-1"]).toHaveLength(3)
    expect(requests["run-2"]).toHaveLength(4)
    expect(requests["run-2"][2]).toContain("From memory of this repository")
    expect(requests["run-2"][1]).not.toContain("From memory of this repository")
  }, 60_000)

  it("offers memory and opens with workspace files only on an unsealed host", async () => {
    // One run per host: the flow's task names a workspace file, and its first
    // frame asks `memory` for that file by path.
    const probe = async (environment: Record<string, string>) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-memory-sealed-")))
      roots.add(root)
      await mkdir(join(root, "flows", "probe"), { recursive: true })
      await mkdir(join(root, "notes"))
      await writeFile(join(root, "notes", "secret.txt"), "host-only-secret\n")
      await writeFile(
        join(root, "flows", "probe", "flow.mdx"),
        [
          "---",
          "name: probe",
          "description: Reads notes/secret.txt.",
          "model: openai:gpt-4o-mini",
          "---",
          "",
          "Summarize notes/secret.txt.",
          ""
        ].join("\n")
      )
      const requests: Array<string> = []
      const agent = new MockAgent()
      agents.add(agent)
      agent.disableNetConnect()
      agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
        200,
        (request) => {
          requests.push(new TextDecoder().decode(request.body as Uint8Array))
          return sse(
            requests.length === 1
              ? cell([
                "try {",
                "  const m = await ctx.call(\"memory\", { task: \"read it\", paths: [\"notes/secret.txt\"] })",
                "  console.log(\"MEMORY-OK \" + m.context)",
                "} catch (error) {",
                "  console.log(\"MEMORY-REFUSED \" + String(error))",
                "}"
              ].join("\n"))
              : cell("ctx.done('done')")
          )
        },
        { headers: { "content-type": "text/event-stream" } }
      ).persist()
      const client = await Effect.runPromise(
        NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
      )
      const executor = await Effect.runPromise(
        RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
      )
      // Keeps every flow and every candidate; finishes every completion.
      const judge = Evaluator.layerScripted((request) =>
        Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            id === "needs_help"
              ? { choice: "none" }
              : ["frustrated", "anxious", "scared", "confused", "confident"].includes(id)
              ? { score: 0 }
              : { probability: /^(?:unnecessary|needed|descend|overclaims|invented)_?\d*$/.test(id) ? 0.01 : 0.99 }
          ])
        )
      )
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const runs = NodeControl.layerExecutor(registry, engine, root, {
        evaluator: judge,
        environment: { OPENAI_API_KEY: "test-key", ...environment },
        grants: GrantStore.layerNoop,
        requestExecutor: Layer.succeed(RequestExecutor.RequestExecutor, executor)
      })
      const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
      const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])
      const events = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "probe", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "native-memory-sealed"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
            Stream.takeUntil((event) => terminal.has(event.kind)),
            Stream.runCollect
          )
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
      )
      // The frame-0 reading of the run's own session: opening memory rows are
      // judged there as `memory` items, beside flows and instructions.
      const settled = events.find((event) =>
        event.kind === "control.agent.relevance-settled" && event.step === undefined
      )?.payload as
        | {
          readonly frame: number
          readonly source: string
          readonly kept: ReadonlyArray<{ readonly kind: string; readonly id: string }>
          readonly withheld: ReadonlyArray<{ readonly kind: string; readonly id: string }>
        }
        | undefined
      return { requests, settled }
    }

    const open = await probe({})
    // The opening seeds the file the task names, and the agent's call reads it.
    expect(open.requests[0]).toContain("host-only-secret")
    expect(open.requests[1]).toContain("MEMORY-OK")
    expect(open.requests[1]).toContain("host-only-secret")
    // The opening row reached the agent through the run-start relevance reading.
    expect(open.settled).toMatchObject({ frame: 0, source: "run" })
    expect(open.settled!.kept.filter((item) => item.kind === "memory").map((item) => item.id)).toEqual([
      "file/notes/secret.txt"
    ])
    expect(open.settled!.withheld.filter((item) => item.kind === "memory")).toEqual([])

    const sealed = await probe({ SMITHERS_BASH_CONTAINER: "benchmark-cell" })
    expect(sealed.requests.length).toBeGreaterThan(1)
    expect(sealed.requests.join("\n")).not.toContain("host-only-secret")
    expect(sealed.requests[1]).toContain("MEMORY-REFUSED")
    // A sealed host opens with no workspace rows to judge.
    expect(sealed.settled!.kept.filter((item) => item.kind === "memory")).toEqual([])
  }, 60_000)
})
