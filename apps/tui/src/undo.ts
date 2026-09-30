/**
 * Review and undo a run: the file changes captured at the flow boundary
 * (`changes.ts`) for a worker's whole transcript, or one chat turn. `changes`
 * is the run's combined diff per file; `plan` reads the disk and works out
 * each file's restored content, or why it stays; `commit` writes the files the
 * person kept checked, rolling back on an IO error.
 */
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { applyPatch, reversePatch } from "diff"
import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { real } from "./approvals.ts"
import * as Changes from "./changes.ts"
import * as Log from "./log.ts"
import type * as Transcript from "./transcript.ts"

export type Failure =
  | { readonly _tag: "Busy" }
  | { readonly _tag: "NothingToUndo" }
  /** A path that reaches outside the workspace, directly or through a symlink, when writing. */
  | { readonly _tag: "Outside"; readonly paths: ReadonlyArray<string> }
  /** The files changed between the plan and the write. */
  | { readonly _tag: "Conflict"; readonly paths: ReadonlyArray<string> }
  | { readonly _tag: "WriteFailed"; readonly path: string; readonly message: string; readonly restored: boolean }

/** Why a file of the run stays as it is. */
export type Refusal = "changed" | "outside" | "unrendered"

/** `new` the run created it; `deleted` the run removed it. */
export type State = "new" | "deleted"

/** One file of a run's combined diff. */
export interface Change {
  readonly path: string
  /** Its patches, oldest first. */
  readonly patches: ReadonlyArray<Transcript.Patch>
  readonly added: number
  readonly removed: number
  readonly state?: State
  /** Every patch of it was undone. */
  readonly undone: boolean
}

/** A file undo restores. */
export interface File {
  readonly path: string
  /** Its bytes when planned; `null` when absent. */
  readonly current: string | null
  /** What undo writes; `null` removes it. */
  readonly next: string | null
  /** Permission bits for a restored deletion, from the patch's `deleted file mode`. */
  readonly mode?: number
}

/** One row of the checklist. */
export interface Entry extends Partial<File> {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly state?: State
  readonly refused?: Refusal
  /** The paths undone only together with this one: both sides of a move. */
  readonly with: ReadonlyArray<string>
}

export interface Plan {
  /** Identities of the calls whose patches the plan reverses. */
  readonly calls: ReadonlyArray<string>
  /**
   * Files that change back, then refused ones, each in the order the run first
   * touched it. None when every file netted to no change.
   */
  readonly entries: ReadonlyArray<Entry>
  /** Paths whose patches net to no change: an undo records them too. */
  readonly settled: ReadonlyArray<string>
}

export type Cell = Extract<Transcript.Item, { kind: "cell" }>

/** A worker's whole transcript. */
export const run = (transcript: Transcript.Transcript): ReadonlyArray<Cell> =>
  transcript.items.filter((item): item is Cell => item.kind === "cell")

/** The chat turn a Summary row belongs to, from its prompt to the next one: the prompt's text and the cells. */
export const turn = (
  transcript: Transcript.Transcript,
  rowId: string
): { readonly prompt: string | undefined; readonly cells: ReadonlyArray<Cell> } => {
  const at = transcript.items.findIndex((item) => item.id === rowId)
  if (at < 0) return { prompt: undefined, cells: [] }
  const prompt = (item: Transcript.Item) => item.kind === "user" && item.queued === undefined
  const start = transcript.items.findLastIndex((item, index) => index <= at && prompt(item))
  const end = transcript.items.findIndex((item, index) => index > at && prompt(item))
  const opening = transcript.items[start]
  return {
    prompt: opening?.kind === "user" ? opening.text : undefined,
    cells: transcript.items.slice(Math.max(0, start), end < 0 ? undefined : end)
      .filter((item): item is Cell => item.kind === "cell")
  }
}

/** Every captured patch of these cells, oldest first, with its call. */
const captured = (cells: ReadonlyArray<Cell>) =>
  cells.flatMap((cell) =>
    cell.calls.flatMap((call) =>
      call.denied === true ? [] : (call.patches ?? []).map((patch) => ({ call: call.identity, patch }))
    )
  )

/** The path a patch is listed under: the file it leaves behind, else the one it removed. */
const home = (patch: Changes.Patch): string => Changes.ends(patch)[0]!

