import { digest } from "@smthrs/core/Digest"
import { makeDigestPartsSync } from "@smthrs/crypto"
import { z } from "zod"
import { type AppTransition } from "./AppState"
import {
  APP_PROJECTION_COLLECTION_NAMES, APP_PROJECTION_SCHEMAS, APP_TRANSITION_TYPES,
  appProjectionKey, projectAppEvent, seedAppProjection,
  type AppProjectionCollectionName, type AppProjectionPersistenceMode, type AppProjectionSeedContext,
  type AppProjectionSnapshot
} from "./AppProjection"
import { canonicalEventValue, canonicalStoredJsonValue, decodeEventValue, encodeEventValue, type EncodedEventValue, type EventJson } from "./EventValue"
import { validateAppTransition } from "./AppTransitionValidation"
import { freezeProjectionValue, isImmutableProjectionValue } from "./ImmutableProjection"

export const APP_EVENT_FORMAT_VERSION = 1
/*
 * Bump whenever an already-persisted row would reproject differently: a field
 * removed, renamed or retyped, a changed transition set, or a changed
 * collection roster (a checkpoint naming another roster is refused below; 11
 * added models and seats, 12 added flow durations; AppStore.events.test.ts
 * pins the roster to the version). A bump retires the stream and clears the event log
 * (AppStore.ts, "projector-upgrade"), so an added OPTIONAL field owes none —
 * every stored row still parses to the same bytes and the same hash, which
 * AppStore.events.test.ts pins per field.
 */
// v14 associates tool acts with their turn; v15 clears dismissed card navigation.
// v16 removes the unused chain journal projections; v17 narrows signup to the GitHub door.
// v18 retires signup details with their account; v19 retires the World starter note.
// v20 renames the workspace.* commands to box.* (saved toast actions name flows).
export const APP_PROJECTOR_VERSION = 20

const JsonSchema: z.ZodType<EventJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonSchema), z.record(z.string(), JsonSchema)
]))
const EncodedValueSchema = z.object({
  value: JsonSchema,
  undefinedPaths: z.array(z.array(z.union([z.string(), z.number().int().nonnegative()])))
}).strict()
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const PositionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const VersionFields = { formatVersion: z.literal(APP_EVENT_FORMAT_VERSION), projectorVersion: z.literal(APP_PROJECTOR_VERSION) }
const ModeSchema = z.enum(["opfs", "localStorage", "memory"])
const BootSchema = z.object({ createdAt: z.number().finite(), theme: z.enum(["light", "dark"]) }).strict()

/** These are private authority rows, not a reactive public card or diagnostic tail. */
export const AppEventRecordSchema = z.object({
  ...VersionFields,
  id: z.string().min(1), streamId: z.string().min(1), sequence: PositionSchema.positive(),
  kind: z.enum(["transition", "boot"]), type: z.string().min(1), actor: z.enum(["user", "smithers", "system"]),
  createdAt: z.number().finite(), revision: PositionSchema, persistenceMode: ModeSchema,
  input: EncodedValueSchema,
  previousEventHash: HashSchema, previousStateHash: HashSchema, stateHash: HashSchema, hash: HashSchema
}).strict()
export type AppEventRecord = z.infer<typeof AppEventRecordSchema>

export const AppEventHeadSchema = z.object({
  ...VersionFields,
  id: z.literal("current"), streamId: z.string().min(1), sequence: PositionSchema,
  revision: PositionSchema, eventHash: HashSchema, stateHash: HashSchema
}).strict()
export type AppEventHead = z.infer<typeof AppEventHeadSchema>

export const AppEventCheckpointSchema = z.object({
  ...VersionFields,
  id: z.literal("current"), streamId: z.string().min(1), sequence: PositionSchema,
  revision: PositionSchema, eventHash: HashSchema, stateHash: HashSchema,
  reason: z.enum(["created", "legacy-baseline", "compaction", "privacy-reset", "projector-upgrade"]),
  snapshot: z.record(z.string(), z.array(JsonSchema)), hash: HashSchema
}).strict()
export type AppEventCheckpoint = z.infer<typeof AppEventCheckpointSchema>

