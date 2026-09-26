import * as Evaluator from "@smthrs/model/Evaluator"
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import * as Monitors from "../src/monitors.ts"
import * as Runtime from "../src/runtime.ts"
import * as Session from "../src/session.ts"

/** A fake world: the source says what `values` holds next, Jev and Luna answer from scripts. */
const harness = (options: {
  readonly values: Array<string>
  readonly judge?: (input: Monitors.Judged) => Promise<boolean>
  readonly compose?: (input: Monitors.Judged) => Promise<string>
  readonly judged?: boolean
  readonly restored?: ReadonlyArray<Monitors.Monitor>
  readonly authorize?: (monitor: Monitors.Monitor) => Promise<void>
}) => {
  const records: Array<Session.Record> = []
  const delivered: Array<Monitors.Delivery> = []
  const judgeCalls: Array<Monitors.Judged> = []
  const composeCalls: Array<Monitors.Judged> = []
  const listeners = new Set<() => void>()
  const scheduled: Array<() => void> = []
  let index = 0
  const observed: Array<Monitors.Source> = []
  const monitors = new Monitors.Monitors({
    judged: options.judged ?? true,
    observe: async (source) => {
      observed.push(source)
      return options.values[Math.min(index++, options.values.length - 1)]!
    },
    judge: async (input) => {
      judgeCalls.push(input)
      return options.judge === undefined ? true : options.judge(input)
    },
    compose: async (input) => {
      composeCalls.push(input)
      return options.compose === undefined ? "The build broke on main." : options.compose(input)
    },
    deliver: (delivery) => delivered.push(delivery),
    persist: (record) => records.push(record),
    subscribe: (_source, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    every: (_ms, run) => {
      scheduled.push(run)
      return () => {}
    },
    settleMs: 0,
    ...(options.restored === undefined ? {} : { restored: options.restored }),
    ...(options.authorize === undefined ? {} : { authorize: options.authorize })
  })
  return { monitors, records, delivered, judgeCalls, composeCalls, listeners, scheduled, observed }
}

const watchTab = { id: "ci", title: "CI", watch: "the build fails", source: { kind: "tab" as const, id: "build" } }

describe("monitor ticks", () => {
  it("delivers exactly one Luna update when Jev calls the change notable", async () => {
    const world = harness({ values: ["green", "red", "red"] })
    expect(world.monitors.create(watchTab)).toEqual({ id: "ci", status: "active" })
    await world.monitors.tick("ci") // baseline: nothing to judge yet
    expect(world.judgeCalls).toHaveLength(0)
    await world.monitors.tick("ci")
    await world.monitors.tick("ci") // unchanged: Jev is not asked again
    expect(world.judgeCalls).toHaveLength(1)
    expect(world.judgeCalls[0]).toMatchObject({ watch: "the build fails", before: "green", after: "red" })
    expect(world.composeCalls).toHaveLength(1)
    expect(world.delivered).toEqual([
      { _tag: "update", id: "ci", title: "CI", text: "The build broke on main.", at: expect.any(Number) }
    ])
    expect(world.monitors.list()[0]).toMatchObject({ id: "ci", status: "active", updates: 1 })
    expect(world.records.filter((record) => record.type === "monitor-update")).toHaveLength(1)
  })

  it("delivers nothing and never asks Luna when Jev calls the change routine", async () => {
    const world = harness({ values: ["a", "b", "c"], judge: async () => false })
    world.monitors.create(watchTab)
    await world.monitors.tick("ci")
    await world.monitors.tick("ci")
    await world.monitors.tick("ci")
    expect(world.judgeCalls).toHaveLength(2)
    expect(world.composeCalls).toHaveLength(0)
    expect(world.delivered).toEqual([])
    expect(world.monitors.list()[0]).toMatchObject({ status: "active", updates: 0 })
  })

  it("fails visibly and typed when Jev fails, and stops judging", async () => {
    const world = harness({
      values: ["a", "b", "c"],
      judge: () =>
        Promise.reject(new Monitors.MonitorError({ _tag: "JevFailed", code: "refused", message: "Gateway said 401" }))
    })
    world.monitors.create(watchTab)
    await world.monitors.tick("ci")
    await world.monitors.tick("ci")
    await world.monitors.tick("ci")
    expect(world.judgeCalls).toHaveLength(1)
    expect(world.composeCalls).toHaveLength(0)
    expect(world.delivered).toEqual([{
      _tag: "failed",
      id: "ci",
      title: "CI",
      failure: { _tag: "JevFailed", code: "refused", message: "Gateway said 401" },
      at: expect.any(Number)
    }])
    expect(world.monitors.list()[0]).toMatchObject({
      status: "failed",
      failure: { _tag: "JevFailed", code: "refused" }
    })
  })

  it("types a Luna failure and a source failure", async () => {
    const luna = harness({ values: ["a", "b"], compose: () => Promise.reject(new Error("429")) })
    luna.monitors.create(watchTab)
    await luna.monitors.tick("ci")
    await luna.monitors.tick("ci")
    expect(luna.delivered[0]).toMatchObject({ _tag: "failed", failure: { _tag: "LunaFailed", message: "429" } })

    const source = harness({ values: [] })
    source.monitors.create(watchTab)
    await source.monitors.tick("ci")
    expect(source.delivered[0]).toMatchObject({ _tag: "failed", failure: { _tag: "SourceFailed" } })
  })

  it("refuses to create a monitor when this host has no Jev", () => {
    const world = harness({ values: ["a"], judged: false })
    expect(() => world.monitors.create(watchTab)).toThrow(Monitors.MonitorError)
    try {
      world.monitors.create(watchTab)
    } catch (error) {
      expect((error as Monitors.MonitorError).failure).toMatchObject({ _tag: "JevFailed", code: "unreachable" })
    }
    expect(world.records).toEqual([])
  })
})

describe("monitor lifecycle", () => {
  it("acknowledges before observing, deduplicates by id, and rejects a changed definition", () => {
    const world = harness({ values: ["a"] })
    expect(world.monitors.create(watchTab)).toEqual({ id: "ci", status: "active" })
    expect(world.monitors.create(watchTab)).toEqual({ id: "ci", status: "active" })
    expect(() => world.monitors.create({ ...watchTab, watch: "tests pass" })).toThrow("another monitor")
    expect(world.records[0]).toMatchObject({ type: "monitor", monitor: { id: "ci", status: "active" } })
  })

  it("needs an interval for a shell source and bounds it", () => {
    const world = harness({ values: ["a"] })
    const shell = {
      id: "log",
      title: "Log",
      watch: "an error",
      source: { kind: "shell" as const, command: "tail -5 x.log" }
    }
    expect(() => world.monitors.create({ ...shell, trigger: { kind: "events" } })).toThrow("interval")
    expect(() => world.monitors.create({ ...shell, trigger: { kind: "interval", seconds: 1 } })).toThrow("10")
    expect(world.monitors.create(shell)).toEqual({ id: "log", status: "active" })
    expect(world.monitors.list()[0]!.trigger).toEqual({ kind: "interval", seconds: 60 })
    expect(world.scheduled).toHaveLength(1)
  })

  it("ticks on source events", async () => {
    const world = harness({ values: ["a", "b"] })
    world.monitors.create(watchTab)
    expect(world.listeners.size).toBe(1)
    for (const listener of world.listeners) listener()
    await Bun.sleep(5)
    for (const listener of world.listeners) listener()
    await Bun.sleep(5)
    expect(world.delivered).toHaveLength(1)
  })

  it("stops: no more ticks, unsubscribed, and a failed or stopped monitor restarts by id", async () => {
    const world = harness({ values: ["a", "b", "c"] })
    world.monitors.create(watchTab)
    await world.monitors.tick("ci")
    expect(world.monitors.stop("ci")).toEqual({ id: "ci", status: "stopped" })
    expect(world.listeners.size).toBe(0)
    await world.monitors.tick("ci")
    expect(world.judgeCalls).toHaveLength(0)
    expect(world.monitors.create(watchTab)).toEqual({ id: "ci", status: "active" })
    expect(world.listeners.size).toBe(1)
  })

  it("survives a reload through the session file without re-announcing", async () => {
    const first = harness({ values: ["a", "b"] })
    first.monitors.create(watchTab)
    await first.monitors.tick("ci")
    await first.monitors.tick("ci")
    const state = Session.restore(first.records)
    expect(state.monitors.map((monitor) => [monitor.id, monitor.status, monitor.seen])).toEqual([["ci", "active", "b"]])
    expect(state.transcript.items.at(-1)).toMatchObject({ kind: "note", text: "CI: The build broke on main." })

    const second = harness({ values: ["b", "c"], restored: state.monitors })
    expect(second.listeners.size).toBe(1)
    await second.monitors.tick("ci") // unchanged since the reload
    expect(second.judgeCalls).toHaveLength(0)
    await second.monitors.tick("ci")
    expect(second.judgeCalls[0]).toMatchObject({ before: "b", after: "c" })
  })
})

/** A promise and its resolver. */
const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(1)
  expect(condition()).toBe(true)
}