const stateOf = (patches: ReadonlyArray<Changes.Patch>): State | undefined => {
  const first = patches[0] === undefined ? undefined : Changes.structured(patches[0])
  const last = patches.at(-1) === undefined ? undefined : Changes.structured(patches.at(-1)!)
  const created = first !== undefined && Changes.sides(patches[0]!, first).before === undefined
  const deleted = last !== undefined && Changes.sides(patches.at(-1)!, last).after === undefined
  return created && !deleted ? "new" : deleted && !created ? "deleted" : undefined
}

const count = (patches: ReadonlyArray<Changes.Patch>) =>
  patches.reduce(
    (total, patch) => {
      const each = SubagentCard.diffCounts(patch.patch)
      return { added: total.added + each.added, removed: total.removed + each.removed }
    },
    { added: 0, removed: 0 }
  )

/** The run's combined diff: every file it changed, first touched first, undone ones included. */
export const changes = (cells: ReadonlyArray<Cell>): ReadonlyArray<Change> => {
  const byPath = new Map<string, Array<Transcript.Patch>>()
  for (const { patch } of captured(cells)) byPath.set(home(patch), [...byPath.get(home(patch)) ?? [], patch])
  return [...byPath].map(([path, patches]) => {
    const state = stateOf(patches)
    return {
      path,
      patches,
      ...count(patches),
      ...(state === undefined ? {} : { state }),
      undone: patches.every((patch) => patch.undone === true)
    }
  })
}

/** Whether these cells hold a captured change not yet undone that undo can reverse: not a binary or large one. */
export const possible = (cells: ReadonlyArray<Cell>): boolean =>
  captured(cells).some(({ patch }) => patch.undone !== true && Changes.structured(patch) !== undefined)

/** Whether every captured change of these cells was undone. */
export const undone = (cells: ReadonlyArray<Cell>): boolean => {
  const all = captured(cells)
  return all.length > 0 && all.every(({ patch }) => patch.undone === true)
}

/**
 * The newest prompt with captured changes left, for Ctrl+K where no row is selected.
 * Refused files stay on that turn's checklist rather than undoing an older turn.
 */
export const latest = (transcript: Transcript.Transcript): ReturnType<typeof turn> | Failure => {
  for (const item of transcript.items.toReversed()) {
    if (item.kind !== "user" || item.queued !== undefined) continue
    const found = turn(transcript, item.id)
    if (possible(found.cells)) return found
  }
  return { _tag: "NothingToUndo" }
}

/**
 * Receipts come from a session file, so their paths are data: undo reads and
 * writes only where a path lands inside the workspace after following every symlink.
 */
const outside = (cwd: string, path: string): boolean => {
  const inside = relative(real(resolve(cwd)), real(resolve(cwd, path)))
  return inside === "" || inside === ".." || inside.startsWith("../") || isAbsolute(inside)
}

/**
 * Each file's restored content, reading only. A file changed since the run, a
 * path outside the workspace, and a binary or large change are refused one by
 * one; the other files still undo.
 */
