import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import type { QuickJSWASMModule } from "quickjs-emscripten-core"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as Catalog from "../src/Catalog.ts"
import * as Chain from "../src/Chain.ts"
import type * as Event from "../src/Event.ts"
import * as Journal from "../src/Journal.ts"
import * as Observation from "../src/Observation.ts"
import type * as Outcome from "../src/Outcome.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import * as Steering from "../src/Steering.ts"
import * as SubChains from "../src/SubChains.ts"
import { countingEntry, failChain, failingEntry, flow, runChain } from "./harness.ts"

const grepResult = { files: ["a.ts", "b.ts", "c.ts", "d.ts"] }

const l1 = [
  "Plan: search, compute on the hits, hand off.",
  flow(
    `const hits = await ctx.call("grep", { pattern: "TODO" })`,
    `const top = hits.files.slice(0, 3)`,
    `const s = await ctx.call("author", { context: [top.join("\\n")] })`,
    `return to(s)`
  )
].join("\n")

const l2 = flow(`await ctx.call("edit", { file: "a.ts" })`, `return done({ patched: true })`)

const doneScript = flow(`return done("recovered")`)

const goldenTags = [
  "ChainStarted",
  "CallSettled",
  "LinkAuthored",
  "LinkEnded",
  "CallSettled",
  "CallSettled",
  "LinkAuthored",
  "LinkEnded",
  "CallSettled",
  "LinkEnded"
]

const goldenRun = async () => {
  const grep = countingEntry("grep", grepResult)
  const edit = countingEntry("edit", { ok: true })
  const result = await runChain({
    author: Author.layerMock([l1, l2]),
    entries: [grep.entry, edit.entry]
  })
  return { edit, grep, ...result }
}

