import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableDeferred, Flow, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Burndown from "../src/Burndown.ts"
import { PatternError } from "../src/PatternError.ts"

interface Issue {
  readonly id: string
  readonly owner?: string
}

const items = (...ids: ReadonlyArray<string>): ReadonlyArray<Issue> => ids.map((id) => ({ id }))

/** A tape of every member call, in the order the round made them. */
const recorder = () => {
  const tape: Array<string> = []
  const note = (entry: string) => Effect.sync(() => void tape.push(entry))
  return { tape, note }
}

const baseOptions = (note: (entry: string) => Effect.Effect<void>) => ({
  key: "sweep",
  concurrency: 4,
  claim: ({ item }: Burndown.ItemArgs<unknown, Issue>) => note(`claim:${item.id}`),
  work: ({ executionId, item }: Burndown.ItemArgs<unknown, Issue> & { readonly executionId: string }) =>
    Effect.as(note(`work:${item.id}@${executionId}`), `fixed ${item.id}`),
  release: ({ item, status }: Burndown.ItemArgs<unknown, Issue> & { readonly status: Burndown.Status }) =>
    note(`release:${item.id}:${status}`)
})

const runRound = <W, E, L = unknown>(
  input: Partial<Burndown.RoundInput<unknown, Issue>> & { readonly items: ReadonlyArray<Issue> },
  options: Burndown.RoundOptions<unknown, Issue, W, E, never, L>
) => Effect.runPromise(Burndown.round({ input: { repo: "acme/app" }, round: 0, ...input }, options))

const refusedRound = (input: Record<string, unknown>, options: Record<string, unknown> = {}) => {
  const { note } = recorder()
  return Effect.runPromise(
    Effect.flip(
      Burndown.round(
        { input: undefined, round: 0, items: items("a"), ...input } as never,
        { ...baseOptions(note), ...options } as never
      )
    )
  )
}

