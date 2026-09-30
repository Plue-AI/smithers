import * as Log from "./log.ts"
/** Capture actual before/after file contents at the executable flow boundary. */
import type * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Bash from "@smthrs/std/Bash"
import { createTwoFilesPatch, parsePatch, type StructuredPatch } from "diff"
import { Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, realpathSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import * as Subprocess from "./subprocess.ts"

export interface Patch {
  readonly path: string
  readonly patch: string
}
export interface Receipt {
  readonly call: string
  readonly patches: ReadonlyArray<Patch>
}
export const identity = (call: Cell.CallIdentity): string =>
  JSON.stringify([call.session, call.frame, call.cell, call.ordinal, call.declaration, call.layers])
const maxBytes = 512_000
/** A text file's content; `null` when absent, `undefined` when unreadable, binary or large. */
export const read = async (path: string): Promise<string | null | undefined> => {
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > maxBytes) return undefined
      const bytes = await file.readFile()
      if (bytes.includes(0)) return undefined
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } finally {
      await file.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined
  }
}
/** A file's permission bits; `undefined` when absent or unreadable. */
export const mode = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return undefined
  }
}
interface FileState {
  readonly digest: string | null | undefined
  readonly text: string | null | undefined
  readonly mode: number | undefined
}
/** Read a candidate before or after the call; a digest covers binary and large files too. */
const fileState = async (path: string): Promise<FileState> => {
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile()) return { digest: undefined, text: undefined, mode: undefined }
      const hash = createHash("sha256")
      let text: string | null | undefined
      if (info.size <= maxBytes) {
        const bytes = await file.readFile()
        hash.update(bytes)
        try {
          text = bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {
          text = undefined
        }
      } else {
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
      }
      return { digest: hash.digest("hex"), text, mode: info.mode & 0o777 }
    } finally {
      await file.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR"
      ? { digest: null, text: null, mode: undefined }
      : { digest: undefined, text: undefined, mode: undefined }
  }
}
/**
 * The most line edits a patch diffs; more is labeled too large. It bounds the
 * work instead of a wall-clock timeout, which fired whenever the process was
 * descheduled and so labeled one-line edits too large under CPU load. Giving
 * up on two unrelated 20,000-line files at 1,000 edits takes about 100 ms.
 */
const maxEditLength = 1_000
/**
 * `null` is an absent file: its side of the patch is `/dev/null`, so creation and deletion reverse.
 * A deletion carries the file's `mode` as git's `deleted file mode` header, so undo restores it.
 */
export const patch = (
  path: string,
  before: string | null,
  after: string | null,
  deletedMode?: number
): Patch | undefined => {
  if (before === after) return undefined
  const body = createTwoFilesPatch(
    before === null ? "/dev/null" : `a/${path}`,
    after === null ? "/dev/null" : `b/${path}`,
    before ?? "",
    after ?? "",
    "",
    "",
    { context: 3, maxEditLength }
  )
  if (body === undefined) return { path, patch: `Diff too large: ${path}` }
  return after !== null || deletedMode === undefined
    ? { path, patch: body }
    : {
      path,
      patch: `diff --git a/${path} b/${path}\ndeleted file mode ${(0o100000 | deletedMode).toString(8)}\n${
        body.replace(/^=+\n/, "")
      }`
    }
}
/**
 * The files a write flow's input names; `undefined` when it names them in a
 * form this reads no further, such as a patch `apply_patch` would refuse.
 */