describe("Chain", () => {
  it.each(["1.0", "12.34", "root/child", "root/", "/root"])(
    "refuses reserved root scope %s before reading the journal",
    async (chain) => {
      const error = await Effect.runPromise(
        Effect.flip(Chain.run({ chain, goal: "root" })).pipe(
          Effect.provide(Layer.mergeAll(
            Journal.layerNoop(),
            Catalog.layer([]),
            Author.layerMock([]),
            ScriptRunner.layerInProcess
          ))
        )
      )
      expect(error).toMatchObject({ _tag: "/chain/ChainError", code: "invalid_journal" })
    }
  )

  it.each(["", "root-a", "1", "1.0a"])("drains steering for root scope %s", async (chain) => {
    const boundaries: Array<string> = []
    const seen: Array<Author.Input> = []
    const { events, outcome } = await runChain({
      chain,
      author: Author.layerFn((input) => {
        seen.push(input)
        return doneScript
      }),
      steering: Steering.layerNoop({
        drain: (boundary) =>
          Effect.sync(() => {
            boundaries.push(boundary)
            return ["stop now"]
          })
      })
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(seen[0]?.context).toContain("[steering] stop now")
    expect(boundaries).toEqual([chain === "" ? "0/0" : `${chain}/0/0`])
    expect(events.find((event) => event._tag === "SteeringDrained")?.chain ?? "").toBe(chain)
  })

  it.each(["success", "refusal", "journal-failure"])(
    "signals a settling entry and awaits its durable receipt before interruption returns (%s)",
    async (outcome) => {
      let entered!: () => void
      const entryStarted = new Promise<void>((resolve) => {
        entered = resolve
      })
      let receiptStarted!: () => void
      const receipt = new Promise<void>((resolve) => {
        receiptStarted = resolve
      })
      let release!: () => void
      const persistence = new Promise<void>((resolve) => {
        release = resolve
      })
      const events: Array<Event.Event> = []
      let calls = 0
      let aborted = false
      let key: Catalog.CallSlot["key"]
      const entry: Catalog.Entry = {
        name: "write",
        description: "controlled write",
        settleOnInterrupt: true,
        handler: (_, slot) =>
          Effect.promise(async () => {
            calls++
            key = slot?.key
            entered()
            await new Promise<void>((resolve) =>
              slot!.signal!.addEventListener("abort", () => {
                aborted = true
                resolve()
              }, { once: true })
            )
            return { written: true }
          }).pipe(Effect.flatMap((value) =>
            outcome === "refusal"
              ? Effect.fail(new Catalog.CallError({ name: "write", message: "cancelled" }))
              : Effect.succeed(value)
          ))
      }
      const journal = Journal.make({
        read: Effect.sync(() => [...events]),
        append: (event) =>
          Effect.tryPromise({
            try: async () => {
              if ((event._tag === "CallSettled" && event.name === "write") || event._tag === "GateRejected") {
                receiptStarted()
                await persistence
                if (outcome === "journal-failure") throw new Error("receipt failed")
              }
              events.push(event)
            },
            catch: () => new Journal.JournalError({ message: "receipt failed" })
          })
      })
      const layers = Layer.mergeAll(
        Layer.succeed(Journal.Journal)(journal),
        Author.layerMock([flow(`await ctx.call("write", {})`, `return done("ok")`)]),
        ScriptRunner.layerInProcess,
        Catalog.layer([entry])
      )
      const program = Chain.run({ goal: "write once" }).pipe(Effect.provide(layers))
      const fiber = Effect.runFork(program)
      try {
        await entryStarted
        let stopped = false
        const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
          stopped = true
        })
        await receipt
        expect(aborted).toBe(true)
        expect(stopped).toBe(false)
        expect(events.some((event) => event._tag === "CallSettled" && event.name === "write")).toBe(false)
        release()
        await stopping
        const settled = events.find((event) => event._tag === "CallSettled" && event.name === "write")
        if (outcome === "success") {
          expect(settled).toMatchObject({ key, result: { written: true } })
          expect(await Effect.runPromise(program)).toEqual({ _tag: "Done", value: "ok" })
        } else if (outcome === "refusal") {
          expect(events.some((event) => event._tag === "GateRejected")).toBe(true)
        } else {
          const exit = await Effect.runPromise(Fiber.await(fiber))
          expect(exit._tag).toBe("Failure")
          expect(String(exit)).toContain("receipt failed")
          expect(settled).toBeUndefined()
        }
        expect(calls).toBe(1)
      } finally {
        release()
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    }
  )

  it("runs a two-link chain to done with the golden journal", async () => {
    const { edit, events, grep, outcome } = await goldenRun()
    expect(outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(events.map((event) => event._tag)).toEqual(goldenTags)
    expect(grep.count()).toBe(1)
    expect(edit.count()).toBe(1)

    const bootstrapCall = events[1] as Event.CallSettled
    expect(bootstrapCall.name).toBe("author")
    expect(bootstrapCall.key).toEqual({
      entryDigest: Chain.authorDigest,
      link: 0,
      ordinal: 0,
      scriptDigest: ""
    })
    expect(bootstrapCall.payload).toEqual({ context: ["fix TODOs"] })

    const l1Script = (events[2] as Event.LinkAuthored).script
    const grepCall = events[4] as Event.CallSettled
    expect(grepCall.name).toBe("grep")
    expect(grepCall.key.link).toBe(1)
    expect(grepCall.key.ordinal).toBe(0)
    expect(grepCall.key.scriptDigest).toBe(l1Script.digest)

    // The script computed on real values: its author call carries them.
    const handoffCall = events[5] as Event.CallSettled
    expect(handoffCall.name).toBe("author")
    expect(handoffCall.key.ordinal).toBe(1)
    expect(handoffCall.payload).toEqual({ context: ["a.ts\nb.ts\nc.ts"] })

    const ended = events[9] as Event.LinkEnded
    expect(ended.link).toBe(2)
    expect(ended.outcome._tag).toBe("Done")
  })

  it("replays a finished chain with zero model calls and zero effects", async () => {
    const { events } = await goldenRun()
    const grep = countingEntry("grep", grepResult)
    const edit = countingEntry("edit", { ok: true })
    const replay = await runChain({
      author: Author.layerMock([]),
      entries: [grep.entry, edit.entry],
      initial: events,
      runner: ScriptRunner.layerNoop()
    })
    expect(replay.outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(replay.events).toEqual(events)
    expect(grep.count()).toBe(0)
    expect(edit.count()).toBe(0)
  })

  it.each([
    ["goal", { goal: "a different goal" }],
    ["envelope", { envelope: { workspace: "different" } }]
  ])("refuses to resume a finished chain under a different %s", async (_label, changed) => {
    const { events } = await goldenRun()
    const error = await failChain({
      author: Author.layerMock([]),
      initial: events,
      runner: ScriptRunner.layerNoop(),
      ...changed
    }) as Chain.ChainError
    expect(error.code).toBe("replay_divergence")
    expect(error.message).toContain("different goal or envelope")
  })

  it("resumes a crash after the first settled call without re-running it", async () => {
    const { events } = await goldenRun()
    const grep = countingEntry("grep", grepResult)
    const edit = countingEntry("edit", { ok: true })
    const resumed = await runChain({
      author: Author.layerMock([l2]),
      entries: [grep.entry, edit.entry],
      initial: events.slice(0, 5)
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(grep.count()).toBe(0)
    expect(edit.count()).toBe(1)
    expect(resumed.events).toEqual(events)
  })

  it("resumes a crash between LinkAuthored and LinkEnded without duplicating either", async () => {
    const { events } = await goldenRun()
    const grep = countingEntry("grep", grepResult)
    const edit = countingEntry("edit", { ok: true })
    const resumed = await runChain({
      author: Author.layerMock([]),
      entries: [grep.entry, edit.entry],
      initial: events.slice(0, 7)
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(grep.count()).toBe(0)
    expect(edit.count()).toBe(1)
    expect(resumed.events).toEqual(events)
  })

  it("journals a catalog rejection and shows it to the recovery author", async () => {
    const seen: Array<Author.Input> = []
    const bad = flow(`await ctx.call("missing", {})`, `return done(null)`)
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? bad : doneScript
    })
    const { events, outcome } = await runChain({ author })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })

    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.link).toBe(1)
    expect(rejection.ordinal).toBe(0)
    expect(rejection.observation.kind).toBe("catalog")

    expect(seen).toHaveLength(2)
    const recovery = seen[1] as Author.Input
    expect(recovery.context[0]).toBe("fix TODOs")
    expect(recovery.context.some((line) => line.startsWith("[catalog]"))).toBe(true)

    const recoveryCall = events.filter((event) =>
      event._tag === "CallSettled" && event.link === 1
    )[0] as Event.CallSettled
    expect(recoveryCall.key.ordinal).toBe(1)
    expect(recoveryCall.key.scriptDigest).toBe("")
  })

  it("retries authoring when the output has no flow block", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? "no fence in sight" : doneScript
    })
    const { events, outcome } = await runChain({ author })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })

    const rejection = events[1] as Event.GateRejected
    expect(rejection._tag).toBe("GateRejected")
    expect(rejection.observation.kind).toBe("shape")
    const marker = events[2] as Event.CallSettled
    expect(marker._tag).toBe("CallSettled")
    expect(marker.result).toEqual({ raw: "no fence in sight", rejected: true })

    const retry = seen[1] as Author.Input
    expect(retry.context.some((line) => line.startsWith("[shape]"))).toBe(true)
  })

  it("recovers from a failing catalog entry", async () => {
    const seen: Array<Author.Input> = []
    const bad = flow(`await ctx.call("boom", {})`, `return done(null)`)
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? bad : doneScript
    })
    const { events, outcome } = await runChain({
      author,
      entries: [failingEntry("boom", "exploded")]
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.kind).toBe("call_failed")
    expect(rejection.observation.message).toContain("exploded")
    expect((seen[1] as Author.Input).context.some((line) => line.startsWith("[call_failed]"))).toBe(true)
  })

  it("rejects a non-JSON handler result before journaling it", async () => {
    const bad = flow(`await ctx.call("bad-result", {})`, `return done(null)`)
    const { events, outcome } = await runChain({
      author: Author.layerMock([bad, doneScript]),
      entries: [countingEntry("bad-result", new Date(0)).entry]
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(events.some((event) => event._tag === "CallSettled" && event.name === "bad-result")).toBe(false)
    const rejection = events.find((event) =>
      event._tag === "GateRejected" && event.observation.message.includes("not JSON-serializable")
    )
    expect(rejection).toBeDefined()
  })

  it("rejects a non-JSON payload supplied by a runner binding", async () => {
    let runs = 0
    const runner = ScriptRunner.make({
      run: (_script, handler) => {
        runs++
        return runs === 1
          ? handler({ name: "bad-input", payload: new Date(0) }).pipe(
            Effect.as({ _tag: "Done", value: null } as const)
          )
          : Effect.succeed({ _tag: "Done", value: "recovered" } as const)
      }
    })
    const { events, outcome } = await runChain({
      author: Author.layerMock([flow(`return done(null)`), doneScript]),
      entries: [countingEntry("bad-input", null).entry],
      runner: Layer.succeed(ScriptRunner.ScriptRunner)(runner)
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(events.some((event) => event._tag === "CallSettled" && event.name === "bad-input")).toBe(false)
  })

  it.each([
    ["throws", `throw new Error("kaput")`, "runtime"],
    ["returns a non-outcome", `return 42`, "invalid_outcome"],
    ["does not compile", `const const`, "compile"]
  ])("recovers from a script that %s", async (_label, body, code) => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? flow(body) : doneScript
    })
    const { events, outcome } = await runChain({ author })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.kind).toBe("script_failed")
    expect(rejection.observation.message).toContain(code)
    expect((seen[1] as Author.Input).context.some((line) => line.startsWith("[script_failed]"))).toBe(true)
  })

  it("does not duplicate a script failure observation on resume", async () => {
    const first = await runChain({
      author: Author.layerMock([flow(`throw new Error("kaput")`), doneScript])
    })
    const rejectionIndex = first.events.findIndex((event) => event._tag === "GateRejected")
    const resumed = await runChain({
      author: Author.layerMock([doneScript]),
      initial: first.events.slice(0, rejectionIndex + 1)
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(resumed.events.filter((event) => event._tag === "GateRejected")).toHaveLength(1)
    expect(resumed.events).toEqual(first.events)
  })

  it("replays a recorded rejection without re-running its gate", async () => {
    const bad = flow(`await ctx.call("missing", {})`, `return done(null)`)
    const first = await runChain({ author: Author.layerMock([bad, doneScript]) })
    const rejectionIndex = first.events.findIndex((event) => event._tag === "GateRejected")
    const resumed = await runChain({
      author: Author.layerMock([doneScript]),
      initial: first.events.slice(0, rejectionIndex + 1)
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(resumed.events.filter((event) => event._tag === "GateRejected")).toHaveLength(1)
    expect(resumed.events).toEqual(first.events)
  })

  it("parks the chain when a link runs out of fuel", async () => {
    const grep = countingEntry("grep", grepResult)
    const greedy = flow(
      `await ctx.call("grep", {})`,
      `await ctx.call("grep", {})`,
      `await ctx.call("grep", {})`,
      `return done(null)`
    )
    const { events, outcome } = await runChain({
      author: Author.layerMock([greedy]),
      entries: [grep.entry],
      maxCallsPerLink: 2
    })
    expect(outcome._tag).toBe("Park")
    expect((outcome as { reason: { code: string } }).reason.code).toBe("quota")
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.kind).toBe("fuel")
    expect(grep.count()).toBe(2)
    const ended = events.at(-1) as Event.LinkEnded
    expect(ended.link).toBe(1)
    expect(ended.outcome._tag).toBe("Park")
  })

  it("parks immediately when the call budget is zero", async () => {
    const { events, outcome } = await runChain({
      author: Author.layerNoop(),
      maxCallsPerLink: 0,
      runner: ScriptRunner.layerNoop()
    })
    expect(outcome._tag).toBe("Park")
    expect(events.map((event) => event._tag)).toEqual(["ChainStarted", "GateRejected", "LinkEnded"])
  })

  it("parks the chain at its link budget", async () => {
    const relay = flow(`const s = await ctx.call("author", { context: [] })`, `return to(s)`)
    const { events, outcome } = await runChain({
      author: Author.layerFn(() => relay),
      maxLinks: 2
    })
    expect(outcome._tag).toBe("Park")
    expect((outcome as { reason: { message: string } }).reason.message).toContain("2 links")
    const ended = events.at(-1) as Event.LinkEnded
    expect(ended.link).toBe(2)
  })

  it("parks when the script says park, and replays the park as terminal", async () => {
    const parking = flow(`return park("timer")`)
    const first = await runChain({ author: Author.layerMock([parking]) })
    expect(first.outcome).toEqual({ _tag: "Park", reason: { code: "timer", message: "" } })

    const replay = await runChain({
      author: Author.layerMock([]),
      initial: first.events,
      runner: ScriptRunner.layerNoop()
    })
    expect(replay.outcome).toEqual(first.outcome)
    expect(replay.events).toEqual(first.events)
  })

  it("fails with replay_divergence when the journal disagrees with the script", async () => {
    const { events } = await goldenRun()
    const tampered = [...events.slice(0, 5)]
    tampered[4] = { ...tampered[4], name: "other" } as Event.Event
    const error = await failChain({
      author: Author.layerMock([]),
      initial: tampered
    }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/ChainError")
    expect(error.code).toBe("replay_divergence")
  })

  it.each([
    ["script digest", { scriptDigest: "tampered" }],
    ["link", { link: 99 }]
  ])("refuses to replay a call settled under a different %s", async (_label, keyPatch) => {
    const { events } = await goldenRun()
    const tampered = [...events.slice(0, 5)]
    const settled = tampered[4] as Event.CallSettled
    tampered[4] = { ...settled, key: { ...settled.key, ...keyPatch } }

    const error = await failChain({
      author: Author.layerMock([]),
      initial: tampered
    }) as { code: string; message: string }
    expect(error.code).toBe("replay_divergence")
    expect(error.message).toContain("different link or script")
  })

  it("refuses to replay a call whose entry left the catalog", async () => {
    const { events } = await goldenRun()
    const error = await failChain({
      author: Author.layerMock([]),
      entries: [countingEntry("edit", { ok: true }).entry],
      initial: events.slice(0, 5)
    }) as { code: string }
    expect(error.code).toBe("replay_divergence")
  })

  it("refuses to replay a settled call under a different payload", async () => {
    const { events } = await goldenRun()
    const tampered = [...events.slice(0, 5)]
    tampered[4] = { ...(tampered[4] as Event.CallSettled), payload: { pattern: "FIXME" } }
    const error = await failChain({
      author: Author.layerMock([]),
      entries: [countingEntry("grep", grepResult).entry],
      initial: tampered
    }) as Chain.ChainError
    expect(error.code).toBe("replay_divergence")
    expect(error.message).toContain("different payload")
  })

  it("refuses catalog and entries together in the test harness", () => {
    expect(() =>
      runChain({
        author: Author.layerMock([]),
        catalog: {} as never,
        entries: []
      })
    ).toThrow("catalog or entries, not both")
  })

  it("refuses to replay a call settled under a redeclared entry", async () => {
    const { events } = await goldenRun()
    const redeclaredGrep = countingEntry("grep", grepResult)
    const error = await failChain({
      author: Author.layerMock([]),
      entries: [
        { ...redeclaredGrep.entry, description: "a different declaration" },
        countingEntry("edit", { ok: true }).entry
      ],
      initial: events.slice(0, 5)
    }) as { _tag: string; code: string; message: string }
    expect(error._tag).toBe("/chain/ChainError")
    expect(error.code).toBe("replay_divergence")
    expect(error.message).toContain("different declaration")
    expect(redeclaredGrep.count()).toBe(0)
  })

  it("fails with invalid_journal when a settled author result is not a script", async () => {
    const { events } = await goldenRun()
    const tampered = [events[0], { ...events[1], result: 42 }] as ReadonlyArray<Event.Event>
    const error = await failChain({
      author: Author.layerMock([]),
      initial: tampered
    }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/ChainError")
    expect(error.code).toBe("invalid_journal")
  })

  it("propagates an exhausted mock author", async () => {
    const error = await failChain({ author: Author.layerMock([]) }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/AuthorError")
    expect(error.code).toBe("exhausted")
  })

  it("pins the goal and envelope, and hands the prefix to the author seat", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return doneScript
    })
    const { events, outcome } = await runChain({
      author,
      envelope: { workspace: "agent" },
      goal: "build it",
      prefix: "SYSTEM"
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(events[0]).toEqual({ _tag: "ChainStarted", envelope: { workspace: "agent" }, goal: "build it" })
    expect((seen[0] as Author.Input).prefix).toBe("SYSTEM")
    expect((seen[0] as Author.Input).context).toEqual(["build it"])
  })

  it("normalizes a garbage author payload from a script to empty context", async () => {
    const seen: Array<Author.Input> = []
    const weird = flow(`const s = await ctx.call("author", "garbage")`, `return to(s)`)
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? weird : doneScript
    })
    const { outcome } = await runChain({ author })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect((seen[1] as Author.Input).context).toEqual([])
  })
})

// `Journal.append` takes an `expectedPosition` so an append is a
// compare-and-swap. `Chain.run` cannot simply track the journal's length,
// because a sub-chain legitimately appends to the same journal under its own
// id while the parent frame is suspended — so what the run tracks is the
// count of events in ITS OWN scope, and a second writer on that scope is a
// conflict rather than a silent interleave.
describe("Chain journal ownership", () => {
  const twoCalls = flow(
    `await ctx.call("edit", { file: "a.ts" })`,
    `await ctx.call("edit", { file: "b.ts" })`,
    `return done("ok")`
  )

  const sharedLayers = (entries: ReadonlyArray<Catalog.Entry>, journal: Layer.Layer<Journal.Journal>) => {
    const base = Layer.mergeAll(journal, Author.layerFn(() => twoCalls), ScriptRunner.layerInProcess)
    return Layer.mergeAll(base, Catalog.layer(entries).pipe(Layer.provide(base)))
  }

  it("never settles one call slot twice when two runs race over one journal", async () => {
    const edit = countingEntry("edit", { ok: true })
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.all(
          [Effect.exit(Chain.run({ goal: "race" })), Effect.exit(Chain.run({ goal: "race" }))],
          { concurrency: 2 }
        )
        const journal = yield* Journal.Journal
        return yield* journal.read
      }).pipe(Effect.provide(sharedLayers([edit.entry], Journal.layerMemory())))
    )
    // Effect execution is at-least-once: the losing run may dispatch a
    // handler live before its next append conflicts. What must hold is that
    // the JOURNAL records each slot once, so no fold ever sees a duplicate
    // and no link ends twice. Both were violated before the run tracked the
    // events it owns: ordinal 1 of link 1 settled twice and link 1 ended
    // twice, with both runs reporting Done.
    const slots = events
      .filter((event): event is Event.CallSettled => event._tag === "CallSettled")
      .map((event) => `${event.key.link}/${event.key.ordinal}`)
    expect(slots).toEqual([...new Set(slots)])
    expect(slots.filter((slot) => slot.startsWith("1/"))).toEqual(["1/0", "1/1"])
    const ended = events.filter((event) => event._tag === "LinkEnded").map((event) => event.link)
    expect(ended).toEqual([...new Set(ended)])
    expect(edit.count()).toBeGreaterThanOrEqual(2)
  })

  it("fails with journal_conflict when another writer advances the same scope", async () => {
    // The intruder stands in for a second process running this same chain:
    // it appends an in-scope event out from under the live run.
    let stored: ReadonlyArray<Event.Event> = []
    const journal = Layer.succeed(Journal.Journal)(Journal.make({
      append: (event, expectedPosition) =>
        stored.length === expectedPosition
          ? Effect.sync(() => {
            stored = [...stored, event]
          })
          : Effect.fail(
            new Journal.JournalError({
              code: "journal_conflict",
              message: `append expected journal position ${expectedPosition}, found ${stored.length}`
            })
          ),
      read: Effect.sync(() => stored)
    }))
    const intruder: Catalog.Entry = {
      description: "appends into this chain's scope behind the run's back",
      handler: () =>
        Effect.sync(() => {
          stored = [...stored, {
            _tag: "GateRejected",
            link: 1,
            observation: Observation.make("shape", "written by another process"),
            ordinal: 9
          }]
          return { ok: true }
        }),
      name: "edit"
    }
    const error = await Effect.runPromise(
      Effect.flip(Chain.run({ goal: "race" })).pipe(
        Effect.provide(sharedLayers([intruder], journal))
      ) as unknown as Effect.Effect<{ _tag: string; code: string }, never, never>
    )
    expect(error._tag).toBe("/chain/JournalError")
    expect(error.code).toBe("journal_conflict")
  })

  it("lets a sub-chain append to the same journal without conflicting", async () => {
    const spawn = flow(
      `const child = await ctx.call("agent", { goal: "child work" })`,
      `return done(child)`
    )
    const scripts = [spawn, flow(`return done("child done")`)]
    const catalog = Layer.effect(Catalog.Catalog)(SubChains.make({ entries: [] }))
    const { outcome } = await runChain({ author: Author.layerMock(scripts), catalog })
    expect(outcome).toEqual({ _tag: "Done", value: { _tag: "Done", value: "child done" } })
  })
})

