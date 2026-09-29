import { describe, expect, spyOn, test } from "bun:test"
import * as Effect from "effect/Effect"
import type { AgentTurnCursor, AgentTurnJournalHead } from "@smthrs/rpc/AgentTurnJournal"
import { memoryStorage, storageLayer } from "./DurableStorage"
import type { NativeStorage } from "./DurableStorage"
import { TurnCancelRegistry } from "./turns"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { TURN_JOURNAL_HEAD_KEY, TURN_JOURNAL_PRODUCER_MS, TURN_JOURNAL_RETENTION_MS, turnJournalBatchKey, verifyTurnJournal } from "./TurnJournal"

const auth = { ownerHash: "1".repeat(64), accessHash: "2".repeat(64) }
const writerHash = "3".repeat(64)
const acceptance = { operation: "accept", runId: "turn", legId: "leg-1", ...auth, writerHash, requestHash: "4".repeat(64) }
const delta = (text: string) => ({ runId: "turn", type: "delta", kind: "text", text })
const terminal = { runId: "turn", type: "done", reason: "stop" }
const call = async (object: TurnCancelRegistry, body: unknown) => {
  const response = await object.fetch(new Request("https://turn-cancel.internal/journal", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }))
  return { status: response.status, body: await response.json() as any }
}
const create = async (storage: NativeStorage = memoryStorage()) => {
  const object = new TurnCancelRegistry({ storage })
  const accepted = await call(object, acceptance)
  expect(accepted.status).toBe(200)
  expect(accepted.body.status).toBe("accepted")
  return { object, initial: accepted.body.cursor as AgentTurnCursor }
}
const append = (object: TurnCancelRegistry, expected: AgentTurnCursor, frames: unknown[]) =>
  call(object, { operation: "append", writerHash, expected, frames })
const read = (object: TurnCancelRegistry, after: AgentTurnCursor | null = null, limit = 16) =>
  call(object, { operation: "read", ...auth, after, limit })