export const plan = async (
  cwd: string,
  cells: ReadonlyArray<Cell>,
  read: (path: string) => Promise<string | null | undefined> = Changes.read
): Promise<Plan | Failure> => {
  const pending = captured(cells).filter(({ patch }) => patch.undone !== true)
  if (pending.length === 0) return { _tag: "NothingToUndo" }
  const order: Array<string> = []
  const touch = (path: string) => {
    if (!order.includes(path)) order.push(path)
  }
  // Both sides of a move undo together or not at all.
  const groups = new Map<string, Set<string>>()
  const group = (path: string) => groups.get(path) ?? new Set([path])
  const link = (a: string, b: string) => {
    const both = new Set([...group(a), ...group(b)])
    for (const path of both) groups.set(path, both)
  }
  const refused = new Map<string, Refusal>()
  for (const { patch } of pending) {
    for (const path of Changes.ends(patch)) touch(path)
    const [first, second] = Changes.ends(patch)
    if (second !== undefined) link(first!, second)
    if (Changes.structured(patch) === undefined) refused.set(patch.path, "unrendered")
  }
  for (const path of order) {
    if (outside(cwd, path)) refused.set(path, "outside")
  }
  // Keyed by the file, not its spelling: a receipt from before paths were
  // captured workspace-relative may name one file `./a.ts` and another `a.ts`.
  const seeded = new Map<string, string | null | undefined>()
  const state = new Map<string, string | null | undefined>()
  const modes = new Map<string, number>()
  const now = async (path: string) => {
    const file = resolve(cwd, path)
    if (!state.has(file)) {
      const value = await read(file)
      seeded.set(file, value)
      state.set(file, value)
    }
    return state.get(file)
  }
  const set = (path: string, value: string | null) => state.set(resolve(cwd, path), value)
  const blocked = (paths: ReadonlyArray<string>) =>
    paths.some((path) => [...group(path)].some((each) => refused.has(each)))
  // Newest first, each patch reversed over what the later ones left.
  for (const { patch } of pending.toReversed()) {
    if (blocked(Changes.ends(patch))) continue
    const parsed = Changes.structured(patch)!
    const { before, after } = Changes.sides(patch, parsed)
    const path = after ?? before!
    const content = await now(path)
    const fits = after === undefined ? content === null : typeof content === "string"
    const restored = !fits
      ? false
      : parsed.hunks.length === 0
      ? content ?? ""
      : applyPatch(content ?? "", reversePatch(parsed))
    if (restored === false || (before === undefined && restored !== "")) {
      refused.set(path, "changed")
      continue
    }
    if (after === undefined && parsed.oldMode !== undefined) modes.set(path, parseInt(parsed.oldMode, 8) & 0o777)
    if (before === undefined) set(path, null)
    else if (before !== path) {
      if ((await now(before)) !== null) {
        refused.set(before, "changed")
        continue
      }
      set(before, restored)
      set(path, null)
    } else set(path, restored)
  }
  const reason = (path: string): Refusal | undefined => {
    const all = [...group(path)].flatMap((each) => refused.get(each) ?? [])
    return all.includes("outside") ? "outside" : all.includes("unrendered") ? "unrendered" : all[0]
  }
  const ready: Array<Entry> = []
  const kept: Array<Entry> = []
  const settled: Array<string> = []
  for (const path of order) {
    const patches = pending.filter(({ patch }) => home(patch) === path).map(({ patch }) => patch)
    const counts = count(patches)
    const shared = { path, ...counts, with: [...group(path)] }
    const why = reason(path)
    if (why !== undefined) {
      const was = stateOf(patches)
      kept.push({ ...shared, ...(was === undefined ? {} : { state: was }), refused: why })
      continue
    }
    const current = seeded.get(resolve(cwd, path))
    const next = state.get(resolve(cwd, path))
    if (current === undefined || next === undefined) {
      kept.push({ ...shared, refused: "changed" })
      continue
    }
    if (current === next) {
      settled.push(path)
      continue
    }
    const mode = next === null ? undefined : modes.get(path)
    ready.push({
      ...shared,
      current,
      next,
      ...(next === null ? { state: "new" as const } : current === null ? { state: "deleted" as const } : {}),
      ...(mode === undefined ? {} : { mode })
    })
  }
  // With no entries, every file netted to no change: recording them leaves nothing to undo.
  return {
    calls: [...new Set(pending.flatMap(({ call }) => call === undefined ? [] : [call]))],
    entries: [...ready, ...kept],
    settled
  }
}

/** The files to write: the checked entries, each with both sides of its move. */
export const chosen = (plan: Plan, checked: ReadonlySet<string>): ReadonlyArray<File> =>
  plan.entries.flatMap((entry) =>
    entry.refused !== undefined || entry.current === undefined || entry.next === undefined ||
      !entry.with.some((path) => checked.has(path))
      ? []
      : [{
        path: entry.path,
        current: entry.current,
        next: entry.next,
        ...(entry.mode === undefined ? {} : { mode: entry.mode })
      }]
  )

/** The checked paths after toggling `path` and the paths it moves with. */
export const toggle = (plan: Plan, checked: ReadonlySet<string>, path: string): ReadonlySet<string> => {
  const entry = plan.entries.find((each) => each.path === path)
  if (entry === undefined || entry.refused !== undefined) return checked
  const next = new Set(checked)
  for (const each of entry.with) {
    if (checked.has(path)) next.delete(each)
    else next.add(each)
  }
  return next
}

/** Every entry undo can write, checked at first. */
export const ready = (plan: Plan): ReadonlySet<string> =>
  new Set(plan.entries.flatMap((entry) => entry.refused === undefined ? [entry.path] : []))

/** The paths an undo of `files` records: those, and the ones that netted to no change. */
export const recorded = (plan: Plan, files: ReadonlyArray<File>): ReadonlyArray<string> => [
  ...files.map((file) => file.path),
  ...plan.settled
]