/** Read boundary only: replay and all new writes still use the literal versions. */
const StoredProjectorVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(version => {
  // Refuse before the storage opener can normalize or commit any rows.
  if (version > APP_PROJECTOR_VERSION) throw new AppProjectorVersionError(version)
  return version
})
export const StoredAppEventHeadSchema = AppEventHeadSchema.extend({ projectorVersion: StoredProjectorVersion })
export const StoredAppEventCheckpointSchema = AppEventCheckpointSchema.extend({ projectorVersion: StoredProjectorVersion })
export const StoredAppEventRecordSchema = AppEventRecordSchema.extend({ projectorVersion: StoredProjectorVersion,
  // Retired events must parse before the projector-upgrade checkpoint replaces them.
  journalBudgetBytes: PositionSchema.positive().optional() })

export class AppProjectorVersionError extends Error {
  constructor(readonly savedVersion: number) {
    super(`Saved app projector version ${savedVersion} is newer than this build (${APP_PROJECTOR_VERSION}). Update Smithers to open it. Saved history was preserved.`)
    this.name = "AppProjectorVersionError"
  }
}

/** An older projector cannot replay with today's row shapes or transition set. */
export const needsAppProjectorUpgrade = (headInput: unknown, checkpointInput: unknown): boolean => {
  const head = StoredAppEventHeadSchema.safeParse(headInput)
  const checkpoint = StoredAppEventCheckpointSchema.safeParse(checkpointInput)
  if (!head.success || !checkpoint.success) return fail("format")
  const newest = Math.max(head.data.projectorVersion, checkpoint.data.projectorVersion)
  if (newest > APP_PROJECTOR_VERSION) throw new AppProjectorVersionError(newest)
  if (head.data.projectorVersion !== checkpoint.data.projectorVersion) return fail("format")
  if (newest === APP_PROJECTOR_VERSION) return false
  if (head.data.streamId !== checkpoint.data.streamId) return fail("scope")
  if (checkpoint.data.sequence > head.data.sequence) return fail("head")
  if (checkpoint.data.hash !== sealedHash("checkpoint", checkpoint.data)) return fail("checkpoint")
  return true
}

export const AppEventRetirementSchema = z.object({ id: HashSchema }).strict()

export class AppEventIntegrityError extends Error {
  constructor(readonly reason: "format" | "scope" | "checkpoint" | "gap" | "conflict" | "event" | "projection" | "head") {
    super(`App event verification failed (${reason}). Saved history was preserved.`)
  }
}
const fail = (reason: AppEventIntegrityError["reason"]): never => { throw new AppEventIntegrityError(reason) }
const hash = (domain: string, value: unknown): string => digest(`smithers-app/${domain}/v1:${canonicalEventValue(value)}`)
const seal = <T extends object>(domain: string, value: T): T & { hash: string } => ({ ...value, hash: hash(domain, value) })
const sealedHash = (domain: string, value: { readonly hash: string }): string => {
  const { hash: _hash, ...body } = value
  return hash(domain, body)
}

/** Stored rows use JSON absence for optional fields. Patch inputs use the lossless event codec. */
const rowJson = (row: unknown): unknown => {
  encodeEventValue(row) // Reject accessors, cycles and silent scalar conversions before JSON.stringify.
  return JSON.parse(JSON.stringify(row)) as unknown
}

export const normalizeAppProjection = (input: unknown): AppProjectionSnapshot => {
  encodeEventValue(input)
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("projection")
  const names = Object.keys(input)
  if (names.length !== APP_PROJECTION_COLLECTION_NAMES.length || names.some(name => !Object.hasOwn(APP_PROJECTION_SCHEMAS, name))) return fail("projection")
  const entries = APP_PROJECTION_COLLECTION_NAMES.map(name => {
    const rows = (input as Record<string, unknown>)[name]
    if (!Array.isArray(rows)) return fail("projection")
    const keys = new Set<string>()
    const normalized = rows.map(row => {
      const result = APP_PROJECTION_SCHEMAS[name].safeParse(rowJson(row))
      if (!result.success) return fail("projection")
      const stored = rowJson(result.data)
      const again = APP_PROJECTION_SCHEMAS[name].safeParse(stored)
      if (!again.success || canonicalEventValue(rowJson(again.data)) !== canonicalEventValue(stored)) return fail("projection")
      const key = appProjectionKey(name, stored)
      if (keys.has(key)) return fail("projection")
      keys.add(key)
      return stored
    })
    return [name, normalized]
  })
  return Object.fromEntries(entries) as AppProjectionSnapshot
}

