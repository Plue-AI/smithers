import * as Redaction from "@smthrs/journal/Redaction"
import type { OperationalFailure } from "./OperationalFailures"
import type { Toast, ToolCallRecord, TransitionRecord } from "./AppState"
import type { NetEntry } from "./controller/context"

const SOURCES = ["toast", "network", "event", "tool", "operation"] as const
type Source = typeof SOURCES[number]

export interface DiagnosticQuery {
  readonly text: string
  readonly source?: Source
  readonly since?: number
  readonly limit: number
  readonly all: boolean
}

/** Filters are optional: a bare read always answers the recent failures. */
export const parseDiagnosticQuery = (query = ""): DiagnosticQuery | string => {
  let source: Source | undefined
  let since: number | undefined
  let limit = 20
  let all = false
  const text: string[] = []
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === "--all") { all = true; continue }
    if (token === "--source") {
      const value = tokens[++index]
      if (!SOURCES.includes(value as Source)) return "Source must be toast, network, event, tool or operation."
      source = value as Source
    } else if (token === "--since") {
      const value = tokens[++index] ?? ""
      since = Date.parse(value)
      if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(since)) {
        return "Since must be an ISO timestamp with a timezone, such as 2026-09-14T13:00:00-07:00."
      }
    } else if (token === "--limit") {
      const value = tokens[++index] ?? ""
      limit = Number(value)
      if (!/^\d+$/.test(value) || limit < 1 || limit > 100) return "Limit must be an integer from 1 to 100."
    } else if (token.startsWith("--")) return `Unknown diagnostic filter: ${token}`
    else text.push(token)
  }
  return { text: text.join(" ").toLowerCase(), source, since, limit, all }
}

