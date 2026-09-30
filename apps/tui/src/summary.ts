/** Evidence-first summary, projected onto exactly the same panel contract agents publish. */
import type * as Panels from "./panels.ts"
import * as Runtime from "./runtime.ts"
import * as Transcript from "./transcript.ts"
import * as Undo from "./undo.ts"

export const sentence = (value: string): string => {
  const line =
    value.replace(/```[\s\S]*?```/g, "").replace(/[*#`]/g, "").trim().split(/\n/).find((line) => line.trim() !== "")
      ?.trim() ?? ""
  const first = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line
  return first.length > 220 ? `${first.slice(0, 217).trimEnd()}…` : first
}
const verbs: Record<string, string> = {
  read: "Read",
  ls: "Listed",
  glob: "Found files matching",
  grep: "Searched for",
  edit: "Updated",
  write: "Wrote",
  apply_patch: "Patched files",
  "ui.publish": "Updated a view",
  "agent.delegate": "Requested background work",
  "tab.read": "Checked background work"
}
/** A request the user asked for that nobody took, in the ledger's words. */
const refusedRequest = (call: Transcript.Call): string | undefined => {
  const verdict = Runtime.requestFlows[call.flow]
  return verdict === undefined || call.status !== "failed"
    ? undefined
    : `${verdict}: ${sentence(call.subject)} (${Runtime.failureReason(call.message)})`
}
/**
 * The requests in these cells whose last attempt failed. A request retried
 * into success is taken; one that never succeeded is reported whatever any
 * answer says about it.
 */
const refusedRequests = (cells: ReadonlyArray<Transcript.Call>): ReadonlyArray<Transcript.Call> =>
  cells.filter((call, index) =>
    refusedRequest(call) !== undefined &&
    !cells.slice(index + 1).some((later) =>
      later.flow === call.flow && later.subject === call.subject && later.status === "ok"
    )
  )
const callLabel = (call: Transcript.Call): string => {
  const refused = refusedRequest(call)
  if (refused !== undefined) return refused
  if (call.status === "failed") {
    const failure = call.verb?.failure ?? `failed to call ${call.flow}`
    return `${failure.charAt(0).toUpperCase()}${failure.slice(1)}: ${sentence(call.subject)}`
  }
  if (call.status === "running" || call.status === "stopped") {
    return `${call.verb?.pending ?? `Running ${call.flow}`}: ${sentence(call.subject)}`
  }
  if (call.flow === "bash") {
    return `Ran ${sentence(call.subject)}${call.exit === undefined || call.exit === 0 ? "" : ` (exit ${call.exit})`}`
  }
  return `${verbs[call.flow] ?? call.verb?.success ?? `Called ${call.flow}`} ${sentence(call.subject)}`.trim()
}
const cellLabel = (cell: Extract<Transcript.Item, { kind: "cell" }>): string => {
  if (cell.status === "rejected") return `Rejected: ${cell.error ?? "cell"}`
  if (cell.status === "failed") return sentence(cell.error ?? "The cell failed.")
  if (cell.calls.length > 0) {
    const changed = cell.calls.filter((call) =>
      (call.patches?.length ?? 0) > 0 || (call.status === "ok" && call.change !== undefined)
    )
    const failed = cell.calls.filter((call) => call.status === "failed" || (call.exit ?? 0) !== 0)
    const important = [...new Set([...changed, ...failed])]
    const chosen = important.length > 0 ? important : cell.calls
    if (chosen.every((call) => call.flow === "read" && call.status === "ok") && chosen.length > 2) {
      return `Read ${chosen.length} files`
    }
    return chosen.slice(0, 2).map(callLabel).join("; ").slice(0, 220)
  }
  if (cell.prose.trim() !== "") return sentence(cell.prose)
  if (cell.status === "writing") return "Preparing the next step"
  if (cell.status === "running") return "Running the next step"
  if (cell.status === "stopped") return "Stopped"
  if (/ctx\.(done|resolve)\(/.test(cell.source)) return "Returned the answer"
  return cell.printed.trim() === "" ? "Finished the calculation" : "Collected the results"
}
export const panel = (transcript: Transcript.Transcript, id = "summary", title = "Summary"): Panels.Panel => {
  const rows: Array<Panels.Row> = []
  for (const item of transcript.items) {
    if (item.kind === "cell") {
      const diffs = item.calls.flatMap((call): Array<Panels.Block> =>
        call.patches !== undefined
          ? call.patches.map((patch) => ({ kind: "diff", ...patch }))
          : call.status !== "ok" || call.change === undefined
          ? []
          : [{ kind: "diff", path: call.change.path, patch: Transcript.unified(call.change) }]
      )
      const undone = Undo.undone([item])
      rows.push({
        id: item.id,
        label: undone ? `Undone: ${cellLabel(item)}`.slice(0, 240) : cellLabel(item),
        status: undone
          ? "cancelled"
          : item.status === "rejected" || refusedRequests(item.calls).length > 0
          ? "failed"
          : item.status === "writing"
          ? "running"
          : item.status === "stopped"
          ? "cancelled"
          : item.status,
        details: [
          ...(item.source === "" ? [] : [{ kind: "code" as const, code: item.source, language: "javascript" }]),
          ...item.calls.map((call): Panels.Block => ({
            kind: "text",
            text: `${callLabel(call)}${call.message === undefined ? "" : `\n${call.message}`}`
          })),
          ...(item.printed === "" ? [] : [{ kind: "text" as const, text: item.printed }]),
          ...(item.error === undefined ? [] : [{ kind: "text" as const, text: item.error }]),
          ...diffs
        ]
      })
    } else if (item.kind === "card") {
      rows.push({
        id: item.id,
        label: item.panel.title,
        details: [
          { kind: "text", text: item.panel.summary },
          ...item.panel.rows.flatMap((row) => row.details).slice(0, 8)
        ]
      })
    } else if (item.kind === "user") {
      rows.push({ id: item.id, label: `Asked: ${sentence(item.text)}`, details: [{ kind: "text", text: item.text }] })
    } else if (item.kind === "answer") {
      rows.push({
        id: item.id,
        label: sentence(item.text) || "Returned the answer",
        status: "done",
        details: [{ kind: "text", text: item.text }]
      })
    } else if (item.kind === "error") {
      rows.push({
        id: item.id,
        label: item.stopped === true ? "stopped" : sentence(item.text),
        status: item.stopped === true ? "cancelled" : "failed",
        details: [{ kind: "text", text: item.text }]
      })
    } else if (item.kind === "shell") {
      rows.push({
        id: item.id,
        label: `Ran ${sentence(item.command)}${item.result?.exitCode ? ` (exit ${item.result.exitCode})` : ""}`,
        status: item.result === undefined
          ? "running"
          : item.result.cancelled
          ? "cancelled"
          : item.result.exitCode === 0
          ? "done"
          : "failed",
        details: [{ kind: "code", code: item.command, language: "bash" }, { kind: "text", text: item.output }]
      })
    }
  }
  const background = new Set(
    transcript.items.flatMap((item) => item.kind === "error" && item.background === true ? [item.id] : [])
  )
  const last = rows.findLast((row) => !background.has(row.id))
  const answer = transcript.items.findLast((item) => item.kind === "answer")
  // The latest turn's requests nobody took lead the summary, whatever its
  // answer says: the answer can be a sentence written before the request failed.
  const turn = transcript.items.slice(transcript.items.findLastIndex((item) => item.kind === "user") + 1)
  const refused = refusedRequests(turn.flatMap((item) => item.kind === "cell" ? item.calls : []))
  const summary = transcript.items.at(-1)?.kind === "user"
    ? `Requested: ${sentence((transcript.items.at(-1) as Extract<Transcript.Item, { kind: "user" }>).text)}`
    : last?.status === "failed"
    ? `failed: ${last.label}`
    : last?.status === "cancelled"
    ? last.label
    : last?.status === "running"
    ? last.label
    : refused.length > 0
    ? refused.map((call) => refusedRequest(call)!).join("; ")
    : answer?.kind === "answer"
    ? sentence(answer.text)
    : last?.label ?? "No turns yet."
  return { id, title, summary, rows }
}