/** Physical row order and optional undefined properties are not distinct materialized facts. */
const immutableRowJson = new WeakMap<object, string>()
const immutableTables = new WeakMap<object, Map<string, string>>()
const projectionDigest = makeDigestPartsSync()
const immutableHashes = new WeakMap<object, string>()
export const appProjectionHash = (snapshot: AppProjectionSnapshot): string => {
  const previous = immutableHashes.get(snapshot)
  if (previous !== undefined) return previous
  const entries = [...APP_PROJECTION_COLLECTION_NAMES].sort().map(name => {
    const table = Object.getOwnPropertyDescriptor(snapshot, name)
    if (!table || !("value" in table) || !Array.isArray(table.value)) return fail("projection")
    const rows = table.value as unknown[]
    const cachedTable = immutableTables.get(rows)?.get(name)
    if (cachedTable !== undefined) return cachedTable
    if (Reflect.ownKeys(rows).length !== rows.length + 1) return fail("projection")
    const values: Array<readonly [string, string]> = []
    for (let index = 0; index < rows.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(rows, index)
      if (!entry || !("value" in entry) || !entry.enumerable) return fail("projection")
      const row = entry.value
      const frozen = isImmutableProjectionValue(row)
      let json = frozen ? immutableRowJson.get(row) : undefined
      if (json === undefined) {
        json = canonicalStoredJsonValue(row)
        if (frozen) immutableRowJson.set(row, json)
      }
      values.push([appProjectionKey(name, row), json])
    }
    values.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const encoded = `${JSON.stringify(name)}:[${values.map(([key, row]) => `[${JSON.stringify(key)},${row}]`).join(",")}]`
    if (isImmutableProjectionValue(rows)) {
      const cached = immutableTables.get(rows) ?? new Map<string, string>()
      cached.set(name, encoded)
      immutableTables.set(rows, cached)
    }
    return encoded
  })
  // Identical v1 wire bytes to hash("projection", normalizedRows), without its repeated tree copies.
  const result = projectionDigest(['smithers-app/projection/v1:{"value":{', ...entries.flatMap((entry, index) => index ? [",", entry] : [entry]), '},"undefinedPaths":[]}'])
  if (isImmutableProjectionValue(snapshot)) immutableHashes.set(snapshot, result)
  return result
}

const revisionOf = (snapshot: AppProjectionSnapshot): number => snapshot.sessions.find(row => row.id === "main")?.revision ?? 0

/** Redaction happens before the fact is retained, not only in its rendered projection. */
export const prepareAppTransition = (snapshot: AppProjectionSnapshot, input: AppTransition): AppTransition => {
  // Round-trip first so no caller-owned object/accessor can change a pending event.
  const transition = decodeEventValue(encodeEventValue(input))
  const removeCapabilities = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return
    if (Object.hasOwn(value, "authorizationId")) delete (value as Record<string, unknown>).authorizationId
    for (const nested of Object.values(value)) removeCapabilities(nested)
  }
  removeCapabilities(transition)
  try { return validateAppTransition(snapshot, transition) } catch { return fail("event") }
}

export interface AppStreamState {
  readonly snapshot: AppProjectionSnapshot
  readonly head: AppEventHead
}

export const createAppCheckpoint = (
  state: AppStreamState,
  reason: AppEventCheckpoint["reason"]
): AppEventCheckpoint => {
  const snapshot = normalizeAppProjection(state.snapshot)
  if (appProjectionHash(snapshot) !== state.head.stateHash || revisionOf(snapshot) !== state.head.revision) return fail("projection")
  return seal("checkpoint", {
    ...state.head, reason,
    snapshot: snapshot as unknown as AppEventCheckpoint["snapshot"]
  })
}

export const initializeAppStream = (
  input: AppProjectionSnapshot,
  streamId: string,
  reason: "created" | "legacy-baseline" | "privacy-reset" | "projector-upgrade"
): AppStreamState & { readonly checkpoint: AppEventCheckpoint } => {
  if (!streamId) return fail("scope")
  const snapshot = normalizeAppProjection(input)
  const stateHash = appProjectionHash(snapshot)
  const head: AppEventHead = {
    ...VersionFieldsValue, id: "current", streamId, sequence: 0,
    revision: revisionOf(snapshot), stateHash, eventHash: hash("genesis", { streamId, stateHash })
  }
  return { snapshot, head, checkpoint: createAppCheckpoint({ snapshot, head }, reason) }
}
const VersionFieldsValue = { formatVersion: APP_EVENT_FORMAT_VERSION, projectorVersion: APP_PROJECTOR_VERSION } as const