describe("Burndown.round", () => {
  it("claims, works, and releases only the items selection calls ours", async () => {
    const { note, tape } = recorder()
    const result = await runRound({ items: [{ id: "a" }, { id: "b", owner: "mac-mini" }, { id: "c" }] }, {
      ...baseOptions(note),
      select: ({ item }) =>
        Effect.succeed(item.owner === undefined ? Burndown.ours : Burndown.skip(`held by ${item.owner}`)),
      detail: (output: string) => output
    })

    expect(result).toEqual({
      rows: [
        { id: "a", status: "landed", detail: "fixed a" },
        { id: "b", status: "skipped", detail: "held by mac-mini" },
        { id: "c", status: "landed", detail: "fixed c" }
      ],
      launched: 2,
      deferred: 0
    })
    expect(tape.filter((entry) => entry.includes(":b"))).toEqual([])
    expect(tape).toContain("work:a@sweep/a")
    expect(tape).toContain("release:c:landed")
  })

  it("skips an item whose selection is malformed or fails, and reconsiders nothing settled", async () => {
    const { note, tape } = recorder()
    const answers: Record<string, Effect.Effect<Burndown.Selection, string>> = {
      a: Effect.succeed({ _tag: "Skip", detail: 7 } as never),
      b: Effect.succeed({ _tag: "Launch" } as never),
      c: Effect.fail("claims unreadable"),
      d: Effect.fail({ message: "rate limited" } as never)
    }
    const result = await runRound({ items: items("a", "b", "c", "d", "e"), settled: ["e"] }, {
      ...baseOptions(note),
      select: ({ item }) => answers[item.id]!
    })

    expect(result.rows).toEqual([
      { id: "a", status: "skipped", detail: "selection did not answer ours" },
      { id: "b", status: "skipped", detail: "selection did not answer ours" },
      { id: "c", status: "skipped", detail: "select failed: claims unreadable" },
      { id: "d", status: "skipped", detail: "select failed: rate limited" }
    ])
    expect(result.launched).toBe(0)
    expect(tape).toEqual([])
  })

  it("reports a held claim as held, never works or releases it, and leaves it settled", async () => {
    const { note, tape } = recorder()
    const claim = ({ item }: Burndown.ItemArgs<unknown, Issue>) =>
      item.id === "a"
        ? Effect.andThen(note("claim:a"), Effect.fail(new Burndown.Held({ message: "claimed by mac-mini" })))
        : note(`claim:${item.id}`)
    const first = await runRound({ items: items("a", "b") }, { ...baseOptions(note), claim })

    expect(first.rows).toEqual([
      { id: "a", status: "held", detail: "claimed by mac-mini" },
      { id: "b", status: "landed", detail: "" }
    ])
    expect(tape.filter((entry) => entry.endsWith(":a") || entry.includes(":a:") || entry.includes("@sweep/a")))
      .toEqual(["claim:a"])

    // The next round carries the settled ids, so the held item is not claimed again.
    tape.length = 0
    const settled = first.rows.map((row) => row.id)
    const second = await runRound({ items: items("a", "b"), settled, round: 1 }, { ...baseOptions(note), claim })
    expect(second).toEqual({ rows: [], launched: 0, deferred: 0 })
    expect(tape).toEqual([])
  })

  it("fails an item whose claim fails for another reason, without releasing it", async () => {
    const { note, tape } = recorder()
    const result = await runRound({ items: items("a") }, {
      ...baseOptions(note),
      claim: () => Effect.fail("issue-claim exited 1")
    })

    expect(result.rows).toEqual([{ id: "a", status: "failed", detail: "claim: issue-claim exited 1" }])
    expect(tape).toEqual([])
  })

  it("releases a claim after the work fails, and one failure leaves its siblings running", async () => {
    const { note, tape } = recorder()
    const result = await runRound({ items: items("a", "b") }, {
      ...baseOptions(note),
      work: ({ item }) =>
        item.id === "a"
          ? Effect.fail(new Error("agent exited 2"))
          : Effect.as(Effect.andThen(Effect.sleep("5 millis"), note("work:b")), "ok")
    })

    expect(result.rows).toEqual([
      { id: "a", status: "failed", detail: "work: agent exited 2" },
      { id: "b", status: "landed", detail: "" }
    ])
    expect(tape).toEqual(["claim:a", "claim:b", "work:b", "release:a:failed", "release:b:landed"])
  })

  it("appends a release failure to the row without changing its status", async () => {
    const { note } = recorder()
    const result = await runRound({ items: items("a", "b") }, {
      ...baseOptions(note),
      work: ({ item }) => item.id === "a" ? Effect.fail("boom") : Effect.succeed("ok"),
      release: ({ item }) => Effect.fail(`label ${item.id} not removed`)
    })

    expect(result.rows).toEqual([
      { id: "a", status: "failed", detail: "work: boom; release: label a not removed" },
      { id: "b", status: "landed", detail: "release: label b not removed" }
    ])
  })

  it("fails only the item whose work was interrupted from inside", async () => {
    const { note, tape } = recorder()
    const result = await runRound({ items: items("a", "b") }, {
      ...baseOptions(note),
      work: ({ item }) => item.id === "a" ? Effect.interrupt : Effect.succeed(`fixed ${item.id}`),
      detail: (output: string) => output
    })

    expect(result.rows).toEqual([
      { id: "a", status: "failed", detail: "work: interrupted" },
      { id: "b", status: "landed", detail: "fixed b" }
    ])
    expect(tape.filter((entry) => entry.startsWith("release:"))).toEqual(["release:a:failed", "release:b:landed"])
  })

  it("stops the whole round, releasing every claim, when the round itself is interrupted", async () => {
    const { note, tape } = recorder()
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          Burndown.round({ input: undefined, round: 0, items: items("a") }, {
            ...baseOptions(note),
            work: () => Effect.never
          })
        )
        yield* Effect.yieldNow
        yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      })
    )

    expect(Exit.isSuccess(exit) && Exit.hasInterrupts(exit.value)).toBe(true)
    expect(tape).toEqual(["claim:a", "release:a:failed"])
  })

  it("still releases every claim when a member dies", async () => {
    const { note, tape } = recorder()
    const details: Array<string> = []
    const exit = await Effect.runPromiseExit(
      Burndown.round({ input: undefined, round: 0, items: items("a", "b") }, {
        ...baseOptions(note),
        concurrency: 1,
        work: ({ item }) => item.id === "b" ? Effect.die("agent crashed") : Effect.succeed("ok"),
        release: ({ detail, item, status }) =>
          Effect.andThen(note(`release:${item.id}:${status}`), Effect.sync(() => void details.push(detail)))
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(tape).toEqual(["claim:a", "claim:b", "release:a:failed", "release:b:failed"])
    expect(details).toEqual(["round died", "round died"])
  })

  it("lands worked items one at a time, in discovery order, and quarantines a failed landing", async () => {
    const { note, tape } = recorder()
    let inFlight = 0
    let widest = 0
    const result = await runRound({ items: items("a", "b", "c") }, {
      ...baseOptions(note),
      land: ({ item, output }) =>
        Effect.gen(function*() {
          inFlight += 1
          widest = Math.max(widest, inFlight)
          yield* Effect.sleep("2 millis")
          inFlight -= 1
          yield* note(`land:${item.id}:${output}`)
          if (item.id === "b") return yield* Effect.fail("merge conflict")
        }),
      detail: (output: string) => output
    })

    expect(result.rows).toEqual([
      { id: "a", status: "landed", detail: "fixed a" },
      { id: "b", status: "failed", detail: "land: merge conflict" },
      { id: "c", status: "landed", detail: "fixed c" }
    ])
    expect(widest).toBe(1)
    expect(tape.filter((entry) => entry.startsWith("land:"))).toEqual([
      "land:a:fixed a",
      "land:b:fixed b",
      "land:c:fixed c"
    ])
    expect(tape.filter((entry) => entry.startsWith("release:"))).toEqual([
      "release:a:landed",
      "release:b:failed",
      "release:c:landed"
    ])
  })

  it("hands what land answered to detail, and each row's detail to release", async () => {
    const { note, tape } = recorder()
    const result = await runRound({ items: items("a", "b") }, {
      ...baseOptions(note),
      land: ({ item }): Effect.Effect<string, string> =>
        item.id === "a" ? Effect.succeed(`rev-${item.id}`) : Effect.fail("checks red"),
      detail: (output: string, landing: string | undefined) => `${output} as ${landing}`,
      release: ({ detail, item, status }) => note(`release:${item.id}:${status}:${detail}`)
    })

    expect(result.rows).toEqual([
      { id: "a", status: "landed", detail: "fixed a as rev-a" },
      { id: "b", status: "failed", detail: "land: checks red" }
    ])
    expect(tape.filter((entry) => entry.startsWith("release:"))).toEqual([
      "release:a:landed:fixed a as rev-a",
      "release:b:failed:land: checks red"
    ])
  })

  it("renders a landed detail with no landing when there is no land member", async () => {
    const seen: Array<unknown> = []
    const { note } = recorder()
    await runRound({ items: items("a") }, {
      ...baseOptions(note),
      detail: (output: string, landing: unknown) => {
        seen.push(landing)
        return output
      }
    })

    expect(seen).toEqual([undefined])
  })

  it("skips the merge queue when nothing worked", async () => {
    const { note, tape } = recorder()
    const result = await runRound({ items: items("a") }, {
      ...baseOptions(note),
      work: () => Effect.fail("boom"),
      land: () => note("land")
    })

    expect(result.rows).toEqual([{ id: "a", status: "failed", detail: "work: boom" }])
    expect(tape).not.toContain("land")
  })

  it("never runs more than concurrency items at once", async () => {
    let inFlight = 0
    let widest = 0
    const { note } = recorder()
    const result = await runRound({ items: items("a", "b", "c", "d", "e", "f") }, {
      ...baseOptions(note),
      concurrency: 2,
      work: () =>
        Effect.gen(function*() {
          inFlight += 1
          widest = Math.max(widest, inFlight)
          yield* Effect.sleep("3 millis")
          inFlight -= 1
          return "ok"
        })
    })

    expect(result.launched).toBe(6)
    expect(widest).toBe(2)
  })

  it("launches only as many items as the capacity has slots and defers the rest", async () => {
    const { note, tape } = recorder()
    const result = await runRound({ items: items("a", "b", "c"), slots: 2 }, baseOptions(note))

    expect(result).toEqual({
      rows: [{ id: "a", status: "landed", detail: "" }, { id: "b", status: "landed", detail: "" }],
      launched: 2,
      deferred: 1
    })
    expect(tape).not.toContain("claim:c")
  })

  it("snapshots item ids at the call", async () => {
    const { note } = recorder()
    const backlog = [{ id: "a" }]
    const effect = Burndown.round({ input: undefined, round: 0, items: backlog }, baseOptions(note))
    ;(backlog[0] as { id: string }).id = "z"
    backlog.push({ id: "b" })

    expect((await Effect.runPromise(effect)).rows.map((row) => row.id)).toEqual(["a"])
  })

  it("refuses a malformed round before any member runs", async () => {
    const refusals = [
      [{}, { key: " " }, "invalid_decorator", "Burndown key must be a nonblank string"],
      [{}, { key: 3 }, "invalid_decorator", "Burndown key must be a nonblank string"],
      [{}, { concurrency: 0 }, "invalid_decorator", "Burndown concurrency must be a positive safe integer, received 0"],
      [{ round: -1 }, {}, "invalid_input", "Burndown round must be a non-negative safe integer"],
      [{ round: "1" }, {}, "invalid_input", "Burndown round must be a non-negative safe integer"],
      [{ round: 0.5 }, {}, "invalid_input", "Burndown round must be a non-negative safe integer"],
      [{ slots: 0 }, {}, "invalid_input", "Burndown slots must be a positive safe integer"],
      [{ slots: "2" }, {}, "invalid_input", "Burndown slots must be a positive safe integer"],
      [{ settled: "a" }, {}, "invalid_input", "Burndown settled must be an array of item ids"],
      [{ items: { a: 1 } }, {}, "invalid_input", "Burndown items must be an array"],
      [{ items: [{ id: "" }] }, {}, "invalid_input", "Burndown items must each have a nonblank string id"],
      [{ items: [{ id: 1 }] }, {}, "invalid_input", "Burndown items must each have a nonblank string id"],
      [{ items: [null] }, {}, "invalid_input", "Burndown items must each have a nonblank string id"],
      [
        { items: [Object.create({ id: "inherited" })] },
        {},
        "invalid_input",
        "Burndown items must each have a nonblank string id"
      ],
      [{ items: [{ id: "a" }, { id: "a" }] }, {}, "invalid_input", "Burndown item ids must be unique, \"a\" repeats"]
    ] as const
    for (const [input, options, code, message] of refusals) {
      const error = await refusedRound(input, options)
      expect(error).toBeInstanceOf(PatternError)
      expect(error).toMatchObject({ code, message })
    }
  })
})

// The work flow a restart must reattach to: its one action counts how often it
// really ran, so a duplicate child is visible.
const workRuns: Array<string> = []

const Fix = Action.make("burndown-test/fix", {
  payload: { issue: Schema.String },
  success: Schema.String
})

const Work = Flow.make("burndown-test/work", {
  payload: { issue: Schema.String },
  success: Schema.String,
  body: ({ issue }) => Fix.call({ issue })
})

const fixLayer = Fix.toLayer(({ issue }) =>
  Effect.sync(() => {
    workRuns.push(issue)
    return `fixed ${issue}`
  })
)

const host = (flow: unknown, ...layers: ReadonlyArray<Layer.Layer<any, any, any>>) =>
  Layer.mergeAll(Interpreter.layer(flow as never), Sleep.layer, WaitFor.layer, ...layers).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  ) as Layer.Layer<any, never, never>

