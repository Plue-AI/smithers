import type { StorageApi } from "@tanstack/db"
import type { EnumerableRecoveryStorage } from "./StorageRecovery"
import { StorageRecoveryError } from "./StorageRecovery"
import { Data } from "effect"
import { z } from "zod"
import { digest } from "@smthrs/core/Digest"
import { AgentTurnErasureSchema, agentTurnJournalDigestInput, type AgentTurnErasure } from "@smthrs/rpc/AgentTurnJournal"

/** Private, outside the envelope: checked before either backend imports or exposes rows. */
export const PRIVACY_RETIREMENT_KEY = "smithers-mvp.privacyRetirement"
/** Delete-only obligations survive an explicit raw local recovery reset. */
export const RESET_ERASURE_OUTBOX_KEY = "smithers-mvp.resetErasures"
export const PRIVACY_RETIREMENT_EVENT = "smithers-privacy-retirement"
export interface PrivacyRetirement {
  readonly version: 2
  readonly id: string
  readonly mode: "account" | "reset"
  readonly backend: "opfs" | "localStorage"
  readonly targetStreamId: string
  readonly phase: "pending" | "remote-pending" | "complete"
  /** Delete-only capabilities: never exported, logged or included in model state. */
  readonly erasures: ReadonlyArray<AgentTurnErasure>
}
const markerFields = {
  id: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/), mode: z.enum(["account", "reset"]), backend: z.enum(["opfs", "localStorage"]),
  targetStreamId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/)
}
const markerSchema = z.object({ version: z.literal(2), ...markerFields,
  phase: z.enum(["pending", "remote-pending", "complete"]), erasures: z.array(AgentTurnErasureSchema)
}).strict().refine(value => (value.phase !== "complete" || value.erasures.length === 0) &&
  (value.phase !== "remote-pending" || value.erasures.length > 0) &&
  new Set(value.erasures.map(entry => JSON.stringify([entry.runId, entry.legId]))).size === value.erasures.length)
const legacyMarkerSchema = z.object({ version: z.literal(1), ...markerFields, phase: z.enum(["pending", "complete"]) }).strict()
/** Raw detail only. People see the copy in `PrivacyRetirementCopy.ts`. */
const CLEANUP_INCOMPLETE = "Local privacy cleanup is incomplete."
type Detail = { readonly message: string }
/** The marker or reset queue in localStorage does not parse or validate. */
export class PrivacyMarkerUnreadable extends Data.TaggedError("PrivacyMarkerUnreadable")<Detail> {
  constructor() { super({ message: `${CLEANUP_INCOMPLETE} The cleanup record is unreadable.` }) }
}
/** A cleanup is still pending, so saved state stays closed until it resumes. */
export class PrivacyCleanupPending extends Data.TaggedError("PrivacyCleanupPending")<Detail> {
  constructor() { super({ message: `${CLEANUP_INCOMPLETE} A cleanup is still pending.` }) }
}
/** Two delete-only proofs claim the same turn leg with different tokens. */
export class PrivacyConflictingErasureProof extends Data.TaggedError("PrivacyConflictingErasureProof")<Detail> {
  constructor() { super({ message: `${CLEANUP_INCOMPLETE} Two erasure proofs conflict.` }) }
}
/** The browser accepted a write or delete but the read-back disagrees. */
export class PrivacyKeyNotRemoved extends Data.TaggedError("PrivacyKeyNotRemoved")<Detail> {
  constructor() { super({ message: `${CLEANUP_INCOMPLETE} Browser storage did not keep a write or delete.` }) }
}
/** The storage the cleanup needs is missing, in memory only, or cannot be opened. */
export class PrivacyStorageUnavailable extends Data.TaggedError("PrivacyStorageUnavailable")<Detail> {
  constructor() { super({ message: `${CLEANUP_INCOMPLETE} The storage it needs is unavailable.` }) }
}
/** The marker names another cleanup, stream or backend than the one running. */
export class PrivacyMarkerMismatch extends Data.TaggedError("PrivacyMarkerMismatch")<Detail> {
  constructor() { super({ message: `${CLEANUP_INCOMPLETE} The cleanup record does not match this store.` }) }
}
/** Saved event authority cannot prove the cleanup, or the store has a shape it cannot erase. */
export class PrivacyAuthorityMissing extends Data.TaggedError("PrivacyAuthorityMissing")<Detail> {
  constructor() { super({ message: `${CLEANUP_INCOMPLETE} Saved history cannot prove the cleanup.` }) }
}
export type PrivacyRetirementError =
  | PrivacyMarkerUnreadable | PrivacyCleanupPending | PrivacyConflictingErasureProof | PrivacyKeyNotRemoved
  | PrivacyStorageUnavailable | PrivacyMarkerMismatch | PrivacyAuthorityMissing
