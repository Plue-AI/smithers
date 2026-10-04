/** Failed checks and review findings become pending repository notes. Only
 * notes a person accepts (`memory notes status <id> accepted`) reach planning.
 */
import * as Digest from "@smthrs/core/Digest"
import * as MemoryMine from "@smthrs/agent/MemoryMine"
import { Effect, Schema } from "effect"
import * as MemoryStore from "../../packages/smithers/agent/memory/src/MemoryStore.ts"
import type { Plan, Result } from "./schema.ts"

/** The control database is per repository, so one fixed namespace is the repository's. */
export const namespace = { kind: "flow", id: "coding" } as const
export const maxLearnings = 20
const maxFindings = 20, maxMessage = 1_000

export const Learning = Schema.Struct({ id: Schema.NonEmptyString, text: Schema.NonEmptyString })
export type Learning = typeof Learning.Type

const clip = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

/** Failure identities exclude run, round and commit; those remain provenance. */
export const failureSignatures = (result: Result): ReadonlyArray<string> => [...new Set([
  ...result.changes.flatMap(change => change.receipts
    .filter(receipt => receipt.status === "failed" && receipt.fault !== "infra")
    .map(receipt => `check:${MemoryMine.normalize(receipt.checkId)}@${receipt.tier === "slow" ? "review" : "check"}`)),
  ...result.findings.map(finding => `review:${Digest.digest(MemoryMine.normalize(finding.message))}`)
])].sort()

/** One pending note for a failure pattern; replay and later runs reuse its identity. */
export const learningNotes = (plan: Plan, executionId: string, round: number, result: Result) => {
  if (result.status !== "changes-requested") return []
  const signatures = failureSignatures(result)
  if (signatures.length === 0) return []
  const findings = result.findings.slice(0, maxFindings).map((finding) => {
    const change = plan.changes.find((change) => change.id === finding.owner)
    return `- ${change?.title ?? finding.owner}: ${clip(finding.message, maxMessage)}`
  })
  const checks = result.changes.flatMap(change => change.receipts)
    .filter(receipt => receipt.status === "failed" && receipt.fault !== "infra")
    .slice(0, maxFindings)
    .map(receipt => `- ${receipt.checkId}@${receipt.tier === "slow" ? "review" : "check"}: ${clip(MemoryMine.sentences(receipt.evidence).join(" "), maxMessage)}`)
  return signatures.slice(0, maxFindings).map(id => ({
    namespace,
    id,
    text: [`Request: ${clip(plan.prompt, 500)}`, ...[...checks, ...findings].slice(0, maxFindings)].join("\n"),
    tags: [],
    provenance: { runId: executionId, iteration: round },
    status: "pending" as const
  }))
}

/** Retained single-note reader; recording writes every distinct failure pattern. */
export const learningNote = (plan: Plan, executionId: string, round: number, result: Result) =>
  learningNotes(plan, executionId, round, result)[0]

/** Writes the round's pending note. A store failure is logged; it never blocks the correction. */
export const recordLearning = (plan: Plan, executionId: string, round: number, result: Result | null) =>
  Effect.gen(function*() {
    const notes = result === null ? [] : learningNotes(plan, executionId, round, result)
    if (notes.length === 0) return
    const store = yield* MemoryStore.MemoryStore
    // Notes are append-only: do not overwrite provenance or resurrect a rejected note.
    for (const note of notes) yield* Effect.gen(function*() {
      if (yield* store.getNote({ id: note.id })) return
      yield* store.putNote(note)
    }).pipe(
      Effect.catch((error) => Effect.logWarning("Coding learning note was not recorded", { id: note.id, error }))
    )
  })

/** The bank label the notes carry in a run's opening memory: the CLI's `--namespace` spelling. */
export const bank = `${namespace.kind}:${namespace.id}`

/**
 * Accepted notes as opening memory rows, keyed by note id. They reach a
 * planning step only as its opening memory, so a judged step's relevance
 * reading withholds the ones Jev is confident the request does not need and
 * journals which it kept (`memory notes get <id>` shows one).
 */
export const learningRows = (learnings: ReadonlyArray<Learning>) =>
  learnings.map((learning) => ({ origin: "recall" as const, bank, key: learning.id, text: learning.text }))

/** The newest accepted, unsuperseded notes, oldest first. */
export const acceptedLearnings = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  const notes = yield* store.listNotes({ namespace, status: "accepted" })
  return notes.slice(-maxLearnings).map((note): Learning => ({ id: note.id, text: note.text }))
})