describe("restart by id with a tick in flight", () => {
  /** Baseline `a`, then a tick that reads `b` and waits on Jev while the monitor restarts. */
  const restartMidJudge = async () => {
    const verdict = deferred<boolean>()
    let calls = 0
    const world = harness({
      values: ["a", "b", "c", "d"],
      judge: () => ++calls === 1 ? verdict.promise : Promise.resolve(true)
    })
    world.monitors.create(watchTab)
    await world.monitors.tick("ci")
    const stale = world.monitors.tick("ci")
    await until(() => world.judgeCalls.length === 1)
    world.monitors.stop("ci")
    expect(world.monitors.create(watchTab)).toEqual({ id: "ci", status: "active" })
    verdict.resolve(true)
    await stale
    await until(() => world.observed.length === 3)
    await Bun.sleep(1)
    return world
  }

  it("ignores the old generation's verdict", async () => {
    const world = await restartMidJudge()
    expect(world.judgeCalls).toEqual([expect.objectContaining({ before: "a", after: "b" })])
    expect(world.composeCalls).toEqual([])
    expect(world.delivered).toEqual([])
    expect(world.monitors.list()[0]).toMatchObject({ status: "active", updates: 0 })
  })

  it("still takes the new generation's baseline, so the first change after it is judged", async () => {
    const world = await restartMidJudge()
    const saved = world.records.flatMap((record) => record.type === "monitor" ? [record.monitor] : [])
    expect(saved.at(-1)).toMatchObject({ status: "active", seen: "c" })
    for (const listener of world.listeners) listener()
    await until(() => world.delivered.length === 1)
    expect(world.judgeCalls.at(-1)).toMatchObject({ before: "c", after: "d" })
  })
})

