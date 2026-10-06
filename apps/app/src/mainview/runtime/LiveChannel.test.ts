import { describe, expect, test } from "bun:test"
import { LiveChannel, type LiveSocket } from "./LiveChannel"

class Socket implements LiveSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  frames: unknown[] = []
  closed = false
  send(raw: string) { this.frames.push(JSON.parse(raw)) }
  close() { this.closed = true }
  open() { this.readyState = 1; this.onopen?.() }
  drop() { this.readyState = 3; this.onclose?.() }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}
const harness = (project?: (topic: string, previous: unknown, delta: unknown) => unknown) => {
  const sockets: Socket[] = []
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const channel = new LiveChannel({
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket },
    random: () => 1, project,
    schedule: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return timer },
    cancel: timer => { (timer as typeof timers[number]).cancelled = true }
  })
  return { channel, sockets, timers }
}

describe("live channel", () => {
  test("private confirmations disappear on disconnect and await a fresh authorized snapshot", () => {
    const { channel, sockets, timers } = harness()
    const release = channel.subscribe("confirmations:17", () => {})
    sockets[0]!.open()
    sockets[0]!.receive({ t: "snap", id: 1, cursor: 8, data: [{ id: "private", state: "pending" }] })
    expect(channel.getSnapshot("confirmations:17")?.data).toEqual([{ id: "private", state: "pending" }])
    sockets[0]!.drop()
    expect(channel.getSnapshot("confirmations:17")).toEqual({ topic: "confirmations:17" })
    timers[0]!.run(); sockets[1]!.open()
    expect(sockets[1]!.frames[0]).toEqual({ t: "sub", id: 1, topic: "confirmations:17" })
    sockets[1]!.receive({ t: "err", id: 1, code: "forbidden" })
    expect(channel.getSnapshot("confirmations:17")?.data).toBeUndefined()
    release(); channel.dispose()
  })
  // T-COL-08 Scope In: unavailable real-stack providers must fail closed.
  test("dark code documents refuse without opening a socket or sending a subscription", () => {
    const { channel, sockets, timers } = harness()
    let notified = 0
    const release = channel.subscribe("doc:code:12:retry.ts", () => notified++)
    expect(channel.getSnapshot("doc:code:12:retry.ts")).toEqual({ topic: "doc:code:12:retry.ts", error: "unsupported" })
    expect(channel.getSnapshot("doc:code:12:retry.ts")?.error).toBe("unsupported")
    expect(notified).toBe(1)
    expect(sockets).toHaveLength(0)
    expect(timers).toHaveLength(0)
    release(); release()
    expect(channel.getSnapshot("doc:code:12:retry.ts")).toBeUndefined()
    expect(channel.getSnapshot("doc:code:12:retry.ts")).toBeUndefined()
    channel.dispose()
  })
  test("dark documents never subscribe on a shared socket or reconnect and do not keep it alive", () => {
    const { channel, sockets, timers } = harness()
    const releaseDoc = channel.subscribe("doc:code:12:retry.ts", () => {})
    const releaseHome = channel.subscribe("home", () => {})
    sockets[0]!.open()
    sockets[0]!.receive({ t: "snap", id: 1, cursor: 1, data: "premature document" })
    sockets[0]!.receive({ t: "gap", id: 1 })
    expect(channel.getSnapshot("doc:code:12:retry.ts")?.error).toBe("unsupported")
    expect(channel.getSnapshot("doc:code:12:retry.ts")?.data).toBeUndefined()
    expect(sockets[0]!.frames).toEqual([{ t: "sub", id: 2, topic: "home" }])
    sockets[0]!.drop(); timers[0]!.run(); sockets[1]!.open()
    expect(sockets[1]!.frames).toEqual([{ t: "sub", id: 2, topic: "home" }])
    releaseHome()
    expect(sockets[1]!.closed).toBe(true)
    releaseDoc()
    expect(sockets[1]!.frames).toEqual([{ t: "sub", id: 2, topic: "home" }, { t: "unsub", id: 2 }])
    channel.dispose()
  })
  test("a code document opened on an active connection stays refused for every reader", () => {
    const { channel, sockets } = harness()
    channel.subscribe("home", () => {})
    sockets[0]!.open()
    let notifications = 0
    const listener = () => notifications++
    const first = channel.subscribe("doc:code:12:retry.ts", listener)
    const held = channel.getSnapshot("doc:code:12:retry.ts")
    const second = channel.subscribe("doc:code:12:retry.ts", listener)
    expect(channel.getSnapshot("doc:code:12:retry.ts")).toBe(held)
    expect(notifications).toBe(1)
    expect(sockets[0]!.frames).toEqual([{ t: "sub", id: 1, topic: "home" }])
    first(); first()
    expect(channel.getSnapshot("doc:code:12:retry.ts")?.error).toBe("unsupported")
    second()
    expect(channel.getSnapshot("doc:code:12:retry.ts")).toBeUndefined()
    expect(sockets[0]!.closed).toBe(false)
    channel.dispose()
    expect(() => channel.subscribe("doc:code:12:retry.ts", listener)).toThrow("disposed")
  })
  test("two Container subscriptions share one socket and one topic; last release unsubscribes", () => {
    const { channel, sockets } = harness()
    let first = 0, second = 0
    const releaseA = channel.subscribe("home", () => first++)
    const releaseB = channel.subscribe("home", () => second++)
    expect(sockets).toHaveLength(1)
    sockets[0]!.open()
    expect(sockets[0]!.frames).toEqual([{ t: "sub", id: 1, topic: "home" }])
    sockets[0]!.receive({ t: "snap", id: 1, cursor: 10, data: { items: [12] } })
    expect([first, second]).toEqual([1, 1])
    expect(channel.getSnapshot("home")?.data).toEqual({ items: [12] })
    releaseA(); releaseA()
    expect(sockets[0]!.frames).toHaveLength(1)
    releaseB()
    expect(sockets[0]!.frames[1]).toEqual({ t: "unsub", id: 1 })
    expect(sockets[0]!.closed).toBe(true)
    channel.dispose()
  })
  test("reconnect resubscribes all active topics with applied cursors and ignores stale sockets", () => {
    const { channel, sockets, timers } = harness((_topic, old, delta) => [...old as number[], ...delta as number[]])
    channel.subscribe("home", () => {})
    channel.subscribe("todo:12", () => {})
    sockets[0]!.open()
    sockets[0]!.receive({ t: "snap", id: 1, cursor: 10, data: [12] })
    sockets[0]!.receive({ t: "delta", id: 1, cursor: 11, data: [13] })
    sockets[0]!.receive({ t: "snap", id: 2, cursor: 20, data: {} })
    sockets[0]!.drop()
    expect(timers[0]!.ms).toBe(250)
    timers[0]!.run(); sockets[1]!.open()
    expect(sockets[1]!.frames).toEqual([{ t: "sub", id: 1, topic: "home", cursor: 11 }, { t: "sub", id: 2, topic: "todo:12", cursor: 20 }])
    sockets[0]!.receive({ t: "snap", id: 1, cursor: 100, data: [] })
    sockets[1]!.receive({ t: "delta", id: 1, cursor: 12, data: [14] })
    expect(channel.getSnapshot("home")?.data).toEqual([12, 13, 14])
    channel.dispose()
  })
  test("gap retains snapshot, rejects deltas until fresh snapshot and omits cursor", () => {
    const { channel, sockets } = harness((_topic, _old, delta) => delta)
    channel.subscribe("home", () => {})
    const socket = sockets[0]!
    socket.open(); socket.receive({ t: "snap", id: 1, cursor: 10, data: "old" })
    socket.receive({ t: "gap", id: 1 })
    expect(socket.frames.at(-1)).toEqual({ t: "sub", id: 1, topic: "home" })
    socket.receive({ t: "delta", id: 1, cursor: 11, data: "guessed" })
    expect(channel.getSnapshot("home")?.data).toBe("old")
    expect(channel.getSnapshot("home")?.cursor).toBeUndefined()
    socket.receive({ t: "snap", id: 1, cursor: 10, data: "fresh" })
    expect(channel.getSnapshot("home")?.data).toBe("fresh")
    channel.dispose()
  })
  test("duplicate and reordered deltas are ignored", () => {
    const { channel, sockets } = harness((_topic, old, delta) => [...old as number[], delta])
    let updates = 0
    channel.subscribe("home", () => updates++)
    const socket = sockets[0]!
    socket.open(); socket.receive({ t: "snap", id: 1, cursor: 10, data: [] })
    for (const cursor of [11, 11, 9, 12]) socket.receive({ t: "delta", id: 1, cursor, data: cursor })
    expect(channel.getSnapshot("home")?.data).toEqual([11, 12])
    expect(updates).toBe(3)
    channel.dispose()
  })
  test("failed reconnects stay between 250ms and 5s; final release cancels retry", () => {
    const { channel, sockets, timers } = harness()
    const release = channel.subscribe("home", () => {})
    for (let i = 0; i < 9; i++) { sockets[i]!.drop(); timers[i]!.run() }
    expect(timers.map(timer => timer.ms)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000])
    sockets[9]!.drop(); release()
    expect(timers[9]!.cancelled).toBe(true)
    timers[9]!.run()
    expect(sockets).toHaveLength(10)
    channel.dispose()
  })
  test("unknown deltas request a snapshot; malformed frames and unowned ids change nothing", () => {
    const { channel, sockets } = harness()
    channel.subscribe("home", () => {})
    const socket = sockets[0]!
    socket.open(); socket.receive({ t: "snap", id: 1, cursor: 1, data: "held" })
    for (const frame of [null, { t: "snap", id: 99, cursor: 2 }, { t: "snap", id: 1, cursor: -1 }, { t: "delta", id: 1, cursor: 2, data: "unknown" }]) socket.receive(frame)
    socket.onmessage?.({ data: "invalid json" })
    socket.onmessage?.({ data: new ArrayBuffer(0) })
    expect(channel.getSnapshot("home")?.data).toBe("held")
    expect(channel.getSnapshot("home")?.cursor).toBe(1)
    expect(socket.frames.at(-1)).toEqual({ t: "sub", id: 1, topic: "home" })
    channel.dispose()
  })
  test("gap followed by reconnect still requests a fresh snapshot without a cursor", () => {
    const { channel, sockets, timers } = harness()
    channel.subscribe("home", () => {})
    sockets[0]!.open()
    sockets[0]!.receive({ t: "snap", id: 1, cursor: 10, data: "held" })
    sockets[0]!.receive({ t: "gap", id: 1 })
    sockets[0]!.drop(); timers[0]!.run(); sockets[1]!.open()
    expect(sockets[1]!.frames).toEqual([{ t: "sub", id: 1, topic: "home" }])
    expect(channel.getSnapshot("home")?.data).toBe("held")
    channel.dispose()
  })
  test("topic owners register one delta projector and reducer failures retain committed state", () => {
    const { channel, sockets } = harness()
    const projector = (old: unknown, delta: unknown) => {
      if (delta === "bad") throw new Error("invalid delta")
      return Number(old) + Number(delta)
    }
    channel.registerProjection("home", projector)
    channel.registerProjection("home", projector)
    expect(() => channel.registerProjection("home", () => 99)).toThrow("already registered")
    channel.subscribe("home", () => {})
    sockets[0]!.open()
    sockets[0]!.receive({ t: "snap", id: 1, cursor: 1, data: 10 })
    sockets[0]!.receive({ t: "delta", id: 1, cursor: 2, data: 2 })
    expect(channel.getSnapshot("home")?.data).toBe(12)
    sockets[0]!.receive({ t: "delta", id: 1, cursor: 3, data: "bad" })
    expect(channel.getSnapshot("home")?.cursor).toBe(2)
    expect(sockets[0]!.frames.at(-1)).toEqual({ t: "sub", id: 1, topic: "home" })
    channel.dispose()
  })
  test("subscription refusal stays on its topic and the socket remains open", () => {
    const { channel, sockets } = harness()
    channel.subscribe("home", () => {})
    sockets[0]!.open(); sockets[0]!.receive({ t: "err", id: 1, code: "forbidden" })
    expect(channel.getSnapshot("home")?.error).toBe("forbidden")
    expect(sockets[0]!.closed).toBe(false)
    channel.dispose()
    expect(() => channel.subscribe("home", () => {})).toThrow("disposed")
  })
})