describe("durable turn output", () => {
  test("an accepted producer has one absolute deadline across reads, retries and restart", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const storage = memoryStorage()
      const { object, initial } = await create(storage)
      const acceptedAt = (storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead).acceptance.acceptedAt
      now = acceptedAt + TURN_JOURNAL_PRODUCER_MS - 1
      expect((await read(object)).body).toMatchObject({ terminal: false, head: initial, batches: [] })
      expect((await call(object, acceptance)).body).toMatchObject({ status: "existing", terminal: false })
      const reopened = new TurnCancelRegistry({ storage })
      now = acceptedAt + TURN_JOURNAL_PRODUCER_MS
      const settled = await read(reopened)
      expect(settled.status).toBe(200)
      expect(settled.body).toMatchObject({ terminal: true, head: { batch: 1, position: 1 } })
      expect(settled.body.batches).toHaveLength(1)
      expect(settled.body.batches[0].frames).toEqual([{ runId: "turn", type: "done", error: expect.any(String) }])
      expect((await call(reopened, acceptance)).body).toMatchObject({ status: "existing", terminal: true })
      expect((await append(reopened, initial, [delta("late")])).body.code).toBe("terminal")
      expect((await read(new TurnCancelRegistry({ storage }))).body.batches).toEqual(settled.body.batches)
    } finally { clock.mockRestore() }
  })

  test("authorized late append settles once while simultaneous reads and foreign callers cannot alter the result", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const storage = memoryStorage()
      const { object, initial } = await create(storage)
      now = (storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead).acceptance.acceptedAt + TURN_JOURNAL_PRODUCER_MS
      expect((await call(object, { operation: "read", ...auth, ownerHash: "9".repeat(64), after: null, limit: 1 })).status).toBe(403)
      expect((await call(object, { ...acceptance, ownerHash: "9".repeat(64) })).status).toBe(403)
      expect((await call(object, { operation: "append", writerHash: "9".repeat(64), expected: initial, frames: [delta("foreign")] })).status).toBe(403)
      expect(storage.data.has(turnJournalBatchKey(1))).toBe(false)
      const answers = await Promise.all([append(object, initial, [delta("late")]), read(object), call(object, acceptance)])
      expect(answers[0]!.body.code).toBe("terminal")
      expect(answers[1]!.body.terminal).toBe(true)
      expect(answers[2]!.body).toMatchObject({ status: "existing", terminal: true })
      const batches = (await read(object)).body.batches
      expect(batches).toHaveLength(1)
      expect(batches[0].frames).toEqual([{ runId: "turn", type: "done", error: expect.any(String) }])
      expect((await append(object, initial, [delta("later")])).body.code).toBe("terminal")
      expect((await read(object)).body.batches).toEqual(batches)
    } finally { clock.mockRestore() }
  })

  test("a lost settlement head receipt and an orphan stage recover to one terminal batch", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      for (const failAfterWrite of [false, true]) {
        const storage = memoryStorage()
        let fail = false
        const wrapped: NativeStorage = { ...storage, put: async (key, value) => {
          if (fail && key === TURN_JOURNAL_HEAD_KEY) {
            fail = false
            if (!failAfterWrite) throw new Error("settlement stage has no head")
            await storage.put(key, value)
            throw new Error("settlement head receipt lost")
          }
          await storage.put(key, value)
        } }
        const { object } = await create(wrapped)
        now = (storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead).acceptance.acceptedAt + TURN_JOURNAL_PRODUCER_MS
        fail = true
        expect((await read(object)).status).toBe(503)
        expect(storage.data.has(turnJournalBatchKey(1))).toBe(true)
        const recovered = await read(new TurnCancelRegistry({ storage: wrapped }))
        expect(recovered.body).toMatchObject({ terminal: true, head: { batch: 1, position: 1 } })
        expect(recovered.body.batches).toHaveLength(1)
        expect(recovered.body.batches[0].frames).toEqual([{ runId: "turn", type: "done", error: expect.any(String) }])
        expect((await read(new TurnCancelRegistry({ storage: wrapped }))).body.batches).toEqual(recovered.body.batches)
      }
    } finally { clock.mockRestore() }
  })

  test("the first retry of a lost acceptance observes expiry without a new writer grant", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const storage = memoryStorage()
      const { object, initial } = await create(storage)
      now = (storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead).acceptance.acceptedAt + TURN_JOURNAL_PRODUCER_MS
      const retry = await call(new TurnCancelRegistry({ storage }), { ...acceptance, writerHash: "a".repeat(64) })
      expect(retry.body).toMatchObject({ status: "existing", terminal: true, cursor: { batch: 1, position: 1 } })
      expect(retry.body.cursor).not.toEqual(initial)
      expect(JSON.stringify(retry.body)).not.toContain(writerHash)
      expect((await append(object, initial, [delta("late original writer")])).body.code).toBe("terminal")
      expect((await call(object, { operation: "append", writerHash: "a".repeat(64), expected: initial, frames: [delta("new writer")]})).status).toBe(403)
      expect((await read(object)).body.batches[0].frames).toEqual([{ runId: "turn", type: "done", error: expect.any(String) }])
    } finally { clock.mockRestore() }
  })

  test("partial output does not renew the deadline and its exact receipt remains replayable", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const storage = memoryStorage()
      const { object, initial } = await create(storage)
      const acceptedAt = (storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead).acceptance.acceptedAt
      now = acceptedAt + TURN_JOURNAL_PRODUCER_MS - 1
      const first = await append(object, initial, [delta("saved partial")])
      expect(first.body.status).toBe("committed")
      now = acceptedAt + TURN_JOURNAL_PRODUCER_MS
      const retry = await append(object, initial, [delta("saved partial")])
      expect(retry.body).toMatchObject({ status: "duplicate", batch: first.body.batch, cursor: first.body.cursor })
      const late = await append(object, first.body.cursor, [delta("late output")])
      expect(late.body.code).toBe("terminal")
      const replay = await read(new TurnCancelRegistry({ storage }))
      expect(replay.body.terminal).toBe(true)
      expect(replay.body.batches).toHaveLength(2)
      expect(replay.body.batches[0]).toEqual(first.body.batch)
      expect(replay.body.batches[1].frames).toEqual([{ runId: "turn", type: "done", error: expect.any(String) }])
      expect(replay.body.head.position).toBe(2)
    } finally { clock.mockRestore() }
  })

  test("a completed turn stays complete after the producer deadline", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const storage = memoryStorage()
      const { object, initial } = await create(storage)
      const complete = await append(object, initial, [terminal])
      expect(complete.body.status).toBe("committed")
      now = (storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead).acceptance.acceptedAt + TURN_JOURNAL_PRODUCER_MS
      const replay = await read(new TurnCancelRegistry({ storage }))
      expect(replay.body).toMatchObject({ terminal: true, head: complete.body.cursor })
      expect(replay.body.batches).toEqual([complete.body.batch])
      expect((await call(object, acceptance)).body).toMatchObject({ status: "existing", terminal: true, cursor: complete.body.cursor })
      expect(storage.data.has(turnJournalBatchKey(2))).toBe(false)
    } finally { clock.mockRestore() }
  })

  test("bad replay cursor and corrupt history do not create a settlement batch", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const storage = memoryStorage()
      const { object, initial } = await create(storage)
      const partial = await append(object, initial, [delta("private partial")])
      now = (storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead).acceptance.acceptedAt + TURN_JOURNAL_PRODUCER_MS
      expect((await read(object, { ...initial, hash: "9".repeat(64) })).body.code).toBe("cursor")
      expect(storage.data.has(turnJournalBatchKey(2))).toBe(false)
      const batch = storage.data.get(turnJournalBatchKey(1)) as any
      storage.data.set(turnJournalBatchKey(1), { ...batch, frames: [delta("tampered")] })
      const answer = await read(new TurnCancelRegistry({ storage }), partial.body.cursor)
      expect(answer.body.code).toBe("corrupt")
      expect(storage.data.has(turnJournalBatchKey(2))).toBe(false)
    } finally { clock.mockRestore() }
  })

  test("concurrent acceptance grants one writer; retries cannot re-execute accepted inference", async () => {
    const storage = memoryStorage()
    const object = new TurnCancelRegistry({ storage })
    const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => call(object, { ...acceptance, writerHash: index.toString(16).repeat(64) })))
    expect(answers.filter(answer => answer.body.status === "accepted")).toHaveLength(1)
    expect(answers.filter(answer => answer.body.status === "existing")).toHaveLength(11)
    expect(answers.every(answer => !JSON.stringify(answer.body).includes("writerHash"))).toBe(true)
    expect((await call(object, { ...acceptance, requestHash: "5".repeat(64) })).status).toBe(409)
    expect((await call(object, { ...acceptance, ownerHash: "5".repeat(64) })).status).toBe(403)
  })

  test("more than a thousand frames replay in full across pages and a recreated object", async () => {
    const storage = memoryStorage()
    const { object, initial } = await create(storage)
    let cursor = initial
    const expected: unknown[] = []
    for (let from = 0; from < 1005; from += 100) {
      const frames = Array.from({ length: Math.min(100, 1005 - from) }, (_, offset) => delta(`chunk-${from + offset}`))
      expected.push(...frames)
      const answer = await append(object, cursor, frames)
      expect(answer.body.status).toBe("committed")
      cursor = answer.body.cursor
    }
    const done = await append(object, cursor, [terminal])
    cursor = done.body.cursor
    expected.push(terminal)
    const reopened = new TurnCancelRegistry({ storage })
    const replayed: unknown[] = []
    let after = initial
    do {
      const page = await read(reopened, after, 3)
      expect(page.status).toBe(200)
      expect(page.body.after).toEqual(after)
      replayed.push(...page.body.batches.flatMap((batch: any) => batch.frames))
      after = page.body.next
    } while (after.batch !== cursor.batch)
    expect(after).toEqual(cursor)
    expect(replayed).toEqual(expected)
    const verified = await Effect.runPromise(verifyTurnJournal.pipe(Effect.provide(storageLayer(storage))))
    expect(verified).toEqual(storage.data.get(TURN_JOURNAL_HEAD_KEY) as AgentTurnJournalHead)
    expect(verified.terminal).toBe(true)
    expect(verified.cursor.position).toBe(1006)
    expect((await append(reopened, cursor, [delta("after done")])).body.code).toBe("terminal")
  })

  test("a batch is invisible until its head commit and an uncommitted stage may be replaced", async () => {
    const storage = memoryStorage()
    let fail = false
    const { object, initial } = await create({ ...storage, put: async (key, value) => {
      if (fail && key === TURN_JOURNAL_HEAD_KEY) { fail = false; throw new Error("failed before head") }
      await storage.put(key, value)
    } })
    fail = true
    expect((await append(object, initial, [delta("unaccepted")])).status).toBe(503)
    expect(storage.data.has(turnJournalBatchKey(1))).toBe(true)
    const invisible = await read(object)
    expect(invisible.body.batches).toEqual([])
    expect(invisible.body.head).toEqual(initial)
    const retry = await append(object, initial, [delta("accepted")])
    expect(retry.body.status).toBe("committed")
    expect((await read(object)).body.batches[0].frames[0].text).toBe("accepted")
  })

  test("a lost receipt after commit returns the original batch; conflicting retries cannot overwrite it", async () => {
    const storage = memoryStorage()
    let fail = false
    const { object, initial } = await create({ ...storage, put: async (key, value) => {
      await storage.put(key, value)
      if (fail && key === TURN_JOURNAL_HEAD_KEY) { fail = false; throw new Error("receipt lost after head") }
    } })
    fail = true
    expect((await append(object, initial, [delta("once")])).status).toBe(503)
    const retried = await append(object, initial, [delta("once")])
    expect(retried.body.status).toBe("duplicate")
    expect(retried.body.cursor.position).toBe(1)
    expect((await append(object, initial, [delta("different")])).body.code).toBe("conflict")
    expect((await read(object)).body.batches).toHaveLength(1)
  })

  test("independent producers cannot commit different frames over the same head", async () => {
    const { object, initial } = await create()
    const answers = await Promise.all([append(object, initial, [delta("first")]), append(object, initial, [delta("second")])])
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 409])
    expect((await read(object)).body.head.position).toBe(1)
    expect((await call(object, { operation: "append", writerHash: "9".repeat(64), expected: initial, frames: [delta("foreign")] })).status).toBe(403)
  })

  test("foreign scopes, invented cursors and malformed output are refused", async () => {
    const { object, initial } = await create()
    expect((await call(object, { operation: "read", ...auth, ownerHash: "9".repeat(64), after: null, limit: 1 })).status).toBe(403)
    expect((await call(object, { operation: "read", ...auth, accessHash: "9".repeat(64), after: null, limit: 1 })).status).toBe(403)
    expect((await read(object, { ...initial, legId: "another" })).body.code).toBe("cursor")
    expect((await read(object, { ...initial, hash: "9".repeat(64) })).body.code).toBe("cursor")
    expect((await append(object, initial, [{ ...delta("foreign"), runId: "another" }])).status).toBe(409)
    expect((await append(object, initial, [terminal, delta("after terminal")])).status).toBe(409)
    expect((await append(object, initial, [delta("x".repeat(100_000))])).body.code).toBe("limit")
    expect((await read(object)).body.head).toEqual(initial)
  })

  test("unknown versions, removed history and changed private bytes refuse recovery without leaking them", async () => {
    const storage = memoryStorage()
    const { object, initial } = await create(storage)
    await append(object, initial, [delta("private response body")])
    const saved = structuredClone(storage.data.get(turnJournalBatchKey(1))) as any
    const corrupted = structuredClone(saved)
    corrupted.frames[0].text = "secret modified response"
    storage.data.set(turnJournalBatchKey(1), corrupted)
    const answer = await read(object)
    expect(answer.status).toBe(500)
    expect(answer.body).toEqual({ status: "error", code: "corrupt" })
    storage.data.delete(turnJournalBatchKey(1))
    expect((await read(object)).status).toBe(500)
    storage.data.set(turnJournalBatchKey(1), saved)
    const head = structuredClone(storage.data.get(TURN_JOURNAL_HEAD_KEY)) as any
    head.version = 99
    storage.data.set(TURN_JOURNAL_HEAD_KEY, head)
    expect((await read(object)).status).toBe(500)
    expect(storage.data.get(TURN_JOURNAL_HEAD_KEY)).toEqual(head)
  })

  test("retirement hides output first and resumes erasure after failure, including an orphan stage", async () => {
    const storage = memoryStorage()
    let fail = true
    const { object, initial } = await create({ ...storage, delete: async key => {
      if (fail) { fail = false; throw new Error("delete failed") }
      await storage.delete!(key)
    } })
    await append(object, initial, [delta("private committed body")])
    storage.data.set(turnJournalBatchKey(2), { private: "uncommitted body" })
    const retire = () => call(object, { operation: "retire", ...auth })
    expect((await retire()).status).toBe(503)
    expect((await read(object)).status).toBe(410)
    expect((await call(object, acceptance)).status).toBe(410)
    expect((await retire()).body.status).toBe("retired")
    expect([...storage.data.keys()]).toEqual([TURN_JOURNAL_HEAD_KEY])
    expect(JSON.stringify([...storage.data.values()])).not.toContain("private")
    expect((await append(object, initial, [delta("late producer")])).status).toBe(410)
  })

  test("a recreated object verifies its complete prefix before accepting an existing identity or new output", async () => {
    const storage = memoryStorage()
    const { object, initial } = await create(storage)
    const committed = await append(object, initial, [delta("private history")])
    const head = structuredClone(storage.data.get(TURN_JOURNAL_HEAD_KEY))
    storage.data.delete(turnJournalBatchKey(1))
    const reopened = new TurnCancelRegistry({ storage })
    expect((await call(reopened, acceptance)).body.code).toBe("corrupt")
    expect((await append(reopened, committed.body.cursor, [delta("must not advance")])).body.code).toBe("corrupt")
    expect(storage.data.get(TURN_JOURNAL_HEAD_KEY)).toEqual(head)
    expect(storage.data.has(turnJournalBatchKey(2))).toBe(false)
    // Missing/corrupt output must remain erasable through the authenticated head.
    expect((await call(reopened, { operation: "retire", ...auth })).body.status).toBe("retired")
    expect([...storage.data.keys()]).toEqual([TURN_JOURNAL_HEAD_KEY])
  })

  test("a storage exception answers 503 and logs its operation and cause; a caller's refusal logs nothing", async () => {
    const logged: string[] = []
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)) })
    try {
      const broken = new TurnCancelRegistry({ storage: { ...memoryStorage(), get: async () => { throw new Error("SQLITE_FULL") } } })
      expect((await read(broken)).status).toBe(503)
      expect(logged.map(line => JSON.parse(line))).toEqual([{
        event: "worker_seam_failure", seam: "turn journal object",
        cause: `StorageFailure(storage.get ${TURN_JOURNAL_HEAD_KEY}): Error: SQLITE_FULL`
      }])
      logged.length = 0
      const { object } = await create()
      expect((await call(object, { ...acceptance, ownerHash: "5".repeat(64) })).status).toBe(403)
      expect(logged).toEqual([])
    } finally { spy.mockRestore() }
  })

  test("acceptance schedules retention before its first write; the alarm deletes every batch page, then the head", async () => {
    const storage = memoryStorage()
    const events: string[] = []
    const alarmed: NativeStorage = { ...storage,
      setAlarm: async time => { events.push(`alarm ${time >= Date.now() + TURN_JOURNAL_RETENTION_MS - 60_000}`) },
      put: async (key, value) => { events.push(`put ${String(key)}`); await storage.put(key, value) } }
    await create(alarmed)
    expect(events).toEqual(["alarm true", `put ${TURN_JOURNAL_HEAD_KEY}`])
    for (let batch = 1; batch <= 300; batch++) storage.data.set(turnJournalBatchKey(batch), { private: batch })
    await new TurnCancelRegistry({ storage: alarmed }).alarm()
    expect([...storage.data.keys()]).toEqual([])
    expect((await call(new TurnCancelRegistry({ storage: alarmed }), acceptance)).body.status).toBe("accepted")
  })

  test("the Worker namespace fixture keeps the native dispatch, serialization, restart and erasure contract", async () => {
    const objects = memoryDurableObjects()
    const stub = () => objects.TURN_CANCELS.get(objects.TURN_CANCELS.idFromName("journal:turn:leg-1"))
    const request = (body: unknown) => stub().fetch(new Request("https://turn-cancel.internal/journal", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    })).then(async response => ({ status: response.status, body: await response.json() as any }))
    const answers = await Promise.all([request(acceptance), request(acceptance)])
    expect(answers.map(answer => answer.body.status).sort()).toEqual(["accepted", "existing"])
    const cursor = answers[0]!.body.cursor
    expect((await request({ operation: "append", writerHash, expected: cursor, frames: [delta("retained")] })).body.status).toBe("committed")
    objects.restart()
    const replay = await request({ operation: "read", ...auth, after: null, limit: 1 })
    expect(replay.body.batches[0].frames[0].text).toBe("retained")
    expect((await request({ operation: "retire", ...auth })).body.status).toBe("retired")
    objects.restart()
    expect((await request({ operation: "read", ...auth, after: null, limit: 1 })).status).toBe(410)
  })
})