describe("restored shell monitors", () => {
  const shellMonitor: Monitors.Monitor = {
    id: "log",
    title: "Log",
    watch: "an error",
    source: { kind: "shell", command: "tail -5 x.log" },
    trigger: { kind: "interval", seconds: 60 },
    status: "active",
    seen: "ok",
    updates: 0,
    createdAt: 1
  }

  it("never runs the command when the gate refuses it, and fails typed", async () => {
    const world = harness({
      values: ["boom"],
      restored: [shellMonitor],
      authorize: () => Promise.reject(new Error("Denied: monitor.create tail -5 x.log"))
    })
    await until(() => world.delivered.length === 1)
    expect(world.scheduled).toHaveLength(0)
    expect(world.observed).toEqual([])
    expect(world.delivered[0]).toMatchObject({
      _tag: "failed",
      failure: { _tag: "Refused", message: "Denied: monitor.create tail -5 x.log" }
    })
    expect(world.monitors.list()[0]).toMatchObject({ status: "failed", failure: { _tag: "Refused" } })
  })

  it("waits for the gate before arming, and arms once it answers", async () => {
    const gate = deferred<void>()
    const asked: Array<string> = []
    const world = harness({
      values: ["ok"],
      restored: [shellMonitor],
      authorize: (monitor) => {
        asked.push(monitor.id)
        return gate.promise
      }
    })
    await Bun.sleep(5)
    expect(asked).toEqual(["log"])
    expect(world.scheduled).toHaveLength(0)
    expect(world.observed).toEqual([])
    gate.resolve()
    await until(() => world.scheduled.length === 1)
    await until(() => world.observed.length === 1)
  })

  it("drops a late approval for a monitor stopped while it waited", async () => {
    const gate = deferred<void>()
    const world = harness({ values: ["ok"], restored: [shellMonitor], authorize: () => gate.promise })
    world.monitors.stop("log")
    gate.resolve()
    await Bun.sleep(5)
    expect(world.scheduled).toHaveLength(0)
    expect(world.observed).toEqual([])
  })

  it("never gates a tab or run source", () => {
    const asked: Array<string> = []
    const world = harness({
      values: ["a"],
      restored: [{ ...shellMonitor, id: "ci", source: { kind: "tab", id: "build" }, trigger: { kind: "events" } }],
      authorize: async (monitor) => void asked.push(monitor.id)
    })
    expect(asked).toEqual([])
    expect(world.listeners.size).toBe(1)
  })
})

describe("Jev adapter", () => {
  const evaluate = (layer: Layer.Layer<Evaluator.Evaluator>) => (request: Evaluator.Request) =>
    Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* Evaluator.Evaluator).evaluate(request)
      }).pipe(Effect.provide(layer))
    )

  it("asks one boolean question and reads its value", async () => {
    let asked: Evaluator.Request | undefined
    const judge = Monitors.jev(evaluate(Evaluator.layerScripted((request) => {
      asked = request
      return { notable: { probability: 0.9 } }
    })))
    expect(await judge({ watch: "the build fails", before: "green", after: "red" })).toBe(true)
    expect(asked!.state).toEqual({ watching: "the build fails", before: "green", after: "red" })
    expect(asked!.questions.notable!.type).toBe("boolean")
    const quiet = Monitors.jev(evaluate(Evaluator.layerScripted(() => ({ notable: { probability: 0.1 } }))))
    expect(await quiet({ watch: "x", before: "a", after: "b" })).toBe(false)
  })

  it("maps an evaluator failure to a typed JevFailed with its code", async () => {
    const judge = Monitors.jev(evaluate(Evaluator.layerUnavailable()))
    const error = await judge({ watch: "x", before: "a", after: "b" }).catch((error) => error)
    expect(error).toBeInstanceOf(Monitors.MonitorError)
    expect(error.failure).toEqual({ _tag: "JevFailed", code: "unreachable", message: Evaluator.unreachableMessage })
  })
})

