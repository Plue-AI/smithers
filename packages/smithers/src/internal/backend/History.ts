/**
 * The repository history from the terminal: the coding factory's stack as the
 * app's History card reads it (`GET …/mythical`, D-20), its writes, and a
 * watch that follows one issue through the lanes. The server sends hints on
 * `…/mythical/events`; every hint (or, without one, every poll) re-reads the
 * snapshot, which is authoritative. Writes are acknowledged at once; the
 * stack does the work.
 *
 * The words and groups mirror `@smthrs/rpc/StackView` and
 * `@smthrs/rpc/StackIssues`, which this published package cannot depend on;
 * `test/BackendHistory.test.ts` keeps them equal.
 * @since 1.0.0
 */

import { clean } from "../../cli/Presentation.ts"
import { Refused, UsageError } from "../../CliError.ts"
import { chunksOf, type Client, esc, list, object, str, type Values } from "./Client.ts"
import type { Handler } from "./Resources.ts"

/** Nothing more happens without a person or a new issue event (`isSettledItemState`). */
const SETTLED = new Set(["skipped", "declined", "cancelled", "landed", "rejected", "blocked"])
const NEEDS_YOU = new Set(["blocked", "rejected", "proposed"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000
/**
 * How long a watch waits for a hint before it reads the snapshot anyway.
 * @private
 * @since 1.0.0
 */
export const POLL_MS = 10_000

/**
 * The owner's word for where an item is (`itemStateLabel`).
 * @private
 * @since 1.0.0
 */
export const stateLabel = (item: Values): string => {
  switch (str(item.state)) {
    case "running":
      return "implementing"
    case "delivering":
    case "verifying":
      return "checking"
    case "integrating":
      return "rebasing"
    case "waiting":
      return "ready"
    case "retrying":
      return object(item.integration).conflict === undefined ? "retrying" : "conflict"
    case "proposed":
      return "PR open"
    default:
      return str(item.state)
  }
}

/**
 * The group an item is listed under (`issueGroupOf`).
 * @private
 * @since 1.0.0
 */
export const groupOf = (item: Values): "needs-you" | "working" | "done" => {
  const state = str(item.state)
  return NEEDS_YOU.has(state) ? "needs-you" : SETTLED.has(state) ? "done" : "working"
}

/**
 * Whether the item is out of the lanes: settled, or its pull request is open (`settled`).
 * @private
 * @since 1.0.0
 */
export const outOfLanes = (item: Values): boolean => SETTLED.has(str(item.state)) || str(item.state) === "proposed"

/**
 * One item: `#12 Title · PR open · checks failed: ci · reason · pull request`.
 * @private
 * @since 1.0.0
 */
export const itemLine = (item: Values, changes: ReadonlyArray<unknown> = []): string => {
  const issue = object(item.issue), checks = object(item.checks), pull = object(item.pullRequest)
  const title = issue.number !== undefined
    ? `#${str(issue.number)} ${str(issue.title)}`
    : str(changes.map(object).find((change) => change.itemId === item.id)?.title) || str(item.id).slice(0, 8)
  const paths = list(object(object(item.integration).conflict).paths).map(str)
  const reason = str(item.state) === "retrying" && paths.length > 0 ? paths.join(", ") : str(item.reason)
  const failed = list(checks.failed).map(str)
  return [
    title,
    stateLabel(item),
    checks.state === undefined ? "" : `checks ${str(checks.state)}${failed.length > 0 ? `: ${failed.join(", ")}` : ""}`,
    reason,
    str(pull.url)
  ].filter(Boolean).map(clean).join(" · ")
}

/**
 * The History as lines: the stack's state and lanes, then Needs you, Working
 * and Done (the last 24 hours), ordered as the app lists them.
 * @private
 * @since 1.0.0
 */
export const render = (value: unknown, now = Date.now()): string => {
  const stack = object(value), changes = list(stack.changes), lanes = list(stack.lanes).map(object)
  const at = (item: Values) => {
    const parsed = Date.parse(str(item.updatedAt))
    return Number.isNaN(parsed) ? 0 : parsed
  }
  const head = [
    str(stack.state),
    str(stack.reason),
    `${lanes.filter((lane) => lane.state === "busy").length}/${str(object(stack.limits).maxParallel)} lanes`,
    stack.mainBehind === true ? "main behind" : "",
    str(stack.lastError)
  ].filter(Boolean).map(clean).join(" · ")
  const listed = list(stack.items).map(object).map((item, index) => ({ item, index })).filter(({ item }) =>
    item.state !== "skipped"
  )
  const of = (id: ReturnType<typeof groupOf>) => listed.filter(({ item }) => groupOf(item) === id)
  const groups = [
    ["◆ Needs you", of("needs-you").sort((a, b) => at(a.item) - at(b.item) || a.index - b.index)],
    [
      "◐ Working",
      of("working").sort((a, b) =>
        Number(a.item.state === "queued") - Number(b.item.state === "queued") ||
        Number(a.item.lane ?? 99) - Number(b.item.lane ?? 99) || a.index - b.index
      )
    ],
    [
      "● Done",
      of("done").filter(({ item }) => at(item) === 0 || now - at(item) <= DAY_MS).sort((a, b) =>
        at(b.item) - at(a.item) || a.index - b.index
      )
    ]
  ] as const
  return [
    head,
    ...groups.filter(([, rows]) => rows.length > 0).flatMap(([label, rows]) => [
      `${label} ${rows.length}`,
      ...rows.map(({ item }) => `  ${itemLine(item, changes)}`)
    ])
  ].join("\n")
}

const stackPath = (c: Client, o: Values, suffix = "") => `${c.repoPath(o.repo)}/mythical${suffix}`
const read = async (c: Client, o: Values): Promise<Values> => object(await c.request("GET", stackPath(c, o)))

type Target = { readonly id: string } | { readonly issue: number }
/** `12`, `#12`, or an item id. */
const target = (value: unknown): Target => {
  const raw = str(value).trim()
  if (UUID.test(raw)) return { id: raw.toLowerCase() }
  if (!/^#?\d{1,15}$/.test(raw) || Number(raw.replace("#", "")) <= 0) {
    throw new UsageError({ message: "Expected an issue number (12 or #12) or an item id" })
  }
  return { issue: Number(raw.replace("#", "")) }
}
const named = (wanted: Target): string => "id" in wanted ? wanted.id : `#${wanted.issue}`
const find = (stack: Values, wanted: Target): Values | undefined =>
  list(stack.items).map(object).find((item) =>
    "id" in wanted ? str(item.id).toLowerCase() === wanted.id : Number(object(item.issue).number) === wanted.issue
  )

/**
 * Hints from `…/mythical/events`: `next` resolves on the next event, or after
 * `ms` when none arrives. A lost stream is reopened at the next wait.
 */
const hints = (c: Client, path: string) => {
  const stop = new AbortController()
  const signal = c.runtime.signal ? AbortSignal.any([stop.signal, c.runtime.signal]) : stop.signal
  let pending = false, open = false, wake: (() => void) | undefined
  const listen = async () => {
    open = true
    try {
      const response = await c.response("GET", path, undefined, { stream: true, signal })
      let buffer = ""
      for await (const chunk of chunksOf(response.body!)) {
        buffer = (buffer + Buffer.from(chunk).toString("utf8")).replaceAll("\r\n", "\n")
        let end: number
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (frame.split("\n").some((line) => line.startsWith("data:"))) {
            pending = true
            wake?.()
          }
        }
        if (buffer.length > 64 * 1024) buffer = ""
      }
    } catch {
      /* the next wait polls the snapshot and reopens the stream */
    } finally {
      open = false
    }
  }
  return {
    next: (ms: number) => {
      if (!open && !signal.aborted) void listen()
      if (pending) {
        pending = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", done)
          wake = undefined
          pending = false
          resolve()
        }
        const timer = setTimeout(done, ms)
        signal.addEventListener("abort", done, { once: true })
        wake = done
      })
    },
    close: () => stop.abort()
  }
}

