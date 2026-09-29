/**
 * Calibration labels read from one run's journal.
 *
 * A `memory` call journals one `decision-settled` row per Jev reading
 * (`memory/needed`, `memory/descend`) and returns what it kept and omitted in
 * its `cell-call-settled` value. What the run did afterwards says which of
 * those answers were right:
 *
 * - withheld then read: a judged item the call did not keep that a later
 *   call names is a hard miss (`needed: true`);
 * - kept and used: a kept item a later call or the answer names is
 *   `needed: true`;
 * - never used: a kept item nothing later names is a weak extra
 *   (`needed: false`, weight 0.2, because unread is not unneeded);
 * - a `relevance-restored` row is a removal false positive, counted apart:
 *   the removal threshold is not refit here.
 *
 * A walked directory appears in neither list; it counts as kept when it is
 * not omitted (above the lowest omitted `p` when the omitted list is full).
 * A withheld item nothing names carries no label. Each label's `p` is Jev's
 * raw probability for the item from the reading.
 */
import * as Memory from "@smthrs/agent/Memory"
import type * as MemoryCalibration from "@smthrs/agent/MemoryCalibration"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"

/** The decisions a run's journal labels; `fact` is judged by `Relevance`. */
export const decisions = ["page", "skill", "dep", "file", "commit", "descend"] as const

/** One of {@link decisions}. */
export type Decision = (typeof decisions)[number]

/** Where a label came from. */
export const sources = ["withheld-then-read", "kept-and-used", "never-used", "landed"] as const

/** One of {@link sources}. */
export type Source = (typeof sources)[number]

/** One labelled Jev answer. */
export interface Labelled extends MemoryCalibration.Label {
  readonly decision: Decision
  readonly id: string
  readonly source: Source
}

/** A run's labels and the removal counts beside them. */
export interface RunLabels {
  readonly labels: ReadonlyArray<Labelled>
  /** `relevance-restored` rows: withheld flows a later call needed. */
  readonly restores: number
  /** Flows the run-start relevance reading withheld. */
  readonly withheldFlows: number
  /** Withheld instruction chunks whose file a later call names. */
  readonly instructionMisses: number
}

/** The weight of a never-used label. */
export const neverUsedWeight = 0.2

/** A Jev reading, as a `decision-settled` row or a `Judgement.Asked` carries it. */
export interface Reading {
  readonly classifier: string
  readonly state: unknown
  readonly answers: Readonly<Record<string, unknown>>
}

