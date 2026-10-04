import type { StorageApi } from "@tanstack/db"
import { PERSISTED_KEY_PREFIX } from "../chain/SchemaVersion"
import { CardHistorySchema,CardSchema,StarredTargetSchema,type Card,type CardHistory,type StarredTarget } from "./AppState"
import { canonicalStoredJsonValue } from "./EventValue"
import { PendingRecoveryAuthoritySchema,type PendingRecoveryAuthority } from "./PendingRecovery"
import { SignupSchema,type Signup } from "./LegacySignup"

export const ENTITY_RECOVERY_STORAGE_KEY = `${PERSISTED_KEY_PREFIX}entity-recovery`

export type EntityRecoveryValue =
  | { readonly kind: "approval-answer"; readonly id: string; readonly question: string; readonly text: string }
  | { readonly kind: "card"; readonly workspaceId: string; readonly branchId: string; readonly id: string; readonly card: Card | null; readonly history?: CardHistory }
  | { readonly kind: "target-star"; readonly id: string; readonly repoId: string; readonly star: StarredTarget | null }
  | { readonly kind: "signup"; readonly signup: Signup }
  | { readonly kind: "first-run-dismissed" }
  | { readonly kind: "hint-dismissed"; readonly id: string }

export interface EntityRecoveryRecord {
  readonly key: string
  readonly revision: number
  readonly value: EntityRecoveryValue
  readonly authority?: PendingRecoveryAuthority
  readonly preparedCommandId?: string
}

interface RecoveryEnvelope {
  readonly version: 1
  readonly records: Record<string, unknown>
}

const envelope = (raw: string | null | undefined): RecoveryEnvelope | undefined => {
  if (raw === null || raw === undefined) return { version: 1, records: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const candidate = parsed as { readonly version?: unknown; readonly records?: unknown }
    if (candidate.version !== 1 || typeof candidate.records !== "object" || candidate.records === null || Array.isArray(candidate.records)) return undefined
    return { version: 1, records: candidate.records as Record<string, unknown> }
  } catch {
    return undefined
  }
}

const record = (key: string, input: unknown): EntityRecoveryRecord | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const candidate = input as { readonly revision?: unknown; readonly value?: unknown; readonly authority?: unknown; readonly preparedCommandId?: unknown }
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1 ||
    typeof candidate.value !== "object" || candidate.value === null || Array.isArray(candidate.value)) return undefined
  const authority = candidate.authority === undefined ? undefined : PendingRecoveryAuthoritySchema.safeParse(candidate.authority)
  if (authority && !authority.success) return undefined
  if (candidate.preparedCommandId !== undefined && (typeof candidate.preparedCommandId !== "string" ||
    !authority?.success || authority.data.actor !== "user" || authority.data.intentId !== candidate.preparedCommandId)) return undefined
  const binding = { ...(authority?.success ? { authority: authority.data } : {}),
    ...(typeof candidate.preparedCommandId === "string" ? { preparedCommandId: candidate.preparedCommandId } : {}) }
  const value = candidate.value as { readonly kind?: unknown; readonly workspaceId?: unknown; readonly branchId?: unknown; readonly card?: unknown; readonly history?: unknown; readonly star?: unknown; readonly id?: unknown; readonly repoId?: unknown; readonly question?: unknown; readonly text?: unknown; readonly signup?: unknown }
  if (value.kind === "card" && typeof value.workspaceId === "string" && typeof value.branchId === "string" && typeof value.id === "string" &&
    key === `card:${value.workspaceId}:${value.branchId}:${value.id}`) {
    const location = { workspaceId: value.workspaceId, branchId: value.branchId }
    if (candidate.preparedCommandId !== undefined && (typeof value.card !== "object" || value.card === null || !("kind" in value.card) || value.card.kind !== "flow-form")) return undefined
    if (value.card === null) return { key, revision: candidate.revision as number, ...binding, value: { kind: "card", ...location, id: value.id, card: null } }
    const card = CardSchema.safeParse(value.card)
    if (!card.success || card.data.id !== value.id || card.data.kind === "env" || card.data.kind === "approval" ||
      card.data.kind === "approvals-inbox" || (card.data.kind === "flow-form" && card.data.payload.flow === "env.set")) return undefined
    const history = value.history === undefined ? undefined : CardHistorySchema.safeParse(value.history)
    if (history !== undefined && (!history.success || history.data.id !== value.id || history.data.index >= history.data.entries.length || history.data.entries.some(entry =>
      entry.id !== value.id || entry.kind === "env" || entry.kind === "approval" || entry.kind === "approvals-inbox" ||
      (entry.kind === "flow-form" && entry.payload.flow === "env.set")))) return undefined
    return { key, revision: candidate.revision as number, ...binding, value: {
      kind: "card", ...location, id: value.id, card: card.data,
      ...(history?.success ? { history: history.data } : {}),
    } }
  }
  if (value.kind === "approval-answer") {
    if (!authority?.success || authority.data.actor !== "user" || typeof value.id !== "string" || !value.id ||
      typeof value.question !== "string" || !/^[0-9a-f]{64}$/.test(value.question) || typeof value.text !== "string" ||
      key !== `approval-answer:${value.id}:${value.question}` ||
      Object.keys(value).some(key => !["kind", "id", "question", "text"].includes(key))) return undefined
    return { key, revision: candidate.revision as number, ...binding,
      value: { kind: "approval-answer", id: value.id, question: value.question, text: value.text } }
  }
  if (value.kind === "signup" && key === "signup") {
    const signup = SignupSchema.safeParse(value.signup)
    return signup.success ? { key, revision: candidate.revision as number, ...binding, value: { kind: "signup", signup: signup.data } } : undefined
  }
  if (candidate.preparedCommandId !== undefined) return undefined
  if (value.kind === "target-star" && typeof value.id === "string" && key === `target-star:${value.id}` && typeof value.repoId === "string") {
    if (value.star === null) return { key, revision: candidate.revision as number, ...binding, value: { kind: "target-star", id: value.id, repoId: value.repoId, star: null } }
    const star = StarredTargetSchema.safeParse(value.star)
    return star.success && star.data.id === value.id
      ? { key, revision: candidate.revision as number, ...binding, value: { kind: "target-star", id: value.id, repoId: value.repoId, star: star.data } }
      : undefined
  }
  if (value.kind === "first-run-dismissed" && key === "first-run-dismissed" && Object.keys(value).length === 1) {
    return { key, revision: candidate.revision as number, ...binding, value: { kind: "first-run-dismissed" } }
  }
  if (value.kind === "hint-dismissed" && authority?.success && authority.data.actor === "user" &&
    typeof value.id === "string" && value.id.length > 0 && key === `hint-dismissed:${value.id}` && Object.keys(value).length === 2) {
    return { key, revision: candidate.revision as number, ...binding, value: { kind: "hint-dismissed", id: value.id } }
  }
  return undefined
}