export const put = async (path: string, content: string | null, mode?: number): Promise<void> => {
  if (content === null) return unlink(path)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  if (mode !== undefined) await chmod(path, mode)
}

const modeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode & 0o7777
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined
    throw error
  }
}

/** Writes the files; refuses if one moved since `plan` read it, and rolls back on an IO error. */
export const commit = async (
  cwd: string,
  files: ReadonlyArray<File>,
  read: (path: string) => Promise<string | null | undefined> = Changes.read,
  write: typeof put = put
): Promise<Failure | undefined> => {
  const escaped = [...new Set(files.map((file) => file.path))].filter((path) => outside(cwd, path))
  if (escaped.length > 0) return { _tag: "Outside", paths: escaped.sort() }
  const moved: Array<string> = []
  const modes = new Map<string, number | undefined>()
  for (const file of files) {
    if ((await read(resolve(cwd, file.path))) !== file.current) moved.push(file.path)
    try {
      modes.set(file.path, await modeOf(resolve(cwd, file.path)))
    } catch (error) {
      return {
        _tag: "WriteFailed",
        path: file.path,
        message: errno(error),
        restored: true
      }
    }
  }
  if (moved.length > 0) return { _tag: "Conflict", paths: moved.sort() }
  const applied: Array<File> = []
  for (const file of files) {
    try {
      await write(resolve(cwd, file.path), file.next, file.mode)
      applied.push(file)
    } catch (error) {
      let restored = true
      // The failed write may have truncated its file before throwing.
      for (const done of [file, ...applied.toReversed()]) {
        const path = resolve(cwd, done.path)
        const mode = modes.get(done.path)
        try {
          if ((await read(path)) !== done.current || (await modeOf(path)) !== mode) {
            await write(path, done.current, mode)
          }
          if ((await read(path)) !== done.current || (await modeOf(path)) !== mode) restored = false
        } catch {
          restored = false
        }
      }
      return {
        _tag: "WriteFailed",
        path: file.path,
        message: errno(error),
        restored
      }
    }
  }
  return undefined
}

/** The failed write's errno code, the one fact `message` words; the rest goes to the log. */
const errno = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === "string") return code
  Log.write("undo.write", error)
  return ""
}

const because: Readonly<Record<string, string>> = {
  EACCES: "no permission",
  EPERM: "no permission",
  ENOSPC: "disk full",
  EROFS: "read-only disk",
  ENOENT: "missing",
  EISDIR: "is a directory",
  EBUSY: "in use"
}

/** A refused row's words. */
export const words: Readonly<Record<Refusal, string>> = {
  changed: "changed since",
  outside: "outside workspace",
  unrendered: "binary or large"
}

/** Toast text. */
export const message = (failure: Failure): string => {
  switch (failure._tag) {
    case "Busy":
      return "Stop running work first"
    case "NothingToUndo":
      return "Nothing to undo"
    case "Outside":
      return `Not undone · ${words.outside}: ${failure.paths.join(", ")}`
    case "Conflict":
      return `Not undone · ${words.changed}: ${failure.paths.join(", ")}`
    case "WriteFailed":
      return `Undo failed${failure.path === "" ? "" : ` · ${failure.path}`}: ${
        because[failure.message] ?? "could not write"
      }${failure.restored ? "" : " · files partly changed"}`
  }
}

/** Toast text when every file of a plan is refused. */
export const refusal = (plan: Plan): string =>
  `Not undone · ${
    (["changed", "outside", "unrendered"] as const).flatMap((why) => {
      const paths = plan.entries.filter((entry) => entry.refused === why).map((entry) => entry.path)
      return paths.length === 0 ? [] : [`${words[why]}: ${paths.join(", ")}`]
    }).join(" · ")
  }`

/** `+1 −1`, or `new`, `deleted`. */
export const counts = (change: { readonly added: number; readonly removed: number; readonly state?: State }) =>
  change.state ??
    [change.added > 0 ? `+${change.added}` : "", change.removed > 0 ? `−${change.removed}` : ""].filter(Boolean)
      .join(" ")

/** `Undo math.js` or `Undo 2 files`. */
export const label = (files: ReadonlyArray<File>): string =>
  files.length === 1 ? `Undo ${files[0]!.path}` : `Undo ${files.length} files`

/** Success toast text. */
export const done = (files: ReadonlyArray<File>): string =>
  files.length === 1 ? `Undid ${files[0]!.path}` : `Undid ${files.length} files`
