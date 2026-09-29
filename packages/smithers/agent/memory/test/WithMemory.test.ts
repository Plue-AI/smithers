import * as Annotations from "@smthrs/core/Annotations"
import * as Flow from "@smthrs/core/Flow"
import * as Graph from "@smthrs/core/Graph"
import * as Node from "@smthrs/core/Node"
import * as Placement from "@smthrs/core/Placement"
import * as Trellis from "@smthrs/patterns/Trellis"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Flows from "../src/Flows.ts"
import { MemoryError } from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as MemoryTrellis from "../src/MemoryTrellis.ts"
import * as Recall from "../src/Recall.ts"
import * as RecallKeyword from "../src/RecallKeyword.ts"
import * as TestMemory from "../src/test/TestMemory.ts"
import * as WithMemory from "../src/WithMemory.ts"

const policy: WithMemory.Policy = {
  banks: ["flow-trellis"],
  maxTokens: 2048
}

const passthrough = (name: string) =>
  Flow.make({
    name,
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: (input) => Node.succeed(input)
  })

const author = passthrough("author")
const leaf = passthrough("leaf")
const envelope: Trellis.Envelope = { fuel: 2, depth: 2, fanout: 2 }

// A trellis is one `@smthrs/flow` declaration whose payload is the `{ input }`
// struct every flow payload is, so the prompt is entered as a field.
const planned = (flow: Trellis.TrellisFlow<unknown>): ReadonlyArray<string> =>
  Graph.nodes(Graph.build(flow, { input: "ship it" })).map((node) => `${node.kind}:${node.id}`)

const annotation = <I, S>(flow: Flow.Any, key: Parameters<typeof Annotations.getOption<I, S>>[1]): S | undefined =>
  Option.getOrUndefined(
    Annotations.getOption((flow as unknown as { readonly annotations: never }).annotations, key)
  )

const remembered = (bank: string, key: string, text: string) =>
  Effect.flatMap(MemoryStore.MemoryStore, (store) =>
    store.putFact({
      namespace: Recall.namespaceForBank(bank),
      key,
      value: { content: text, tags: [] },
      provenance: {}
    }))

