import { Context, Data, Effect, Layer, Semaphore } from "effect"
import { z } from "zod"
import { BudgetTokensSchema, RepositoryJobSchema, SetupDraftSchema, SetupHostInputSchema, SetupOperationResponseSchema, SetupReceiptSchema, type SetupHostInput, type RepositoryJob } from "@smthrs/rpc/RepositorySetup"
import { workerFailureCode, type WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import { DurableStorage, namespaceCall, type NativeNamespace } from "./DurableStorage"
import { readBoundedJson, readJsonOrUndefined } from "./Http"
import { refuse } from "./Responses"

/** `cause` is the storage or body failure behind a generic answer, for the log line only. */
export class SetupStoreError extends Data.TaggedError("SetupStoreError")<{ readonly message: string; readonly status?: number; readonly code?: WorkerFailureCode; readonly cause?: unknown }> {}
export const SetupPlanSchema = z.object({ planId: z.string().min(1), flowId: z.literal("repository/setup"), digest: z.string().min(1),
  executionDigest: z.string().min(1), envelope: z.object({ capabilities: z.array(z.string()), flows: z.array(z.string()),
    budget: z.object({ tokens: BudgetTokensSchema,
      milliseconds: z.number().int().positive().max(SetupDraftSchema.shape.budgetMinutes.maxValue! * 60_000) }), host: z.string().optional() }) })
const instant = () => z.number().int().nonnegative().optional()
export const SetupRecordSchema = z.object({ version: z.number().int().nonnegative(), input: SetupHostInputSchema,
  workspaceId: z.string().uuid().optional(),
  binding: z.object({ gatewayId: z.string().min(1), workspaceId: z.string().uuid().optional() }).optional(),
  plan: SetupPlanSchema.optional(), runId: z.string().min(1).optional(), receipt: SetupReceiptSchema,
  result: SetupOperationResponseSchema.optional(), observationError: z.string().max(1000).optional(),
  resultPendingSince: instant(),
  // Server-side phase clock. Every instant is optional so a record stored
  // before this existed still decodes, and none of them reaches the wire.
  createdAt: instant(), workspaceSelectedAt: instant(), workspaceReadyAt: instant(), gatewayReadyAt: instant(),
  plannedAt: instant(), approvedAt: instant(), runStartedAt: instant() })
export type SetupRecord = z.infer<typeof SetupRecordSchema>
export type SetupInstant = "createdAt" | "workspaceSelectedAt" | "workspaceReadyAt" | "gatewayReadyAt" | "plannedAt" | "approvedAt" | "runStartedAt"
const PHASE_SEGMENTS: readonly (readonly [string, SetupInstant])[] = [["workspaceSelectedMs", "createdAt"],
  ["workspaceReadyMs", "workspaceSelectedAt"], ["gatewayReadyMs", "workspaceReadyAt"], ["plannedMs", "gatewayReadyAt"],
  ["approvedMs", "plannedAt"], ["runStartedMs", "approvedAt"], ["runMs", "runStartedAt"]]
/**
 * One bounded, content-free line for the write that actually commits a terminal
 * record, so the phase clock has a consumer. It carries identifiers and
 * durations only: no prompt, repository, issue or user text, and no credential.
 * At-most-once and attempted, never durable; logging never fails the request.
 */
const logSetupPhases = (record: SetupRecord, terminalAt: number) => {
  const durations = Object.fromEntries(PHASE_SEGMENTS.flatMap(([name, from], index) => {
    const start = record[from], end = index + 1 < PHASE_SEGMENTS.length ? record[PHASE_SEGMENTS[index + 1]![1]] : terminalAt
    return start === undefined || end === undefined ? [] : [[name, end - start]]
  }))
  try {
    console.log(JSON.stringify({ event: "repository_setup_phases", requestId: record.input.requestId, job: record.input.job,
      operation: record.input.operation, phase: record.receipt.phase, ...(record.runId ? { runId: record.runId } : {}),
      ...(record.createdAt === undefined ? {} : { totalMs: terminalAt - record.createdAt }), ...durations }))
  } catch { /* Observability never decides whether a finished setup request stands. */ }
}
const KeySchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/)
const RegistrationMatchSchema = z.object({ registrationId: z.string(), revision: z.number().int().positive(), digest: z.string(), workspaceId: z.string().uuid(), sourceRevision: z.string().min(1) })
const DiscoverySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("found"), record: SetupRecordSchema }),
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("unavailable"), error: z.string() })
])
type Discovery = z.infer<typeof DiscoverySchema>
const PointerSchema = z.object({ sequence: z.number().int().positive(), requestId: z.string().min(1) })
const CommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), login: z.string().min(1).max(100), input: SetupHostInputSchema }),
  z.object({ action: z.literal("read"), requestId: KeySchema }),
  z.object({ action: z.literal("claim"), requestId: KeySchema, holder: KeySchema }),
  z.object({ action: z.literal("release"), requestId: KeySchema, holder: KeySchema }),
  z.object({ action: z.literal("discover"), repo: z.string().min(3).max(201), job: RepositoryJobSchema, match: RegistrationMatchSchema.optional() }),
  z.object({ action: z.literal("update"), requestId: KeySchema, expectedVersion: z.number().int().nonnegative(), record: SetupRecordSchema })
])
type Command = z.infer<typeof CommandSchema>
const REQUEST_PREFIX = "repository-setup:request:"
const key = (id: string) => `${REQUEST_PREFIX}${id}`
export const setupPointerKey = (repo: string, job: RepositoryJob) => `repository-setup:current:${encodeURIComponent(repo)}:${job}`
/** Outlives the platform's 30-second waitUntil window after a killed holder. */
export const SETUP_ADVANCE_LEASE_MS = 60_000
const leaseKey = (id: string) => `repository-setup:lease:${id}`
const LeaseSchema = z.object({ holder: z.string(), until: z.number().finite() })
export const SETUP_QUEUE_KEY = "repository-setup:pending"
export interface SetupQueue { readonly login: string; readonly requests: Record<string, number> }
/**
 * The pin is the request's candidate, never its identity: the workspace this
 * request resolved to is as much its own as the one it asked for, so a retry
 * that carries the pin a poll reported back is the same operation. Any other
 * workspace still names a different one.
 */
