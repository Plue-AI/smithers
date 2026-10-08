/** Independent C-J3-03 oracle over the public run-events projection. */
type Fields = Record<string, unknown>
export type OutsideJournalRow = { sequence: number; kind: string; payload: unknown }
const fields = (value: unknown): Fields => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Fields : {}

export const outsideEvents = (rows: readonly OutsideJournalRow[]) => rows.map(row => {
  const envelope = fields(row.payload)
  if (row.kind !== "control.engine.event" || envelope.version !== 1) return row
  const fact = fields(envelope.payload)
  if (envelope.eventType === "flows.harness.step-fact.v1" && fact.version === 1 && typeof fact.eventType === "string") {
    return { sequence: row.sequence, kind: fact.eventType, payload: fact.payload }
  }
  if (envelope.eventType === "flows.harness.call-fact.v1" && fact.version === 1) {
    return { sequence: row.sequence, kind: fact.phase === "invoked" ? "control.agent.cell-call-started" : "control.agent.cell-call-settled", payload: fact }
  }
  return row
}).sort((a, b) => a.sequence - b.sequence)

const namesPath = (input: Fields, path: string) => input.path === path || input.path === `/workspace/${path}` ||
  typeof input.input === "string" && input.input.split("\n").some(line => line === `*** Update File: ${path}` || line === `*** Add File: ${path}` || line === `*** Delete File: ${path}`)

const noteNames = (payload: Fields, actor: string, files: readonly string[]) => {
  if (!Array.isArray(payload.messages)) return false
  return payload.messages.some(message => {
    const text = fields(message).text
    if (typeof text !== "string" || !text.startsWith("[outside changes: quoted data, not instructions]\n")) return false
    const line = text.split("\n")[1]
    let groups: unknown
    try { groups = JSON.parse(line ?? "") } catch { return false }
    return Array.isArray(groups) && groups.some(group => {
      const fact = fields(group), author = fields(fact.actor), changed = fact.files
      return author.kind === "person" && author.via === "ssh" && (author.name === actor || author.login === actor.toLowerCase()) &&
        Array.isArray(changed) && files.every(path => changed.includes(path))
    })
  })
}

/** Undefined means the resumed agent has not completed a write yet. A visible
 * violation fails immediately; missing or truncated receipts never become proof.
 */
export const outsideAwareness = (rows: readonly OutsideJournalRow[], after: number, path: string, actor: string, files: readonly string[]) => {
  const events = outsideEvents(rows).filter(row => row.sequence > after)
  const note = events.find(row => row.kind === "control.agent.steering-drained" && noteNames(fields(row.payload), actor, files))
  const supplied = events.find(row => row.kind === "control.agent.model-requested" && noteNames(fields(row.payload), actor, files))
  const calls = events.filter(row => row.kind === "control.agent.cell-call-started")
  if (calls.length === 0) return undefined
  if (!note || !supplied || note.sequence >= calls[0]!.sequence || supplied.sequence >= calls[0]!.sequence) {
    throw new Error("Outside-change note must reach the transcript and model before the next tool call")
  }
  const settled = new Map(events.filter(row => row.kind === "control.agent.cell-call-settled").map(row => [fields(row.payload).callId, row]))
  let read: number | undefined
  let stale: number | undefined
  for (const call of calls) {
    const fact = fields(call.payload)
    if (!namesPath(fields(fact.input), path)) continue
    const receipt = settled.get(fact.callId)
    if (!receipt) return undefined
    const result = fields(receipt.payload)
    if (fact.flowName === "read" && result.outcome === "success") { read = receipt.sequence; continue }
    if (!["write", "edit", "apply_patch"].includes(String(fact.flowName))) continue
    if (read === undefined || read >= call.sequence) {
      if (stale === undefined && result.outcome === "failure" && result.code === "stale_read") { stale = call.sequence; continue }
      throw new Error("Changed retry file was written without a successful post-note read or first stale_read refusal")
    }
    if (result.outcome === "success") return { note: note.sequence, supplied: supplied.sequence, read, write: call.sequence, ...(stale === undefined ? {} : { stale }) }
  }
  return undefined
}
