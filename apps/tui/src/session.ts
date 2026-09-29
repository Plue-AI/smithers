/**
 * Sessions on disk: one JSONL file per conversation, under
 * `~/.smithers/tui/sessions/<cwd slug>/` (or `$SMITHERS_TUI_SESSION_DIR`).
 *
 * The file is the transcript's own input: prompts, every harness event but
 * the model's token deltas, shell results and turn outcomes. Folding it
 * again rebuilds the screen and the conversation the next turn is told.
 * Credential shapes in that text are redacted before a line reaches the disk.
 */
import * as Redaction from "@smthrs/journal/Redaction"
import type * as FailureCopy from "@smthrs/model/FailureCopy"
import * as PromptQueue from "@smthrs/rpc/PromptQueue"
import { Data } from "effect"
import { createHash, randomUUID } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import type * as Activity from "./activity.ts"
import type * as Changes from "./changes.ts"
import type * as Context from "./context.ts"
import type * as Extension from "./extension.ts"
import * as Failures from "./failures.ts"
import type * as Flows from "./flows.ts"
import type * as Monitors from "./monitors.ts"
import * as Panels from "./panels.ts"
import * as Shell from "./shell.ts"
import * as Transcript from "./transcript.ts"
import type * as Workspace from "./workspace.ts"

export type Record =
  | { readonly type: "caption"; readonly prose: string }
  /** A worker's card is placed here and drawn in its own file's `card` record. */
  | { readonly type: "panel"; readonly panel: Panels.Panel; readonly placement?: "card" }
  /** A panel published as a chat card; its transcript item and its `ui:<id>` view. */
  | { readonly type: "card"; readonly at: number; readonly panel: Panels.Panel }
  /** A cell's status item or key (`runtime:<source>`); repo and plugin items are never persisted. */
  | {
    readonly type: "contribution"
    readonly owner: string
    readonly contribution: Extract<Extension.Contribution, { kind: "status" | "key" }>
  }
  | { readonly type: "tab"; readonly tab: Workspace.Tab }
  | { readonly type: "flow"; readonly run: Flows.Run }
  | { readonly type: "monitor"; readonly monitor: Monitors.Monitor }
  /** A delivered monitor update, or its failure. */
  | {
    readonly type: "monitor-update"
    readonly at: number
    readonly id: string
    readonly title: string
    readonly text: string
    readonly failed?: true
  }
  | { readonly type: "patch"; readonly receipt: Changes.Receipt }
  | {
    readonly type: "session"
    readonly version: 1
    readonly id: string
    readonly cwd: string
    readonly createdAt: number
    /** The session this one was forked from (pi's `parentSession`). */
    readonly parent?: string
  }
  | { readonly type: "name"; readonly name: string }
  | { readonly type: "user"; readonly at: number; readonly text: string; readonly steered?: boolean }
  /** A row drawn as it happened: a wrapped harness's own `⏺`/`•` rows. */
  | { readonly type: "note"; readonly at: number; readonly text: string }
  | { readonly type: "event"; readonly at: number; readonly event: Activity.Observed }
  | {
    readonly type: "outcome"
    readonly at: number
    readonly prompt: string
    readonly outcome: {
      readonly _tag: string
      readonly answer?: string
      readonly message?: string
      readonly headline?: string
      /** The typed failure copy, so a restored session never re-reads the message. */
      readonly failure?: FailureCopy.Description
    }
  }
  | { readonly type: "shell"; readonly at: number; readonly result: Shell.Result; readonly excluded: boolean }
  /** An Alt+Enter follow-up admitted to this conversation's FIFO queue. */
  | { readonly type: "queued"; readonly at: number; readonly prompt: PromptQueue.Prompt }
  /** A follow-up left the queue: its turn started, or it went back to the editor. */
  | { readonly type: "dequeued"; readonly at: number; readonly id: string; readonly reason: "started" | "restored" }
  /** `/compact`: the model no longer receives the oldest `dropped` context entries. */
  | { readonly type: "compact"; readonly at: number; readonly dropped: number }
  /** The user reversed these calls' captured changes (call identities, `Changes.identity`). */
  | {
    readonly type: "undo"
    readonly at: number
    readonly calls: ReadonlyArray<string>
    readonly paths: ReadonlyArray<string>
    /** A worker tab's calls: that tab's file marks them; this record only tells the context. */
    readonly tab?: string
  }