const sameInput = (a: SetupHostInput, b: SetupHostInput, resolvedWorkspace?: string) => a.repo === b.repo && a.job === b.job && a.operation === b.operation
  && a.digest === b.digest && a.revision === b.revision && JSON.stringify(a.manual) === JSON.stringify(b.manual) && (a.workspaceId === b.workspaceId ||
    (resolvedWorkspace !== undefined && b.workspaceId === resolvedWorkspace))

/** One lock per existing GatewaySessionRegistry object, never per HTTP request. */
export class SetupStorageMutex extends Context.Service<SetupStorageMutex, Semaphore.Semaphore>()("smithers-server/SetupStorageMutex") {}
export const setupStorageMutexLayer = () => Layer.succeed(SetupStorageMutex, Semaphore.makeUnsafe(1))

/** Internal storage door. The public route supplies the validated login as the object identity. */
export const repositorySetupStorageRequest = (request: Request) => Effect.gen(function* () {
  const decoded = CommandSchema.safeParse(yield* readJsonOrUndefined(request))
  if (!decoded.success) return Response.json({ message: "Invalid setup storage command" }, { status: 400 })
  const command = decoded.data
  const storage = yield* DurableStorage
  const lock = yield* SetupStorageMutex
  return yield* Effect.gen(function* () {
    if (command.action === "discover") return Response.json(yield* discoverStoredSetup(command))
    const id = command.action === "create" ? command.input.requestId : command.requestId
    const old = yield* storage.get<SetupRecord>(key(id))
    if (command.action === "read") return Response.json({ record: old ?? null })
    if (command.action === "claim" || command.action === "release") {
      const raw = yield* storage.get(leaseKey(id))
      const parsed = raw === undefined ? undefined : LeaseSchema.safeParse(raw)
      if (parsed && !parsed.success) return Response.json({ message: "The setup lease is unavailable" }, { status: 503 })
      const lease = parsed?.data
      if (command.action === "release") {
        if (lease?.holder === command.holder) yield* storage.put(leaseKey(id), { holder: "", until: 0 })
        return Response.json({ released: true })
      }
      if (!old || old.result || (lease && lease.until > Date.now())) return Response.json({ claimed: false })
      yield* storage.put(leaseKey(id), { holder: command.holder, until: Date.now() + SETUP_ADVANCE_LEASE_MS })
      return Response.json({ claimed: true })
    }
    const queue = (yield* storage.get<SetupQueue>(SETUP_QUEUE_KEY)) ?? { login: command.action === "create" ? command.login : "", requests: {} }
    const enqueue = () => Effect.gen(function* () {
      if (command.action !== "create" || old?.result) return queue
      if (queue.login !== command.login) return yield* Effect.fail(new SetupStoreError({ status: 409, message: "The setup owner cannot change" }))
      if (!Object.hasOwn(queue.requests, id) && Object.keys(queue.requests).length >= 100) return yield* Effect.fail(new SetupStoreError({ status: 429, message: "Too many setup requests are still pending" }))
      // An alarm without a committed admission is harmless. Never admit a
      // record unless its pointer and observation queue commit in one put.
      if (storage.setAlarm) yield* storage.setAlarm(Date.now() + 5_000)
      return { ...queue, requests: { ...queue.requests, [id]: Date.now() + 86_400_000 } }
    })
    if (command.action === "create" && old) {
      // A typed refusal, not a bare sentence: the app spends the id on this
      // code and asks under a new one instead of repeating the same 409.
      if (!sameInput(old.input, command.input, old.workspaceId ?? old.binding?.workspaceId)) return refuse("setup_request_conflict", "This setup request was already used for another operation. Not your fault; retry starts a new one.")
      if (!old.result) yield* storage.put(SETUP_QUEUE_KEY, yield* enqueue())
      return Response.json({ record: old })
    }
    if (command.action === "update") {
      if (!old || !sameInput(old.input, command.record.input) || command.record.input.requestId !== id) return Response.json({ message: "The setup request identity cannot change" }, { status: 409 })
      if (old.version !== command.expectedVersion || old.result) return Response.json({ record: old })
    }
    const record: SetupRecord = command.action === "create" ? { version: 0, input: command.input, createdAt: Date.now(), receipt: {
      requestId: id, revision: command.input.revision, digest: command.input.digest, operation: command.input.operation,
      phase: "queued", updatedAt: Date.now(), results: [], evidence: []
    } } : { ...command.record, version: old!.version + 1 }
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 120_000) return Response.json({ message: "The setup record is too large; use artifact references for detailed output" }, { status: 413 })
    if (command.action === "create") {
      const pointerKey = setupPointerKey(record.input.repo, record.input.job)
      const raw = yield* storage.get(pointerKey)
      const previous = raw === undefined ? undefined : PointerSchema.safeParse(raw)
      if (previous && !previous.success) return Response.json({ message: "The setup admission index is unavailable" }, { status: 503 })
      const sequence = (previous?.data?.sequence ?? 0) + 1
      yield* storage.putMany({ [key(id)]: record, [pointerKey]: { sequence, requestId: id }, [SETUP_QUEUE_KEY]: yield* enqueue() })
    } else {
      const remaining = { ...queue.requests }
      if (record.result) delete remaining[id]
      yield* storage.putMany({ [key(id)]: record,
        ...(record.result && Object.hasOwn(queue.requests, id) ? { [SETUP_QUEUE_KEY]: { ...queue, requests: remaining } } : {}) })
      // Reached only by the update that matched the current version against a
      // record with no result, under the lock: exactly the write that finishes
      // the request. A caller cannot infer this from the record it is handed.
      if (record.result) yield* Effect.sync(() => logSetupPhases(record, Date.now()))
    }
    return Response.json({ record })
  }).pipe(lock.withPermits(1), Effect.catchTag("SetupStoreError", error => Effect.succeed(Response.json({ message: error.message }, { status: error.status ?? 503 }))))
})

