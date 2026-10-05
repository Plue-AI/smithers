import { MODEL_STREAM_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { decodeAgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"
import { randomUuid } from "../../runtime/RandomUuid"

/**
 * The fast model's titles for the timeline's folded lines (#3732; mvp.md Timeline, spec §14.5.3). The rail asks for
 * the runs it folds; once the set has held still for `debounceMs` (and at most `maxWaitMs` after the first change),
 * each key with no answer yet is sent once, at most `concurrency` at a time, to the host's model: POST
 * /api/model/stream, which on an install runs on the fast role. An answer is cached by its key. A refusal, failure or
 * timeout settles the key with no title, so the deterministic title stands, with no error state and no retry; an
 * answer that arrives after its key timed out, or after dispose, is dropped. Without a writer (a host that does not
 * advertise `model.turn`) nothing is ever asked.
 */

/** One folded line: its key (TimelineZoom `foldKey`) and the lines it stands for. */
export interface FoldRun {
  readonly key: string
  readonly lines: ReadonlyArray<Pick<TimelineLine, "kind" | "title">>
}
/** One model answer to `prompt`; aborting `signal` cancels the request. */
export type TitleWriter = (prompt: string, signal: AbortSignal) => Promise<string>
/** What the rail reads: every title written so far, by key; subscribing asks for this handle's runs. */
export interface FoldTitles {
  readonly get: () => ReadonlyMap<string, string>
  readonly subscribe: (listener: () => void) => () => void
}
export interface TimelineTitleSeamOptions {
  readonly write?: TitleWriter
  readonly debounceMs?: number
  readonly maxWaitMs?: number
  readonly timeoutMs?: number
  readonly concurrency?: number
}

export const TITLE_INSTRUCTIONS = [
  "You title one stretch of a coding conversation for its timeline.",
  "Reply with the title alone: at most 8 plain words saying what happened there, with no quotes, Markdown or trailing period.",
  "Use the conversation's own words for the work. Never use the words thread, task, workflow, lane, sandbox or VM."
].join(" ")

/** The most input lines one request carries: the first ones and the last few, with the count between them. */
export const TITLE_INPUT_LINES = 40
const TITLE_INPUT_TAIL = 10
const TITLE_INPUT_CHARS = 160
const TITLE_WORDS = 8

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > TITLE_INPUT_CHARS ? `${flat.slice(0, TITLE_INPUT_CHARS - 1)}…` : flat
}

/** The request's one user message: how many entries the stretch holds, then its lines by kind, capped. */
export const titlePrompt = (lines: FoldRun["lines"]): string => {
  const row = (line: FoldRun["lines"][number]) => `${line.kind}: ${clip(line.title)}`
  const rows = lines.length <= TITLE_INPUT_LINES ? lines.map(row) : [
    ...lines.slice(0, TITLE_INPUT_LINES - TITLE_INPUT_TAIL).map(row),
    `… ${lines.length - TITLE_INPUT_LINES} more …`,
    ...lines.slice(-TITLE_INPUT_TAIL).map(row)
  ]
  return [`This stretch holds ${lines.length} entries. Its lines, in order:`, ...rows].join("\n")
}

/* Internal modeling words the product never shows (AGENTS.md, Product words). */
const INTERNAL_WORDS = /\b(?:threads?|tasks?|workflows?|lanes?|sandbox(?:es)?|vms?)\b/i

/**
 * The model's answer as a title: its first non-empty line, without a label, Markdown, wrapping quotes or trailing
 * punctuation, cut to 8 words. Undefined when nothing is left or it uses an internal word, so the deterministic
 * title stands.
 */
export const cleanTitle = (answer: string): string | undefined => {
  const line = answer.split("\n").map(each => each.trim()).find(each => each !== "") ?? ""
  const words = line.replace(/^title\s*:\s*/i, "").replace(/[*_`#>]/g, "").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .split(/\s+/).filter(Boolean).slice(0, TITLE_WORDS)
  const title = words.join(" ").replace(/[\s.,;:!—–-]+$/, "").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim()
  return title === "" || INTERNAL_WORDS.test(title) ? undefined : title
}

/**
 * The host's model door: POST /api/model/stream with one user message and no tools, read to its `done` frame. Its
 * text deltas are the answer; a refused request, a `done` carrying an error or a stream with no `done` rejects.
 */
export const modelStreamTitles = (http: (url: string, init?: RequestInit) => Promise<Response>, baseUrl: string): TitleWriter =>
  async (prompt, signal) => {
    const response = await http(`${baseUrl}${MODEL_STREAM_PATH}`, {
      method: "POST", signal, credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: `timeline-title-${randomUuid()}`, instructions: TITLE_INSTRUCTIONS, messages: [{ role: "user", content: prompt }] })
    })
    if (!response.ok) throw new Error(`The model door answered ${response.status}.`)
    let text = ""
    for (const row of (await response.text()).split("\n")) {
      let parsed: unknown
      try { parsed = JSON.parse(row) } catch { continue }
      const frame = decodeAgentTurnFrame(parsed)
      if (frame?.type === "delta" && frame.kind === "text") text += frame.text
      if (frame?.type === "done") {
        if (frame.error !== undefined) throw new Error(frame.error)
        return text
      }
    }
    throw new Error("The model stream ended before its answer.")
  }

const EMPTY: ReadonlyMap<string, string> = new Map()
const NOTHING: FoldTitles = { get: () => EMPTY, subscribe: () => () => {} }

export function createTimelineTitleSeam(options: TimelineTitleSeamOptions) {
  const { write, debounceMs = 1_500, maxWaitMs = 10_000, timeoutMs = 15_000, concurrency = 2 } = options
  let titles: ReadonlyMap<string, string> = EMPTY
  /** Keys answered or given up on: never asked again. */
  const settled = new Set<string>()
  const inFlight = new Map<string, AbortController>()
  /** The runs each subscribed handle asks for; a handle no one subscribes to asks for nothing. */
  const asking = new Map<FoldTitles, { readonly runs: ReadonlyArray<FoldRun>; subscribers: number }>()
  const listeners = new Set<() => void>()
  let last: { readonly signature: string; readonly handle: FoldTitles } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let due = 0
  let disposed = false

  const next = (): FoldRun | undefined => {
    for (const { runs, subscribers } of asking.values()) {
      if (subscribers === 0) continue
      const run = runs.find(each => !settled.has(each.key) && !inFlight.has(each.key))
      if (run !== undefined) return run
    }
    return undefined
  }
  const finish = (key: string, controller: AbortController, title: string | undefined): void => {
    // Stale: this key timed out or the seam was disposed before the answer came.
    if (disposed || inFlight.get(key) !== controller) return
    inFlight.delete(key)
    settled.add(key)
    if (title !== undefined) {
      titles = new Map(titles).set(key, title)
      for (const listener of listeners) listener()
    }
    pump()
  }
  const pump = (): void => {
    for (let run = next(); write !== undefined && !disposed && run !== undefined && inFlight.size < concurrency; run = next()) {
      const { key } = run
      const controller = new AbortController()
      inFlight.set(key, controller)
      const deadline = setTimeout(() => { finish(key, controller, undefined); controller.abort() }, timeoutMs)
      void write(titlePrompt(run.lines), controller.signal).then(cleanTitle, () => undefined)
        .then(title => { clearTimeout(deadline); finish(key, controller, title) })
    }
  }
  /** Debounced: each change waits `debounceMs` more, but never past `maxWaitMs` after the first. */
  const schedule = (): void => {
    const now = Date.now()
    if (timer === undefined) due = now + maxWaitMs
    else clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; pump() }, Math.max(0, Math.min(debounceMs, due - now)))
  }

  /**
   * The handle for these runs: the same one while the rail folds the same runs, so its subscription holds still.
   * Subscribing (the rail mounting it) asks for its runs after the debounce; every handle reads the same titles.
   */
  const ask = (runs: ReadonlyArray<FoldRun>): FoldTitles => {
    if (write === undefined || disposed) return NOTHING
    const signature = runs.map(run => run.key).join("\n")
    if (last?.signature === signature) return last.handle
    const entry = { runs, subscribers: 0 }
    const handle: FoldTitles = {
      get: () => titles,
      subscribe: listener => {
        listeners.add(listener)
        if (entry.subscribers++ === 0) asking.set(handle, entry)
        if (!disposed && runs.some(run => !settled.has(run.key))) schedule()
        return () => {
          listeners.delete(listener)
          if (--entry.subscribers === 0) asking.delete(handle)
        }
      }
    }
    last = { signature, handle }
    return handle
  }
  const dispose = (): void => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
    asking.clear()
    listeners.clear()
  }
  return { ask, dispose }
}
export type TimelineTitleSeam = ReturnType<typeof createTimelineTitleSeam>