export const PRIVACY_RETIREMENT_TAGS = [
  "PrivacyMarkerUnreadable", "PrivacyCleanupPending", "PrivacyConflictingErasureProof", "PrivacyKeyNotRemoved",
  "PrivacyStorageUnavailable", "PrivacyMarkerMismatch", "PrivacyAuthorityMissing"
] as const satisfies ReadonlyArray<PrivacyRetirementError["_tag"]>
const privacyTags: ReadonlySet<string> = new Set(PRIVACY_RETIREMENT_TAGS)
export const isPrivacyRetirementError = (value: unknown): value is PrivacyRetirementError =>
  value instanceof Error && privacyTags.has((value as { readonly _tag?: unknown })._tag as string)
export type PrivacyStorage = StorageApi & EnumerableRecoveryStorage
/** Encoded row keys and values come only from the verified permitted projection. */
export type PermittedStorageRows = ReadonlyMap<string, ReadonlyMap<string, unknown>>
export const permittedRows = <T extends { readonly versionKey: string }>(
  existing: ReadonlyMap<string, T>, permitted: ReadonlyMap<string, unknown>
): Map<string, { readonly versionKey: string; readonly data: unknown }> => {
  const canonical = new Map<string, T>()
  for (const [key, row] of existing) canonical.set(key.startsWith("s:") || key.startsWith("n:") ? key : `s:${key}`, row)
  return new Map([...permitted].map(([key, data]) => {
    const row = canonical.get(key)
    if (row === undefined) throw new PrivacyMarkerMismatch()
    return [key, { versionKey: row.versionKey, data }]
  }))
}
export const privacyStorage = (value: StorageApi | undefined): PrivacyStorage => {
  const candidate = value as Partial<PrivacyStorage> | undefined
  if (candidate === undefined || typeof candidate.length !== "number" || typeof candidate.key !== "function") {
    throw new PrivacyStorageUnavailable()
  }
  return candidate as PrivacyStorage
}
export const readPrivacyRetirement = (storage: Pick<StorageApi, "getItem">): PrivacyRetirement | undefined => {
  const raw = storage.getItem(PRIVACY_RETIREMENT_KEY)
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw)
    if (value?.version === 1) return { ...legacyMarkerSchema.parse(value), version: 2, erasures: [] }
    return markerSchema.parse(value)
  } catch { throw new PrivacyMarkerUnreadable() }
}
const storeMarker = (storage: StorageApi, value: PrivacyRetirement): void => {
  markerSchema.parse(value)
  const raw = JSON.stringify(value)
  storage.setItem(PRIVACY_RETIREMENT_KEY, raw)
  if (storage.getItem(PRIVACY_RETIREMENT_KEY) !== raw) throw new PrivacyKeyNotRemoved()
}
const mergeErasures = (previous: ReadonlyArray<AgentTurnErasure>, next: ReadonlyArray<AgentTurnErasure>): AgentTurnErasure[] => {
  const pending = new Map(previous.map(entry => [JSON.stringify([entry.runId, entry.legId]), entry]))
  for (const value of next) {
    const entry = AgentTurnErasureSchema.parse(value), key = JSON.stringify([entry.runId, entry.legId])
    const old = pending.get(key)
    if (old !== undefined && old.retirementProof !== entry.retirementProof) throw new PrivacyConflictingErasureProof()
    pending.set(key, entry)
  }
  return [...pending.values()]
}
const resetErasureSchema = z.object({ version: z.literal(1), erasures: z.array(AgentTurnErasureSchema) }).strict()
  .refine(value => new Set(value.erasures.map(entry => JSON.stringify([entry.runId, entry.legId]))).size === value.erasures.length)

