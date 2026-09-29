import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import {
  AgentTurnBatchSchema, AgentTurnJournalCommandSchema,
  AgentTurnJournalHeadSchema, AgentTurnRetirementSchema, agentTurnJournalDigestInput, projectAgentTurnBatch
} from "@smthrs/rpc/AgentTurnJournal"
import type {
  AgentTurnAcceptance, AgentTurnBatch, AgentTurnCursor, AgentTurnJournalCommand,
  AgentTurnJournalHead, AgentTurnRetirement
} from "@smthrs/rpc/AgentTurnJournal"
import { DurableStorage } from "./DurableStorage"
import type { DurableStorageShape } from "./DurableStorage"
import { StorageFailure } from "./Failures"
import { logSeamFailure } from "./RefusalLog"
import { readBody } from "./Responses"
import { sha256Hex } from "./turnLimit"

/** Logical JSON budgets; the host may refuse its serialized representation earlier. */
export const TURN_JOURNAL_BATCH_BYTES = 96 * 1024
export const TURN_JOURNAL_OUTPUT_BYTES = 8 * 1024 * 1024
export const TURN_JOURNAL_MAX_BATCHES = 8192
/** Absolute output authority deadline; reads settle expired producers without re-executing them. */
export const TURN_JOURNAL_PRODUCER_MS = 15 * 60 * 1000
/** Every leg object, output and tombstone alike, is deleted this long after it was first written. */
export const TURN_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const TURN_JOURNAL_HEAD_KEY = "turn-journal:v1:head"
const TURN_JOURNAL_BATCH_PREFIX = "turn-journal:v1:batch:"
export const turnJournalBatchKey = (batch: number): string => `${TURN_JOURNAL_BATCH_PREFIX}${batch}`

/**
 * One private object's verification cache, guarded by its request mutex.
 * Only this protocol writes its immutable accepted batches. Reinstantiation
 * or an unknown head forces a full prefix audit before admission/publication.
 */
export interface TurnJournalAudit { verifiedHeadHash?: string }

type Saved = AgentTurnJournalHead | AgentTurnRetirement
type Reason = "not-found" | "forbidden" | "retired" | "conflict" | "cursor" | "terminal" | "limit" | "corrupt"
/** A journal command the object refuses; `reason` is the wire code the Worker maps to a status. */
export class JournalRefusal extends Data.TaggedError("JournalRefusal")<{ readonly reason: Reason }> {
  override get message(): string {
    return `Turn journal ${this.reason}.`
  }
}
const refuse = (reason: Reason): Effect.Effect<never, JournalRefusal> => Effect.fail(new JournalRefusal({ reason }))
const retired = (value: Saved): value is AgentTurnRetirement => "retired" in value
const unsigned = <T extends { readonly hash: string }>(value: T): Omit<T, "hash"> => {
  const { hash: _hash, ...body } = value
  return body
}
const seal = <T extends object>(kind: Parameters<typeof agentTurnJournalDigestInput>[0], value: T) =>
  Effect.map(sha256Hex(agentTurnJournalDigestInput(kind, value)), hash => ({ ...value, hash }))
const checkSeal = <T extends { readonly hash: string }>(kind: Parameters<typeof agentTurnJournalDigestInput>[0], value: T) =>
  Effect.flatMap(seal(kind, unsigned(value)), checked => checked.hash === value.hash ? Effect.succeed(value) : refuse("corrupt"))
const sameCursor = (left: AgentTurnCursor, right: AgentTurnCursor): boolean =>
  left.runId === right.runId && left.legId === right.legId && left.batch === right.batch &&
  left.position === right.position && left.hash === right.hash
const cursorAfter = (batch: AgentTurnBatch): AgentTurnCursor => ({
  version: 1, runId: batch.runId, legId: batch.legId, batch: batch.batch,
  position: batch.from + batch.frames.length - 1, hash: batch.hash
})
const initial = (acceptance: AgentTurnAcceptance) => seal("head", {
  version: 1 as const, acceptance,
  cursor: { version: 1 as const, runId: acceptance.runId, legId: acceptance.legId, batch: 0, position: 0, hash: acceptance.hash },
  bytes: 0, terminal: false
})