describe("Chain journal cost", () => {
  /**
   * A binding that counts its operations: a run's position bookkeeping is
   * observable only through how often it has to read the whole journal.
   */
  const countingJournal = (initial: ReadonlyArray<Event.Event> = []) => {
    const stored: Array<Event.Event> = [...initial]
    let reads = 0
    let appends = 0
    const layer = Layer.succeed(Journal.Journal)(Journal.make({
      append: (event, expectedPosition) =>
        Effect.suspend(() => {
          appends = appends + 1
          if (stored.length !== expectedPosition) {
            return Effect.fail(
              new Journal.JournalError({
                code: "journal_conflict",
                message: `append expected journal position ${expectedPosition}, found ${stored.length}`
              })
            )
          }
          stored.push(event)
          return Effect.void
        }),
      read: Effect.sync(() => {
        reads = reads + 1
        return stored.slice()
      })
    }))
    return { appends: () => appends, layer, reads: () => reads, stored }
  }

  const layersOver = (
    journal: Layer.Layer<Journal.Journal>,
    author: Layer.Layer<Author.Author>,
    catalog: Layer.Layer<Catalog.Catalog, never, Journal.Journal | Author.Author | ScriptRunner.ScriptRunner>
  ) => {
    const base = Layer.mergeAll(journal, author, ScriptRunner.layerInProcess)
    return Layer.mergeAll(base, catalog.pipe(Layer.provide(base)))
  }

  const foreign = (count: number): Array<Event.Event> => {
    const events: Array<Event.Event> = []
    for (let index = 0; index < count; index++) {
      events.push({ _tag: "LinkEnded", chain: `other-${index}`, link: 0, outcome: { _tag: "Done", value: null } })
    }
    return events
  }

  it("reads the journal once on a run with no sub-chains", async () => {
    // Before position tracking became incremental every append re-read and
    // rescanned the whole journal, so reads grew with appends: ten events
    // cost eleven reads. One read, at run start, is the whole hydration.
    const grep = countingEntry("grep", grepResult)
    const edit = countingEntry("edit", { ok: true })
    const journal = countingJournal()
    const outcome = await Effect.runPromise(
      Chain.run({ goal: "count" }).pipe(
        Effect.provide(layersOver(journal.layer, Author.layerMock([l1, l2]), Catalog.layer([grep.entry, edit.entry])))
      ) as Effect.Effect<Outcome.RunResult, never, never>
    )
    expect(outcome).toEqual({ _tag: "Done", value: { patched: true } })
    expect(journal.stored.map((event) => event._tag)).toEqual(goldenTags)
    expect(journal.appends()).toBe(goldenTags.length)
    expect(journal.reads()).toBe(1)
  })

  it("re-reads only when a sub-chain advanced the journal", async () => {
    // The parent reads once at start, the child reads once at ITS start, and
    // the parent's first append after the child returns lands on a moved
    // position: one conflict, one repairing read, then the retry succeeds.
    const spawn = flow(
      `const child = await ctx.call("agent", { goal: "child work" })`,
      `return done(child)`
    )
    const journal = countingJournal()
    const catalog = Layer.effect(Catalog.Catalog)(SubChains.make({ entries: [] }))
    const outcome = await Effect.runPromise(
      Chain.run({ goal: "spawn" }).pipe(
        Effect.provide(layersOver(journal.layer, Author.layerMock([spawn, flow(`return done("child done")`)]), catalog))
      ) as Effect.Effect<Outcome.RunResult, never, never>
    )
    expect(outcome).toEqual({ _tag: "Done", value: { _tag: "Done", value: "child done" } })
    expect(journal.reads()).toBe(3)
    expect(journal.appends()).toBe(journal.stored.length + 1)
  })

  it("runs over a journal seeded with 250,000 foreign-scope events", async () => {
    // Node caps argument spreading near 120,000 elements, so mirroring the
    // journal with `splice(0, length, ...latest)` threw RangeError inside
    // `append` once a shared journal outgrew that: nothing was journaled and
    // every resume died on the same line.
    const { events, outcome } = await runChain({
      author: Author.layerMock([doneScript]),
      initial: foreign(250_000)
    })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(events.slice(250_000).map((event) => event._tag)).toEqual([
      "ChainStarted",
      "CallSettled",
      "LinkAuthored",
      "LinkEnded",
      "LinkEnded"
    ])
    expect(events.length).toBe(250_000 + 5)
  })

  it("surfaces a binding conflict at a position the journal did not move past", async () => {
    // A conflict the run can repair is one where the journal grew under a
    // scope it does not own. A binding that refuses the very position its
    // read reports has nothing to repair: the run must not spin on it.
    let refusals = 0
    const stored: Array<Event.Event> = []
    const journal = Layer.succeed(Journal.Journal)(Journal.make({
      append: (event, expectedPosition) =>
        Effect.suspend(() => {
          if (stored.length === 3) {
            refusals = refusals + 1
            return Effect.fail(new Journal.JournalError({ code: "journal_conflict", message: "refused at 3" }))
          }
          stored.push(event)
          return Effect.void
        }),
      read: Effect.sync(() => stored.slice())
    }))
    const error = await Effect.runPromise(
      Effect.flip(Chain.run({ goal: "stuck" })).pipe(
        Effect.provide(layersOver(journal, Author.layerMock([doneScript]), Catalog.layer([])))
      ) as unknown as Effect.Effect<Journal.JournalError, never, never>
    )
    expect(error._tag).toBe("/chain/JournalError")
    expect(error.code).toBe("journal_conflict")
    expect(error.message).toBe("refused at 3")
    expect(refusals).toBe(1)
  })

  it("propagates an unavailable journal from a mid-run append", async () => {
    const stored: Array<Event.Event> = []
    const journal = Layer.succeed(Journal.Journal)(Journal.make({
      append: (event) =>
        Effect.suspend(() => {
          if (stored.length === 2) return Effect.fail(new Journal.JournalError({ message: "disk gone" }))
          stored.push(event)
          return Effect.void
        }),
      read: Effect.sync(() => stored.slice())
    }))
    const error = await Effect.runPromise(
      Effect.flip(Chain.run({ goal: "gone" })).pipe(
        Effect.provide(layersOver(journal, Author.layerMock([doneScript]), Catalog.layer([])))
      ) as unknown as Effect.Effect<Journal.JournalError, never, never>
    )
    expect(error.code).toBe("journal_unavailable")
    expect(error.message).toBe("disk gone")
    expect(stored.length).toBe(2)
  })
})