export type AppEventInput =
  | { readonly kind: "transition"; readonly transition: AppTransition }
  | { readonly kind: "boot"; readonly seed: AppProjectionSeedContext }

export const appendAppEvent = (
  previous: AppStreamState,
  input: AppEventInput,
  context: { readonly eventId: string; readonly createdAt: number; readonly persistenceMode: AppProjectionPersistenceMode }
): (AppStreamState & { readonly event: AppEventRecord }) | undefined => {
  if (!context.eventId || !Number.isFinite(context.createdAt) || !ModeSchema.safeParse(context.persistenceMode).success ||
    previous.head.sequence >= Number.MAX_SAFE_INTEGER || (input.kind !== "boot" && input.kind !== "transition")) return fail("event")
  if (appProjectionHash(previous.snapshot) !== previous.head.stateHash || revisionOf(previous.snapshot) !== previous.head.revision) return fail("projection")
  const seed = input.kind === "boot" ? BootSchema.safeParse(decodeEventValue(encodeEventValue(input.seed))) : undefined
  if (seed && (!seed.success || seed.data.createdAt !== context.createdAt)) return fail("event")
  const transition = input.kind === "transition" ? prepareAppTransition(previous.snapshot, input.transition) : undefined
  const value = seed?.success ? seed.data : transition
  const encoded = encodeEventValue(value)
  const snapshot = input.kind === "boot"
    ? seedAppProjection(previous.snapshot, value as AppProjectionSeedContext)
    : projectAppEvent(previous.snapshot, { transition: transition!, revision: previous.head.revision + 1,
      createdAt: context.createdAt, persistenceMode: context.persistenceMode })
  if (snapshot === previous.snapshot || (input.kind === "boot" && appProjectionHash(snapshot) === previous.head.stateHash)) return undefined
  if (isImmutableProjectionValue(previous.snapshot)) freezeProjectionValue(snapshot)
  const stateHash = appProjectionHash(snapshot)
  const event: AppEventRecord = seal("event", {
    ...VersionFieldsValue, id: context.eventId, streamId: previous.head.streamId, sequence: previous.head.sequence + 1,
    kind: input.kind, type: transition?.type ?? "app.boot", actor: transition?.actor ?? "system",
    createdAt: context.createdAt, revision: revisionOf(snapshot), persistenceMode: context.persistenceMode,
    input: { value: encoded.value, undefinedPaths: encoded.undefinedPaths.map(path => [...path]) }, previousEventHash: previous.head.eventHash, previousStateHash: previous.head.stateHash, stateHash
  })
  const head: AppEventHead = { ...previous.head, sequence: event.sequence, revision: event.revision, eventHash: event.hash, stateHash }
  return { snapshot, head, event }
}

const decodeRecord = (input: unknown): AppEventRecord => {
  const result = AppEventRecordSchema.safeParse(input)
  if (!result.success) return fail("format")
  const event = result.data
  if (event.hash !== sealedHash("event", event)) return fail("event")
  return event
}

const replayEvent = (previous: AppStreamState, event: AppEventRecord): AppStreamState => {
  if (event.streamId !== previous.head.streamId) return fail("scope")
  if (event.sequence !== previous.head.sequence + 1) return fail("gap")
  if (event.previousEventHash !== previous.head.eventHash || event.previousStateHash !== previous.head.stateHash) return fail("conflict")
  let value: unknown
  try { value = decodeEventValue(event.input as EncodedEventValue) } catch { return fail("event") }
  let snapshot: AppProjectionSnapshot
  if (event.kind === "boot") {
    const seed = BootSchema.safeParse(value)
    if (!seed.success || event.type !== "app.boot" || event.actor !== "system" || seed.data.createdAt !== event.createdAt) return fail("event")
    snapshot = seedAppProjection(previous.snapshot, seed.data)
  } else {
    if (typeof value !== "object" || value === null || !("type" in value) || !("actor" in value) ||
      value.type !== event.type || value.actor !== event.actor || !Object.hasOwn(APP_TRANSITION_TYPES, event.type)) return fail("event")
    const transition = prepareAppTransition(previous.snapshot, value as AppTransition)
    if (canonicalEventValue(transition) !== canonicalEventValue(value)) return fail("event")
    snapshot = projectAppEvent(previous.snapshot, { transition, revision: event.revision,
      createdAt: event.createdAt, persistenceMode: event.persistenceMode })
    if (snapshot === previous.snapshot) return fail("event")
  }
  freezeProjectionValue(snapshot)
  if (revisionOf(snapshot) !== event.revision || appProjectionHash(snapshot) !== event.stateHash) return fail("projection")
  return { snapshot, head: { ...previous.head, sequence: event.sequence, revision: event.revision, eventHash: event.hash, stateHash: event.stateHash } }
}