const noErasure = () => new StorageFailure({ operation: "turn journal erasure", cause: new Error("The storage host cannot erase saved output.") })

/**
 * Schedule the object's retention alarm before its first write, so no Worker
 * head exists without its deletion. The native SQLite host has no alarms; its
 * device-local output lives until the browser retires it.
 */
const scheduleRetention = (storage: DurableStorageShape): Effect.Effect<void, StorageFailure> => {
  const setAlarm = storage.setAlarm
  return setAlarm === undefined ? Effect.void : Effect.flatMap(Clock.currentTimeMillis, now => setAlarm(now + TURN_JOURNAL_RETENTION_MS))
}

const load = (storage: DurableStorageShape): Effect.Effect<Saved | undefined, StorageFailure | JournalRefusal> =>
  Effect.gen(function* () {
    const raw = yield* storage.get<unknown>(TURN_JOURNAL_HEAD_KEY)
    if (raw === undefined) return undefined
    const gone = AgentTurnRetirementSchema.safeParse(raw)
    if (gone.success) {
      if (gone.data.erasedBatches > gone.data.batches + 1) return yield* refuse("corrupt")
      if ((gone.data.ownerHash === null) !== (gone.data.acceptanceHash === null) ||
        gone.data.acceptanceHash === null && (gone.data.batches !== 0 || gone.data.erasedBatches !== 1)) return yield* refuse("corrupt")
      return yield* checkSeal("retirement", gone.data)
    }
    const decoded = AgentTurnJournalHeadSchema.safeParse(raw)
    if (!decoded.success) return yield* refuse("corrupt")
    const head = yield* checkSeal("head", decoded.data)
    yield* checkSeal("acceptance", head.acceptance)
    if (head.cursor.runId !== head.acceptance.runId || head.cursor.legId !== head.acceptance.legId ||
      head.cursor.batch > TURN_JOURNAL_MAX_BATCHES + 1 || head.cursor.position < head.cursor.batch ||
      (head.cursor.batch === 0 && (head.cursor.position !== 0 || head.cursor.hash !== head.acceptance.hash || head.bytes !== 0 || head.terminal))) {
      return yield* refuse("corrupt")
    }
    return head
  })

const loadBatch = (storage: DurableStorageShape, head: AgentTurnJournalHead, number: number) =>
  Effect.gen(function* () {
    const decoded = AgentTurnBatchSchema.safeParse(yield* storage.get<unknown>(turnJournalBatchKey(number)))
    if (!decoded.success) return yield* refuse("corrupt")
    const batch = yield* checkSeal("batch", decoded.data)
    if (batch.runId !== head.cursor.runId || batch.legId !== head.cursor.legId || batch.batch !== number ||
      batch.frames.some(frame => frame.runId !== batch.runId) || batch.frames.slice(0, -1).some(frame => frame.type === "done")) {
      return yield* refuse("corrupt")
    }
    return batch
  })

const authorize = (saved: Saved, command: { readonly ownerHash: string; readonly accessHash: string }) => {
  const auth = retired(saved) ? saved : saved.acceptance
  return (auth.ownerHash === command.ownerHash || retired(saved) && auth.ownerHash === null) && auth.accessHash === command.accessHash ? Effect.void : refuse("forbidden")
}

const rebuild = (storage: DurableStorageShape, saved: AgentTurnJournalHead) => Effect.gen(function* () {
  let replay = yield* initial(saved.acceptance)
  for (let number = 1; number <= saved.cursor.batch; number++) {
    const batch = yield* loadBatch(storage, saved, number)
    const next = yield* Effect.try({
      try: () => projectAgentTurnBatch(replay, batch), catch: () => new JournalRefusal({ reason: "corrupt" })
    })
    replay = yield* seal("head", next)
  }
  if (replay.hash !== saved.hash) return yield* refuse("corrupt")
  return replay
})

