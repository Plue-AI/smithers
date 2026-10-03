import * as Effects from "@smthrs/core/Effects"
import * as Graph from "@smthrs/core/Graph"
import * as Node from "@smthrs/core/Node"
import * as Flow from "@smthrs/flow/Flow"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Flows from "../src/Flows.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as TestMemory from "../src/test/TestMemory.ts"
import * as WithMemory from "../src/WithMemory.ts"

describe("Flows", () => {
  it("declares remember and recall as unsealed flows without bodies", () => {
    expect(Flows.remember.name).toBe("remember")
    expect(Flows.recall.name).toBe("recall")
    // A declaration with no body of its own carries the action a host
    // implements, which is what `handlersFor` supplies.
    expect(Flows.remember.effects?.tier).not.toBe("sealed")
    expect(Flows.recall.effects?.tier).toBe("sealed")
  })

  it("narrows recall inside a default-tier envelope and builds a sealed caller without diagnostics", () => {
    const envelope = Effects.make({
      reads: ["memory/**"],
      writes: [],
      mode: "expected",
      onConflict: "fail"
    })
    expect(Effects.narrow(envelope, Flows.recallEffects)).toEqual({ ok: true })

    const boundRecall = Flow.make("bound-recall", {
      payload: Flows.RecallInput,
      success: Flows.RecallOutput,
      effects: Flows.recallEffects,
      body: () => Node.succeed([])
    })
    const sealed = Flow.make("sealed-caller", {
      payload: Flows.RecallInput,
      success: Flows.RecallOutput,
      effects: envelope,
      body: (input) => boundRecall.call(input)
    })
    const diagnostics = Graph.diagnostics(Graph.build(sealed))
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "effect_tier_widening")).toEqual([])
  })

  it("exposes a bindable recall slot and concrete runtime handlers", () => {
    const binding = Flow.make("recall-slot", {
      payload: Flows.RecallInput,
      success: Flows.RecallOutput,
      body: () => Node.succeed([])
    })
    expect(Flows.bindRecall(binding)).toBe(binding)
    expect(Flows.handlersFor(Flows.recall)).toMatchObject({
      remember: expect.any(Function),
      recall: expect.any(Function)
    })
  })

  it("persists a remembered fact in the bank's namespace, with and without tags", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const tagged = yield* Flows.runRemember({
          bank: "global-history",
          key: "release",
          text: "cut 0.1.0",
          tags: ["scope:project"]
        })
        const untagged = yield* Flows.runRemember({ bank: "project", key: "plain", text: "no tags" })
        const prefixed = yield* store.getFact({ namespace: { kind: "global", id: "history" }, key: "release" })
        const local = yield* store.getFact({ namespace: { kind: "flow", id: "project" }, key: "plain" })
        return { tagged, untagged, prefixed, local }
      }).pipe(Effect.provide(TestMemory.layer))
    )

    expect(result.tagged).toEqual({ key: "release" })
    expect(result.untagged).toEqual({ key: "plain" })
    expect(result.prefixed?.value).toEqual({ content: "cut 0.1.0" })
    expect(result.prefixed?.tags).toEqual(["scope:project"])
    expect(result.local?.value).toEqual({ content: "no tags" })
    expect(result.local?.tags).toEqual([])
  })

  it("decodes the remember tag vocabulary, uniqueness, and 16-tag boundary", () => {
    const decode = Schema.decodeUnknownSync(Flows.RememberInput)
    const input = { bank: "bank", key: "key", text: "text" }
    expect(decode({ ...input, tags: Array.from({ length: 16 }, (_, index) => `scope:${index}`) }).tags)
      .toHaveLength(16)
    for (const tags of [["vendor:value"], ["scope:"], ["scope:same", "scope:same"]]) {
      expect(() => decode({ ...input, tags })).toThrow()
    }
    expect(() => decode({ ...input, tags: Array.from({ length: 17 }, (_, index) => `scope:${index}`) })).toThrow()
  })

  it("rejects an out-of-vocabulary remember tag with the same typed error as putNote", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const tags = ["vendor:value"] as never
        return yield* Effect.all([
          Effect.flip(Flows.runRemember({ bank: "bank", key: "fact", text: "text", tags })),
          Effect.flip(store.putNote({
            namespace: { kind: "flow", id: "bank" },
            id: "note",
            text: "text",
            tags,
            provenance: {}
          }))
        ])
      }).pipe(Effect.provide(TestMemory.layer))
    )
    expect(failures.map((failure) => failure.code)).toEqual(["invalid_tag", "invalid_tag"])
  })

  it("passes remember TTL and supplied provenance into the durable fact row", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* Flows.runRememberWith({ runId: "run-1", nodeId: "node-1", iteration: 2 })(
          { bank: "bank", key: "expiring", text: "text", ttlMs: 10 }
        )
        const current = yield* store.getFact({ namespace: "bank", key: "expiring" })
        const persisted = yield* sql<{ readonly provenance_json: string }>`SELECT provenance_json
          FROM memory_facts WHERE namespace_kind = 'flow' AND namespace_id = 'bank' AND fact_key = 'expiring'`
        yield* TestClock.adjust("10 millis")
        const expired = yield* store.getFact({ namespace: "bank", key: "expiring" })
        return { current, expired, provenanceJson: persisted[0]?.provenance_json }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase), Effect.provide(TestClock.layer()))
    )
    expect(result.current?.ttlMs).toBe(10)
    expect(JSON.parse(result.provenanceJson ?? "null")).toEqual({ runId: "run-1", nodeId: "node-1", iteration: 2 })
    expect(result.expired).toBeUndefined()
  })

  it("binds provenance at handler construction, not per call", async () => {
    const persisted = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const handlers = Flows.handlersFor(
          WithMemory.withMemory(Flows.remember, { banks: ["bank"], maxTokens: 1024 }),
          { runId: "run-9", nodeId: "node-9", iteration: 1 }
        )
        yield* handlers.remember({ bank: "bank", key: "bound", text: "text" })
        const rows = yield* sql<{ readonly provenance_json: string }>`SELECT provenance_json
          FROM memory_facts WHERE namespace_kind = 'flow' AND namespace_id = 'bank' AND fact_key = 'bound'`
        return rows[0]?.provenance_json
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(JSON.parse(persisted ?? "null")).toEqual({ runId: "run-9", nodeId: "node-9", iteration: 1 })
  })

  // `FlowBinding.make({ flow, handler })` types its handler as
  // `(input, call: Call) => Effect` and invokes it as `handler(decoded, call)`.
  // A second positional parameter on any memory handler therefore receives the
  // Call, so a provenance parameter there both breaks the binding's types and
  // persists the whole call payload into `provenance_json`. Arity is the cheap
  // in-package pin for that contract.
  it("keeps every runtime handler one-argument so FlowBinding can bind it", () => {
    expect(Flows.runRemember.length).toBe(1)
    expect(Flows.runRecall.length).toBe(1)
    expect(Flows.handlersFor(Flows.remember).remember.length).toBe(1)
    expect(Flows.runRememberWith({ runId: "run-1" }).length).toBe(1)
  })

  it("delegates the recall handler to the installed recall service", async () => {
    const rows = await Effect.runPromise(
      Flows.runRecall({ banks: ["flow-one", "flow-two"], query: "durable" }).pipe(
        Effect.provide(Recall.layer({
          recall: (input) =>
            Effect.succeed(input.banks.map((bank) => ({ bank, key: input.query, text: "row", score: 1 })))
        }))
      )
    )

    expect(rows).toEqual([
      { bank: "flow-one", key: "durable", text: "row", score: 1 },
      { bank: "flow-two", key: "durable", text: "row", score: 1 }
    ])
  })
})