describe("Burndown.child", () => {
  it("runs work under the derived execution id, so a rerun reattaches instead of duplicating", async () => {
    workRuns.length = 0
    const { note } = recorder()
    const options = {
      ...baseOptions(note),
      key: "issue-sweep/acme",
      work: Burndown.child(Work, ({ item }: Burndown.ItemArgs<unknown, Issue>) => ({ issue: item.id })),
      detail: (output: string) => output
    }
    const twice = Effect.gen(function*() {
      const first = yield* Burndown.round({ input: undefined, round: 0, items: items("1", "2") }, options)
      // The process died before the round was recorded: the rerun claims again
      // and reaches the same child executions.
      const second = yield* Burndown.round({ input: undefined, round: 0, items: items("1", "2") }, options)
      const id = yield* Work.executionId({ issue: "1" })
      return { first, second, id }
    })
    const { first, second } = await Effect.runPromise(
      twice.pipe(Effect.provide(host(Work, fixLayer)), Effect.scoped) as Effect.Effect<any>
    )

    expect(first.rows).toEqual([
      { id: "1", status: "landed", detail: "fixed 1" },
      { id: "2", status: "landed", detail: "fixed 2" }
    ])
    expect(second.rows).toEqual(first.rows)
    expect(workRuns.sort()).toEqual(["1", "2"])
  })
})