const admitHead = (storage: DurableStorageShape, saved: AgentTurnJournalHead, audit: TurnJournalAudit | undefined) =>
  Effect.gen(function* () {
    if (audit?.verifiedHeadHash === saved.hash) return
    yield* rebuild(storage, saved)
    if (audit !== undefined) audit.verifiedHeadHash = saved.hash
  })

/** Commit every producer or interruption batch through the same bounded prefix write. */
const commitBatch = (storage: DurableStorageShape, current: AgentTurnJournalHead, batch: AgentTurnBatch, audit: TurnJournalAudit | undefined) =>
  Effect.gen(function* () {
    const projection = yield* Effect.try({
      try: () => projectAgentTurnBatch(current, batch),
      catch: () => new JournalRefusal({ reason: "conflict" })
    })
    const bytes = projection.bytes - current.bytes
    // Reserve one small terminal failure batch even after ordinary retention
    // is exhausted. The producer must explicitly record why output stopped.
    const terminalReserve = batch.frames.length === 1 && batch.frames[0]!.type === "done" && bytes <= 2048
    if (bytes > TURN_JOURNAL_BATCH_BYTES || (projection.bytes > TURN_JOURNAL_OUTPUT_BYTES || batch.batch > TURN_JOURNAL_MAX_BATCHES) && !terminalReserve ||
      batch.batch > TURN_JOURNAL_MAX_BATCHES + 1) return yield* refuse("limit")
    const next = yield* seal("head", projection)
    yield* storage.put(turnJournalBatchKey(batch.batch), batch)
    yield* storage.put(TURN_JOURNAL_HEAD_KEY, next)
    if (audit !== undefined) audit.verifiedHeadHash = next.hash
    return next
  })

/** The mutex makes expiry and append mutually exclusive; the terminal head fences the writer. */
const settleExpired = (storage: DurableStorageShape, current: AgentTurnJournalHead, audit: TurnJournalAudit | undefined) =>
  Effect.gen(function* () {
    if (current.terminal || (yield* Clock.currentTimeMillis) < current.acceptance.acceptedAt + TURN_JOURNAL_PRODUCER_MS) return current
    const cursor = current.cursor
    const batch = yield* seal("batch", {
      version: 1 as const, runId: cursor.runId, legId: cursor.legId,
      batch: cursor.batch + 1, from: cursor.position + 1, previousHash: cursor.hash,
      frames: [{ runId: cursor.runId, type: "done" as const, error: "The response timed out. Review saved output before retrying." }]
    })
    return yield* commitBatch(storage, current, batch, audit)
  })

/**
 * Called under the object's one lifetime mutex. The batch write precedes a
 * single head write: only the head makes a prefix visible. A crash before the
 * head leaves an unreachable staging batch which a retry can replace. A lost
 * receipt after the head is detected by the exact batch digest, never retried
 * as fresh inference. No function in this module executes a model or a tool.
 */