// The author gate journals its rejection BEFORE the settled marker so a
// crash between the two resumes through `rejectedPrior` rather than
// replaying the marker as if it were a real author result.
describe("Chain crash recovery", () => {
  it("resumes a link whose rejection was journaled without its settled marker", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return doneScript
    })
    const initial: ReadonlyArray<Event.Event> = [
      { _tag: "ChainStarted", envelope: null, goal: "fix TODOs" },
      {
        _tag: "GateRejected",
        link: 0,
        observation: Observation.make("shape", "no flow block"),
        ordinal: 0
      }
    ]
    const { events, outcome } = await runChain({ author, initial })
    expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
    // Ordinal 0 replayed as the recorded rejection; the live author call is
    // ordinal 1, and it carries the crashed attempt's observation.
    const settled = events.filter((event): event is Event.CallSettled => event._tag === "CallSettled")
    expect(settled.map((event) => event.key.ordinal)).toEqual([1])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.context).toEqual(["fix TODOs", "[shape] no flow block"])
  })
})

describe("Chain recovery bounds", () => {
  const boundedRun = async (
    options: Chain.Options,
    author: Layer.Layer<Author.Author>,
    initial: ReadonlyArray<Event.Event> = [],
    runner: Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure> = ScriptRunner.layerInProcess
  ) => {
    const events: Array<Event.Event> = [...initial]
    const journal = Journal.layerNoop({
      read: Effect.sync(() => [...events]),
      append: (event) =>
        Effect.sync(() => {
          // Bound the reproduction independently of the harness under test.
          if (events.length - initial.length >= 40) throw new Error("recovery exceeded append bound")
          events.push(event)
        })
    })
    const outcome = await Effect.runPromise(
      Chain.run(options).pipe(
        Effect.provide(Layer.mergeAll(journal, author, Catalog.layer([]), runner))
      )
    )
    return { events, outcome }
  }

  it.each([0, 4])("parks refused harness payloads with budget %i", async (maxCallsPerLink) => {
    const options = { goal: "goal", context: ["x".repeat(8_400_000)], maxCallsPerLink }
    const { events, outcome } = await boundedRun(options, Author.layerNoop())
    expect(outcome._tag).toBe("Park")
    expect(outcome).toMatchObject({ reason: { code: "quota" } })
    const rejected = events.filter((event) => event._tag === "GateRejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.observation.kind).toBe("fuel")
    expect(rejected[0]?.observation.message).toContain(maxCallsPerLink === 0 ? "budget" : "JSON")
    // A crash after refusal must replay the rejection without appending it again.
    const resumed = await boundedRun(options, Author.layerNoop(), events.slice(0, -1))
    expect(resumed).toEqual({ events, outcome })
  })

  it("checks fuel before inspecting a refused script payload", async () => {
    let reads = 0
    const runner = Layer.succeed(ScriptRunner.ScriptRunner)(ScriptRunner.make({
      run: (_script, handler) =>
        Effect.gen(function*() {
          yield* handler({ name: "author", payload: { context: [] } })
          yield* handler({
            name: "bad",
            payload: {
              get value() {
                reads++
                throw new Error("refused")
              }
            }
          })
          return { _tag: "Done", value: null } as const
        })
    }))
    const { events, outcome } = await boundedRun(
      { goal: "goal", maxCallsPerLink: 1 },
      Author.layerFn(() => doneScript),
      [],
      runner
    )
    expect(outcome).toMatchObject({ _tag: "Park", reason: { code: "quota" } })
    expect(reads).toBe(0)
    expect(events.filter((event) => event._tag === "GateRejected").map((event) => event.observation.kind))
      .toEqual(["fuel"])
  })

  it("parks an 8.4M-character QuickJS throw within the call budget", async () => {
    let calls = 0
    const author = Author.layerFn(() => ++calls === 1 ? flow(`throw "x".repeat(8400000)`) : "invalid")
    const { events, outcome } = await boundedRun(
      { goal: "goal", maxCallsPerLink: 4 },
      author,
      [],
      QuickJsRunner.layer()
    )
    expect(outcome).toMatchObject({ _tag: "Park", reason: { code: "quota" } })
    const rejected = events.filter((event): event is Event.GateRejected =>
      event._tag === "GateRejected" && event.link === 1
    )
    expect(rejected.map((event) => event.ordinal)).toEqual([0, 1, 2, 3, 4])
    expect(rejected.at(-1)?.observation.kind).toBe("fuel")
    // One LinkAuthored precedes execution; the link appends five
    // rejections, three rejected-author settlements, and one terminal.
    expect(events.filter((event) => "link" in event && event.link === 1).map((event) => event._tag)).toEqual([
      "LinkAuthored",
      "GateRejected",
      "GateRejected",
      "CallSettled",
      "GateRejected",
      "CallSettled",
      "GateRejected",
      "CallSettled",
      "GateRejected",
      "LinkEnded"
    ])
  })

  it.each(["script", "handler"])(
    "caps multi-megabyte %s failures in the journal and author payload",
    async (source) => {
      const seen: Array<Author.Input> = []
      const author = Author.layerFn((input) => {
        seen.push(input)
        return seen.length === 1
          ? flow(source === "script" ? `throw "x".repeat(2000000)` : `await ctx.call("fail", {})`)
          : doneScript
      })
      const { events, outcome } = await runChain({
        author,
        entries: [failingEntry("fail", "x".repeat(2_000_000))]
      })
      expect(outcome).toEqual({ _tag: "Done", value: "recovered" })
      const rejected = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
      expect(rejected.observation.message.length).toBeLessThanOrEqual(8192)
      expect(rejected.observation.message).toContain("[truncated]")
      expect(seen[1]?.context.join("\n").length).toBeLessThan(8400)
      const recovery = events.find((event) => event._tag === "CallSettled" && event.link === 1)
      expect(JSON.stringify(recovery).length).toBeLessThan(9000)
    }
  )

  it("caps an oversized native realm failure before recovering through the author", async () => {
    // Inject the native failure rather than relying on host stack exhaustion,
    // which can instead surface as an ordinary rejected realm promise.
    const module = {
      newRuntime: () => {
        throw new Error("native abort: " + "x".repeat(2_000_000))
      }
    } as unknown as QuickJSWASMModule
    const runner = Layer.effect(ScriptRunner.ScriptRunner)(QuickJsRunner.make({}, () => Promise.resolve(module)))
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return doneScript
    })
    const { events, outcome } = await boundedRun({ goal: "goal", maxLinks: 2 }, author, [], runner)
    expect(outcome).toMatchObject({ _tag: "Park", reason: { code: "quota" } })
    const rejected = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejected.observation.kind).toBe("script_failed")
    // The observation the model reads names the origin: a runner defect,
    // not something the script did.
    expect(rejected.observation.message.startsWith(`runtime: ${QuickJsRunner.hostDefectMarker}`)).toBe(true)
    expect(rejected.observation.message).toContain("native abort")
    expect(rejected.observation.message).toContain("[truncated]")
    expect(rejected.observation.message.length).toBeLessThanOrEqual(8192)
    expect(seen[1]?.context.join("\n").length).toBeLessThan(8400)
    const recovery = events.find((event) => event._tag === "CallSettled" && event.link === 1)
    expect(JSON.stringify(recovery).length).toBeLessThan(9000)
  })

  it("caps the combined recovery block including oversized legacy observations", async () => {
    const initial: Array<Event.Event> = [{ _tag: "ChainStarted", goal: "goal", envelope: null }]
    for (let ordinal = 0; ordinal < 6; ordinal++) {
      initial.push({
        _tag: "GateRejected",
        link: 0,
        ordinal,
        observation: { kind: "shape", message: "x".repeat(10000) }
      })
    }
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return doneScript
    })
    const { outcome, events } = await boundedRun({ goal: "goal" }, author, initial)
    expect(outcome).toMatchObject({ _tag: "Done" })
    const block = seen[0]!.context.slice(1)
    expect(block.join("\n").length).toBeLessThanOrEqual(32768)
    expect(block.join("\n")).toContain("[truncated]")
    expect(events.slice(0, initial.length)).toEqual(initial)
  })

  it("replays settled calls even when the resumed call budget is zero", async () => {
    const first = await boundedRun({ goal: "goal" }, Author.layerMock([doneScript]))
    const resumed = await boundedRun({ goal: "goal", maxCallsPerLink: 0 }, Author.layerNoop(), first.events.slice(0, 2))
    expect(resumed).toEqual(first)
  })

  it("names Options.context and bounds the payload diff when context changes on resume", async () => {
    const goal = "goal"
    const prefix = "x".repeat(10000)
    const { events } = await boundedRun({ goal, context: [prefix + "old context"] }, Author.layerMock([doneScript]))
    const error = await Effect.runPromise(
      Effect.flip(Chain.run({ goal, context: [prefix + "new context"] })).pipe(
        Effect.provide(Layer.mergeAll(
          Journal.layerMemory(events.slice(0, 2)),
          Author.layerNoop(),
          Catalog.layer([]),
          ScriptRunner.layerInProcess
        ))
      )
    )
    expect(error).toMatchObject({ code: "replay_divergence" })
    expect(error.message).toContain("Options.context")
    expect(error.message).toContain("old context")
    expect(error.message).toContain("new context")
    expect(error.message.length).toBeLessThan(2000)
  })
})

