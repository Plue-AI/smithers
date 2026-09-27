/**
 * The text a maintainer approved for a run, kept as the task text.
 *
 * The backend admits an issue or pull request's text for credentialed work
 * and hands the run that exact snapshot (`Event.approvedText`). A run can
 * still read the subject live, after someone edited it, so every live read of
 * the subject is pinned back to the snapshot and a difference is recorded as
 * drift rather than followed.
 */
import { createHash } from "node:crypto"
import type { Event, Record, SourceStatus } from "./schema.ts"

type Approved = NonNullable<typeof Event.Type["approvedText"]>
const DRIFT = "Live text differs from the approved text; the approved text is used"

/** The event's snapshot, or nothing when its revision does not name its text. */
export const approvedText = (event: typeof Event.Type): Approved | undefined => {
  const approved = event.approvedText
  if (approved === undefined) return undefined
  const revision = `sha256:${createHash("sha256").update(`${approved.title}\u0000${approved.body}`).digest("hex")}`
  return approved.revision === revision ? approved : undefined
}

/** The subject with its title and body replaced by the snapshot. */
export const pinApprovedSubject = (
  approved: Approved | undefined,
  live: Readonly<globalThis.Record<string, unknown>>
): globalThis.Record<string, unknown> => {
  if (approved === undefined) return { ...live }
  const drift = live.title !== approved.title || (typeof live.body === "string" ? live.body : "") !== approved.body
  return { ...live, title: approved.title, body: approved.body, ...(drift ? { approvedTextDrift: true } : {}) }
}

/** History records with the subject's record pinned to the snapshot. */
export const pinApprovedRecords = (
  event: typeof Event.Type,
  records: ReadonlyArray<typeof Record.Type>
): {
  readonly records: ReadonlyArray<typeof Record.Type>
  readonly sources: ReadonlyArray<typeof SourceStatus.Type>
  readonly drift: boolean
} => {
  const approved = approvedText(event)
  if (approved === undefined || event.issueNumber === undefined) return { records, sources: [], drift: false }
  const title = approved.title.slice(0, 1000), body = approved.body.slice(0, 16000)
  const drifted = new Set<string>()
  const pinned = records.map((record) => {
    if (record.source !== event.source || record.number !== event.issueNumber) return record
    if (record.title !== title || record.body !== body) drifted.add(`${record.source}:${record.kind}#${record.number}`)
    return { ...record, title, body, revision: approved.revision }
  })
  const sources = [...drifted].map((path) => ({ path, status: "read" as const, summary: DRIFT }))
  return { records: pinned, sources, drift: sources.length > 0 }
}
