/**
 * Undo a turn's edits: reverse the file changes captured at the flow boundary
 * (`changes.ts`), all or nothing. `target` picks the calls from a Summary row,
 * `plan` computes every file's restored content without writing, and `commit`
 * writes it, rolling back on an IO error.
 */
import { applyPatch, parsePatch, reversePatch, type StructuredPatch } from "diff"
import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { real } from "./approvals.ts"
import * as Changes from "./changes.ts"
import * as Log from "./log.ts"
import type * as Transcript from "./transcript.ts"

export type Failure =
  | { readonly _tag: "Busy" }
  | { readonly _tag: "NothingToUndo" }
  | { readonly _tag: "AlreadyUndone" }
  /** A writer call with no receipt: shell outside a repository, or a session from before capture. */
  | { readonly _tag: "Uncaptured"; readonly flows: ReadonlyArray<string> }
  /** A binary, large, or truncated change, labeled instead of diffed. */
  | { readonly _tag: "Unrendered"; readonly paths: ReadonlyArray<string> }
  /** A receipt path that reaches outside the workspace, directly or through a symlink. */
  | { readonly _tag: "Outside"; readonly paths: ReadonlyArray<string> }
  /** The files changed since the turn. */
  | { readonly _tag: "Conflict"; readonly paths: ReadonlyArray<string> }
  | { readonly _tag: "WriteFailed"; readonly path: string; readonly message: string; readonly restored: boolean }

/** The calls to reverse, newest first, and the paths they touched. */
export interface Target {
  readonly calls: ReadonlyArray<Transcript.Call>
  readonly paths: ReadonlyArray<string>
}
export interface File {
  readonly path: string
  readonly current: string | null
  readonly next: string | null
  /** Permission bits for a restored deletion, from the patch's `deleted file mode`. */
  readonly mode?: number
}
export interface Plan {
  /** Identities of the reversed calls. */
  readonly calls: ReadonlyArray<string>
  readonly files: ReadonlyArray<File>
}

/** The flows that write files in the TUI's catalog (filesystem and shell). */
export const writers: ReadonlyArray<string> = ["edit", "write", "apply_patch", "bash"]

type Cell = Extract<Transcript.Item, { kind: "cell" }>