export const executeTurnJournal = (command: AgentTurnJournalCommand, audit?: TurnJournalAudit): Effect.Effect<unknown, StorageFailure | JournalRefusal, DurableStorage> =>
  Effect.gen(function* () {
    const storage = yield* DurableStorage
    let current = yield* load(storage)
    if (command.operation === "erase" && current === undefined) {
      // A privacy request can race a POST whose acceptance receipt was lost.
      // Persist absence as retired so a delayed producer cannot recreate it.
      if (storage.delete === undefined) return yield* Effect.fail(noErasure())
      yield* scheduleRetention(storage)
      yield* storage.put(TURN_JOURNAL_HEAD_KEY, yield* seal("retirement", {
        version: 1 as const, retired: true as const, runId: command.runId, legId: command.legId,
        ownerHash: null, accessHash: command.accessHash, acceptanceHash: null,
        batches: 0, erasedBatches: 1, retiredAt: yield* Clock.currentTimeMillis
      }))
      return { status: "retired" }
    }
    if (command.operation === "accept") {
      if (current !== undefined) {
        yield* authorize(current, command)
        if (retired(current)) return yield* refuse("retired")
        if (current.acceptance.requestHash !== command.requestHash || current.acceptance.runId !== command.runId || current.acceptance.legId !== command.legId) {
          return yield* refuse("conflict")
        }
        yield* admitHead(storage, current, audit)
        current = yield* settleExpired(storage, current, audit)
        // Never return the original writer capability to a retry.
        return { status: "existing", cursor: current.cursor, terminal: current.terminal }
      }
      const acceptance = yield* seal("acceptance", {
        version: 1 as const, runId: command.runId, legId: command.legId,
        ownerHash: command.ownerHash, accessHash: command.accessHash,
        requestHash: command.requestHash, writerHash: command.writerHash,
        acceptedAt: yield* Clock.currentTimeMillis
      })
      const head = yield* initial(acceptance)
      yield* scheduleRetention(storage)
      yield* storage.put(TURN_JOURNAL_HEAD_KEY, head)
      if (audit !== undefined) audit.verifiedHeadHash = head.hash
      return { status: "accepted", cursor: head.cursor, terminal: false }
    }
    if (current === undefined) return yield* refuse("not-found")
    if (command.operation === "retire" || command.operation === "erase") {
      if (command.operation === "retire") yield* authorize(current, command)
      else {
        const identity = retired(current) ? current : current.acceptance
        if (identity.runId !== command.runId || identity.legId !== command.legId || identity.accessHash !== command.accessHash) return yield* refuse("forbidden")
      }
      // Check erasure support before accepting the privacy operation.
      if (storage.delete === undefined) return yield* Effect.fail(noErasure())
      let tombstone = retired(current) ? current : yield* seal("retirement", {
        version: 1 as const, retired: true as const, runId: current.acceptance.runId, legId: current.acceptance.legId,
        ownerHash: current.acceptance.ownerHash, accessHash: current.acceptance.accessHash,
        acceptanceHash: current.acceptance.hash, batches: current.cursor.batch, erasedBatches: 0,
        retiredAt: yield* Clock.currentTimeMillis
      })
      if (!retired(current)) yield* storage.put(TURN_JOURNAL_HEAD_KEY, tombstone)
      if (audit !== undefined) delete audit.verifiedHeadHash
      // Include the one possible uncommitted staging batch. A tombstone is
      // visible before deletion and remains retryable if any delete fails.
      for (let batch = tombstone.erasedBatches + 1; batch <= tombstone.batches + 1; batch++) {
        yield* storage.delete(turnJournalBatchKey(batch))
        tombstone = yield* seal("retirement", { ...unsigned(tombstone), erasedBatches: batch })
        yield* storage.put(TURN_JOURNAL_HEAD_KEY, tombstone)
      }
      return { status: "retired" }
    }
    if (command.operation === "read") {
      yield* authorize(current, command)
      if (retired(current)) return yield* refuse("retired")
      yield* admitHead(storage, current, audit)
      const baseline = yield* initial(current.acceptance)
      const after = command.after ?? baseline.cursor
      if (after.runId !== current.cursor.runId || after.legId !== current.cursor.legId || after.batch > current.cursor.batch) return yield* refuse("cursor")
      const boundary = after.batch === 0 ? baseline.cursor : cursorAfter(yield* loadBatch(storage, current, after.batch))
      if (!sameCursor(after, boundary)) return yield* refuse("cursor")
      current = yield* settleExpired(storage, current, audit)
      let next = after
      const batches: AgentTurnBatch[] = []
      for (let number = after.batch + 1; number <= Math.min(current.cursor.batch, after.batch + command.limit); number++) {
        const batch = yield* loadBatch(storage, current, number)
        if (batch.from !== next.position + 1 || batch.previousHash !== next.hash) return yield* refuse("corrupt")
        if (batch.frames.at(-1)?.type === "done" && number !== current.cursor.batch) return yield* refuse("corrupt")
        batches.push(batch)
        next = cursorAfter(batch)
      }
      if (next.batch === current.cursor.batch && (!sameCursor(next, current.cursor) ||
        (batches.length > 0 && (batches.at(-1)!.frames.at(-1)?.type === "done") !== current.terminal))) return yield* refuse("corrupt")
      return { status: "ok", after, next, head: current.cursor, terminal: current.terminal, more: next.batch < current.cursor.batch, batches }
    }
    if (retired(current)) return yield* refuse("retired")
    if (current.acceptance.writerHash !== command.writerHash) return yield* refuse("forbidden")
    yield* admitHead(storage, current, audit)
    current = yield* settleExpired(storage, current, audit)
    const expected = command.expected
    const batch = yield* seal("batch", {
      version: 1 as const, runId: expected.runId, legId: expected.legId,
      batch: expected.batch + 1, from: expected.position + 1,
      previousHash: expected.hash, frames: command.frames
    })
    if (expected.batch < current.cursor.batch) {
      const previousWrite = yield* loadBatch(storage, current, batch.batch)
      return previousWrite.hash === batch.hash
        ? { status: "duplicate", batch: previousWrite, cursor: cursorAfter(previousWrite) }
        : yield* refuse(current.terminal ? "terminal" : "conflict")
    }
    if (!sameCursor(expected, current.cursor)) return yield* refuse("cursor")
    if (current.terminal) return yield* refuse("terminal")
    const next = yield* commitBatch(storage, current, batch, audit)
    return { status: "committed", batch, cursor: next.cursor }
  })