/** Called under the same admission lock. It never refreshes the execution queue. */
const discoverStoredSetup = (command: Extract<Command, { action: "discover" }>): Effect.Effect<Discovery, never, DurableStorage> => Effect.gen(function* () {
  const storage = yield* DurableStorage
  const pointerKey = setupPointerKey(command.repo, command.job)
  const raw = yield* storage.get(pointerKey)
  if (raw !== undefined) {
    const pointer = PointerSchema.safeParse(raw)
    if (!pointer.success) return { state: "unavailable", error: "The setup admission index is invalid" } as const
    const record = SetupRecordSchema.safeParse(yield* storage.get(key(pointer.data.requestId)))
    if (!record.success || record.data.input.requestId !== pointer.data.requestId || record.data.input.repo !== command.repo || record.data.input.job !== command.job) return { state: "unavailable", error: "The indexed setup request is unavailable" } as const
    return { state: "found", record: record.data } as const
  }
  // Queue membership expires after 24 hours without stopping its host. Check
  // ALL legacy records before trusting even a single remaining queue entry.
  const records: SetupRecord[] = []
  let startAfter: string | undefined, count = 0, bytes = 0
  for (;;) {
    const page = yield* storage.list<unknown>({ prefix: REQUEST_PREFIX, limit: 50, ...(startAfter ? { startAfter } : {}) })
    for (const [name, value] of page) {
      count++; bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength
      if (count > 200 || bytes > 4 * 1024 * 1024) return { state: "unavailable", error: "Previous setup requests exceed the recovery limit" } as const
      const parsed = SetupRecordSchema.safeParse(value)
      if (!parsed.success || key(parsed.data.input.requestId) !== name) return { state: "unavailable", error: "A previous setup request is invalid" } as const
      if (parsed.data.input.repo === command.repo && parsed.data.input.job === command.job) records.push(parsed.data)
      startAfter = name
    }
    if (page.size < 50) break
  }
  const unfinished = records.filter(record => !record.result)
  if (unfinished.length > 1) return { state: "unavailable", error: "More than one previous setup request is unfinished" } as const
  const matching = command.match ? records.filter(record => record.result && record.input.operation === "apply"
    && record.input.revision === command.match!.revision && record.input.digest === command.match!.digest
    && (record.workspaceId ?? record.binding?.workspaceId ?? record.input.workspaceId) === command.match!.workspaceId
    && record.result.receipt?.registrationId === command.match!.registrationId && record.result.receipt.sourceRevision === command.match!.sourceRevision) : []
  const selected = unfinished[0] ?? (records.length === 1 ? records[0] : matching.length === 1 ? matching[0] : undefined)
  if (!selected) return records.length ? { state: "unavailable", error: "Previous setup requests cannot be selected safely" } as const : { state: "none" } as const
  yield* storage.put(pointerKey, { sequence: 1, requestId: selected.input.requestId })
  return { state: "found", record: selected } as const
}).pipe(Effect.catch(() => Effect.succeed({ state: "unavailable", error: "Setup recovery storage is unavailable" } as const)))