/** A judged item: its decision, id and raw probability. */
export interface Judged {
  readonly decision: Decision
  readonly id: string
  readonly p: number
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

const isDecision = (value: unknown): value is Decision =>
  typeof value === "string" && (decisions as ReadonlyArray<string>).includes(value)

const decisionOf = (kind: unknown): Decision | undefined =>
  kind === "dir" ? "descend" : isDecision(kind) ? kind : undefined

/** The item key both a reading and a `memory` result name. */
export const keyOf = (decision: Decision, id: string): string => `${decision}\u0000${id}`

/** The items a `memory/needed` or `memory/descend` reading judged, with `p`. */
export const judgedOf = (reading: Reading): ReadonlyArray<Judged> => {
  const descend = reading.classifier === "memory/descend"
  if (!descend && reading.classifier !== "memory/needed") return []
  const items = record(reading.state).items
  if (!Array.isArray(items)) return []
  return items.flatMap((raw, index) => {
    const item = record(raw)
    const p = record(reading.answers[`${descend ? "descend" : "needed"}_${index}`]).p
    const id = descend ? item.path : item.id
    const decision = descend ? "descend" : decisionOf(item.kind)
    return typeof p === "number" && typeof id === "string" && decision !== undefined ? [{ decision, id, p }] : []
  })
}

/**
 * The path-like tokens of `text`: runs of path characters, without a
 * leading `./` or trailing `.` and `/`, so "cat ./src/a.ts." yields
 * `cat` and `src/a.ts`.
 */
const tokens = (text: string): ReadonlyArray<string> =>
  text.split(/[^A-Za-z0-9_.@+/-]+/).map((token) => token.replace(/^(?:\.\/)+/, "").replace(/[./]+$/, ""))
    .filter((token) => token !== "")

/**
 * Whether `text` names the item `id` as a whole token: the token is `id`, a
 * path under it (`id/...`), or, given the run's `root`, the absolute path
 * `root/id` or one under it. A nested path with the same suffix
 * (`packages/x/README.md` for `README.md`) never matches.
 */
export const mentions = (text: string, id: string, root?: string): boolean =>
  tokens(text).some((token) => {
    const relative = root !== undefined && root !== "" && token.startsWith(`${root}/`)
      ? token.slice(root.length + 1)
      : token
    return relative === id || relative.startsWith(`${id}/`)
  })

/**
 * Whether one of `names` names the item: a path by {@link mentions}, a page,
 * skill or dep as a whole token, a commit by its id or a prefix of 8 or more.
 */
const named = (judged: Judged, names: ReadonlyArray<string>, root: string): boolean => {
  switch (judged.decision) {
    case "file":
    case "descend":
      return names.some((name) => mentions(name, judged.id, root))
    case "commit":
      return names.some((name) => name.includes(judged.id) || (name.length >= 8 && judged.id.startsWith(name)))
    default:
      return names.some((name) => tokens(name).includes(judged.id))
  }
}

/**
 * The strings a call names: its path, root, paths, globs, pattern and
 * command, and the files an `apply_patch` call's patch touches.
 */
const callNames = (call: Record<string, unknown>): ReadonlyArray<string> => {
  const input = record(call.input)
  const values = [input.path, input.root, input.pattern, input.command, input.file, input.name, input.page, input.rev]
  const lists = [input.paths, input.globs].flatMap((list) => Array.isArray(list) ? list : [])
  const patched = call.flowName === ApplyPatch.name && typeof input.input === "string"
    ? ApplyPatch.paths(input.input) ?? []
    : []
  return [...values, ...lists, ...patched].filter((value): value is string => typeof value === "string")
}

/** The text of a `resolved` answer. */
const answerText = (event: Record<string, unknown>): string => {
  const content = record(event.message).content
  return Array.isArray(content)
    ? content.map((part) => record(part).text).filter((text): text is string => typeof text === "string").join("\n")
    : ""
}

/**
 * The run's root when the journal records no working directory: the
 * deepest directory every repository instruction file sits under. A file
 * under a hidden directory, such as the global `~/.smithers/agent/AGENTS.md`
 * a host reads before the repository's own, is left out, so this inference
 * misses a repository under a hidden directory and a run started below the
 * repository root; a TUI session header's `cwd` is exact.
 */
const inferredRoot = (files: ReadonlyArray<string>): string => {
  const dirs = files.map((file) => file.split("/").slice(0, -1))
    .filter((dir) => !dir.some((segment) => segment.startsWith(".")))
  const first = dirs[0] ?? []
  let length = 0
  while (length < first.length && dirs.every((dir) => dir[length] === first[length])) length++
  return first.slice(0, length).join("/")
}

interface MemoryCall {
  readonly at: number
  readonly judged: ReadonlyArray<Judged>
  readonly kept: ReadonlySet<string>
  readonly omitted: ReadonlySet<string>
  /** The lowest `p` in a full (truncated) omitted list; kept dirs sit above it. */
  readonly floor: number
}

/**
 * The labels one run's journal yields, in event order.
 *
 * Readings are attributed to the next `memory` call that settles after
 * them; readings of a failed call, or that no call claims (a frame-0
 * opening), carry no kept set and yield no label.
 */
export const fromEvents = (events: ReadonlyArray<unknown>, cwd?: string): RunLabels => {
  const calls: Array<MemoryCall> = []
  const names: Array<{ readonly at: number; readonly names: ReadonlyArray<string> }> = []
  const withheldInstructions: Array<{ readonly at: number; readonly file: string }> = []
  const instructionFiles: Array<string> = []
  let pending: Array<Judged> = []
  let restores = 0
  let withheldFlows = 0
  events.forEach((raw, at) => {
    const event = record(raw)
    switch (event._tag) {
      case "decision-settled":
        pending.push(...judgedOf(event as unknown as Reading))
        return
      case "cell-call-started": {
        const call = record(event.call)
        if (call.flowName !== "memory") names.push({ at, names: callNames(call) })
        return
      }
      case "cell-call-settled": {
        if (event.flowName !== "memory") return
        const result = record(event.result)
        // Readings belong to the call that settles next; a failed call's
        // readings are dropped with it.
        const judged = pending
        pending = []
        if (result.outcome !== "success") return
        const value = record(result.value)
        const keys = (items: unknown) =>
          new Set(
            (Array.isArray(items) ? items : []).flatMap((item) => {
              const { id, kind } = record(item)
              const decision = decisionOf(kind)
              return decision === undefined || typeof id !== "string" ? [] : [keyOf(decision, id)]
            })
          )
        const omitted = Array.isArray(value.omitted) ? value.omitted : []
        const floor = omitted.length < Memory.maxOmitted
          ? -1
          : Math.min(...omitted.map((item) => record(item).p).filter((p): p is number => typeof p === "number"))
        calls.push({ at, judged, kept: keys(value.kept), omitted: keys(omitted), floor })
        return
      }
      case "resolved":
        names.push({ at, names: [answerText(event)] })
        return
      case "relevance-restored":
        restores++
        return
      case "relevance-settled":
        for (const item of Array.isArray(event.kept) ? event.kept : []) {
          const { id, kind } = record(item)
          if (kind === "instruction" && typeof id === "string") instructionFiles.push(id.replace(/#[^#]*$/, ""))
        }
        for (const item of Array.isArray(event.withheld) ? event.withheld : []) {
          const { id, kind } = record(item)
          if (kind === "flow") withheldFlows++
          if (kind === "instruction" && typeof id === "string") {
            withheldInstructions.push({ at, file: id.replace(/#[^#]*$/, "") })
            instructionFiles.push(id.replace(/#[^#]*$/, ""))
          }
        }
        return
    }
  })
  const later = (at: number): ReadonlyArray<string> =>
    names.filter((entry) => entry.at > at).flatMap((entry) => entry.names)
  // Instruction ids are absolute; a call names a path relative to the run's
  // root: the recorded working directory, else the inferred one.
  const root = cwd !== undefined && cwd !== "" ? cwd.replace(/\/+$/, "") : inferredRoot(instructionFiles)
  const labels = calls.flatMap((call) => {
    const after = later(call.at)
    const seen = new Set<string>()
    return call.judged.flatMap((judged): ReadonlyArray<Labelled> => {
      const key = keyOf(judged.decision, judged.id)
      if (seen.has(key)) return []
      seen.add(key)
      const used = named(judged, after, root)
      const base = { decision: judged.decision, id: judged.id, p: judged.p }
      // A kept directory is in neither list: the walk descended into it.
      const kept = judged.decision === "descend"
        ? !call.omitted.has(key) && judged.p > call.floor
        : call.kept.has(key)
      if (kept) {
        return [
          used
            ? { ...base, needed: true, source: "kept-and-used" }
            : { ...base, needed: false, weight: neverUsedWeight, source: "never-used" }
        ]
      }
      return used ? [{ ...base, needed: true, source: "withheld-then-read" }] : []
    })
  })
  const instructionMisses = withheldInstructions.filter(({ at, file }) => {
    const id = root !== "" && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
    return later(at).some((name) => mentions(name, id, root))
  }).length
  return { labels, restores, withheldFlows, instructionMisses }
}

/** A journal's harness events and the working directory it records, if any. */
export interface Journal {
  readonly events: ReadonlyArray<unknown>
  readonly cwd?: string
}

/**
 * The events of a journal's rows in either form: flat harness events (a
 * `_tag` per row, as `SMITHERS_TUI_RECORD` and the e2e driver write), or a
 * TUI session file (`~/.smithers/tui/sessions/`), whose `session` header
 * records the `cwd` and whose `{ type: "event", at, event }` records wrap
 * the events. Other session records (prompts, captions, outcomes) are
 * skipped.
 */
export const journalOf = (rows: ReadonlyArray<unknown>): Journal => {
  let cwd: string | undefined
  const events = rows.flatMap((raw) => {
    const row = record(raw)
    if (row.type === "session") {
      if (cwd === undefined && typeof row.cwd === "string") cwd = row.cwd
      return []
    }
    if (row.type === "event") return typeof record(row.event)._tag === "string" ? [row.event] : []
    return typeof row._tag === "string" ? [raw] : []
  })
  return cwd === undefined ? { events } : { events, cwd }
}

/** Parses one JSONL journal; blank lines are skipped, a malformed line throws. */
export const parseJsonl = (text: string): ReadonlyArray<unknown> =>
  text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown)

/** Labels grouped by decision. */
export const byDecision = (
  labels: ReadonlyArray<Labelled>
): Readonly<Record<Decision, ReadonlyArray<MemoryCalibration.Label>>> => {
  const grouped: Record<Decision, Array<MemoryCalibration.Label>> = {
    page: [],
    skill: [],
    dep: [],
    file: [],
    commit: [],
    descend: []
  }
  for (const label of labels) {
    grouped[label.decision].push({
      p: label.p,
      needed: label.needed,
      ...(label.weight === undefined ? {} : { weight: label.weight })
    })
  }
  return grouped
}