export interface Summary {
  readonly file: string
  readonly name: string | undefined
  readonly firstPrompt: string
  readonly modified: number
  /** Set on a fork: the session file it was forked from. */
  readonly parent?: string
}

export const root = (): string =>
  process.env.SMITHERS_TUI_SESSION_DIR ?? join(homedir(), ".smithers", "tui", "sessions")

const slug = (cwd: string): string => cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")

/** Keep the slug and its 16-byte fence/hash within the 255-byte filename limit. */
const boundedSlug = (cwd: string): string => {
  let value = ""
  let bytes = 0
  for (const character of slug(cwd)) {
    bytes += Buffer.byteLength(character)
    if (bytes > 239) break
    value += character
  }
  return value
}

/** A bounded directory slug plus the exact path's hash; truncated or colliding slugs never share a folder. */
export const directory = (cwd: string): string =>
  join(root(), `--${boundedSlug(cwd)}--${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`)

/** The folder before the hash; shared by colliding paths, so its files are filtered by their header's cwd. */
const legacyDirectory = (cwd: string): string => join(root(), `--${slug(cwd)}--`)

/** APFS may hold a pre-bound Unicode slug that exceeds Linux's byte limit. */
const readableDirectories = (cwd: string): ReadonlyArray<string> => [
  ...new Set([
    directory(cwd),
    join(root(), `--${slug(cwd)}--${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`),
    legacyDirectory(cwd)
  ])
]

/** Sessions hold prompts, code, diffs and shell output: owner-only folders and files. */
const privateFolder = (folder: string): void => {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  chmodSync(folder, 0o700)
}
const append = (file: string, text: string): void => appendFileSync(file, text, { mode: 0o600 })

const text = (value: string): string => String(Redaction.redact(value))

/** `value` as JSON with every string redacted. */
const strings = (value: unknown): string =>
  JSON.stringify(value, (_, each: unknown) => (typeof each === "string" ? text(each) : each))

/** A tab's or a flow run's result text, redacted; the rest of it is what a retry relaunches. */
const said = <A extends { readonly answer?: string; readonly message?: string }>(value: A): A => ({
  ...value,
  ...(value.answer === undefined ? {} : { answer: text(value.answer) }),
  ...(value.message === undefined ? {} : { message: text(value.message) })
})

/**
 * A record as a session file holds it: the journal's textual credential rules
 * applied to its text, so `!printenv` or an agent reading `~/.ssh` leaves
 * `[REDACTED]` on disk, not the secret. Field names are not judged, because a
 * call identity's `session` is not a credential and undo matches on it.
 *
 * What the TUI re-executes keeps its bytes: a placeholder in a `patch` is what
 * undo would write into the file, one in a flow run's input or a worker tab's
 * prompt is what retry would relaunch, one in a monitor's source is what its
 * next tick would run, and one in a view is what selecting its action would
 * send; a queued follow-up is the prompt its turn will send. `session` and `undo` hold ids and paths, which a rule could mistake for
 * a key (`~/sk-demo-project`).
 */
const line = (record: Record): string => {
  switch (record.type) {
    case "event": {
      if (record.event._tag !== "model-requested") return strings(record) + "\n"
      const { request: _request, ...event } = record.event
      return strings({ ...record, event }) + "\n"
    }
    case "session":
    case "patch":
    case "undo":
    case "panel":
    case "queued":
      return JSON.stringify(record) + "\n"
    case "tab":
      return JSON.stringify({ ...record, tab: said(record.tab) }) + "\n"
    case "flow":
      return JSON.stringify({ ...record, run: said(record.run) }) + "\n"
    case "monitor": {
      const { source, ...rest } = record.monitor
      return JSON.stringify({ ...record, monitor: { ...(JSON.parse(strings(rest)) as typeof rest), source } }) + "\n"
    }
    default:
      return strings(record) + "\n"
  }
}

export interface Writer {
  readonly file: string
  readonly append: (record: Record) => void
}

/**
 * A new session file, written lazily so an empty session leaves nothing behind.
 * A `seed` (a fork's copied records) is written at once, or not at all.
 */
