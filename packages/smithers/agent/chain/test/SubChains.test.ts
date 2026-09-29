import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as Authorize from "../src/Authorize.ts"
import type * as Catalog from "../src/Catalog.ts"
import * as Chain from "../src/Chain.ts"
import * as Event from "../src/Event.ts"
import * as Journal from "../src/Journal.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import * as Steering from "../src/Steering.ts"
import * as SubChains from "../src/SubChains.ts"
import { countingEntry, flow, runChain, runOn } from "./harness.ts"

const runners = [
  ["in-process", ScriptRunner.layerInProcess],
  ["QuickJS", QuickJsRunner.layer()]
] as const

const doneChild = flow(`const found = await ctx.call("grep", {})`, `return done(found)`)

const parentDelegates = flow(
  `const child = await ctx.call("agent", { context: ["look in src"], goal: "count TODOs" })`,
  `if (child._tag !== "Done") return park(child.reason.code, child.reason.message)`,
  `return done({ from: "parent", child: child.value })`
)

describe("SubChains", () => {
  it.each(["", "root-a"])("runs a child chain to done under root scope %s", async (chain) => {
    const grep = countingEntry("grep", { files: ["a.ts"] })
    const catalog = SubChains.layer({ entries: [grep.entry] })
    const { events, outcome } = await runChain({
      chain,
      author: Author.layerMock([parentDelegates, doneChild]),
      catalog
    })
    expect(outcome).toEqual({
      _tag: "Done",
      value: { child: { files: ["a.ts"] }, from: "parent" }
    })
    expect(grep.count()).toBe(1)

    const childEvents = events.filter((event) => (event.chain ?? "") !== chain)
    expect(childEvents.length).toBeGreaterThan(0)
    expect(new Set(childEvents.map((event) => event.chain))).toEqual(new Set([chain === "" ? "1.0" : `${chain}/1.0`]))
    const settle = events.find((event) => event._tag === "CallSettled" && event.name === "agent") as Event.CallSettled
    expect(settle.result).toEqual({ _tag: "Done", value: { files: ["a.ts"] } })
  })

  it.each(["", "root-a"])("resumes a serialized interrupted child under root scope %s", async (chain) => {
    const grep = countingEntry("grep", { files: ["a.ts"] })
    const first = await runChain({
      chain,
      author: Author.layerMock([parentDelegates, doneChild]),
      catalog: SubChains.layer({ entries: [grep.entry] })
    })
    const child = chain === "" ? "1.0" : `${chain}/1.0`
    const childSettleIndex = first.events.findIndex((event) =>
      event._tag === "CallSettled" && event.chain === child && event.name === "grep"
    )
    expect(childSettleIndex).toBeGreaterThan(0)
    const interrupted = first.events.slice(0, childSettleIndex + 1)
    const encode = Schema.encodeSync(Event.Event)
    const wire = JSON.stringify(interrupted.map((event) => encode(event)))
    const initial = Schema.decodeUnknownSync(Schema.Array(Event.Event))(JSON.parse(wire))
    expect(initial).toStrictEqual(interrupted)
    expect(new Set(initial.map((event) => event.chain ?? ""))).toEqual(new Set([chain, child]))
    expect(grep.count()).toBe(1)
    const resumedGrep = countingEntry("grep", { files: ["a.ts"] })
    const resumed = await runChain({
      chain,
      author: Author.layerMock([]),
      catalog: SubChains.layer({ entries: [resumedGrep.entry] }),
      initial
    })
    expect(resumed.outcome).toEqual(first.outcome)
    expect(resumedGrep.count()).toBe(0)
    expect(resumed.events).toStrictEqual(first.events)
    expect(Event.terminal(resumed.events, chain)).toEqual(first.outcome)
    expect(Event.terminal(resumed.events, child)).toEqual({ _tag: "Done", value: { files: ["a.ts"] } })
  })

  it("settles a child's non-approval park as data the parent script decides on", async () => {
    const parking = flow(`return park("timer", "waiting on the world")`)
    const { events, outcome } = await runChain({
      author: Author.layerMock([parentDelegates, parking]),
      catalog: SubChains.layer({ entries: [] })
    })
    expect(outcome).toEqual({ _tag: "Park", reason: { code: "timer", message: "waiting on the world" } })
    const settle = events.find((event) => event._tag === "CallSettled" && event.name === "agent") as Event.CallSettled
    expect(settle.result).toEqual({ _tag: "Park", reason: { code: "timer", message: "waiting on the world" } })
  })

  it.each(runners)("settles a terminal child approval park as data (%s)", async (_, runner) => {
    const terminal = { _tag: "Park", reason: { code: "approval", message: "script deliberately stopped" } }
    const first = await runChain({
      author: Author.layerMock([
        flow(`return done(await ctx.call("agent", { goal: "stop" }))`),
        flow(`return park("approval", "script deliberately stopped")`)
      ]),
      catalog: SubChains.layer({ entries: [] }),
      runner
    })
    expect(first.outcome).toEqual({ _tag: "Done", value: terminal })
    const settleIndex = first.events.findIndex((event) => event._tag === "CallSettled" && event.name === "agent")
    expect(settleIndex).toBeGreaterThan(0)
    // A crash after the child's LinkEnded but before the parent settles
    // must also return the child's terminal as data.
    const resumed = await runChain({
      author: Author.layerMock([]),
      catalog: SubChains.layer({ entries: [] }),
      initial: first.events.slice(0, settleIndex),
      runner
    })
    expect(resumed).toEqual(first)
  })

  it.each(runners)("bubbles a child's approval wait and a grant resumes the same slot (%s)", async (_, runner) => {
    const pattern = (action: CapabilityPattern["action"], resource: string): CapabilityPattern =>
      new CapabilityPattern({ action, resource })
    const allowAuthor = new Rule({ effect: "allow", pattern: pattern("model:call", "**") })
    const allowSpawn = new Rule({ effect: "allow", pattern: pattern("proc:spawn", "**") })
    const gated = { ...countingEntry("repo/write", "written").entry, capabilities: ["fs:write:src/**"] }
    const childWrites = flow(`const wrote = await ctx.call("repo/write", {})`, `return done(wrote)`)

    const first = await runChain({
      runner,
      author: Author.layerMock([parentDelegates, childWrites]),
      authorize: Authorize.layerRules([allowAuthor, allowSpawn]),
      catalog: SubChains.layer({ entries: [gated] })
    })
    expect(first.outcome).toEqual({
      _tag: "ApprovalWait",
      reason: { code: "approval", message: `"repo/write" needs approval for fs:write:src/**` }
    })
    // Nothing settled for the agent call: the park is resumable in place.
    expect(first.events.some((event) => event._tag === "CallSettled" && event.name === "agent")).toBe(false)

    const regranted = { ...countingEntry("repo/write", "written").entry, capabilities: ["fs:write:src/**"] }
    const resumed = await runChain({
      runner,
      author: Author.layerMock([]),
      authorize: Authorize.layerRules([
        allowAuthor,
        allowSpawn,
        new Rule({ effect: "allow", pattern: pattern("fs:write", "**") })
      ]),
      catalog: SubChains.layer({ entries: [regranted] }),
      initial: first.events
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: { child: "written", from: "parent" } })
  })

  it("bounds nesting depth with a typed refusal", async () => {
    const recurse = flow(
      `const child = await ctx.call("agent", { goal: "go deeper" })`,
      `return done(child)`
    )
    const surrender = flow(`return done("stopped")`)
    const { events, outcome } = await runChain({
      author: Author.layerFn((input) =>
        input.context.some((line) => line.includes("[call_failed]")) ? surrender : recurse
      ),
      catalog: SubChains.layer({ entries: [], maxDepth: 1 })
    })
    expect(outcome._tag).toBe("Done")
    const refusal = events.find((event) =>
      event._tag === "GateRejected" && event.observation.message.includes("nesting deeper")
    )
    expect(refusal).toBeDefined()
  })

  it("refuses a malformed agent payload", async () => {
    const bad = flow(`const child = await ctx.call("agent", { mission: 1 })`, `return done(child)`)
    const surrender = flow(`return done("gave up")`)
    const { events, outcome } = await runChain({
      author: Author.layerMock([bad, surrender]),
      catalog: SubChains.layer({ entries: [] })
    })
    expect(outcome).toEqual({ _tag: "Done", value: "gave up" })
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.message).toContain("{ goal, context? }")
  })

  it("refuses a slotless invocation: no slot means no derivable child identity", async () => {
    const layers = Layer.mergeAll(
      Journal.layerMemory(),
      Author.layerMock([]),
      ScriptRunner.layerInProcess
    )
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const catalog = yield* SubChains.make({ entries: [] })
        const agent = catalog.lookup(SubChains.agentName)
        return yield* Effect.flip((agent as NonNullable<typeof agent>).handler({ goal: "standalone" }))
      }).pipe(Effect.provide(layers), Effect.orDie)
    )
    expect(error.message).toContain("requires a call slot")
  })

  it("dies at construction when entries shadow reserved names", async () => {
    const layers = Layer.mergeAll(
      Journal.layerMemory(),
      Author.layerMock([]),
      ScriptRunner.layerInProcess
    )
    await expect(
      runOn(layers, SubChains.make({ entries: [countingEntry("agent", null).entry] }))
    ).rejects.toThrow("shadow reserved catalog names: agent")
  })

  it("always composes the system entries into the recursive catalog", async () => {
    const script = flow(`const now = await ctx.call("sys/now")`, `return done(typeof now)`)
    const { outcome } = await runChain({
      author: Author.layerMock([script]),
      catalog: SubChains.layer({ entries: [] })
    })
    expect(outcome).toEqual({ _tag: "Done", value: "number" })
  })

  it.each(runners)("propagates a child's typed rate limit without settling the call (%s)", async (_, runner) => {
    const failure = new Author.AuthorError({
      code: "author_unavailable",
      cause: "rate_limited",
      message: "child seat offline"
    })
    let calls = 0
    const author = Author.make({
      author: () => {
        calls = calls + 1
        if (calls === 1) return Effect.succeed(parentDelegates)
        if (calls === 2) return Effect.fail(failure)
        return Effect.succeed(flow(`return done("recovered")`))
      }
    })
    const base = Layer.mergeAll(Journal.layerMemory(), Layer.succeed(Author.Author)(author), runner)
    const layers = Layer.mergeAll(base, SubChains.layer({ entries: [] }).pipe(Layer.provide(base)))
    await Effect.runPromise(
      Effect.gen(function*() {
        const error = yield* Effect.flip(Chain.run({ goal: "parent" }))
        expect(error).toBe(failure)
        expect(error).toMatchObject({ _tag: "/chain/AuthorError", code: "author_unavailable", cause: "rate_limited" })
        const journal = yield* Journal.Journal
        const events = yield* journal.read
        expect(events.some((event) => event._tag === "GateRejected")).toBe(false)
        expect(events.some((event) => event._tag === "CallSettled" && event.name === "agent")).toBe(false)
        const resumed = yield* Chain.run({ goal: "parent" })
        expect(resumed).toEqual({ _tag: "Done", value: { from: "parent", child: "recovered" } })
      }).pipe(Effect.provide(layers))
    )
  })

  it.each(["", "root-a"])("keeps steering at root %s even when admitted mid-child", async (chain) => {
    const queue: Array<string> = []
    const steering = Steering.make({
      admit: (message) =>
        Effect.sync(() => {
          queue.push(message)
        }),
      drain: () => Effect.sync(() => queue.splice(0))
    })
    const seen: Array<Author.Input> = []
    const childInterrupts = flow(
      `await ctx.call("interrupt", {})`,
      `const s = await ctx.call("author", { context: ["child carrying on"] })`,
      `return to(s)`
    )
    const author = Author.make({
      author: (input) =>
        Effect.sync(() => {
          seen.push(input)
          if (seen.length === 1) return parentDelegates
          if (seen.length === 2) return childInterrupts
          if (seen.length === 3) return flow(`return done("child done")`)
          return flow(`return done("root done")`)
        })
    })
    const interrupt: Catalog.Entry = {
      description: "admits steering mid-child, like a user typing",
      handler: () =>
        Effect.sync(() => {
          queue.push("root: change course")
          return null
        }),
      name: "interrupt"
    }
    const rootFollowsUp = flow(
      `const child = await ctx.call("agent", { goal: "count TODOs" })`,
      `const s = await ctx.call("author", { context: ["root reviewing child"] })`,
      `return to(s)`
    )
    const { outcome } = await runChain({
      chain,
      author: Layer.succeed(Author.Author)(
        Author.make({
          author: (input) =>
            Effect.sync(() => {
              seen.push(input)
              if (seen.length === 1) return rootFollowsUp
              if (seen.length === 2) return childInterrupts
              if (seen.length === 3) return flow(`return done("child done")`)
              return flow(`return done("root done")`)
            })
        })
      ),
      catalog: SubChains.layer({ entries: [interrupt] }),
      steering: Layer.succeed(Steering.Steering)(steering)
    })
    expect(outcome).toEqual({ _tag: "Done", value: "root done" })
    // The child's mid-run author call (3rd) never sees the instruction;
    // the root's next author call (4th) does.
    const childAuthor = seen[2] as Author.Input
    const rootAuthor = seen[3] as Author.Input
    expect(childAuthor.context.some((line) => line.startsWith("[steering]"))).toBe(false)
    expect(rootAuthor.context.some((line) => line.startsWith("[steering]"))).toBe(true)
  })

  describe.each(runners)("child budgets (%s)", (_, runner) => {
    const parent = flow(
      `const child = await ctx.call("agent", { goal: "bounded child" })`,
      `await ctx.call("parent/after", {})`,
      `return done(child)`
    )

    it.each([
      [0, 0, 0],
      [1, 0, 1],
      [2, 1, 2],
      [3, 2, 2]
    ])("enforces maxLinks %i with %i child handlers and %i author calls", async (maxLinks, calls, authors) => {
      const childWork = countingEntry("child/work", "ok")
      const parentAfter = countingEntry("parent/after", null)
      const { events, outcome } = await runChain({
        runner,
        maxLinks: 10,
        maxCallsPerLink: 10,
        author: Author.layerMock([
          parent,
          flow(
            `await ctx.call("child/work", {})`,
            `return to(await ctx.call("author", { context: [] }))`
          ),
          flow(`await ctx.call("child/work", {})`, `return done("child done")`)
        ]),
        catalog: SubChains.layer({ entries: [childWork.entry, parentAfter.entry], maxLinks })
      })
      const terminal = maxLinks === 3
        ? { _tag: "Done", value: "child done" }
        : { _tag: "Park", reason: { code: "quota", message: `the chain reached its budget of ${maxLinks} links` } }
      expect(outcome).toEqual({ _tag: "Done", value: terminal })
      expect(Event.terminal(events, "1.0")).toEqual(terminal)
      expect(childWork.count()).toBe(calls)
      expect(parentAfter.count()).toBe(1)
      expect(events.filter((event) => event.chain === "1.0" && event._tag === "CallSettled" && event.name === "author"))
        .toHaveLength(authors)
    })

    it.each([0, 1, 2, 3])("enforces maxCallsPerLink %i independently of parent fuel", async (maxCallsPerLink) => {
      const childWork = countingEntry("child/work", "ok")
      const parentAfter = countingEntry("parent/after", null)
      const { events, outcome } = await runChain({
        runner,
        maxLinks: 10,
        maxCallsPerLink: 10,
        author: Author.layerMock([
          parent,
          flow(
            `await ctx.call("child/work", {})`,
            `await ctx.call("child/work", {})`,
            `await ctx.call("child/work", {})`,
            `return done("child done")`
          )
        ]),
        catalog: SubChains.layer({ entries: [childWork.entry, parentAfter.entry], maxCallsPerLink })
      })
      const terminal = maxCallsPerLink === 3
        ? { _tag: "Done", value: "child done" }
        : {
          _tag: "Park",
          reason: {
            code: "quota",
            message: `link ${maxCallsPerLink === 0 ? 0 : 1} exceeded its budget of ${maxCallsPerLink} calls`
          }
        }
      expect(outcome).toEqual({ _tag: "Done", value: terminal })
      expect(Event.terminal(events, "1.0")).toEqual(terminal)
      expect(childWork.count()).toBe(maxCallsPerLink)
      expect(parentAfter.count()).toBe(1)
      expect(events.filter((event) => event.chain === "1.0" && event._tag === "CallSettled" && event.name === "author"))
        .toHaveLength(maxCallsPerLink === 0 ? 0 : 1)
    })
  })

  it("passes child budgets and prefix through, and pins them in the contract digest", async () => {
    const seen: Array<Author.Input> = []
    const author = Author.make({
      author: (input) =>
        Effect.sync(() => {
          seen.push(input)
          return seen.length === 1 ? parentDelegates : flow(`return done(null)`)
        })
    })
    const { outcome } = await runChain({
      author: Layer.succeed(Author.Author)(author),
      catalog: SubChains.layer({ entries: [], maxLinks: 2, prefix: "CHILD PREFIX" })
    })
    expect(outcome._tag).toBe("Done")
    expect(seen[1]?.prefix).toBe("CHILD PREFIX")
    expect(seen[1]?.context).toEqual(["count TODOs", "look in src"])

    expect(SubChains.contractDigest({ entries: [], maxLinks: 2, prefix: "CHILD PREFIX" }))
      .not.toBe(SubChains.contractDigest({ entries: [], maxLinks: 3, prefix: "CHILD PREFIX" }))
    expect(SubChains.contractDigest({ entries: [] }))
      .not.toBe(SubChains.contractDigest({ entries: [], maxDepth: 2 }))
  })
})