test("revoked topic discards cached data and cursor, ignores deltas, and reconnects without private state", () => {
  const { channel, sockets, timers } = harness((_topic, _old, delta) => delta)
  channel.subscribe("conversation:main", () => {})
  channel.subscribe("view:Ben:main", () => {})
  const socket = sockets[0]!
  socket.open()
  socket.receive({ t: "snap", id: 1, cursor: 5, data: "shared" })
  socket.receive({ t: "snap", id: 2, cursor: 8, data: "private view" })
  socket.receive({ t: "err", id: 2, code: "forbidden" })
  expect(channel.getSnapshot("view:Ben:main")).toEqual({ topic: "view:Ben:main", error: "forbidden" })
  expect(channel.getSnapshot("view:Ben:main")?.data).toBeUndefined()
  expect(channel.getSnapshot("view:Ben:main")?.cursor).toBeUndefined()
  expect(channel.getSnapshot("view:Ben:main")?.error).toBe("forbidden")
  socket.receive({ t: "delta", id: 2, cursor: 9, data: "stale" })
  expect(channel.getSnapshot("view:Ben:main")?.data).toBeUndefined()
  expect(channel.getSnapshot("conversation:main")?.data).toBe("shared")
  socket.drop(); timers[0]!.run(); sockets[1]!.open()
  expect(sockets[1]!.frames).toEqual([{ t: "sub", id: 1, topic: "conversation:main", cursor: 5 }, { t: "sub", id: 2, topic: "view:Ben:main" }])
  sockets[1]!.receive({ t: "snap", id: 2, cursor: 1, data: "reauthorized" })
  expect(channel.getSnapshot("view:Ben:main")?.data).toBe("reauthorized")
  expect(channel.getSnapshot("view:Ben:main")?.cursor).toBe(1)
  expect(channel.getSnapshot("view:Ben:main")?.error).toBeUndefined()
  channel.dispose()
})