describe("Chain handler payload", () => {
  // A runner binding may hand the chain a live object. The handler and the
  // author context must act on the boundary copy the journal records, not
  // on a getter that answers differently on its next read.
  it("hands the handler and the author the journaled copy, not the live payload", async () => {
    let reads = 0
    const live = {
      get target() {
        reads++
        return reads === 1 ? "authorized" : "swapped"
      }
    }
    let authorReads = 0
    const liveContext = {
      get context() {
        authorReads++
        return authorReads === 1 ? ["authorized"] : ["swapped"]
      }
    }
    const received: Array<unknown> = []
    const contexts: Array<ReadonlyArray<string>> = []
    const runner = Layer.succeed(ScriptRunner.ScriptRunner)(ScriptRunner.make({
      run: (_script, handler) =>
        Effect.gen(function*() {
          yield* handler({ name: "author", payload: liveContext })
          yield* handler({ name: "write", payload: live })
          return { _tag: "Done", value: null } as const
        })
    }))
    const { events } = await runChain({
      author: Author.layerFn((input) => {
        contexts.push(input.context)
        return doneScript
      }),
      entries: [{
        name: "write",
        description: "records its payload",
        capabilities: [],
        handler: (payload) => Effect.sync(() => received.push(payload))
      }],
      runner
    })
    const settled = events.filter((event): event is Event.CallSettled =>
      event._tag === "CallSettled" && event.name === "write"
    )
    expect(settled.map((event) => event.payload)).toEqual([{ target: "authorized" }])
    expect(received).toEqual([{ target: "authorized" }])
    expect(contexts.at(-1)).toEqual(["authorized"])
  })
})