describe("WithMemory", () => {
  it("shares declared banks and refuses a mixed private-bank request before IO", async () => {
    const shared = { ...policy, banks: ["global-team", "project-demo"] }
    let reads = 0
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const remember = Flows.handlersFor(WithMemory.withMemory(Flows.remember, shared)).remember
        yield* remember({ bank: "global-team", key: "team", text: "shared fact" })
        yield* remember({ bank: "project-demo", key: "project", text: "project fact" })
        const recall = Flows.handlersFor(WithMemory.withMemory(Flows.recall, shared)).recall
        const failure = yield* Effect.flip(recall({ banks: ["global-team", "user-will"], query: "fact" }))
        const rows = yield* recall({ banks: [], query: "fact" })
        return { failure, rows }
      }).pipe(
        Effect.provideService(Recall.Recall, {
          recall: (input) =>
            Effect.sync(() => {
              reads++
              return input.banks.map((bank) => ({ bank, key: bank, text: "fact", score: 1 }))
            })
        }),
        Effect.provide(TestMemory.layer)
      )
    )
    expect(result.failure.code).toBe("invalid_namespace")
    expect(reads).toBe(1)
    expect(result.rows.map((row) => row.bank)).toEqual(shared.banks)
  })

  it("rejects an invalid namespace and out-of-range budget at annotation time", () => {
    for (
      const invalid of [
        { ...policy, banks: [""] },
        { ...policy, maxTokens: -1 },
        { ...policy, maxTokens: Recall.MAX_RECALL_TOKENS + 1 }
      ]
    ) {
      expect(() => WithMemory.withMemory(Flows.recall, invalid)).toThrow(MemoryError)
    }
  })

  // `retain` names only the behavior that exists: absent stores each write
  // when it is made, `"never"` drops it. A retired lifecycle spelling that
  // promised to hold writes until completion is refused, not silently honored.
  it("refuses the retired on-complete retain spelling with a typed invalid_argument", () => {
    const retired = { ...policy, retain: "on-complete" } as unknown as WithMemory.Policy
    let thrown: unknown
    try {
      WithMemory.withMemory(Flows.remember, retired)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MemoryError)
    expect((thrown as MemoryError).code).toBe("invalid_argument")
    expect(WithMemory.policyOf(WithMemory.withMemory(Flows.remember, policy))).not.toHaveProperty("retain")
  })

  it("detaches and deep-freezes policy refusals before handlers run", async () => {
    const original = {
      banks: ["flow-frozen"],
      recall: "none" as const,
      maxTokens: 128,
      retain: "never" as const
    }
    const scopedRecall = WithMemory.withMemory(Flows.recall, original)
    const scopedRemember = WithMemory.withMemory(Flows.remember, original)
    const attached = WithMemory.policyOf(scopedRecall)!

    original.banks[0] = "mutated"
    delete (original as { recall?: "none" }).recall
    delete (original as { retain?: "never" }).retain
    expect(Reflect.deleteProperty(attached as object, "recall")).toBe(false)
    expect(Reflect.set(attached.banks as object, "0", "mutated-again")).toBe(false)

    const result = await Effect.runPromise(
      Effect.sync(() => {
        Reflect.deleteProperty(attached as object, "retain")
      }).pipe(
        Effect.andThen(Effect.all({
          recalled: Flows.runRecallFor(scopedRecall, { banks: ["bank"], query: "q" }),
          remembered: Flows.runRememberFor(scopedRemember, { bank: "bank", key: "key", text: "text" })
        })),
        Effect.provideService(Recall.Recall, Recall.makeNoop()),
        Effect.provideService(MemoryStore.MemoryStore, MemoryStore.makeNoop())
      )
    )
    expect(Object.isFrozen(attached)).toBe(true)
    expect(Object.isFrozen(attached.banks)).toBe(true)
    expect(attached.banks).toEqual(["flow-frozen"])
    expect(result).toEqual({ recalled: [], remembered: { key: "key" } })
  })

  it("annotates the flow and every flow it declares", () => {
    const nested = [passthrough("first"), passthrough("second")]
    const parent = Flow.make({
      name: "parent",
      input: Schema.Unknown,
      output: Schema.Unknown,
      // "by-name" is an unresolved registry reference, which a policy carries
      // through untouched because there is no flow yet to annotate.
      flows: [...nested, "by-name"]
    })

    const scoped = WithMemory.withMemory(parent, policy)

    expect(WithMemory.policyOf(scoped)).toEqual(policy)
    expect(WithMemory.children(scoped)).toHaveLength(2)
    expect(WithMemory.children(scoped).map((child) => WithMemory.policyOf(child))).toEqual([policy, policy])
    expect(WithMemory.references(scoped)).toHaveLength(3)
    expect(WithMemory.references(scoped)[2]).toBe("by-name")
    // The original declaration is untouched: a policy is a fresh flow, not a mutation.
    expect(WithMemory.policyOf(parent)).toBeUndefined()
    expect(WithMemory.children(parent).map((child) => WithMemory.policyOf(child))).toEqual([undefined, undefined])
    // A flow with a body reaches its collaborators by calling them, not from a list.
    expect(WithMemory.children(WithMemory.withMemory(passthrough("body"), policy))).toEqual([])
  })

  it("keeps the annotations the tree already carried", () => {
    const child = Flow.make({
      name: "child",
      input: Schema.Unknown,
      output: Schema.Unknown,
      model: "smart",
      flows: [Flows.recall]
    }).pipe(Flow.within(Placement.local()))
    const parent = Flow.make({
      name: "parent",
      input: Schema.Unknown,
      output: Schema.Unknown,
      model: "smart",
      flows: [child]
    }).pipe(Flow.within(Placement.local()), Flow.annotate(Annotations.Priority, 7))

    const scoped = WithMemory.withMemory(parent, policy)
    const scopedChild = WithMemory.children(scoped)[0] as Flow.Any

    expect(annotation(scoped, Annotations.Placement)).toEqual(Placement.local())
    expect(annotation(scoped, Annotations.Priority)).toEqual(7)
    expect(annotation(scopedChild, Annotations.Placement)).toEqual(Placement.local())
    expect(WithMemory.policyOf(scoped)).toEqual(policy)
    expect(WithMemory.policyOf(scopedChild)).toEqual(policy)
  })

  it("keeps the schema types the declaration carried, so a host can bind the copy", () => {
    // A host binds a declaration through `FlowBinding.make`, which reads
    // `flow.input` and `flow.output` as schemas and types the handler from
    // them. A copy that answers `Flow.Any` has no schema types left to read, so
    // the binding call stops compiling. The annotation below is that
    // requirement, checked by `tsc` rather than at run time.
    const scoped: Flow.Flow<typeof Flows.RecallInput, typeof Flows.RecallOutput, never> = WithMemory.withMemory(
      Flows.recall,
      policy
    )
    // The existential stays available for the flows a pattern passes around,
    // which is what `MemoryTrellis.parts` and `Trellis.MakeOptions` carry.
    const erased: Flow.Any = WithMemory.withMemory(Flows.recall as Flow.Any, policy)

    expect(scoped.input).toBe(Flows.RecallInput)
    expect(scoped.output).toBe(Flows.RecallOutput)
    expect(WithMemory.policyOf(scoped)).toEqual(policy)
    expect(WithMemory.policyOf(erased)).toEqual(policy)
  })

  it("builds the Trellis graph unchanged and carries the policy on top of it", () => {
    const plain = Trellis.make({ author, leaf, envelope })
    const scoped = MemoryTrellis.make({ author, leaf, envelope, memory: policy })

    // Node for node, the same graph: an annotation is metadata, not identity.
    // The count is stated so the equality above cannot pass on two empty plans.
    expect(planned(plain)).toHaveLength(9)
    expect(planned(scoped)).toEqual(planned(plain))
    expect(WithMemory.policyOf(scoped)).toEqual(policy)
    expect(WithMemory.policyOf(plain)).toBeUndefined()
    // A composed flow declares no collaborator list; the flows it calls were
    // scoped by `parts` before `Trellis.make` composed them.
    expect(WithMemory.references(scoped)).toEqual([])
    expect(WithMemory.children(scoped)).toEqual([])
  })

  it("carries the caller's name and description onto the trellis it declares", () => {
    const named = MemoryTrellis.make({
      name: "release-notes",
      description: "Delegates release notes under one memory policy.",
      author,
      leaf,
      envelope,
      memory: policy
    })

    expect(named._tag).toBe("release-notes")
    expect(named.description).toBe("Delegates release notes under one memory policy.")
    expect(WithMemory.policyOf(named)).toEqual(policy)
  })

  it("hands the policy to the leaf the trellis calls and to the memory flows that leaf declares", () => {
    const agent = Flow.make({
      name: "leaf-agent",
      input: Schema.Unknown,
      output: Schema.Unknown,
      model: "smart",
      flows: [Flows.recall, Flows.remember]
    })
    const scoped = MemoryTrellis.parts({ author, leaf: agent, envelope, memory: policy })

    expect(WithMemory.policyOf(scoped.leaf)).toEqual(policy)
    expect(WithMemory.policyOf(scoped.author)).toEqual(policy)
    expect(WithMemory.children(scoped.leaf).map((child) => WithMemory.policyOf(child))).toEqual([policy, policy])
    // The trellis calls the scoped leaf, so what the plan generates inherits it.
    expect(MemoryTrellis.make({ author, leaf: agent, envelope, memory: policy })).not.toBe(agent)
    expect(WithMemory.policyOf(agent)).toBeUndefined()
  })

  it("resolves a delegated leaf's recall to the trellis namespace over the real store", async () => {
    const agent = Flow.make({
      name: "leaf-agent",
      input: Schema.Unknown,
      output: Schema.Unknown,
      model: "smart",
      flows: [Flows.recall]
    })
    const rows = await Effect.runPromise(
      Effect.gen(function*() {
        yield* remembered("flow-trellis", "ledger", "durable ledger rows")
        yield* remembered("flow-elsewhere", "other", "durable elsewhere rows")
        const scoped = MemoryTrellis.parts({ author, leaf: agent, envelope, memory: policy })
        const recall = WithMemory.children(scoped.leaf)[0] as Flow.Any
        return yield* Flows.runRecallFor(recall, { banks: [], query: "durable" })
      }).pipe(
        Effect.provide(RecallKeyword.layer),
        Effect.provide(TestMemory.layer)
      )
    )

    expect(rows.map((row) => row.key)).toEqual(["ledger"])
  })

  it("reaches the trellis namespace through the handler a host binds", async () => {
    const agent = Flow.make({
      name: "leaf-agent",
      input: Schema.Unknown,
      output: Schema.Unknown,
      model: "smart",
      flows: [Flows.recall, Flows.remember]
    })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* remembered("flow-trellis", "ledger", "durable ledger rows")
        yield* remembered("flow-elsewhere", "other", "durable elsewhere rows")
        const scoped = MemoryTrellis.parts({ author, leaf: agent, envelope, memory: policy })
        // The declarations a host binds are the ones the leaf hands the model.
        const [boundRecall, boundRemember] = WithMemory.children(scoped.leaf) as ReadonlyArray<Flow.Any>
        const rows = yield* Flows.handlersFor(boundRecall as Flow.Any).recall({ banks: [], query: "durable" })
        yield* Flows.handlersFor(boundRemember as Flow.Any).remember({
          bank: "",
          key: "written",
          text: "written through the bound handler"
        })
        const store = yield* MemoryStore.MemoryStore
        return {
          rows,
          written: yield* store.getFact({ namespace: Recall.namespaceForBank(policy.banks[0]!), key: "written" })
        }
      }).pipe(
        Effect.provide(RecallKeyword.layer),
        Effect.provide(TestMemory.layer)
      )
    )

    expect(result.rows.map((row) => row.key)).toEqual(["ledger"])
    expect(result.written?.value).toEqual({ content: "written through the bound handler" })
    expect(result.written?.tags).toEqual([])
  })

  it("refuses recall through the bound handler when the policy says none", async () => {
    const rows = await Effect.runPromise(
      Flows.handlersFor(WithMemory.withMemory(Flows.recall, { ...policy, recall: "none" }))
        .recall({ banks: ["flow-trellis"], query: "durable" })
        .pipe(
          Effect.provide(Recall.layer({ recall: () => Effect.die("recall must not be called under recall: none") }))
        )
    )

    expect(rows).toEqual([])
  })

  it("recalls from the annotated namespace when the caller names no bank", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* remembered("flow-trellis", "ledger", "durable ledger rows")
        yield* remembered("flow-elsewhere", "other", "durable elsewhere rows")
        const scoped = yield* Flows.runRecallFor(
          WithMemory.withMemory(Flows.recall, policy),
          { banks: [], query: "durable" }
        )
        const unscoped = yield* Effect.flip(Flows.runRecallFor(Flows.recall, { banks: [], query: "durable" }))
        const explicit = yield* Effect.flip(Flows.runRecallFor(
          WithMemory.withMemory(Flows.recall, policy),
          { banks: ["flow-elsewhere"], query: "durable" }
        ))
        return { scoped, unscoped, explicit }
      }).pipe(
        Effect.provide(RecallKeyword.layer),
        Effect.provide(TestMemory.layer)
      )
    )

    expect(result.scoped.map((row) => row.key)).toEqual(["ledger"])
    expect(result.unscoped.code).toBe("invalid_namespace")
    expect(result.explicit).toBeInstanceOf(MemoryError)
    expect(result.explicit.code).toBe("invalid_namespace")
  })

  it("rejects foreign recall banks before calling the selected service", async () => {
    const scoped = WithMemory.withMemory(Flows.recall, policy)
    for (const banks of [["user-other"], ["flow-trellis", "user-other"], ["agent-trellis"], ["elsewhere"]]) {
      const error = await Effect.runPromise(
        Effect.flip(Flows.handlersFor(scoped).recall({ banks, query: "durable" })).pipe(
          Effect.provide(Recall.layer({ recall: () => Effect.die("foreign banks must not reach recall") }))
        )
      )
      expect(error).toBeInstanceOf(MemoryError)
      expect(error.code).toBe("invalid_namespace")
    }
  })

  it("rejects a foreign remember before overwriting its existing fact", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* remembered("user-other", "private", "original")
        const error = yield* Effect.flip(
          Flows.handlersFor(WithMemory.withMemory(Flows.remember, policy))
            .remember({ bank: "user-other", key: "private", text: "overwritten" })
        )
        const store = yield* MemoryStore.MemoryStore
        return { error, fact: yield* store.getFact({ namespace: "user-other", key: "private" }) }
      }).pipe(Effect.provide(TestMemory.layer))
    )
    expect(result.error).toBeInstanceOf(MemoryError)
    expect(result.error.code).toBe("invalid_namespace")
    expect(result.fact?.value).toEqual({ content: "original", tags: [] })
  })

  it.each(["flow", "agent", "user", "global"] as const)(
    "rejects foreign reads and overwrites under a %s policy over the real store",
    async (kind) => {
      const scopedPolicy = { ...policy, banks: [`${kind}-trellis`] }
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          yield* remembered("user-other", "private", "durable private text")
          const recallError = yield* Effect.flip(
            Flows.handlersFor(WithMemory.withMemory(Flows.recall, scopedPolicy))
              .recall({ banks: ["user-other"], query: "durable" })
          )
          const remember = Flows.handlersFor(WithMemory.withMemory(Flows.remember, scopedPolicy)).remember
          const writeErrors = yield* Effect.forEach(
            ["user-other", "flow-elsewhere", "agent-trellis"].filter(
              (bank) => bank !== scopedPolicy.banks[0]
            ),
            (bank) => Effect.flip(remember({ bank, key: "private", text: "overwritten" }))
          )
          const store = yield* MemoryStore.MemoryStore
          return { recallError, writeErrors, facts: yield* store.listAllFacts }
        }).pipe(Effect.provide(RecallKeyword.layer), Effect.provide(TestMemory.layer))
      )
      for (const error of [result.recallError, ...result.writeErrors]) {
        expect(error).toBeInstanceOf(MemoryError)
        expect(error.code).toBe("invalid_namespace")
      }
      expect(result.facts).toHaveLength(1)
      expect(result.facts[0]?.namespace).toEqual({ kind: "user", id: "other" })
      expect(result.facts[0]?.value).toEqual({ content: "durable private text", tags: [] })
    }
  )

  it.each(["flow", "agent", "user", "global"] as const)(
    "accepts explicit banks resolving to the %s policy namespace",
    async (kind) => {
      const scopedPolicy = { ...policy, banks: [`${kind}-trellis`] }
      const banks = kind === "flow" ? ["trellis", "flow-trellis"] : [`${kind}-trellis`]
      const rows = await Effect.runPromise(
        Effect.gen(function*() {
          for (const bank of banks) {
            yield* Flows.runRememberFor(WithMemory.withMemory(Flows.remember, scopedPolicy), {
              bank,
              key: "allowed",
              text: "durable allowed text"
            })
          }
          return yield* Flows.runRecallFor(WithMemory.withMemory(Flows.recall, scopedPolicy), {
            banks,
            query: "durable"
          })
        }).pipe(Effect.provide(RecallKeyword.layer), Effect.provide(TestMemory.layer))
      )
      expect(rows.map((row) => row.key)).toEqual(["allowed"])
    }
  )

  it("returns no rows and never asks the recall service when the policy says none", async () => {
    const rows = await Effect.runPromise(
      Flows.runRecallFor(
        WithMemory.withMemory(Flows.recall, { ...policy, recall: "none" }),
        { banks: ["flow-trellis"], query: "durable" }
      ).pipe(
        Effect.provide(Recall.layer({ recall: () => Effect.die("recall must not be called under recall: none") }))
      )
    )

    expect(rows).toEqual([])
  })

  it("caps recall with the policy budget until the caller asks for its own", async () => {
    const seen: Array<number | undefined> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const scoped = WithMemory.withMemory(Flows.recall, { ...policy, maxTokens: 64 })
        yield* Flows.runRecallFor(scoped, { banks: ["flow-trellis"], query: "durable" })
        yield* Flows.runRecallFor(scoped, { banks: ["flow-trellis"], query: "durable", maxTokens: 9 })
      }).pipe(
        Effect.provide(Recall.layer({
          recall: (input) => Effect.sync(() => (seen.push(input.maxTokens), []))
        }))
      )
    )

    expect(seen).toEqual([64, 9])
  })

  it("writes into the annotated namespace and writes nothing at all when retain is never", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const kept = yield* Flows.runRememberFor(
          WithMemory.withMemory(Flows.remember, policy),
          { bank: "", key: "kept", text: "policy namespace" }
        )
        const dropped = yield* Flows.runRememberFor(
          WithMemory.withMemory(Flows.remember, { ...policy, retain: "never" }),
          { bank: "flow-trellis", key: "dropped", text: "never retained" }
        )
        return {
          kept,
          dropped,
          keptFact: yield* store.getFact({ namespace: Recall.namespaceForBank(policy.banks[0]!), key: "kept" }),
          droppedFact: yield* store.getFact({ namespace: Recall.namespaceForBank(policy.banks[0]!), key: "dropped" })
        }
      }).pipe(Effect.provide(TestMemory.layer))
    )

    expect(result.kept).toEqual({ key: "kept" })
    expect(result.dropped).toEqual({ key: "dropped" })
    expect(result.keptFact?.value).toEqual({ content: "policy namespace" })
    expect(result.keptFact?.tags).toEqual([])
    expect(result.droppedFact).toBeUndefined()
  })
})