// The declared lineage. Members are actions answering from a per-test script,
// because a body builds once and cannot see a run-time answer.
const Discover = Action.make("burndown-test/discover", {
  payload: { input: Schema.Unknown, round: Schema.Number },
  success: Schema.Unknown
})

const Capacity = Action.make("burndown-test/capacity", {
  payload: { input: Schema.Unknown, round: Schema.Number },
  success: Schema.Unknown
})

const Dispatch = Burndown.dispatch("burndown-test/dispatch")

interface Script {
  readonly discover: (round: number) => ReadonlyArray<Issue>
  readonly capacity?: (call: number) => unknown
  readonly work?: (item: Issue) => Effect.Effect<string, string>
  readonly claim?: (item: Issue) => Effect.Effect<void, string | Burndown.Held>
  readonly select?: (item: Issue, round: number) => Burndown.Selection
}

const scripted = (script: Script) => {
  const { note, tape } = recorder()
  let capacityCalls = 0
  const layers = [
    Discover.toLayer(({ round }) => Effect.as(note(`discover:${round}`), script.discover(round))),
    Capacity.toLayer(({ round }) =>
      Effect.as(note(`capacity:${round}`), script.capacity === undefined ? undefined : script.capacity(capacityCalls++))
    ),
    Burndown.layer(Dispatch, {
      key: "test",
      concurrency: 2,
      ...(script.select === undefined ? {} : {
        select: ({ item, round }: Burndown.ItemArgs<unknown, Issue>) => Effect.succeed(script.select!(item, round))
      }),
      claim: ({ item }) => Effect.andThen(note(`claim:${item.id}`), script.claim?.(item) ?? Effect.void),
      work: ({ item, round }) =>
        Effect.andThen(note(`work:${item.id}@${round}`), script.work?.(item) ?? Effect.succeed("ok")),
      release: ({ item, status }) => note(`release:${item.id}:${status}`)
    })
  ]
  return { tape, layers }
}