/** Every valid pending entity, ordered exactly as the serialized SQLite writer accepted it. */
export const readEntityRecoveries = (storage: StorageApi | undefined): ReadonlyArray<EntityRecoveryRecord> => {
  try {
    const parsed = envelope(storage?.getItem(ENTITY_RECOVERY_STORAGE_KEY))
    if (parsed === undefined) return []
    return Object.entries(parsed.records)
      .map(([key, value]) => record(key, value))
      .filter((value): value is EntityRecoveryRecord => value !== undefined)
      .sort((left, right) => left.revision - right.revision)
  } catch {
    return []
  }
}

/** Replace only this entity's pending projection; unrelated pending entities remain recoverable. */
export const writeEntityRecovery = (
  storage: StorageApi | undefined,
  record: EntityRecoveryRecord
): EntityRecoveryRecord | undefined => {
  try {
    if (storage === undefined) return undefined
    const current = envelope(storage.getItem(ENTITY_RECOVERY_STORAGE_KEY))
    // Preserve malformed evidence rather than overwriting the only copy.
    if (current === undefined) return undefined
    storage.setItem(ENTITY_RECOVERY_STORAGE_KEY, JSON.stringify({
      version: 1,
      records: { ...current.records, [record.key]: { revision: record.revision, value: record.value, ...(record.authority === undefined ? {} : { authority: record.authority }), ...(record.preparedCommandId === undefined ? {} : { preparedCommandId: record.preparedCommandId }) } }
    }))
    return record
  } catch {
    return undefined
  }
}

/** An older acknowledgement may clear its record, but never a newer edit of the same entity. */
export const clearEntityRecovery = (storage: StorageApi | undefined, expected: EntityRecoveryRecord): void => {
  try {
    if (storage === undefined) return
    const current = envelope(storage.getItem(ENTITY_RECOVERY_STORAGE_KEY))
    if (current === undefined) return
    const saved = record(expected.key, current.records[expected.key])
    if (saved?.revision !== expected.revision || saved.preparedCommandId !== expected.preparedCommandId || canonicalStoredJsonValue(saved.authority ?? null) !== canonicalStoredJsonValue(expected.authority ?? null) ||
      canonicalStoredJsonValue(saved.value) !== canonicalStoredJsonValue(expected.value)) return
    const { [expected.key]: _cleared, ...records } = current.records
    if (Object.keys(records).length === 0) storage.removeItem(ENTITY_RECOVERY_STORAGE_KEY)
    else storage.setItem(ENTITY_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, records }))
  } catch {
    // A later boot can compare the retained record with the durable revision.
  }
}