test("a retention snapshot replaces an invalid former cursor", () => {
  const { channel, sockets, timers } = harness()
  channel.subscribe("home", () => {})
  sockets[0]!.open()
  sockets[0]!.receive({ t: "snap", id: 1, cursor: 100, data: "before" })
  sockets[0]!.drop(); timers[0]!.run(); sockets[1]!.open()
  sockets[1]!.receive({ t: "snap", id: 1, cursor: 2, data: "committed" })
  expect(channel.getSnapshot("home")).toEqual({ topic: "home", cursor: 2, data: "committed" })
  channel.dispose()
})

test("presence uses one socket, an independent frame id, the latest location, and stops at last close", () => {
  const { channel, sockets, timers } = harness()
  const closeTopic = channel.subscribe("branch:b1", () => {})
  const first = channel.trackPresence({ branch: "b1" })
  sockets[0]!.open()
  expect(sockets[0]!.frames).toEqual([
    { t: "sub", id: 1, topic: "branch:b1" },
    { t: "presence", id: 2, where: { branch: "b1" } }
  ])
  first.move({ branch: "b1", path: "retry.ts", line: 12 })
  expect(sockets[0]!.frames.at(-1)).toEqual({ t: "presence", id: 2, where: { branch: "b1", path: "retry.ts", line: 12 } })
  expect(timers[0]!.ms).toBe(10000)
  timers[0]!.run()
  expect(sockets[0]!.frames.at(-1)).toEqual({ t: "presence", id: 2, where: { branch: "b1", path: "retry.ts", line: 12 } })
  const second = channel.trackPresence({ branch: "b1", terminal: "terminal-2" })
  second.release(); second.release()
  expect(sockets[0]!.frames.at(-1)).toEqual({ t: "presence", id: 2, where: { branch: "b1", path: "retry.ts", line: 12 } })
  // A provider's presence refusal cannot discard the card's topic subscription.
  sockets[0]!.receive({ t: "err", id: 2, code: "unsupported" })
  expect(channel.getSnapshot("branch:b1")?.error).toBeUndefined()
  first.release()
  expect(sockets[0]!.frames.at(-1)).toEqual({ t: "presence", id: 2, where: { branch: "" } })
  expect(timers.at(-1)!.cancelled).toBe(true)
  const count = sockets[0]!.frames.length
  timers.at(-1)!.run(); first.move({ branch: "b2" })
  expect(sockets[0]!.frames).toHaveLength(count)
  closeTopic(); channel.dispose()
})