export interface DiagnosticEntry {
  readonly id: string
  readonly source: Source
  readonly at: number
  readonly status: string
  readonly title: string
  readonly detail: string
  readonly error: boolean
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string => typeof value === "string" ? value : ""
const payloadOf = (record: TransitionRecord): Record<string, unknown> => {
  try { return object(JSON.parse(record.payload)) } catch { return {} }
}

/** Only public error fields enter the read; never copy arbitrary transition payloads or tool arguments. */
const errorDetail = (payload: Record<string, unknown>): string =>
  string(payload.message) || string(payload.error) || string(payload.detail)

/**
 * Strip URL credentials, query and fragment even when a URL occurs inside an error message,
 * then apply the shared diagnostic redactor to the whole text before any clip.
 */
const publicText = (value: string): string => String(Redaction.redactDiagnostic(value
  .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
    try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}` } catch { return "[URL]" }
  })))

const clipped = (value: string): string => {
  const safe = publicText(value)
  return safe.length <= 1500 ? safe : `${safe.slice(0, 1500)}… [truncated]`
}

/** Project existing retained evidence. Dismissal removes UI, never the journal's earlier toast result. */
export const readDiagnostics = (input: {
  readonly transitions: ReadonlyArray<TransitionRecord>
  readonly toasts: ReadonlyArray<Toast>
  readonly toolCalls: ReadonlyArray<ToolCallRecord>
  readonly network: ReadonlyArray<NetEntry>
  readonly operations?: ReadonlyArray<OperationalFailure>
}, query: DiagnosticQuery) => {
  const entries: DiagnosticEntry[] = []
  const toastTitles = new Map<string, string>()
  const lastToast = new Map<string, DiagnosticEntry>()
  const add = (entry: DiagnosticEntry): DiagnosticEntry => {
    const safe = { ...entry, title: clipped(entry.title), detail: clipped(entry.detail) }
    entries.push(safe)
    return safe
  }
  for (const record of [...input.transitions].sort((a, b) => a.revision - b.revision)) {
    const payload = payloadOf(record)
    if (record.type === "toast.shown" || record.type === "toast.progressed" || record.type === "toast.resolved") {
      const key = string(payload.key)
      if (typeof payload.title === "string") toastTitles.set(key, payload.title)
      const status = record.type !== "toast.resolved" ? "running" : string(payload.status)
      lastToast.set(key, add({
        id: record.id, source: "toast", at: record.createdAt, status,
        title: toastTitles.get(key) ?? key, detail: string(payload.detail), error: status === "failed"
      }))
    } else if (record.type.endsWith(".failed") ||
      (record.type === "flow.invoked" && (payload.outcome === "failed" || payload.outcome === "unknown-command"))) {
      add({ id: record.id, source: "event", at: record.createdAt, status: "failed",
        title: string(payload.name) || record.type, detail: errorDetail(payload), error: true })
    } else if (record.type === "card.upsert" || record.type === "card.updated") {
      const card = object(payload.card ?? payload.patch)
      if (card.status !== "error") continue
      add({ id: record.id, source: "event", at: record.createdAt, status: "failed",
        title: string(card.title) || string(card.id) || string(payload.id) || record.type,
        detail: errorDetail(object(card.payload)), error: true })
    }
  }
  // Still-visible toasts can outlive the bounded transition tail. Keep them readable without duplicating it.
  for (const toast of input.toasts) {
    const recorded = lastToast.get(toast.key)
    if (recorded?.at === toast.updatedAt && recorded.status === toast.status) continue
    add({ id: toast.id, source: "toast", at: toast.updatedAt, status: toast.status,
      title: toast.title, detail: toast.detail, error: toast.status === "failed" })
  }
  for (const call of input.toolCalls) {
    // Successful tools can contain arbitrary repository content (including the word "error").
    if (!/^(failed:|unknown-command:|unavailable:)/i.test(call.result)) continue
    add({ id: call.id, source: "tool", at: call.createdAt, status: "failed",
      title: call.name, detail: call.result, error: true })
  }
  input.network.forEach((entry, index) => add({
    id: `network-${entry.at}-${index}`, source: "network", at: entry.at, status: String(entry.status),
    title: `${entry.method} ${entry.url.split(/[?#]/, 1)[0]}`,
    detail: `${entry.status === "error" ? "Request failed" : `HTTP ${entry.status}`} · ${entry.ms}ms`,
    error: entry.status === "error" || entry.status >= 400
  }))
  input.operations?.forEach((entry, index) => add({
    id: `operation-${entry.at}-${index}`, source: "operation", at: entry.at, status: entry.lost,
    title: `${entry.seam}${entry.subject ? ` ${entry.subject}` : ""}`, detail: `${entry.message} ×${entry.count}`, error: true
  }))
  const matches = entries.filter(entry =>
    (query.all || entry.error) && (query.source === undefined || entry.source === query.source) &&
    (query.since === undefined || entry.at >= query.since) &&
    `${entry.title} ${entry.detail} ${entry.status}`.toLowerCase().includes(query.text)
  ).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id, undefined, { numeric: true }))
  const items: Array<Omit<DiagnosticEntry, "at" | "error"> & { readonly at: string }> = []
  let size = 0
  for (const entry of matches.slice(0, query.limit)) {
    const { error: _error, ...fields } = entry
    const item = { ...fields, at: new Date(entry.at).toISOString() }
    size += new TextEncoder().encode(JSON.stringify(item)).length
    if (size > 24_000) break
    items.push(item)
  }
  return {
    items, totalMatching: matches.length, hasMore: items.length < matches.length,
    coverage: {
      transitions: input.transitions.length, toolCalls: input.toolCalls.length, network: input.network.length,
      oldestTransitionAt: input.transitions.length === 0 ? null : new Date(Math.min(...input.transitions.map(row => row.createdAt))).toISOString(),
      note: "Retained app evidence only: newest 500 transitions and 250 tool calls, plus active toasts and this controller's last 100 requests and 100 operational failures. Dismissed toasts remain only while their transitions are retained. Console logs and server logs are not captured. Empty results do not prove no errors occurred."
    }
  }
}