export const touched = (flow: string, input: unknown): Array<string> | undefined => {
  if (input === null || typeof input !== "object") return []
  const value = input as Record<string, unknown>
  if ((flow === "edit" || flow === "write") && typeof value.path === "string") return [value.path]
  if (flow === "apply_patch" && typeof value.input === "string") {
    const named = ApplyPatch.paths(value.input)
    return named === undefined ? undefined : [...named]
  }
  return []
}
export const paths = (flow: string, input: unknown): Array<string> => touched(flow, input) ?? []
const command = async (
  program: string,
  cwd: string,
  args: Array<string>,
  env: Record<string, string> = {}
): Promise<string | undefined> => {
  try {
    const child = Subprocess.spawn([program, ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }
    })
    const timer = setTimeout(() => child.kill(), 5000)
    try {
      const decoder = new TextDecoder()
      let output = ""
      const reader = child.stdout.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
        if (output.length > 4_000_000) {
          child.kill()
          return undefined
        }
      }
      output += decoder.decode()
      return await child.exited === 0 ? output : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    Log.write("changes.command", error)
    return undefined
  }
}
const git = (cwd: string, args: Array<string>, env?: Record<string, string>) => command("git", cwd, args, env)
/** A receipt's one-file patch, parsed; undefined for a binary, large or truncated change, which is labeled, not diffed. */
export const structured = (patch: Patch): StructuredPatch | undefined => {
  const all = parsePatch(patch.patch)
  if (all.length !== 1) return undefined
  const one = all[0]!
  if (one.isBinary === true) return undefined
  const flagged = one.isCreate === true || one.isDelete === true || one.isRename === true ||
    one.oldFileName === "/dev/null" || one.newFileName === "/dev/null"
  return one.hunks.length === 0 && !flagged ? undefined : one
}
const side = (value: string | undefined): string | undefined =>
  value === undefined || value === "/dev/null" ? undefined : value.replace(/^[ab]\//, "")
/** The path a patch reads before and writes after; `undefined` for a created or deleted side. */
export const sides = (
  patch: Patch,
  parsed: StructuredPatch
): { readonly before: string | undefined; readonly after: string | undefined } => ({
  before: parsed.isCreate === true || parsed.oldFileName === "/dev/null"
    ? undefined
    : side(parsed.oldFileName) ?? patch.path,
  after: parsed.isDelete === true || parsed.newFileName === "/dev/null"
    ? undefined
    : side(parsed.newFileName) ?? patch.path
})
/** Every path a patch touches: both sides of a move, else its own. */
export const ends = (patch: Patch): ReadonlyArray<string> => {
  const parsed = structured(patch)
  if (parsed === undefined) return [patch.path]
  const { before, after } = sides(patch, parsed)
  const both = [...new Set([after, before].filter((path): path is string => path !== undefined))]
  return both.length === 0 ? [patch.path] : both
}
export const splitPatch = (diff: string): Array<Patch> =>
  diff.split(/(?=^diff --git )/m).filter((part) => part.trim() !== "").map((patch) => {
    const added = patch.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1]
    const removed = patch.match(/^--- (?:a\/)?(.+)$/m)?.[1]
    const path = (added === "/dev/null" ? removed : added) ?? removed ??
      patch.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1] ?? "Changes"
    return { path: path.replace(/\t.*$/, ""), patch }
  })

const changedPatch = (path: string, old: FileState, next: FileState): Patch | undefined => {
  if (
    old.digest === undefined || next.digest === undefined ||
    (old.digest === next.digest && old.mode === next.mode)
  ) return undefined
  if (old.text === undefined || next.text === undefined) return { path, patch: `Binary or large file: ${path}` }
  const diff = patch(path, old.text, next.text, next.text !== null ? undefined : old.mode)
  if (diff !== undefined) return diff
  return {
    path,
    patch: `diff --git a/${path} b/${path}\nold mode ${(0o100000 | (old.mode ?? 0)).toString(8)}\nnew mode ${
      (0o100000 | (next.mode ?? 0)).toString(8)
    }\n`
  }
}

/**
 * Candidate files in the working tree, including untracked paths, without
 * staging or consulting HEAD. Ignored files are not candidates for receipts.
 */
const gitPaths = async (cwd: string): Promise<Array<string> | undefined> => {
  const output = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."])
  return output === undefined ? undefined : [...new Set(output.split("\0").filter(Boolean))]
}
const states = async (cwd: string, paths: ReadonlyArray<string>): Promise<Map<string, FileState>> => {
  const found = new Map<string, FileState>()
  for (let at = 0; at < paths.length; at += 64) {
    const batch = await Promise.all(
      paths.slice(at, at + 64).map(async (path) => [path, await fileState(resolve(cwd, path))] as const)
    )
    for (const [path, state] of batch) found.set(path, state)
  }
  return found
}