/**
 * The retention alarm: batches first, then the head, so an interrupted pass
 * leaves a head that refuses reads as corrupt and the platform retries the
 * alarm. Removing the head first would let a new acceptance write batch keys
 * that the retried alarm then deletes.
 */
export const expireTurnJournal: Effect.Effect<void, StorageFailure, DurableStorage> = Effect.gen(function* () {
  const storage = yield* DurableStorage
  const erase = storage.delete
  if (erase === undefined) return yield* Effect.fail(noErasure())
  for (;;) {
    const batches = yield* storage.list<unknown>({ prefix: TURN_JOURNAL_BATCH_PREFIX, limit: 128 })
    if (batches.size === 0) break
    yield* Effect.forEach(batches.keys(), erase, { discard: true })
  }
  yield* erase(TURN_JOURNAL_HEAD_KEY)
})

/** Full replay audit against the served head; it cannot adopt corrupt materialized state. */
export const verifyTurnJournal: Effect.Effect<AgentTurnJournalHead, StorageFailure | JournalRefusal, DurableStorage> =
  Effect.gen(function* () {
    const storage = yield* DurableStorage
    const saved = yield* load(storage)
    if (saved === undefined) return yield* refuse("not-found")
    if (retired(saved)) return yield* refuse("retired")
    return yield* rebuild(storage, saved)
  })

/** The internal request boundary; it never returns saved private bytes in a failure. */
export const turnJournalRequest = (request: Request, audit?: TurnJournalAudit): Effect.Effect<Response, never, DurableStorage> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    const body = yield* readBody(request, "The turn journal request is too large.")
    if (body instanceof Response) return body
    const parsed = AgentTurnJournalCommandSchema.safeParse(body)
    if (!parsed.success) return Response.json({ status: "error", code: "request_invalid" }, { status: 400 })
    return Response.json(yield* executeTurnJournal(parsed.data, audit))
  }).pipe(Effect.catch(failure => Effect.sync(() => {
    // A caller's refusal is the caller's; storage and corruption are this object's.
    if (failure._tag !== "JournalRefusal" || failure.reason === "corrupt") logSeamFailure("turn journal object", failure)
    return Response.json(
      { status: "error", code: failure._tag === "JournalRefusal" ? failure.reason : "storage_failed" },
      { status: failure._tag !== "JournalRefusal" ? 503 : failure.reason === "forbidden" ? 403 : failure.reason === "not-found" ? 404 : failure.reason === "retired" ? 410 : failure.reason === "corrupt" ? 500 : 409 }
    )
  })))