/** Pure replay. No host, dispatcher, network or effect executor is reachable here. */
export const replayAppEvents = (
  checkpointInput: unknown,
  events: ReadonlyArray<unknown>,
  headInput: unknown
): AppStreamState => {
  const checkpointResult = AppEventCheckpointSchema.safeParse(checkpointInput)
  const headResult = AppEventHeadSchema.safeParse(headInput)
  if (!checkpointResult.success || !headResult.success) return fail("format")
  const checkpoint = checkpointResult.data
  const expected = headResult.data
  if (checkpoint.hash !== sealedHash("checkpoint", checkpoint)) return fail("checkpoint")
  if (checkpoint.streamId !== expected.streamId) return fail("scope")
  if (checkpoint.sequence > expected.sequence) return fail("head")
  const snapshot = normalizeAppProjection(checkpoint.snapshot)
  freezeProjectionValue(snapshot)
  if (appProjectionHash(snapshot) !== checkpoint.stateHash || revisionOf(snapshot) !== checkpoint.revision) return fail("checkpoint")
  let current: AppStreamState = { snapshot, head: {
    ...VersionFieldsValue, id: "current", streamId: checkpoint.streamId,
    sequence: checkpoint.sequence, revision: checkpoint.revision, eventHash: checkpoint.eventHash, stateHash: checkpoint.stateHash
  } }
  const bySequence = new Map<number, AppEventRecord>()
  const byId = new Map<string, string>()
  for (const raw of events) {
    const event = decodeRecord(raw)
    if (event.streamId !== expected.streamId) return fail("scope")
    if (event.sequence > expected.sequence) return fail("head")
    const prior = bySequence.get(event.sequence)
    if (prior !== undefined && prior.hash !== event.hash) return fail("conflict")
    const sameId = byId.get(event.id)
    if (sameId !== undefined && sameId !== event.hash) return fail("conflict")
    bySequence.set(event.sequence, event)
    byId.set(event.id, event.hash)
  }
  for (const event of [...bySequence.values()].sort((a, b) => a.sequence - b.sequence)) {
    if (event.sequence <= checkpoint.sequence) continue
    current = replayEvent(current, event)
  }
  if (canonicalEventValue(current.head) !== canonicalEventValue(expected)) return fail("head")
  return current
}

export interface AppProjectionDifference {
  readonly collection: AppProjectionCollectionName
  readonly key: string
  readonly kind: "missing" | "extra" | "changed"
}
export interface AppStateVerification {
  readonly valid: boolean
  readonly streamId: string
  readonly sequence: number
  readonly expectedHash: string
  readonly actualHash: string
  readonly differences: ReadonlyArray<AppProjectionDifference>
}

/** A proof identifies mismatches without exposing row payloads to diagnostics. */
export const verifyAppProjection = (expected: AppStreamState, actual: AppProjectionSnapshot): AppStateVerification => {
  const differences: AppProjectionDifference[] = []
  for (const collection of APP_PROJECTION_COLLECTION_NAMES) {
    const wanted = new Map(expected.snapshot[collection].map(row => [appProjectionKey(collection, row), row]))
    const observed = new Map(actual[collection].map(row => [appProjectionKey(collection, row), row]))
    for (const [key, row] of wanted) {
      if (!observed.has(key)) differences.push({ collection, key, kind: "missing" })
      else if (canonicalEventValue(rowJson(row)) !== canonicalEventValue(rowJson(observed.get(key)))) differences.push({ collection, key, kind: "changed" })
    }
    for (const key of observed.keys()) if (!wanted.has(key)) differences.push({ collection, key, kind: "extra" })
  }
  const actualHash = appProjectionHash(actual)
  return { valid: differences.length === 0 && actualHash === expected.head.stateHash,
    streamId: expected.head.streamId, sequence: expected.head.sequence,
    expectedHash: expected.head.stateHash, actualHash, differences }
}

export const retiredAppStreamKey = (streamId: string): string => hash("retired-stream", streamId)