interface FileStat {
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
  readonly ino: bigint
  readonly mode: bigint
}
const fileStat = async (path: string): Promise<FileStat | null | undefined> => {
  try {
    const info = await stat(path, { bigint: true })
    return { size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, ino: info.ino, mode: info.mode }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined
  }
}
const stats = async (cwd: string, paths: ReadonlyArray<string>): Promise<Map<string, FileStat | null | undefined>> => {
  const found = new Map<string, FileStat | null | undefined>()
  for (let at = 0; at < paths.length; at += 64) {
    const batch = await Promise.all(
      paths.slice(at, at + 64).map(async (path) => [path, await fileStat(resolve(cwd, path))] as const)
    )
    for (const [path, info] of batch) found.set(path, info)
  }
  return found
}
const sameStat = (a: FileStat | null | undefined, b: FileStat | null | undefined): boolean =>
  a === null && b === null || a !== null && b !== null && a !== undefined && b !== undefined &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino && a.mode === b.mode

/** Paths with pre-call bytes that differ from the index, including untracked files. */
const dirtyPaths = async (cwd: string): Promise<Array<string> | undefined> => {
  const output = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
  if (output === undefined) return undefined
  const entries = output.split("\0").filter(Boolean)
  const paths: Array<string> = []
  for (let at = 0; at < entries.length; at++) {
    const entry = entries[at]!
    paths.push(entry.slice(3))
    if (entry[0] === "R" || entry[1] === "R" || entry[0] === "C" || entry[1] === "C") at++
  }
  return paths
}

const indexBlobs = async (cwd: string): Promise<Map<string, string> | undefined> => {
  const output = await git(cwd, ["ls-files", "--stage", "-z", "--", "."])
  if (output === undefined) return undefined
  const blobs = new Map<string, string>()
  for (const entry of output.split("\0").filter(Boolean)) {
    const match = entry.match(/^\d+ ([a-f0-9]+) 0\t(.+)$/s)
    if (match !== null) blobs.set(match[2]!, match[1]!)
  }
  return blobs
}

/** Recover a clean tracked file's pre-call bytes from the index only when its stat changed. */
const indexState = async (cwd: string, blob: string, before: FileStat): Promise<FileState> => {
  if (before.size > BigInt(maxBytes)) {
    return { digest: `index:${blob}`, text: undefined, mode: Number(before.mode & 0o777n) }
  }
  const bytes = await new Promise<Buffer | undefined>((done) =>
    execFile(
      "git",
      ["cat-file", "blob", blob],
      { cwd, encoding: "buffer", maxBuffer: maxBytes + 1 },
      (error, output) => done(error ? undefined : Buffer.isBuffer(output) ? output : Buffer.from(output))
    )
  )
  if (bytes === undefined) return { digest: undefined, text: undefined, mode: Number(before.mode & 0o777n) }
  let text: string | undefined
  try {
    text = bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    text = undefined
  }
  return { digest: createHash("sha256").update(bytes).digest("hex"), text, mode: Number(before.mode & 0o777n) }
}

/**
 * Shell calls in flight, each collecting the files named writers touch
 * meanwhile, in any worker of this process. Those files are the writers'
 * receipts, so a shell receipt leaves them out.
 */
const shells = new Set<Set<string>>()
const claim = (cwd: string, files: ReadonlyArray<string>): void => {
  for (const claimed of shells) for (const file of files) claimed.add(resolve(cwd, file))
}

/** A bash call's changes against pre-call files, relative to `cwd`; no receipt outside a repository. */
const shell = (binding: FlowBinding.Binding, call: Cell.Call, cwd: string, onPatch: (receipt: Receipt) => void) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const claimed = new Set<string>()
      shells.add(claimed)
      return claimed
    }),
    (claimed) =>
      observed(binding, call, cwd, (receipt) =>
        onPatch({
          ...receipt,
          patches: receipt.patches.filter((patch) => !claimed.has(resolve(cwd, patch.path)))
        })),
    (claimed) => Effect.sync(() => shells.delete(claimed))
  )