/**
 * @private
 * @since 1.0.0
 */
export const history: Record<string, Handler> = {
  "history show": (c, _a, o) => read(c, o),
  "history watch": async (c, a, o) => {
    const wanted = target(a.issue)
    const stream = hints(c, stackPath(c, o, "/events"))
    let last = ""
    try {
      for (;;) {
        const stack = await read(c, o)
        const item = find(stack, wanted)
        const line = item === undefined
          ? `${named(wanted)} · not in the history yet`
          : itemLine(item, list(stack.changes))
        if (line !== last) c.write(`${line}\n`)
        last = line
        if (item !== undefined && outOfLanes(item)) {
          if (!["landed", "proposed"].includes(str(item.state))) c.runtime.exit?.(1)
          return item
        }
        if (c.runtime.signal?.aborted) {
          throw new Refused({ fault: "user", code: "cancelled", message: "Watch cancelled" })
        }
        await stream.next(POLL_MS)
      }
    } finally {
      stream.close()
    }
  },
  "history retry": async (c, a, o) => {
    const wanted = target(a.issue)
    let id = "id" in wanted ? wanted.id : undefined
    if (id === undefined) {
      const item = find(await read(c, o), wanted)
      if (item === undefined) {
        throw new Refused({ fault: "user", code: "not_found", message: `${named(wanted)} is not in the history` })
      }
      id = str(item.id)
    }
    return c.request("POST", stackPath(c, o, `/items/${esc(id)}/retry`), {})
  },
  "history backfill": (c, _a, o) => c.request("POST", stackPath(c, o, "/backfill"), {}),
  "history bootstrap": (c, _a, o) => c.request("POST", stackPath(c, o, "/bootstrap"), {}),
  "history parallel": (c, a, o) => {
    const lanes = Number(a.lanes)
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 8) throw new UsageError({ message: "Lanes must be 1 to 8" })
    return c.request("PUT", stackPath(c, o, "/config"), { maxParallel: lanes })
  }
}

/**
 * Each history command's human body.
 * @private
 * @since 1.0.0
 */
export const humans: Record<string, (value: unknown) => string> = {
  "history show": (value) => render(value),
  "history watch": (value) => itemLine(object(value)),
  "history retry": (value) => itemLine(object(value)),
  "history backfill": (value) => render(value),
  "history bootstrap": (value) => render(value),
  "history parallel": (value) => render(value)
}