/** Expiration stops observation, never claims that an unseen host execution stopped. */
export const pendingSetupRequests = () => Effect.gen(function* () {
  const storage = yield* DurableStorage
  const lock = yield* SetupStorageMutex
  return yield* Effect.gen(function* () {
    const queue = yield* storage.get<SetupQueue>(SETUP_QUEUE_KEY)
    if (!queue) return undefined
    const requests: Record<string, number> = {}
    for (const [id, expiresAt] of Object.entries(queue.requests)) {
      const record = yield* storage.get<SetupRecord>(key(id))
      if (!record || record.result) continue
      if (expiresAt > Date.now()) requests[id] = expiresAt
      else yield* storage.put(key(id), { ...record, version: record.version + 1, observationError: "Setup observation expired. Retry to reconnect." })
    }
    const pending = { ...queue, requests }
    yield* storage.put(SETUP_QUEUE_KEY, pending)
    if (Object.keys(requests).length && storage.setAlarm) yield* storage.setAlarm(Date.now() + 5_000)
    return pending
  }).pipe(lock.withPermits(1))
})

export interface SetupRequestsShape {
  readonly claim: (login: string, requestId: string, holder: string) => Effect.Effect<boolean, SetupStoreError>
  readonly release: (login: string, requestId: string, holder: string) => Effect.Effect<void, SetupStoreError>
  readonly discover: (login: string, repo: string, job: RepositoryJob, match?: z.infer<typeof RegistrationMatchSchema>) => Effect.Effect<Discovery, SetupStoreError>
  readonly create: (login: string, input: SetupHostInput) => Effect.Effect<SetupRecord, SetupStoreError>
  readonly read: (login: string, requestId: string) => Effect.Effect<SetupRecord | undefined, SetupStoreError>
  readonly update: (login: string, previous: SetupRecord, next: SetupRecord) => Effect.Effect<SetupRecord, SetupStoreError>
}
export class SetupRequests extends Context.Service<SetupRequests, SetupRequestsShape>()("smithers-server/SetupRequests") {}
export const setupRequestsLayer = (namespace: NativeNamespace): Layer.Layer<SetupRequests> => {
  const call = (login: string, command: Command) => Effect.gen(function* () {
    const response = yield* namespaceCall("repository-setup", namespace, login, new Request("https://gateway-sessions.internal/repository-setup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
    }))
    const body = yield* readBoundedJson(response, 128_000)
    if (!response.ok) {
      const code = workerFailureCode((body as { code?: unknown })?.code)
      return yield* Effect.fail(new SetupStoreError({ status: response.status, ...(code === null ? {} : { code }),
        message: typeof (body as { message?: unknown })?.message === "string" ? (body as { message: string }).message : "Setup storage is unavailable" }))
    }
    return body
  }).pipe(Effect.catch(error => Effect.fail(error instanceof SetupStoreError ? error : new SetupStoreError({ message: "Setup storage is unavailable", cause: error }))))
  const recordCall = (login: string, command: Command) => call(login, command).pipe(Effect.flatMap(body => Effect.gen(function* () {
    if ((body as { record?: unknown })?.record == null) return undefined
    const parsed = SetupRecordSchema.safeParse((body as { record: unknown }).record)
    if (!parsed.success) return yield* Effect.fail(new SetupStoreError({ message: "The persisted setup record is invalid" }))
    return parsed.data
  })))
  const required = (record: SetupRecord | undefined) => record === undefined
    ? Effect.fail(new SetupStoreError({ message: "The setup request was not persisted" })) : Effect.succeed(record)
  return Layer.succeed(SetupRequests, {
    claim: (login, requestId, holder) => call(login, { action: "claim", requestId, holder }).pipe(Effect.flatMap(body => {
      const result = z.object({ claimed: z.boolean() }).safeParse(body)
      return result.success ? Effect.succeed(result.data.claimed) : Effect.fail(new SetupStoreError({ message: "The setup lease is unavailable" }))
    })),
    release: (login, requestId, holder) => call(login, { action: "release", requestId, holder }).pipe(Effect.asVoid),
    discover: (login, repo, job, match) => call(login, { action: "discover", repo, job, ...(match ? { match } : {}) }).pipe(Effect.flatMap(body => {
      const result = DiscoverySchema.safeParse(body)
      return result.success ? Effect.succeed(result.data) : Effect.fail(new SetupStoreError({ message: "Setup recovery is invalid" }))
    })),
    create: (login, input) => recordCall(login, { action: "create", login, input }).pipe(Effect.flatMap(required)),
    read: (login, requestId) => recordCall(login, { action: "read", requestId }),
    update: (login, previous, record) => recordCall(login, { action: "update", requestId: previous.input.requestId, expectedVersion: previous.version, record }).pipe(Effect.flatMap(required))
  })
}