export const readResetErasures = (storage: Pick<StorageApi, "getItem">): ReadonlyArray<AgentTurnErasure> => {
  const raw = storage.getItem(RESET_ERASURE_OUTBOX_KEY)
  if (raw === null) return []
  try { return resetErasureSchema.parse(JSON.parse(raw)).erasures } catch { throw new PrivacyMarkerUnreadable() }
}
const storeResetErasures = (storage: StorageApi, entries: ReadonlyArray<AgentTurnErasure>): void => {
  if (entries.length === 0) {
    storage.removeItem(RESET_ERASURE_OUTBOX_KEY)
    if (storage.getItem(RESET_ERASURE_OUTBOX_KEY) !== null) throw new PrivacyKeyNotRemoved()
    return
  }
  const raw = JSON.stringify(resetErasureSchema.parse({ version: 1, erasures: entries }))
  storage.setItem(RESET_ERASURE_OUTBOX_KEY, raw)
  if (storage.getItem(RESET_ERASURE_OUTBOX_KEY) !== raw) throw new PrivacyKeyNotRemoved()
}

/** Call under the writer lease before erasing any raw local source. A corrupt
 * old marker cannot prove unknown obligations; only a fully validated marker
 * contributes delete-only entries. The separate queue itself must validate. */
export const preserveResetErasures = (storage: StorageApi): void => {
  const retained = readResetErasures(storage)
  let marker: PrivacyRetirement | undefined
  try { marker = readPrivacyRetirement(storage) } catch { /* Explicit raw reset may erase an unreadable marker. */ }
  const entries = mergeErasures(retained, marker?.erasures ?? [])
  if (entries.length > 0 || storage.getItem(RESET_ERASURE_OUTBOX_KEY) !== null) storeResetErasures(storage, entries)
}

export const pendingRemoteErasures = (storage: Pick<StorageApi, "getItem">): ReadonlyArray<AgentTurnErasure> => {
  const marker = readPrivacyRetirement(storage)
  if (marker?.phase === "pending") return []
  return mergeErasures(marker?.erasures ?? [], readResetErasures(storage))
}

export const beginPrivacyRetirement = (
  storage: StorageApi, intent: Omit<PrivacyRetirement, "version" | "phase" | "erasures">,
  erasures: ReadonlyArray<AgentTurnErasure> = []
): PrivacyRetirement => {
  const previous = readPrivacyRetirement(storage)
  if (previous?.phase === "pending") throw new PrivacyCleanupPending()
  const pending = mergeErasures(previous?.erasures ?? [], erasures)
  mergeErasures(readResetErasures(storage), pending) // Conflicting scoped proofs must fail before a new marker is accepted.
  const next: PrivacyRetirement = { version: 2, ...intent, phase: "pending", erasures: pending }
  storeMarker(storage, next)
  if (typeof globalThis.dispatchEvent === "function") globalThis.dispatchEvent(new Event(PRIVACY_RETIREMENT_EVENT))
  return readPrivacyRetirement(storage)!
}
/** A degraded prepare could not read OPFS legs; add them after authority verifies and before rotation. */
export const addPendingTurnErasures = (storage: StorageApi, intent: PrivacyRetirement, entries: ReadonlyArray<AgentTurnErasure>): void => {
  const current = readPrivacyRetirement(storage)
  if (current?.id !== intent.id || current.phase !== "pending") throw new PrivacyMarkerMismatch()
  const erasures = mergeErasures(current.erasures, entries)
  if (erasures.length !== current.erasures.length) storeMarker(storage, { ...current, erasures })
}
export const completePrivacyRetirement = (storage: StorageApi, intent: PrivacyRetirement): void => {
  const current = readPrivacyRetirement(storage)
  if (current?.id !== intent.id || current.targetStreamId !== intent.targetStreamId) throw new PrivacyMarkerMismatch()
  storeMarker(storage, { ...current, phase: current.erasures.length === 0 ? "complete" : "remote-pending" })
}

