import { expect, test } from "bun:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import * as Monitors from "../src/monitors.ts"
import type { Record as SessionRecord } from "../src/session.ts"

const deferred = <A>() => {
  let resolve!: (value: A) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const restored: Monitors.Monitor = {
  id: "log",
  title: "Build",
  watch: "an error",
  source: { kind: "shell", command: "tail build.log" },
  trigger: { kind: "interval", seconds: 60 },
  status: "active",
  seen: "green",
  updates: 2,
  createdAt: 1
}

const harness = (overrides: Partial<Monitors.Ports> = {}) => {
  const records: SessionRecord[] = []
  const deliveries: Monitors.Delivery[] = []
  const observations: Monitors.Source[] = []
  const subscriptions = new Set<() => void>()
  const intervals: Array<{ ms: number; run: () => void }> = []
  const calls: string[] = []
  const monitors = new Monitors.Monitors({
    judged: true,
    observe: async (source) => {
      observations.push(source)
      return "green"
    },
    judge: async () => {
      calls.push("judge")
      return true
    },
    compose: async () => {
      calls.push("compose")
      return "Build failed"
    },
    deliver: (delivery) => {
      deliveries.push(delivery)
      calls.push(`deliver:${delivery._tag}`)
    },
    persist: (record) => {
      records.push(record)
      calls.push(`persist:${record.type}`)
    },
    subscribe: (_source, listener) => {
      subscriptions.add(listener)
      return () => {
        subscriptions.delete(listener)
        calls.push("unsubscribe")
      }
    },
    every: (ms, run) => {
      intervals.push({ ms, run })
      return () => calls.push("unschedule")
    },
    ...overrides
  })
  return { monitors, records, deliveries, observations, subscriptions, intervals, calls }
}

test.each(["resolve", "reject"] as const)("dispose fences a restored authorization's late %s", async (outcome) => {
  const gate = deferred<void>()
  const asked: string[] = []
  const world = harness({
    restored: [restored],
    authorize: (monitor) => {
      asked.push(monitor.id)
      return gate.promise
    }
  })
  try {
    expect(asked).toEqual(["log"])
    expect(world.monitors.list()).toEqual([{
      id: "log",
      title: "Build",
      watch: "an error",
      source: { kind: "shell", command: "tail build.log" },
      trigger: { kind: "interval", seconds: 60 },
      status: "active",
      updates: 2,
      createdAt: 1
    }])
    await world.monitors.dispose()
    if (outcome === "resolve") gate.resolve(undefined)
    else gate.reject(new Error("Late denied"))
    await gate.promise.catch(() => {})
    await nextTurn()
    expect(world.intervals).toEqual([])
    expect(world.observations).toEqual([])
    expect(world.records).toEqual([])
    expect(world.deliveries).toEqual([])
    expect(world.monitors.context()).toBe("[{\"id\":\"log\",\"title\":\"Build\",\"status\":\"active\",\"updates\":2}]")
  } finally {
    gate.resolve(undefined)
    await world.monitors.dispose()
  }
})

test.each(["stopped", "failed"] as const)(
  "restored %s monitors never ask authorization or schedule work",
  async (status) => {
    const asked: string[] = []
    const world = harness({
      restored: [{ ...restored, status }],
      authorize: async (monitor) => {
        asked.push(monitor.id)
      }
    })
    try {
      await world.monitors.tick("log")
      expect(asked).toEqual([])
      expect(world.intervals).toEqual([])
      expect(world.observations).toEqual([])
      expect(world.records).toEqual([])
      expect(world.monitors.stop("log")).toEqual({ id: "log", status })
      expect(world.deliveries).toEqual([])
    } finally {
      await world.monitors.dispose()
    }
  }
)

test.each([new Error("Denied"), "Denied"])(
  "restored authorization failure persists before delivery",
  async (failure) => {
    const gate = deferred<void>()
    const delivered = deferred<void>()
    const records: SessionRecord[] = []
    const deliveries: Monitors.Delivery[] = []
    const order: string[] = []
    const world = harness({
      restored: [restored],
      authorize: () => gate.promise,
      persist: (record) => {
        records.push(record)
        order.push(`persist:${record.type}`)
      },
      deliver: (delivery) => {
        deliveries.push(delivery)
        order.push("deliver")
        delivered.resolve(undefined)
      }
    })
    try {
      gate.reject(failure)
      await delivered.promise
      expect(order).toEqual(["persist:monitor", "persist:monitor-update", "deliver"])
      expect(records).toEqual([
        {
          type: "monitor",
          monitor: {
            ...restored,
            status: "failed",
            failure: { _tag: "Refused", message: "Denied" },
            endedAt: expect.any(Number)
          }
        },
        {
          type: "monitor-update",
          at: expect.any(Number),
          id: "log",
          title: "Build",
          text: "The watch command was not approved.",
          failed: true
        }
      ])
      expect(deliveries).toEqual([{
        _tag: "failed",
        id: "log",
        title: "Build",
        failure: { _tag: "Refused", message: "Denied" },
        at: expect.any(Number)
      }])
      expect(world.monitors.context()).toBe(
        "[{\"id\":\"log\",\"title\":\"Build\",\"status\":\"failed\",\"updates\":2,\"failure\":\"Refused: Denied\"}]"
      )
      expect(world.observations).toEqual([])
      expect(world.intervals).toEqual([])
    } finally {
      await world.monitors.dispose()
    }
  }
)

test("listeners receive the persisted new state and unsubscribe independently", async () => {
  const world = harness()
  const first: string[] = []
  const second: string[] = []
  const stopFirst = world.monitors.subscribe(() => {
    expect(world.records.at(-1)?.type).toBe("monitor")
    first.push(world.monitors.list()[0]!.status)
  })
  const stopSecond = world.monitors.subscribe(() => second.push(world.monitors.list()[0]!.status))
  try {
    expect(world.monitors.create({ id: "tab", title: "Review", watch: "done", source: { kind: "tab", id: "worker" } }))
      .toEqual({ id: "tab", status: "active" })
    await world.monitors.tick("tab")
    stopFirst()
    world.monitors.stop("tab")
    stopSecond()
    stopSecond()
    expect(first).toEqual(["active", "active"])
    expect(second).toEqual(["active", "active", "stopped"])
    expect(world.subscriptions.size).toBe(0)
    expect(world.monitors.context()).toBe(
      "[{\"id\":\"tab\",\"title\":\"Review\",\"status\":\"stopped\",\"updates\":0}]"
    )
  } finally {
    stopFirst()
    stopSecond()
    await world.monitors.dispose()
  }
})

test.each(["resolve", "reject"] as const)(
  "dispose aborts an unresolved observation and drops its late %s",
  async (outcome) => {
    const observation = deferred<string>()
    const admitted = deferred<AbortSignal>()
    const world = harness({
      observe: async (_source, signal) => {
        admitted.resolve(signal)
        return observation.promise
      }
    })
    let closing: Promise<void> | undefined
    try {
      world.monitors.create({ id: "tab", title: "Review", watch: "done", source: { kind: "tab", id: "worker" } })
      const signal = await admitted.promise
      const initialRecords = [...world.records]
      closing = world.monitors.dispose()
      expect(signal.aborted).toBe(true)
      expect(world.subscriptions.size).toBe(0)
      if (outcome === "resolve") observation.resolve("late answer")
      else observation.reject(new Error("late failure"))
      await closing
      expect(world.records).toEqual(initialRecords)
      expect(world.deliveries).toEqual([])
      expect(world.calls).toEqual(["persist:monitor", "unsubscribe"])
      expect(() =>
        world.monitors.create({ id: "next", title: "Next", watch: "done", source: { kind: "tab", id: "other" } })
      )
        .toThrow("Session closed")
    } finally {
      observation.resolve("cleanup")
      await closing
      await world.monitors.dispose()
    }
  }
)

test("an unknown stop refuses without persistence, subscription, or observation", async () => {
  const world = harness()
  try {
    expect(() => world.monitors.stop("missing")).toThrow("Unknown monitor")
    await world.monitors.tick("missing")
    expect(world.records).toEqual([])
    expect(world.deliveries).toEqual([])
    expect(world.observations).toEqual([])
    expect(world.subscriptions.size).toBe(0)
    expect(world.monitors.context()).toBe("[]")
  } finally {
    await world.monitors.dispose()
  }
})

test("a persistence refusal cannot acknowledge creation; recovery admits one subscription", async () => {
  let blocked = true
  const records: SessionRecord[] = []
  const world = harness({
    persist: (record) => {
      if (blocked) throw new Error("Store unavailable")
      records.push(record)
    }
  })
  const request: Monitors.Request = { id: "tab", title: "Review", watch: "done", source: { kind: "tab", id: "worker" } }
  try {
    expect(() => world.monitors.create(request)).toThrow("Store unavailable")
    expect(world.monitors.list()).toEqual([])
    expect(world.subscriptions.size).toBe(0)
    expect(world.observations).toEqual([])
    blocked = false
    expect(world.monitors.create(request)).toEqual({ id: "tab", status: "active" })
    expect(world.monitors.create(request)).toEqual({ id: "tab", status: "active" })
    expect(world.subscriptions.size).toBe(1)
    await world.monitors.tick("tab")
    const admitted: Monitors.Monitor = {
      id: "tab",
      title: "Review",
      watch: "done",
      source: { kind: "tab", id: "worker" },
      trigger: { kind: "events" },
      status: "active",
      updates: 0,
      createdAt: expect.any(Number)
    }
    expect(records).toEqual([
      { type: "monitor", monitor: admitted },
      { type: "monitor", monitor: { ...admitted, seen: "green" } }
    ])
    expect(world.observations).toEqual([{ kind: "tab", id: "worker" }])
    expect(world.deliveries).toEqual([])
  } finally {
    blocked = false
    await world.monitors.dispose()
  }
})

test.each(
  [
    ["judge", "resolve"],
    ["judge", "reject"],
    ["compose", "resolve"],
    ["compose", "reject"]
  ] as const
)("dispose awaits owned %s work and drops its late %s", async (stage, outcome) => {
  const judgeResult = deferred<boolean>()
  const composeResult = deferred<string>()
  const admitted = deferred<void>()
  let reads = 0
  const called: string[] = []
  const world = harness({
    observe: async () => ++reads === 1 ? "green" : "red",
    judge: async () => {
      called.push("judge")
      if (stage === "judge") {
        admitted.resolve(undefined)
        return judgeResult.promise
      }
      return true
    },
    compose: async () => {
      called.push("compose")
      if (stage === "compose") {
        admitted.resolve(undefined)
        return composeResult.promise
      }
      return "Unexpected late composition"
    }
  })
  let closing: Promise<void> | undefined
  try {
    world.monitors.create({ id: "tab", title: "Review", watch: "done", source: { kind: "tab", id: "worker" } })
    await world.monitors.tick("tab")
    const tick = world.monitors.tick("tab")
    await admitted.promise
    expect(called).toEqual(stage === "judge" ? ["judge"] : ["judge", "compose"])
    const before = [...world.records]
    expect(before.at(-1)).toMatchObject({ type: "monitor", monitor: { seen: "green", updates: 0, status: "active" } })
    let closed = false
    closing = world.monitors.dispose().then(() => {
      closed = true
    })
    await nextTurn()
    expect(closed).toBe(false)
    if (stage === "judge") {
      if (outcome === "resolve") judgeResult.resolve(true)
      else judgeResult.reject(new Error("Late judge failure"))
    } else {
      if (outcome === "resolve") composeResult.resolve("Late update")
      else composeResult.reject(new Error("Late composer failure"))
    }
    await tick
    await closing
    await nextTurn()
    expect(closed).toBe(true)
    expect(world.records).toEqual(before)
    expect(world.deliveries).toEqual([])
    expect(world.subscriptions.size).toBe(0)
    expect(world.monitors.context()).toBe("[{\"id\":\"tab\",\"title\":\"Review\",\"status\":\"active\",\"updates\":0}]")
    expect(called).toEqual(stage === "judge" ? ["judge"] : ["judge", "compose"])
  } finally {
    judgeResult.resolve(false)
    composeResult.resolve("cleanup")
    await closing
    await world.monitors.dispose()
  }
})