const observed = (binding: FlowBinding.Binding, call: Cell.Call, cwd: string, onPatch: (receipt: Receipt) => void) =>
  Effect.gen(function*() {
    const jj = Subprocess.which("jj", process.env) !== null
      ? (yield* Effect.promise(() => command("jj", cwd, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])))?.trim()
      : undefined
    if (jj) {
      const result = yield* binding.run(call)
      const diff = yield* Effect.promise(() => command("jj", cwd, ["diff", "--from", jj, "--git", "--color=never"]))
      if (diff !== undefined) {
        yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches: splitPatch(diff) }))
      }
      return result
    }
    const candidates = yield* Effect.promise(() => gitPaths(cwd))
    if (candidates === undefined) return yield* binding.run(call)
    const dirty = yield* Effect.promise(() => dirtyPaths(cwd))
    const blobs = yield* Effect.promise(() => indexBlobs(cwd))
    const beforeStats = yield* Effect.promise(() => stats(cwd, candidates))
    const before = yield* Effect.promise(() => states(cwd, dirty ?? candidates))
    const result = yield* binding.run(call)
    const afterPaths = yield* Effect.promise(() => gitPaths(cwd))
    if (afterPaths === undefined) return result
    const allPaths = [...new Set([...candidates, ...afterPaths])]
    const afterStats = yield* Effect.promise(() => stats(cwd, allPaths))
    const patches: Array<Patch> = []
    let verified = true
    for (const path of allPaths) {
      const pre = beforeStats.has(path) ? beforeStats.get(path) : null
      const post = afterStats.get(path)
      if (pre === undefined || post === undefined) verified = false
      if (sameStat(pre, post)) continue
      const old = before.get(path) ?? (pre === null
        ? { digest: null, text: null, mode: undefined }
        : pre === undefined || blobs?.get(path) === undefined
        ? { digest: undefined, text: undefined, mode: undefined }
        : yield* Effect.promise(() => indexState(cwd, blobs.get(path)!, pre)))
      const next = yield* Effect.promise(() => fileState(resolve(cwd, path)))
      const diff = changedPatch(path, old, next)
      if (old.digest === undefined || next.digest === undefined) verified = false
      if (diff !== undefined) patches.push(diff)
    }
    if (verified) yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches }))
    return result
  })

/**
 * A named file as a shell receipt names it: relative to the workspace, else
 * absolute. `./a.ts`, `/repo/a.ts` and `a.ts` are then one file of a run.
 */
const within = (cwd: string, path: string): string => {
  const full = resolve(cwd, path)
  const roots = [resolve(cwd)]
  try {
    roots.push(realpathSync(cwd))
  } catch {
    // An unreadable workspace keeps its spelled root.
  }
  for (const root of roots) {
    const inside = relative(root, full)
    if (inside !== "" && inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside)) return inside
  }
  return full
}

/** A write flow's changes: the files its input names, read before and after. */
const named = (binding: FlowBinding.Binding, call: Cell.Call, cwd: string, onPatch: (receipt: Receipt) => void) =>
  Effect.gen(function*() {
    const files = [...new Set(paths(call.flowName, call.input).map((path) => within(cwd, path)))]
    yield* Effect.sync(() => claim(cwd, files))
    const before = yield* Effect.promise(() => states(cwd, files))
    // Claimed again once it ends: a shell that started meanwhile saw no claim at the start.
    const result = yield* binding.run(call).pipe(Effect.ensuring(Effect.sync(() => claim(cwd, files))))
    const patches: Array<Patch> = []
    let additional = 0
    for (const path of files) {
      const old = before.get(path)
      const next = yield* Effect.promise(() => fileState(resolve(cwd, path)))
      const diff = changedPatch(path, old ?? { digest: null, text: null, mode: undefined }, next)
      if (diff === undefined) continue
      if (patches.length >= 200) {
        additional++
        continue
      }
      patches.push(diff)
    }
    if (additional > 0) {
      patches.push({
        path: "More changes",
        patch: `${additional} additional files; diff capture limited to 200 files.`
      })
    }
    // Empty is meaningful: a rejected/no-op write must not show a proposed edit as real.
    if (patches.length > 0) yield* Effect.sync(() => onPatch({ call: identity(call.identity), patches }))
    return result
  })

/** Wrap the existing bindings, without introducing another tool or execution model. */
export const capture = (
  source: FlowBinding.Source,
  cwd: string,
  onPatch: (receipt: Receipt) => void
): FlowBinding.Source => ({
  ...source,
  bindings: () =>
    source.bindings().pipe(Effect.map((bindings) =>
      bindings.map((binding) => ({
        ...binding,
        run: (call: Cell.Call) =>
          call.flowName === "bash" && Schema.decodeUnknownResult(Bash.Input)(call.input)._tag === "Success"
            ? shell(binding, call, cwd, onPatch)
            : named(binding, call, cwd, onPatch)
      }))
    ))
})