/** Follow a committed projector rotation without losing remote erasure obligations. */
export const retargetPrivacyRetirement = (storage: StorageApi, intent: PrivacyRetirement, targetStreamId: string): void => {
  const current = readPrivacyRetirement(storage)
  if (current?.id !== intent.id || current.targetStreamId !== intent.targetStreamId) {
    throw new PrivacyMarkerMismatch()
  }
  storeMarker(storage, { ...current, targetStreamId })
}

export const deriveTurnErasures = (legs: Iterable<{ readonly turnId: string; readonly journal: { readonly legId: string; readonly token: string } }>): AgentTurnErasure[] =>
  [...legs].map(leg => AgentTurnErasureSchema.parse({ runId: leg.turnId, legId: leg.journal.legId,
    retirementProof: digest(agentTurnJournalDigestInput("access", leg.journal.token)) }))

/** Keep a side turn's delete-only proof before its in-memory replay token is released. */
export const enqueueTurnErasure = (storage: StorageApi, entry: AgentTurnErasure): void => {
  storeResetErasures(storage, mergeErasures(readResetErasures(storage), [entry]))
}

/** Ack only the exact scoped delete capability; never replace a newer intent with an old snapshot. */
export const acknowledgeRemoteErasure = (storage: StorageApi, acknowledged: AgentTurnErasure): void => {
  const current = readPrivacyRetirement(storage)
  const reset = readResetErasures(storage)
  const keep = (entry: AgentTurnErasure) => entry.runId !== acknowledged.runId || entry.legId !== acknowledged.legId || entry.retirementProof !== acknowledged.retirementProof
  if (current !== undefined) {
    const erasures = current.erasures.filter(keep)
    if (erasures.length !== current.erasures.length) storeMarker(storage, { ...current, erasures,
      phase: current.phase === "pending" ? "pending" : erasures.length === 0 ? "complete" : "remote-pending" })
  }
  const retained = reset.filter(keep)
  if (retained.length !== reset.length) storeResetErasures(storage, retained)
}

/** Hold the writer lease throughout enumeration/deletion; this is not a cross-tab CAS. */
export const ownedLocalKeys = (storage: PrivacyStorage): string[] => {
  if (!Number.isSafeInteger(storage.length) || storage.length < 0 || storage.length > 100_000) throw new PrivacyStorageUnavailable()
  const keys = new Set<string>()
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith("smithers-mvp.") || key?.startsWith("smithers-mvp-quarantine.")) keys.add(key)
  }
  return [...keys].sort()
}
/** Keep only explicit verified live/bookkeeping keys; never preserve an opaque backup. */
export const eraseLocalRecoveryCopies = (storage: PrivacyStorage, keep: ReadonlySet<string>): void => {
  readResetErasures(storage) // Retain only validated delete-only obligations, never opaque backup bytes.
  for (const key of ownedLocalKeys(storage)) {
    if (key === PRIVACY_RETIREMENT_KEY || key === RESET_ERASURE_OUTBOX_KEY || keep.has(key)) continue
    storage.removeItem(key)
    if (storage.getItem(key) !== null) throw new PrivacyKeyNotRemoved()
  }
  if (ownedLocalKeys(storage).some(key => key !== PRIVACY_RETIREMENT_KEY && key !== RESET_ERASURE_OUTBOX_KEY && !keep.has(key))) throw new PrivacyKeyNotRemoved()
}

/** Capture before any asynchronous work and call again immediately before releasing bytes. */
export const capturePrivacyGuard = (storage: Pick<StorageApi, "getItem"> | undefined): (() => void) => {
  const original = storage === undefined ? undefined : readPrivacyRetirement(storage)
  if (original?.phase === "pending") throw new StorageRecoveryError("changed")
  return () => {
    const current = storage === undefined ? undefined : readPrivacyRetirement(storage)
    if (current?.id !== original?.id || current?.targetStreamId !== original?.targetStreamId || current?.phase === "pending") throw new StorageRecoveryError("changed")
  }
}