test("presence reconnects with the latest move and disposal cancels all heartbeats", () => {
  const { channel, sockets, timers } = harness()
  channel.subscribe("branch:b1", () => {})
  const lease = channel.trackPresence({ branch: "b1" })
  sockets[0]!.open(); sockets[0]!.drop()
  lease.move({ branch: "b1", run: "run-1", step: "verify" })
  timers.find(timer => timer.ms === 250)!.run()
  sockets[1]!.open()
  expect(sockets[1]!.frames).toEqual([
    { t: "sub", id: 1, topic: "branch:b1" },
    { t: "presence", id: 2, where: { branch: "b1", run: "run-1", step: "verify" } }
  ])
  channel.dispose()
  const count = sockets[1]!.frames.length
  for (const timer of timers) if (timer.ms === 10000) timer.run()
  lease.move({ branch: "b2" }); lease.release()
  expect(sockets[1]!.frames).toHaveLength(count)
})

test("members reconnect requests a fresh snapshot, retains the roster and notifies at an unchanged cursor", () => {
  const { channel, sockets, timers } = harness()
  let notices = 0
  channel.subscribe("members", () => notices++)
  sockets[0]!.open()
  sockets[0]!.receive({ t: "snap", id: 1, cursor: 10, data: { members: ["will"] } })
  sockets[0]!.drop()
  expect(notices).toBe(2) // Lost authority notifies before the replacement roster.
  expect(channel.getSnapshot("members")?.data).toEqual({ members: ["will"] })
  timers[0]!.run(); sockets[1]!.open()
  expect(sockets[1]!.frames).toEqual([{ t: "sub", id: 1, topic: "members" }])
  sockets[1]!.receive({ t: "snap", id: 1, cursor: 10, data: { members: ["will"] } })
  expect(notices).toBe(3)
  channel.dispose()
})