describe("RememberInput bounds", () => {
  const decode = Schema.decodeUnknownExit(Flows.RememberInput)
  const valid = { bank: "bank", key: "key", text: "text" }

  it("accepts a fact at every bound", () => {
    expect(
      decode({
        bank: "b".repeat(Recall.MAX_RECALL_BANK_NAME_LENGTH),
        key: "k".repeat(Flows.MAX_REMEMBER_KEY_BYTES),
        text: "t".repeat(Flows.MAX_REMEMBER_TEXT_BYTES)
      })._tag
    ).toBe("Success")
  })

  // A fact remembered into a bank recall cannot name is unreachable forever.
  it.each([
    ["an empty bank", { ...valid, bank: "" }],
    ["a bank recall rejects", { ...valid, bank: "b".repeat(Recall.MAX_RECALL_BANK_NAME_LENGTH + 1) }],
    ["an oversized key", { ...valid, key: "k".repeat(Flows.MAX_REMEMBER_KEY_BYTES + 1) }],
    ["an oversized text", { ...valid, text: "t".repeat(Flows.MAX_REMEMBER_TEXT_BYTES + 1) }],
    ["a text over the byte cap in multibyte characters", {
      ...valid,
      text: "é".repeat(Flows.MAX_REMEMBER_TEXT_BYTES / 2 + 1)
    }]
  ])("rejects %s", (_name, input) => {
    expect(decode(input)._tag).toBe("Failure")
  })
})

describe("Flows model-facing boundary", () => {
  it("refuses a scoped remember or recall on a declaration that carries no policy", async () => {
    const touched: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const handlers = Flows.handlersFor(Flows.remember)
        const remember = yield* Effect.flip(handlers.remember({ bank: "user-victim", key: "k", text: "planted" }))
        const recall = yield* Effect.flip(
          Flows.runRecallFor(Flows.recall, { banks: ["global-secrets"], query: "q" })
        )
        const planted = yield* store.getFact({ namespace: { kind: "user", id: "victim" }, key: "k" })
        return { remember, recall, planted }
      }).pipe(
        Effect.provide(Recall.layer({
          recall: (input) =>
            Effect.sync(() => {
              touched.push(...input.banks)
              return []
            })
        })),
        Effect.provide(TestMemory.layer)
      )
    )
    expect(result.remember.code).toBe("invalid_namespace")
    expect(result.recall.code).toBe("invalid_namespace")
    expect(result.planted).toBeUndefined()
    expect(touched).toEqual([])
  })

  it("refuses a model-written source: tag so a planted fact cannot pose as trusted-source memory", async () => {
    const decode = Schema.decodeUnknownSync(Flows.RememberInput)
    expect(() => decode({ bank: "bank", key: "key", text: "text", tags: ["source:eval"] })).toThrow()
    const failure = await Effect.runPromise(
      Effect.flip(
        Flows.runRemember({ bank: "bank", key: "key", text: "text", tags: ["source:supervisor"] as never })
      ).pipe(Effect.provide(TestMemory.layer))
    )
    expect(failure.code).toBe("invalid_tag")
  })
})