let executions = 0

const settle = (flow: Burndown.BurndownFlow, payload: unknown, layers: ReadonlyArray<Layer.Layer<any, any, any>>) =>
  Effect.runPromise(
    (flow.execute(payload as never, { executionId: `burndown-${++executions}` }) as Effect.Effect<any, any, any>).pipe(
      Effect.provide(host(flow, ...layers)),
      Effect.scoped
    ) as Effect.Effect<Burndown.Result>
  )

describe("Burndown.make", () => {
  it("rediscovers the backlog each round until a round launches nothing", async () => {
    const backlog: Record<number, ReadonlyArray<Issue>> = {
      0: items("a", "b"),
      1: items("a", "b", "c"),
      2: items("a", "b", "c")
    }
    const { layers, tape } = scripted({ discover: (round) => backlog[round] ?? [] })
    const burndown = Burndown.make({ discover: Discover, dispatch: Dispatch, maxRounds: 10 })

    expect(burndown._tag).toBe("burndown(maxRounds=10, capacity=false)")
    expect(await settle(burndown, { input: { repo: "acme/app" } }, layers)).toEqual({
      rows: [
        { id: "a", status: "landed", detail: "" },
        { id: "b", status: "landed", detail: "" },
        { id: "c", status: "landed", detail: "" }
      ],
      rounds: 3,
      stopped: "drained"
    })
    expect(tape.filter((entry) => entry.startsWith("discover:"))).toEqual(["discover:0", "discover:1", "discover:2"])
    expect(tape.filter((entry) => entry.startsWith("work:"))).toEqual(["work:a@0", "work:b@0", "work:c@1"])
  })

  it("never retries a held or failed item in a later round, and keeps reconsidering a skipped one", async () => {
    const { layers, tape } = scripted({
      discover: (round) => round < 3 ? items("held", "broken", "fresh") : [],
      claim: (item) => item.id === "held" ? Effect.fail(new Burndown.Held({ message: "mac-mini" })) : Effect.void,
      work: (item) => item.id === "broken" ? Effect.fail("tests red") : Effect.succeed("ok")
    })
    const burndown = Burndown.make({ discover: Discover, dispatch: Dispatch, maxRounds: 5 })

    expect(await settle(burndown, { input: null }, layers)).toEqual({
      rows: [
        { id: "held", status: "held", detail: "mac-mini" },
        { id: "broken", status: "failed", detail: "work: tests red" },
        { id: "fresh", status: "landed", detail: "" }
      ],
      rounds: 2,
      stopped: "drained"
    })
    expect(tape.filter((entry) => entry.startsWith("claim:"))).toEqual(["claim:held", "claim:broken", "claim:fresh"])
  })

  it("replaces a skipped row once a later round calls the item ours", async () => {
    const { layers } = scripted({
      discover: () => items("a", "b"),
      select: (item, round) => item.id === "b" && round === 0 ? Burndown.skip("claimed elsewhere") : Burndown.ours
    })
    const burndown = Burndown.make({ discover: Discover, dispatch: Dispatch, maxRounds: 5 })

    expect(await settle(burndown, { input: null }, layers)).toEqual({
      rows: [{ id: "a", status: "landed", detail: "" }, { id: "b", status: "landed", detail: "" }],
      rounds: 3,
      stopped: "drained"
    })
  })

  it("keeps a settled row final even when a dispatch reports the item again", async () => {
    const Replaying = Burndown.dispatch("burndown-test/replaying-dispatch")
    const { layers } = scripted({ discover: () => items("a") })
    const burndown = Burndown.make({ discover: Discover, dispatch: Replaying, maxRounds: 3 })
    const replaying = Replaying.toLayer(({ round }) =>
      Effect.succeed(
        round === 0
          ? { rows: [{ id: "a", status: "landed" as const, detail: "first" }], launched: 1, deferred: 0 }
          : { rows: [{ id: "a", status: "failed" as const, detail: "again" }], launched: 0, deferred: 0 }
      )
    )

    expect(await settle(burndown, { input: null }, [...layers, replaying])).toEqual({
      rows: [{ id: "a", status: "landed", detail: "first" }],
      rounds: 2,
      stopped: "drained"
    })
  })

  it("stops at the round budget", async () => {
    const { layers } = scripted({ discover: (round) => items(`item-${round}`) })
    const burndown = Burndown.make({ discover: Discover, dispatch: Dispatch, maxRounds: 2, name: "sweep" })

    expect(burndown._tag).toBe("sweep")
    expect(await settle(burndown, { input: null }, layers)).toEqual({
      rows: [
        { id: "item-0", status: "landed", detail: "" },
        { id: "item-1", status: "landed", detail: "" }
      ],
      rounds: 2,
      stopped: "max_rounds"
    })
  })

  it("launches only the capacity's slots and picks the rest up next round", async () => {
    const { layers, tape } = scripted({
      discover: () => items("a", "b", "c"),
      capacity: () => Burndown.available(2)
    })
    const burndown = Burndown.make({ discover: Discover, dispatch: Dispatch, capacity: Capacity, maxRounds: 5 })

    const result = await settle(burndown, { input: null }, layers)
    expect(result.rows.map((row) => row.status)).toEqual(["landed", "landed", "landed"])
    expect(result).toMatchObject({ rounds: 3, stopped: "drained" })
    expect(tape.filter((entry) => entry.startsWith("work:"))).toEqual(["work:a@0", "work:b@0", "work:c@1"])
  })

  it("sleeps until the capacity's reset instant, then asks again", async () => {
    const { layers, tape } = scripted({
      discover: () => items("a"),
      capacity: (call) => call === 0 ? Burndown.waitUntil(Date.now() + 20) : Burndown.available(1)
    })
    const burndown = Burndown.make({ discover: Discover, dispatch: Dispatch, capacity: Capacity, maxRounds: 5 })
    const started = Date.now()

    const result = await settle(burndown, { input: null }, layers)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
    expect(result).toEqual({ rows: [{ id: "a", status: "landed", detail: "" }], rounds: 3, stopped: "drained" })
    expect(tape.slice(0, 3)).toEqual(["capacity:0", "capacity:1", "discover:1"])
  })

  it("parks on exhausted capacity without launching, and resumes when the operator signals", async () => {
    const { layers, tape } = scripted({
      discover: () => items("a"),
      capacity: (call) => call === 0 ? Burndown.exhausted("every account is out of credit") : Burndown.available(1)
    })
    const burndown = Burndown.make({
      discover: Discover,
      dispatch: Dispatch,
      capacity: Capacity,
      maxRounds: 5,
      signal: "accounts-reset"
    })
    const executionId = `burndown-park-${++executions}`
    const program = Effect.gen(function*() {
      yield* burndown.execute({ input: null }, { executionId, discard: true })
      let parked = Option.none<Flow.Result<unknown, unknown>>()
      for (let turn = 0; turn < 50 && Option.isNone(parked); turn++) {
        yield* Effect.sleep("1 millis")
        parked = yield* burndown.poll(executionId)
        if (Option.isSome(parked) && parked.value._tag !== "Suspended") break
        if (Option.isSome(parked)) break
      }
      expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
      // Parked: nothing was discovered or launched.
      expect(tape).toEqual(["capacity:0"])

      const gate = Burndown.signal("accounts-reset")
      const token = DurableDeferred.tokenFromExecutionId(gate, { flow: burndown, executionId })
      yield* DurableDeferred.succeed(gate, { token, value: { reset: true } })
      return yield* burndown.execute({ input: null }, { executionId })
    })
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(host(burndown, ...layers)),
        Effect.scoped
      ) as Effect.Effect<any>
    )

    expect(result).toEqual({ rows: [{ id: "a", status: "landed", detail: "" }], rounds: 3, stopped: "drained" })
    expect(tape).toEqual([
      "capacity:0",
      "capacity:1",
      "discover:1",
      "claim:a",
      "work:a@1",
      "release:a:landed",
      "capacity:2",
      "discover:2"
    ])
  })

  it("settles at the budget when a park spends the last round", async () => {
    const { layers, tape } = scripted({
      discover: () => items("a"),
      capacity: () => Burndown.waitUntil(0)
    })
    const burndown = Burndown.make({ discover: Discover, dispatch: Dispatch, capacity: Capacity, maxRounds: 1 })

    expect(await settle(burndown, { input: null }, layers)).toEqual({ rows: [], rounds: 1, stopped: "max_rounds" })
    expect(tape).toEqual(["capacity:0"])
  })

  it("dies when the capacity member breaks its contract", async () => {
    const { layers, tape } = scripted({ discover: () => items("a"), capacity: () => ({ _tag: "Available", slots: 0 }) })
    const burndown = Burndown.make({ discover: Discover, dispatch: Dispatch, capacity: Capacity, maxRounds: 2 })

    await expect(settle(burndown, { input: null }, layers)).rejects.toBeDefined()
    expect(tape).toEqual(["capacity:0"])
  })

  it("dies when the dispatch member breaks its contract", async () => {
    const Broken = Action.make("burndown-test/broken-dispatch", {
      payload: Burndown.DispatchPayload,
      success: Schema.Unknown
    })
    const { layers } = scripted({ discover: () => items("a") })
    const burndown = Burndown.make({ discover: Discover, dispatch: Broken, maxRounds: 2 })

    await expect(
      settle(burndown, { input: null }, [...layers, Broken.toLayer(() => Effect.succeed({ rows: "none" }))])
    ).rejects.toBeDefined()
  })

  it("accepts a lineage deadline and a description", () => {
    const burndown = Burndown.make({
      discover: Discover,
      dispatch: Dispatch,
      maxRounds: 3,
      deadline: "6 hours",
      description: "Work every open issue."
    })

    expect(burndown.description).toBe("Work every open issue.")
    expect(burndown.deadline).toBeDefined()
  })

  it("refuses a declaration it cannot bound", () => {
    const base = { discover: Discover, dispatch: Dispatch }
    for (const maxRounds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(() => Burndown.make({ ...base, maxRounds })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: "Burndown maxRounds must be a positive safe integer below Number.MAX_SAFE_INTEGER"
        })
      )
    }
    for (const deadline of ["0 millis", "Infinity", "soon"] as const) {
      expect(() => Burndown.make({ ...base, maxRounds: 1, deadline: deadline as never })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: "Burndown deadline must be a positive finite duration"
        })
      )
    }
    expect(() => Burndown.make({ ...base, maxRounds: 1, signal: " " })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Burndown signal must be a nonblank name" })
    )
  })

  it("names the operator signal through WaitFor", () => {
    expect(Burndown.signal().name).toBe(`WaitFor/${Burndown.DefaultSignal}`)
    expect(Burndown.signal("reset").name).toBe("WaitFor/reset")
  })

  it("builds a dispatch action whose answer decodes as a round result", () => {
    expect(Dispatch.name).toBe("burndown-test/dispatch")
    expect(Dispatch.nondeterministic).toBe(true)
    expect(Node.isNode(Dispatch.call({ input: null, round: 0, items: [], settled: [] }))).toBe(true)
  })
})