export const create = (
  cwd: string,
  kind: "chat" | "worker" = "chat",
  options: { readonly parent?: string; readonly seed?: ReadonlyArray<Record> } = {}
): Writer => {
  const id = randomUUID()
  const folder = kind === "worker" ? join(directory(cwd), "workers") : directory(cwd)
  const prepare = () => {
    privateFolder(directory(cwd))
    privateFolder(folder)
  }
  const file = join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`)
  const header = (): Record => ({
    type: "session",
    version: 1,
    id,
    cwd,
    createdAt: Date.now(),
    ...(options.parent === undefined ? {} : { parent: options.parent })
  })
  let opened = false
  if (options.seed !== undefined && options.seed.length > 0) {
    try {
      prepare()
      writeFileSync(file, [header(), ...options.seed].map(line).join(""), {
        flag: "wx",
        mode: 0o600
      })
    } catch (error) {
      rmSync(file, { force: true })
      throw error
    }
    opened = true
  }
  return {
    file,
    append: (record) => {
      if (!opened) {
        prepare()
        append(file, line(header()))
        opened = true
      }
      append(file, line(record))
    }
  }
}

/** Repair only the final JSONL fragment; scan backwards without rereading a long conversation. */
const repairTail = (file: string): void => {
  const fd = openSync(file, "r+")
  try {
    const size = fstatSync(fd).size
    const unchanged = () => {
      if (fstatSync(fd).size !== size) throw new Error("Session changed while repairing its final record")
    }
    if (size === 0) return
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let start = 0
    let content = false
    scan: for (let end = size; end > 0;) {
      const position = Math.max(0, end - chunk.length)
      const count = readSync(fd, chunk, 0, end - position, position)
      for (let index = count - 1; index >= 0; index--) {
        const byte = chunk[index]!
        if (!content && (byte === 10 || byte === 13 || byte === 32 || byte === 9)) continue
        content = true
        if (byte === 10) {
          start = position + index + 1
          break scan
        }
      }
      end = position
    }
    if (!content) {
      unchanged()
      ftruncateSync(fd, 0)
      return
    }
    const tail = Buffer.allocUnsafe(size - start)
    let read = 0
    while (read < tail.length) {
      const count = readSync(fd, tail, read, tail.length - read, start + read)
      if (count === 0) throw new Error("Session changed while repairing its final record")
      read += count
    }
    try {
      JSON.parse(tail.toString("utf8"))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      unchanged()
      ftruncateSync(fd, start)
      return
    }
    if (tail.at(-1) !== 10) {
      unchanged()
      writeSync(fd, "\n", size, "utf8")
    }
  } finally {
    closeSync(fd)
  }
}

/** Continues an existing file. */
export const reopen = (file: string): Writer => {
  let repaired = false
  return {
    file,
    append: (record) => {
      if (!repaired && existsSync(file)) {
        chmodSync(file, 0o600)
        repairTail(file)
      }
      repaired = true
      append(file, line(record))
    }
  }
}

/** The disk refused a session record: a full disk, a removed folder, lost permission. */
export interface WriteFailed {
  readonly _tag: "SessionWriteFailed"
  readonly file: string
  readonly message: string
}

/**
 * `writer`, whose appends never throw: a turn, shell or undo settles on screen
 * even when its record cannot be saved. `report` hears the first failure of
 * each run of failures; a write that succeeds again ends the run.
 */
export const guarded = (writer: Writer, report: (failure: WriteFailed) => void): Writer => {
  let failing = false
  return {
    file: writer.file,
    append: (record) => {
      try {
        if (failing && existsSync(writer.file)) repairTail(writer.file)
        writer.append(record)
        failing = false
      } catch (error) {
        if (!failing) {
          report({
            _tag: "SessionWriteFailed",
            file: writer.file,
            message: error instanceof Error ? error.message : String(error)
          })
        }
        failing = true
      }
    }
  }
}

/** Thrown for a record damaged before the file's last line; a torn last line (a crash mid-append) is dropped. */
export class Corrupt extends Data.TaggedError("SessionCorrupt")<{
  readonly file: string
  readonly line: number
  readonly message: string
}> {
  constructor(file: string, line: number) {
    super({ file, line, message: `Conversation ${basename(file)} is damaged at line ${line}` })
  }
}

const parse = (file: string, text: string): ReadonlyArray<Record> => {
  const lines = text.split("\n")
  const last = lines.findLastIndex((line) => line.trim() !== "")
  const records: Array<Record> = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue
    try {
      records.push(JSON.parse(line) as Record)
    } catch {
      if (index !== last) throw new Corrupt(file, index + 1)
    }
  }
  return records
}

export const load = (file: string): ReadonlyArray<Record> => parse(file, readFileSync(file, "utf8"))

/** Moves a file that failed to load out of the listing, beside it as `.damaged`, and says so. */
export const quarantine = (file: string, error: unknown): string => {
  const reason = Failures.present("resume", error).sentence
  try {
    renameSync(file, `${file}.damaged`)
    return `${reason} Moved to ${basename(file)}.damaged.`
  } catch {
    return `${reason} ${Failures.inTerminal}`
  }
}

/** Stream metadata lines only; event payloads never accumulate in memory. */
function* metadata(file: string): Generator<string> {
  const fd = openSync(file, "r")
  const bytes = Buffer.allocUnsafe(64 * 1024)
  const decoder = new StringDecoder("utf8")
  let line = ""
  let skip = false
  try {
    while (true) {
      const size = readSync(fd, bytes, 0, bytes.length, null)
      if (size === 0) break
      const parts = decoder.write(bytes.subarray(0, size)).split("\n")
      for (let i = 0; i < parts.length; i++) {
        if (!skip) {
          line += parts[i]!
          if (line.length >= 32 && !/^\{"type":"(session|user|name)"/.test(line)) {
            skip = true
            line = ""
          }
        }
        if (i < parts.length - 1) {
          if (!skip) yield line
          line = ""
          skip = false
        }
      }
    }
    if (!skip && line !== "") yield line + decoder.end()
  } finally {
    closeSync(fd)
  }
}

/** A listing parses only the header, the first prompt and names, and skips a damaged file instead of failing the list. */
const summary = (file: string): (Summary & { readonly cwd?: string }) | undefined => {
  let header: Record | undefined
  let first: Record | undefined
  let named: Record | undefined
  try {
    for (const line of metadata(file)) {
      const type = /^\{"type":"(session|user|name)"/.exec(line)?.[1]
      if (type === undefined || (type === "user" && first !== undefined)) continue
      let record: Record
      try {
        record = JSON.parse(line) as Record
      } catch {
        continue
      }
      if (record.type === "session") header ??= record
      else if (record.type === "user") first = record
      else named = record
    }
    return {
      file,
      ...(header?.type === "session" && header.parent !== undefined ? { parent: header.parent } : {}),
      name: named?.type === "name" ? named.name : undefined,
      firstPrompt: first?.type === "user" ? first.text : basename(file),
      modified: statSync(file).mtimeMs,
      ...(header?.type === "session" ? { cwd: header.cwd } : {})
    }
  } catch {
    return undefined
  }
}

const summaries = (folder: string): ReadonlyArray<Summary & { readonly cwd?: string }> =>
  existsSync(folder)
    ? readdirSync(folder).filter((name) => name.endsWith(".jsonl")).flatMap((name) => summary(join(folder, name)) ?? [])
    : []

/** Sessions for `cwd`, newest first. */
export const list = (cwd: string): ReadonlyArray<Summary> =>
  readableDirectories(cwd).flatMap((folder) =>
    summaries(folder).filter((row) => folder !== legacyDirectory(cwd) || row.cwd === cwd)
  )
    .map(({ cwd: _cwd, ...row }) => row)
    .sort((a, b) => b.modified - a.modified)

/** Startup needs only modification times; legacy folders also require their cwd header. */
export const latest = (cwd: string): string | undefined => {
  const candidates: Array<{ file: string; modified: number }> = []
  for (const folder of readableDirectories(cwd)) {
    if (!existsSync(folder)) continue
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".jsonl")) continue
      const file = join(folder, name)
      try {
        const info = statSync(file)
        if (!info.isFile()) continue
        if (folder === legacyDirectory(cwd)) {
          const records = metadata(file)
          try {
            const first = records.next().value
            if (first === undefined || (JSON.parse(first) as { cwd?: string }).cwd !== cwd) continue
          } finally {
            records.return(undefined)
          }
        }
        candidates.push({ file, modified: info.mtimeMs })
      } catch { /* A concurrent removal must not block startup. */ }
    }
  }
  return candidates.sort((a, b) => b.modified - a.modified)[0]?.file
}

/** A user turn a fork can start before. `index` is its position in the file's records. */
export interface Turn {
  readonly index: number
  readonly at: number
  readonly text: string
}

/** pi's fork points: prompts that started a turn, newest first. A steer belongs to its turn; `!cmd` is not a turn. */
export const turns = (records: ReadonlyArray<Record>): ReadonlyArray<Turn> =>
  records
    .flatMap((record, index) =>
      record.type === "user" && record.steered !== true ? [{ index, at: record.at, text: record.text }] : []
    )
    .reverse()

export type Fork =
  | {
    readonly _tag: "Forked"
    readonly writer: Writer
    readonly records: ReadonlyArray<Record>
    readonly text: string
  }
  | { readonly _tag: "Stale" }

/** pi's /fork: a new session holding `source`'s records before `turn`. `source` is only read. */
export const fork = (source: string, cwd: string, turn: Turn): Fork => {
  const records = load(source)
  const at = records[turn.index]
  if (at?.type !== "user" || at.steered === true || at.at !== turn.at || at.text !== turn.text) return { _tag: "Stale" }
  // Queued follow-ups belong to the source conversation; a fork never inherits them.
  const before: ReadonlyArray<Record> = records.slice(0, turn.index).filter((record) =>
    record.type !== "session" && record.type !== "queued" && record.type !== "dequeued"
  )
  // A worker started before the fork point may have settled after it: carry its last record, not a stale `requested`.
  type TabRecord = Extract<Record, { readonly type: "tab" }>
  const key = (tab: Workspace.Tab) => `${tab.id}\0${tab.file}`
  const last = new Map<string, TabRecord>()
  for (const record of records) if (record.type === "tab") last.set(key(record.tab), record)
  const settled = new Set<TabRecord>()
  for (const record of before) if (record.type === "tab") settled.add(last.get(key(record.tab))!)
  const copies = new Map<string, string>()
  try {
    const kept = [...before, ...[...settled].filter((record) => !before.includes(record))].map((record): Record => {
      if (record.type !== "tab") return record
      const original = record.tab.file
      if (!copies.has(original)) {
        const worker = create(cwd, "worker", {
          parent: original,
          seed: existsSync(original) ? load(original).filter((record) => record.type !== "session") : []
        })
        copies.set(original, worker.file)
      }
      return { ...record, tab: { ...record.tab, file: copies.get(original)! } }
    })
    const writer = create(cwd, "chat", { parent: source, seed: kept })
    return { _tag: "Forked", writer, records: kept, text: at.text }
  } catch (error) {
    for (const file of copies.values()) rmSync(file, { force: true })
    throw error
  }
}

type Outcome = Extract<Record, { readonly type: "outcome" }>

/** The outcome of a chat turn whose process ended before the turn settled. */
export const interrupted = { _tag: "interrupted", headline: "Interrupted" } as const

/**
 * A chat session as it reads after a restart. A foreground turn is a prompt
 * (a `user` record that is not a steer) and its `outcome`; a prompt with no
 * outcome lost the process running it, and nothing runs it now. One followed
 * by a later prompt (a file from before these receipts) settles in place;
 * the last one's `receipt` is returned for the caller to append, so the file
 * says so too. Worker files never pass through here: a worker relaunches.
 */
export const recover = (records: ReadonlyArray<Record>, at = Date.now()): {
  readonly records: ReadonlyArray<Record>
  readonly receipt?: Outcome
} => {
  const recovered: Array<Record> = []
  let open: Extract<Record, { readonly type: "user" }> | undefined
  const settle = (when: number): Outcome => ({ type: "outcome", at: when, prompt: open!.text, outcome: interrupted })
  for (const record of records) {
    if (record.type === "user" && record.steered !== true) {
      if (open !== undefined) recovered.push(settle(record.at))
      open = record
    } else if (record.type === "outcome") open = undefined
    recovered.push(record)
  }
  if (open === undefined) return { records: recovered }
  const receipt = settle(Math.max(at, open.at))
  return { records: [...recovered, receipt], receipt }
}

/** What a session file rebuilds: the screen, the agent's context, and the prompt history. */
export const restore = (records: ReadonlyArray<Record>): {
  readonly transcript: Transcript.Transcript
  readonly workspace: Workspace.Snapshot
  readonly flows: ReadonlyArray<Flows.Run>
  readonly monitors: ReadonlyArray<Monitors.Monitor>
  /** Runtime status items and keys, latest per owner and id. */
  readonly contributions: ReadonlyArray<{ readonly owner: string; readonly contribution: Extension.Contribution }>
  readonly entries: Array<Context.Entry>
  readonly prompts: Array<string>
  /** Follow-ups still waiting for a turn, oldest first. */
  readonly queued: ReadonlyArray<PromptQueue.Prompt>
  readonly name: string | undefined
} => {
  const panels = new Map<string, Panels.Panel>()
  const cards = new Set<string>()
  const contributions = new Map<string, { readonly owner: string; readonly contribution: Extension.Contribution }>()
  const tabs = new Map<string, Workspace.Tab>()
  const flows = new Map<string, Flows.Run>()
  const monitors = new Map<string, Monitors.Monitor>()
  let transcript = Transcript.empty
  const entries: Array<Context.Entry> = []
  const prompts: Array<string> = []
  let queued: ReadonlyArray<PromptQueue.Prompt> = []
  let name: string | undefined
  for (const record of records) {
    switch (record.type) {
      case "caption":
        transcript = Transcript.caption(transcript, record.prose)
        break
      case "note":
        transcript = Transcript.note(transcript, record.text, record.at)
        break
      case "panel":
        Panels.keep(panels, record.panel)
        if (record.placement === "card") cards.add(record.panel.id)
        else cards.delete(record.panel.id)
        break
      case "card":
        Panels.keep(panels, record.panel)
        cards.add(record.panel.id)
        transcript = Transcript.card(transcript, record.panel, record.at)
        break
      case "contribution": {
        const id = record.contribution.kind === "status" ? record.contribution.status.id : record.contribution.key.id
        contributions.set(`${record.owner}\0${record.contribution.kind}\0${id}`, {
          owner: record.owner,
          contribution: record.contribution
        })
        break
      }
      case "tab":
        tabs.set(record.tab.id, record.tab)
        break
      case "flow":
        flows.set(record.run.id, record.run)
        break
      case "monitor":
        monitors.set(record.monitor.id, record.monitor)
        break
      case "monitor-update":
        transcript = record.failed === true
          ? Transcript.alert(transcript, `${record.title}: ${record.text}`, record.at)
          : Transcript.note(transcript, `${record.title}: ${record.text}`, record.at)
        break
      case "patch":
        transcript = Transcript.patched(transcript, record.receipt)
        break
      case "name":
        name = record.name
        break
      case "user":
        transcript = Transcript.user(transcript, record.text, record.steered === true, record.at)
        prompts.push(record.text)
        break
      case "event":
        transcript = Transcript.apply(transcript, record.event, record.at)
        break
      case "shell":
        transcript = Transcript.shell(transcript, record.result, record.excluded, record.at)
        prompts.push(`${record.excluded ? "!!" : "!"}${record.result.command}`)
        if (!record.excluded) entries.push({ kind: "shell", text: Shell.contextText(record.result) })
        break
      case "outcome":
        if (record.outcome._tag === "done") {
          entries.push({ kind: "exchange", user: record.prompt, answer: record.outcome.answer ?? "" })
        } else {
          transcript = Transcript.failure(
            transcript,
            record.outcome._tag === "cancelled"
              ? "Stopped"
              : record.outcome.headline ?? record.outcome.message ?? "Failed",
            record.at
          )
        }
        break
      case "undo":
        if (record.tab === undefined) transcript = Transcript.undone(transcript, record.calls, record.paths, record.at)
        entries.push({ kind: "undo", paths: record.paths })
        break
      case "compact":
        entries.splice(0, record.dropped)
        break
      case "queued":
        queued = PromptQueue.enqueue(queued, record.prompt)
        break
      case "dequeued":
        queued = PromptQueue.remove(queued, record.id)
        break
      case "session":
        break
    }
  }
  return {
    transcript,
    entries,
    prompts,
    queued,
    name,
    workspace: {
      tabs: [...tabs.values()],
      panels: [...panels.values()],
      cards: [...cards].filter((id) => panels.has(id))
    },
    flows: [...flows.values()],
    monitors: [...monitors.values()],
    contributions: [...contributions.values()]
  }
}
