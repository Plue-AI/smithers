import * as Flows from "@smthrs/memory/Flows"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import type * as Catalog from "../src/Catalog.ts"
import * as MemoryEntries from "../src/MemoryEntries.ts"
import { flow, runChain, runOn } from "./harness.ts"

const services = Layer.provideMerge(RecallKeyword.layer, TestMemory.layerWithDatabase)

const policy = { banks: ["worldview", "b"], maxTokens: 1000, retain: "on-complete" } as const

const entriesOf = (): Promise<ReadonlyArray<Catalog.Entry>> =>
  runOn(services, MemoryEntries.make(policy))

const call = (entry: Catalog.Entry, payload: unknown): Promise<unknown> =>
  Effect.runPromise(entry.handler(payload) as Effect.Effect<unknown, never, never>)

const callError = (entry: Catalog.Entry, payload: unknown): Promise<Catalog.CallError> =>
  Effect.runPromise(Effect.flip(entry.handler(payload)) as Effect.Effect<Catalog.CallError, never, never>)

describe("MemoryEntries", () => {
  it("exposes the memory package's own declarations", async () => {
    const entries = await entriesOf()
    expect(entries.map((entry) => entry.name)).toEqual([Flows.rememberName, Flows.recallName])
    expect(entries[0]?.description).toBe(Flows.rememberDescription)
    expect(entries[1]?.description).toBe(Flows.recallDescription)
  })

  it("remembers into the real store and recalls it back", async () => {
    const entries = await runOn(
      services,
      Effect.gen(function*() {
        const built = yield* MemoryEntries.make(policy)
        const remember = built[0] as Catalog.Entry
        const recall = built[1] as Catalog.Entry
        const written = yield* remember.handler({
          bank: "worldview",
          key: "release-plan",
          // `@smthrs/memory` `Namespace.Tag` is a template literal: every tag
          // carries one of the stable prefixes `branch:`, `stream:`, `source:`
          // or `scope:`, so a bare word is refused at the seam. A tag names
          // WHERE a memory came from, and an unprefixed one cannot say.
          tags: ["scope:release"],
          text: "ship the chain harness this week"
        })
        const found = yield* recall.handler({ banks: ["worldview"], query: "chain harness" })
        return { found, written }
      })
    )
    expect(entries.written).toEqual({ key: "release-plan" })
    const found = entries.found as Array<{ readonly bank: string; readonly key: string; readonly text: string }>
    expect(found).toHaveLength(1)
    expect({ bank: found[0]!.bank, key: found[0]!.key, text: found[0]!.text }).toEqual({
      bank: "worldview",
      key: "release-plan",
      text: "ship the chain harness this week"
    })
  })

  it("refuses malformed payloads quoting the actual parse failure", async () => {
    const [remember, recall] = await entriesOf() as [Catalog.Entry, Catalog.Entry]
    const rememberError = await callError(remember, { key: "x" })
    expect(rememberError.cause).toBe("invalid_input")
    expect(rememberError.message).toContain(`"remember" rejected its input`)
    expect(rememberError.message).toContain("bank")
    const recallError = await callError(recall, { banks: ["b"], query: 42 })
    expect(recallError.cause).toBe("invalid_input")
    expect(recallError.message).toContain("query")
  })

  it("escalates a store failure as a typed call error", async () => {
    const failing = await Effect.runPromise(
      MemoryEntries.make(policy).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(
              (await import("@smthrs/memory/MemoryStore")).MemoryStore
            )(
              (await import("@smthrs/memory/MemoryStore")).makeNoop()
            ),
            Layer.succeed(
              (await import("@smthrs/memory/Recall")).Recall
            )(
              (await import("@smthrs/memory/Recall")).makeNoop()
            )
          )
        )
      )
    )
    const remember = failing[0] as Catalog.Entry
    const error = await callError(remember, { bank: "b", key: "k", text: "t" })
    expect(error.message).toContain(`"${Flows.rememberName}" failed [store]:`)
    expect(error.cause).toBe("store")
  })

  it("pins a contract digest that re-keys when the contract changes", async () => {
    const entries = await entriesOf()
    const remember = entries[0] as Catalog.Entry
    expect(remember.digest).toBe(
      MemoryEntries.contractDigest({
        description: Flows.rememberDescription,
        effects: { ...Flows.rememberEffects },
        input: Flows.RememberInput,
        name: Flows.rememberName,
        output: Flows.RememberOutput
      })
    )
    const changed = MemoryEntries.contractDigest({
      description: Flows.rememberDescription,
      effects: { ...Flows.rememberEffects },
      input: Flows.RecallInput,
      name: Flows.rememberName,
      output: Flows.RememberOutput
    })
    expect(remember.digest).not.toBe(changed)
  })

  it("digests field types as well as field names", async () => {
    const Schema = (await import("effect")).Schema
    const text = MemoryEntries.contractDigest({
      description: "d",
      effects: {},
      input: Schema.Struct({ value: Schema.String }),
      name: "n",
      output: Schema.String
    })
    const object = MemoryEntries.contractDigest({
      description: "d",
      effects: {},
      input: Schema.Struct({ value: Schema.Struct({ text: Schema.String }) }),
      name: "n",
      output: Schema.String
    })
    expect(text).not.toBe(object)
  })

  it("digests scalar schemas and marks codeless failures unknown", async () => {
    const Schema = (await import("effect")).Schema
    const scalar = MemoryEntries.contractDigest({
      description: "d",
      effects: {},
      input: Schema.String,
      name: "n",
      output: Schema.String
    })
    expect(scalar).toMatch(/^[0-9a-f]{64}$/)

    const codeless = await Effect.runPromise(
      MemoryEntries.make(policy).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(
              (await import("@smthrs/memory/MemoryStore")).MemoryStore
            )(
              (await import("@smthrs/memory/MemoryStore")).makeNoop({
                putFact: () => Effect.fail({ message: "wire fell over" } as never)
              })
            ),
            Layer.succeed(
              (await import("@smthrs/memory/Recall")).Recall
            )(
              (await import("@smthrs/memory/Recall")).makeNoop()
            )
          )
        )
      )
    )
    const remember = codeless[0] as Catalog.Entry
    const error = await callError(remember, { bank: "b", key: "k", text: "t" })
    expect(error.cause).toBe("unknown")

    const oddFailures = await Effect.runPromise(
      MemoryEntries.make(policy).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(
              (await import("@smthrs/memory/MemoryStore")).MemoryStore
            )(
              (await import("@smthrs/memory/MemoryStore")).makeNoop({
                putFact: () => Effect.fail({ code: 42 } as never)
              })
            ),
            Layer.succeed(
              (await import("@smthrs/memory/Recall")).Recall
            )(
              (await import("@smthrs/memory/Recall")).Recall.of({
                recall: () => Effect.fail("snap" as never)
              })
            )
          )
        )
      )
    )
    const nonStringCode = await callError(oddFailures[0] as Catalog.Entry, { bank: "b", key: "k", text: "t" })
    expect(nonStringCode.cause).toBe("unknown")
    const bareString = await callError(oddFailures[1] as Catalog.Entry, { banks: ["b"], query: "q" })
    expect(bareString.cause).toBe("unknown")
    expect(bareString.message).toContain("snap")
  })

  it("refuses output that leaves the shipped contract", async () => {
    const broken = await Effect.runPromise(
      MemoryEntries.make(policy).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(
              (await import("@smthrs/memory/MemoryStore")).MemoryStore
            )(
              (await import("@smthrs/memory/MemoryStore")).makeNoop({
                putFact: () => Effect.succeed(undefined)
              })
            ),
            Layer.succeed(
              (await import("@smthrs/memory/Recall")).Recall
            )(
              (await import("@smthrs/memory/Recall")).Recall.of({
                recall: () => Effect.succeed({ rows: "not the contract" } as never)
              })
            )
          )
        )
      )
    )
    const recall = broken[1] as Catalog.Entry
    const error = await callError(recall, { banks: ["b"], query: "q" })
    expect(error.cause).toBe("invalid_output")
    expect(error.message).toContain("outside its contract")
  })

  it("composes the system entries into the standalone layer", async () => {
    const catalog = await Effect.runPromise(
      Effect.flatMap(
        (await import("../src/Catalog.ts")).Catalog,
        (service) => Effect.succeed(service.entries.map((entry) => entry.name))
      ).pipe(
        Effect.provide(MemoryEntries.layer(policy).pipe(Layer.provide(services)))
      )
    )
    // The system entries come last so a host entry cannot shadow them.
    expect(catalog).toEqual(["remember", "recall", "sys/now", "sys/random"])
  })

  it("lets a chain script remember and recall through the one door", async () => {
    const script = flow(
      `await ctx.call("remember", { bank: "worldview", key: "note", text: "the registry mounts flows" })`,
      `const found = await ctx.call("recall", { banks: ["worldview"], query: "registry" })`,
      `return done(found)`
    )
    const { entries, outcome } = await runOn(
      services,
      Effect.gen(function*() {
        const built = yield* MemoryEntries.make(policy)
        const run = yield* Effect.promise(() => runChain({ author: Author.layerMock([script]), entries: built }))
        return { entries: built, ...run }
      })
    )
    expect(entries).toHaveLength(2)
    expect(JSON.stringify(outcome)).toContain("the registry mounts flows")
  })

  // A script is model-authored: the bank in its payload is not authority.
  it("refuses a bank outside the host policy for remember and recall", async () => {
    const [remember, recall] = await entriesOf() as [Catalog.Entry, Catalog.Entry]
    const written = await callError(remember, { bank: "other-user", key: "k", text: "poison" })
    expect(written.cause).toBe("invalid_namespace")
    const read = await callError(recall, { banks: ["worldview", "other-user"], query: "q" })
    expect(read.cause).toBe("invalid_namespace")
  })

  it("records the chain, link, and call that wrote a fact", async () => {
    const fact = await Effect.runPromise(
      Effect.gen(function*() {
        const [remember] = yield* MemoryEntries.make(policy)
        yield* remember!.handler(
          { bank: "worldview", key: "traced", text: "t" },
          { chain: "chain-1", key: "key" as never, link: 2, ordinal: 3 }
        )
        const store = yield* MemoryStore.MemoryStore
        const facts = yield* store.listAllFacts
        return facts.find((row) => row.key === "traced")
      }).pipe(Effect.provide(services))
    )
    expect(fact?.provenance).toEqual({ iteration: 3, nodeId: "link-2", runId: "chain-1" })
  })

  it("fails typed on an invalid policy", async () => {
    const error = await Effect.runPromise(
      Effect.flip(MemoryEntries.make({ ...policy, banks: [] })).pipe(
        Effect.provide(services)
      )
    )
    expect(error.code).toBe("invalid_argument")
  })
})