const parsed = (patch: Changes.Patch): StructuredPatch | undefined => {
  const all = parsePatch(patch.patch)
  if (all.length !== 1) return undefined
  const one = all[0]!
  if (one.isBinary === true) return undefined
  const flagged = one.isCreate === true || one.isDelete === true || one.isRename === true ||
    one.oldFileName === "/dev/null" || one.newFileName === "/dev/null"
  return one.hunks.length === 0 && !flagged ? undefined : one
}
const name = (value: string | undefined): string | undefined =>
  value === undefined || value === "/dev/null" ? undefined : value.replace(/^[ab]\//, "")
const sides = (patch: Changes.Patch, structured: StructuredPatch) => {
  const before = structured.isCreate === true || structured.oldFileName === "/dev/null"
    ? undefined
    : name(structured.oldFileName) ?? patch.path
  const after = structured.isDelete === true || structured.newFileName === "/dev/null"
    ? undefined
    : name(structured.newFileName) ?? patch.path
  return { before, after }
}

/** The calls a Summary row stands for: a cell, or a prompt's whole turn. Pure, for the keypress. */
export const target = (transcript: Transcript.Transcript, rowId: string): Target | Failure => {
  const at = transcript.items.findIndex((item) => item.id === rowId)
  const row = transcript.items[at]
  let cells: Array<Cell> = []
  if (row?.kind === "cell") cells = [row]
  else if (row?.kind === "user" && row.queued === undefined) {
    for (const item of transcript.items.slice(at + 1)) {
      if (item.kind === "user" && item.queued === undefined) break
      if (item.kind === "cell") cells.push(item)
    }
  } else return { _tag: "NothingToUndo" }
  const all = cells.toReversed().flatMap((cell) => cell.calls.toReversed())
  // A shell diff is repository-wide, so a nonempty receipt may include edits
  // from other workers. An empty receipt made no edits and can coexist with a
  // named-file call in the same turn.
  const uncaptured = [
    ...new Set(
      all.filter((call) =>
        writers.includes(call.flow) && call.denied !== true &&
        (call.patches === undefined || (call.flow === "bash" && call.patches.length > 0))
      ).map((call) => call.flow)
    )
  ]
  if (uncaptured.length > 0) return { _tag: "Uncaptured", flows: uncaptured }
  const patched = all.filter((call) => (call.patches?.length ?? 0) > 0)
  if (patched.length === 0) return { _tag: "NothingToUndo" }
  const calls = patched.filter((call) => call.undone !== true)
  if (calls.length === 0) return { _tag: "AlreadyUndone" }
  const unrendered = [
    ...new Set(
      calls.flatMap((call) => call.patches!.filter((patch) => parsed(patch) === undefined).map((patch) => patch.path))
    )
  ]
  if (unrendered.length > 0) return { _tag: "Unrendered", paths: unrendered }
  const paths = new Set<string>()
  for (const call of calls) {
    for (const patch of call.patches!) {
      const { before, after } = sides(patch, parsed(patch)!)
      paths.add(after ?? before ?? patch.path)
      if (before !== undefined) paths.add(before)
    }
  }
  return { calls, paths: [...paths] }
}

/**
 * The newest prompt's changes that can still be undone, for Ctrl+K where no
 * row is selected. A prompt with nothing, or nothing left, to undo is passed
 * over; any other refusal is the answer.
 */
export const latest = (transcript: Transcript.Transcript): Target | Failure => {
  let passed: Failure = { _tag: "NothingToUndo" }
  for (const item of transcript.items.toReversed()) {
    if (item.kind !== "user" || item.queued !== undefined) continue
    const found = target(transcript, item.id)
    if (!("_tag" in found)) return found
    if (found._tag !== "NothingToUndo" && found._tag !== "AlreadyUndone") return found
    if (found._tag === "AlreadyUndone") passed = found
  }
  return passed
}

/**
 * Receipts come from a session file, so their paths are data: undo writes only
 * where a path lands inside the workspace after following every symlink.
 */
const outside = (cwd: string, paths: ReadonlyArray<string>): Failure | undefined => {
  const root = real(resolve(cwd))
  const escaped = [...new Set(paths)].filter((path) => {
    const inside = relative(root, real(resolve(cwd, path)))
    return inside === "" || inside === ".." || inside.startsWith("../") || isAbsolute(inside)
  })
  return escaped.length === 0 ? undefined : { _tag: "Outside", paths: escaped.sort() }
}

/** Every file's restored content, reading only. Collects every conflicting path. */
export const plan = async (
  cwd: string,
  target: Target,
  read: (path: string) => Promise<string | null | undefined> = Changes.read
): Promise<Plan | Failure> => {
  // A shell diff is repository-wide and may hold other workers' edits; `target` never picks one, and neither does a plan.
  if (target.calls.some((call) => call.flow === "bash")) return { _tag: "Uncaptured", flows: ["bash"] }
  const escaped = outside(
    cwd,
    target.calls.flatMap((call) =>
      call.patches!.flatMap((patch) => {
        const structured = parsed(patch)
        if (structured === undefined) return [patch.path]
        const { before, after } = sides(patch, structured)
        return [before, after].filter((path): path is string => path !== undefined)
      })
    )
  )
  if (escaped !== undefined) return escaped
  const seeded = new Map<string, string | null | undefined>()
  const state = new Map<string, string | null | undefined>()
  const poisoned = new Set<string>()
  const modes = new Map<string, number>()
  const now = async (path: string) => {
    if (!state.has(path)) {
      const value = await read(resolve(cwd, path))
      seeded.set(path, value)
      state.set(path, value)
    }
    return state.get(path)
  }
  for (const call of target.calls) {
    for (const patch of call.patches!) {
      const structured = parsed(patch)!
      const { before, after } = sides(patch, structured)
      const path = after ?? before!
      const content = await now(path)
      if (poisoned.has(path)) continue
      const fits = after === undefined ? content === null : typeof content === "string"
      const restored = !fits
        ? false
        : structured.hunks.length === 0
        ? content ?? ""
        : applyPatch(content ?? "", reversePatch(structured))
      if (restored === false || (before === undefined && restored !== "")) {
        poisoned.add(path)
        continue
      }
      if (after === undefined && structured.oldMode !== undefined) {
        modes.set(path, parseInt(structured.oldMode, 8) & 0o777)
      }
      if (before === undefined) state.set(path, null)
      else if (before !== path) {
        if ((await now(before)) !== null) {
          poisoned.add(before)
          continue
        }
        state.set(before, restored)
        state.set(path, null)
      } else state.set(path, restored)
    }
  }
  if (poisoned.size > 0) return { _tag: "Conflict", paths: [...poisoned].sort() }
  const files: Array<File> = []
  for (const [path, next] of state) {
    const current = seeded.get(path)
    const mode = next === null ? undefined : modes.get(path)
    if (current !== undefined && next !== undefined && current !== next) {
      files.push({ path, current, next, ...(mode === undefined ? {} : { mode }) })
    }
  }
  // Every call nets to no change on disk: a→b then b→a.
  if (files.length === 0) return { _tag: "NothingToUndo" }
  return { calls: target.calls.flatMap((call) => (call.identity === undefined ? [] : [call.identity])), files }
}

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

/** Writes the plan; refuses if a file moved since `plan` read it, and rolls back on an IO error. */
export const commit = async (
  cwd: string,
  plan: Plan,
  read: (path: string) => Promise<string | null | undefined> = Changes.read,
  write: typeof put = put
): Promise<Failure | undefined> => {
  const escaped = outside(cwd, plan.files.map((file) => file.path))
  if (escaped !== undefined) return escaped
  const moved: Array<string> = []
  const modes = new Map<string, number | undefined>()
  for (const file of plan.files) {
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
  for (const file of plan.files) {
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

/** Toast text. */
export const message = (failure: Failure): string => {
  switch (failure._tag) {
    case "Busy":
      return "Stop running work first"
    case "NothingToUndo":
      return "Nothing to undo"
    case "AlreadyUndone":
      return "Already undone"
    case "Uncaptured":
      return `Not undone · uncaptured: ${failure.flows.join(", ")}`
    case "Unrendered":
      return `Not undone · binary or large: ${failure.paths.join(", ")}`
    case "Outside":
      return `Not undone · outside workspace: ${failure.paths.join(", ")}`
    case "Conflict":
      return `Not undone · changed since: ${failure.paths.join(", ")}`
    case "WriteFailed":
      return `Undo failed${failure.path === "" ? "" : ` · ${failure.path}`}: ${
        because[failure.message] ?? "could not write"
      }${failure.restored ? "" : " · files partly changed"}`
  }
}

/** Success toast text. */
export const done = (plan: Plan): string =>
  plan.files.length === 1 ? `Undid ${plan.files[0]!.path}` : `Undid ${plan.files.length} files`