describe("runtime flows", () => {
  it("binds monitor.create, monitor.list and monitor.stop only when the host offers monitors", async () => {
    const names = async (ports: Runtime.Ports) =>
      (await Effect.runPromise(Runtime.source(ports).bindings())).map((binding) => binding.descriptor.name)
    expect(await names({ publish: () => {} })).not.toContain("monitor.create")
    const world = harness({ values: ["a"] })
    expect(await names({ publish: () => {}, monitors: world.monitors })).toEqual(
      expect.arrayContaining(["monitor.create", "monitor.list", "monitor.stop"])
    )
  })

  it("monitor.create returns the receipt at once and a refused create is a failed call", async () => {
    const world = harness({ values: ["a"] })
    const bindings = await Effect.runPromise(Runtime.source({ publish: () => {}, monitors: world.monitors }).bindings())
    const create = bindings.find((binding) => binding.descriptor.name === "monitor.create")!
    const call = {
      input: { id: "ci", title: "CI", watch: "the build fails", source: { kind: "tab", id: "build" } }
    } as unknown as Parameters<typeof create.run>[0]
    const result = await Effect.runPromise(create.run(call))
    expect(result.outcome).toBe("success")
    expect(world.monitors.list()).toHaveLength(1)
    const off = harness({ values: ["a"], judged: false })
    const refused = (await Effect.runPromise(Runtime.source({ publish: () => {}, monitors: off.monitors }).bindings()))
      .find((binding) => binding.descriptor.name === "monitor.create")!
    const failed = await Effect.runPromise(refused.run(call))
    expect(failed.outcome).toBe("failure")
    // The cell reads the failure's tag and code, not prose alone.
    expect(failed.message).toBe(
      "Flow monitor.create failed: JevFailed (unreachable): Jev is unavailable: set AI_GATEWAY_API_KEY"
    )
  })

  it("monitor.create declares proc:spawn, so the approval gate sees it; list and stop declare nothing", async () => {
    const world = harness({ values: ["a"] })
    const bindings = await Effect.runPromise(Runtime.source({ publish: () => {}, monitors: world.monitors }).bindings())
    const declared = (name: string) =>
      bindings.find((binding) => binding.descriptor.name === name)!.descriptor.capabilities
    expect(declared("monitor.create")).toEqual(["proc:spawn:*"])
    expect(declared("monitor.list")).toEqual([])
    expect(declared("monitor.stop")).toEqual([])
  })
})

describe("observer", () => {
  const observe = Monitors.observer({
    tab: () => ({ status: "running", summary: "Fixing.", turns: [{ label: "Read app.tsx", status: "done" }] }),
    run: () => ({ status: "failed", message: "exit 1", steps: [{ label: "build", status: "failed" }] }),
    shell: async (command) => ({ output: `ran ${command}`, exitCode: 2 })
  })
  it("reads tabs, runs and shell output as text", async () => {
    expect(await observe({ kind: "tab", id: "t" })).toBe("status: running\nsummary: Fixing.\n- done Read app.tsx")
    expect(await observe({ kind: "run", id: "r" })).toBe("status: failed\nmessage: exit 1\n- failed build")
    expect(await observe({ kind: "shell", command: "make" })).toBe("ran make\n(exit 2)")
  })
})

describe("chat surfaces", () => {
  it("shows a monitor failure as an error row that does not stop the chat summary", async () => {
    const Summary = await import("../src/summary.ts")
    const Transcript = await import("../src/transcript.ts")
    let transcript = Transcript.user(Transcript.empty, "Watch CI", false, 1)
    transcript = Transcript.alert(transcript, "CI: Jev failed (refused): Gateway said 401", 2)
    expect(transcript.items.at(-1)).toMatchObject({ kind: "error", background: true })
    const summary = Summary.panel(transcript)
    expect(summary.summary).not.toMatch(/^Stopped/)
    expect(summary.rows.at(-1)).toMatchObject({ status: "failed", label: expect.stringContaining("Jev failed") })
  })
})
