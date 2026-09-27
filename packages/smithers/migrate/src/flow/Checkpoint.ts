/**
 * The checkpoint a unit can be restored to.
 *
 * A migration edits a working copy that already holds work nobody asked this
 * tool to touch, so the checkpoint has two halves and both matter:
 *
 * - A VCS-native handle, recorded in the report so a person can go back with
 *   the tool they already use. On jj it is the change id the working copy sat
 *   on, taken before `jj new` opens a fresh change for the migration, so the
 *   operator's own edits stay in their own change. On git it is
 *   `refs/smithers-migrate/<unit>/<timestamp>`, pointing at the commit
 *   `git stash create` built — a ref, not a stash entry, so the working tree
 *   is never touched and `git stash list` is never disturbed.
 * - A byte-exact copy of the unit's file set under
 *   `<reportDir>/backup/<unit>/`. That is what {@link restore} and
 *   {@link diff} read, because it is the one record that is exact whether or
 *   not a file was tracked, staged, or ignored.
 *
 * A project under no version control refuses, because a migration with no way
 * back is not a migration. `allowNoVcs` accepts the copy alone as the way
 * back.
 *
 * @since 1.0.0-rc.0
 */

import { Action } from "@smthrs/flow"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import * as Fs from "../internal/Fs.ts"
import { io, make, MigrateError } from "../MigrateError.ts"
import type * as Report from "../Report.ts"
import * as Exec from "./internal/Exec.ts"
import * as Pending from "./internal/Pending.ts"
import * as VcsInternal from "./internal/Vcs.ts"

/**
 * Which version control the project is under.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Vcs = Schema.Literals(["jj", "git", "none"])

/**
 * Which version control the project is under.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Vcs = typeof Vcs.Type

/**
 * A recorded checkpoint: the VCS handle, the command that undoes the unit by
 * hand, and the backup directory holding the unit's files as they were.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Ref = Schema.Struct({
  vcs: Vcs,
  ref: Schema.String,
  restore: Schema.String,
  backup: Schema.String,
  files: Schema.Array(Schema.String),
  /**
   * The checkpoint-time state of every declared source and target path.
   *
   * Restore decisions come only from this manifest. A later failed read is an
   * I/O failure, never evidence that the original path was absent.
   */
  entries: Schema.Array(Schema.Struct({
    path: Schema.String,
    state: Schema.Literals(["absent", "file"]),
    digest: Schema.optional(Schema.String),
    /**
     * The file's permission bits (`stat.mode & 0o777`) at the checkpoint, so
     * a restore puts back an executable or a read-only file rather than the
     * default mode `writeFile` gives everything. Absent in checkpoints taken
     * before this field existed; those restore the way they always did.
     */
    mode: Schema.optional(Schema.Number)
  })),
  /**
   * A digest of every file under the project's 0.x run-state paths, taken
   * before the unit runs.
   *
   * A checkpoint records two things, and they are not the same thing: what it
   * can put back, and what must not change at all. The second belongs here
   * rather than in a step of its own, because a plan orders what depends on
   * something — a separate digest step nothing downstream consumed would be
   * free to run after the rewrite it was supposed to precede.
   */
  digests: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String })),
  /**
   * When this checkpoint was taken, in epoch milliseconds read from the `Clock`
   * service. It is what a unit's duration is measured from, so the number a
   * report shows is that unit's own time rather than the run's.
   */
  takenAt: Schema.Number,
  /**
   * The absolute path of the whole-tree digest manifest {@link tree} wrote.
   *
   * The path rather than the digests themselves: a project has thousands of
   * files and every one of them would otherwise cross the journal, once per
   * unit. It lives beside the unit's backup, under the report directory the
   * operator is told to commit, so it is as durable as the backup is.
   */
  tree: Schema.String
})

/**
 * A recorded checkpoint.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Ref = typeof Ref.Type

/** The recovery record written before a unit is allowed to transform files. */
interface Pending {
  readonly status: "pending"
  readonly unit: string
  readonly root: string
  readonly checkpoint: {
    readonly vcs: Vcs
    readonly ref: string
    readonly restore: string
    readonly backup: string
  }
  readonly takenAt: number
  readonly instruction: string
  readonly rollback?: Rollback | undefined
}

/**
 * The checkpoint step: record where the unit started before anything edits it.
 *
 * `irreversible` because it opens a jj change and writes a git ref. Neither is
 * content-shared across executions, and neither may be replayed from another
 * run's recorded result.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const action = Action.make("smithers/migrate-v1/Checkpoint", {
  payload: {
    root: Schema.String,
    unit: Schema.String,
    files: Schema.Array(Schema.String),
    backupDir: Schema.String,
    allowNoVcs: Schema.Boolean,
    /** Directories holding 0.x run state, digested as they are. Project-relative, or absolute for gateway state outside the project. */
    runStateRoots: Schema.optional(Schema.Array(Schema.String)),
    /**
     * Project-relative paths the whole-tree manifest leaves out: the report
     * directory, the 1.0 runtime state directory, and the run-state roots,
     * which have their own check.
     */
    treeExclude: Schema.optional(Schema.Array(Schema.String))
  },
  success: Ref,
  error: MigrateError,
  tier: "irreversible"
})

const optionalNotFound = Fs.optionalNotFound

/**
 * Which version control a project root is under, preferring jj when a checkout
 * is colocated.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const detectVcs: typeof VcsInternal.detect = VcsInternal.detect

const absolute = (path: Path.Path, root: string, file: string): string => path.join(root, ...file.split("/"))

/**
 * Fails when a project path, or any directory on the way to it, is a symbolic
 * link. Reading through one copies bytes from wherever it points into the
 * backup; writing or removing through one changes a file outside the project.
 */
const refuseLink = (
  root: string,
  file: string,
  doing: string
): Effect.Effect<void, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const link = yield* Fs.linkOnPath(root, file)
    if (link === undefined) return
    return yield* Effect.fail(
      make(
        "checkpoint-failed",
        link === file
          ? `declared migration path "${file}" is a symbolic link; the tool will not ${doing} through it`
          : `declared migration path "${file}" is reached through the symbolic link "${link}"; the tool will not ${doing} through it`
      )
    )
  })

const pendingFile = (path: Path.Path, backupDir: string): string =>
  path.join(path.dirname(backupDir), "pending-unit.json")

const pending = (
  payload: { readonly root: string; readonly unit: string; readonly backupDir: string },
  ref: Ref
): Effect.Effect<Ref, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = pendingFile(path, payload.backupDir)
    const record: Pending = {
      status: "pending",
      unit: payload.unit,
      root: payload.root,
      checkpoint: { vcs: ref.vcs, ref: ref.ref, restore: ref.restore, backup: ref.backup },
      takenAt: ref.takenAt,
      instruction: `This unit may have stopped after editing the project. From "${payload.root}", run: ${ref.restore}`
    }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.mapError(io(`could not create ${path.dirname(file)}`))
    )
    // Atomically: this file is the crash-recovery record, so a crash halfway
    // through writing it must not leave one that cannot be read back.
    yield* Fs.writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`).pipe(
      Effect.mapError(io(`could not record the pending checkpoint ${file}`))
    )
    return ref
  })

/**
 * One explicit checkpoint-time path state: what the path was when the
 * checkpoint was taken, so a restore never has to infer it later.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Entry {
  readonly path: string
  readonly state: "absent" | "file"
  readonly digest?: string | undefined
  /** The permission bits the path carried at the checkpoint, when recorded. */
  readonly mode?: number | undefined
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const verifiedBytes = (
  fs: FileSystem.FileSystem,
  file: string,
  expected: string,
  description: string
): Effect.Effect<Uint8Array, MigrateError> =>
  fs.readFile(file).pipe(
    Effect.mapError(io(`could not read ${description}`)),
    Effect.flatMap((bytes) =>
      sha256(bytes) === expected
        ? Effect.succeed(bytes)
        : Effect.fail(make("checkpoint-failed", `${description} no longer matches its checkpoint digest`))
    )
  )

/** Prepare each destination component without following links, including dangling links. */
const privateDirectory = (
  root: string,
  directory: string
): Effect.Effect<string, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const relative = path.relative(path.resolve(root), path.resolve(directory))
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* Effect.fail(make("checkpoint-failed", `backup directory must be inside the project: ${directory}`))
    }
    // Resolve the trusted root once: /tmp itself is a symlink on macOS.
    const realRoot = yield* fs.realPath(root).pipe(Effect.mapError(io(`could not resolve ${root}`)))
    return yield* Effect.tryPromise({
      try: async () => {
        let current = realRoot
        for (const component of relative.split(path.sep)) {
          current = path.join(current, component)
          const info = await lstat(current).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return undefined
            throw cause
          })
          if (info === undefined) await mkdir(current, { mode: 0o700 })
          else if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error(`backup component is not a real directory: ${current}`)
          }
          // FileSystem.open has no numeric flags. Use a no-follow directory
          // handle so tightening an existing report directory cannot chmod a link target.
          const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try {
            await handle.chmod(0o700)
          } finally {
            await handle.close()
          }
        }
        return current
      },
      catch: io(`could not prepare private backup directory ${directory}`)
    })
  })

let backupCounter = 0

/** Write through an exclusive private file; replacing a completed checkpoint never follows its old inode. */
const writeBackup = (
  root: string,
  directory: string,
  file: string,
  bytes: Uint8Array
): Effect.Effect<void, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    if (path.isAbsolute(file) || file.split(/[\\/]/).some((part) => part === ".." || part === "" || part === ".")) {
      return yield* Effect.fail(make("checkpoint-failed", `invalid backup path: ${file}`))
    }
    const target = path.join(directory, ...file.split("/"))
    const parent = yield* privateDirectory(root, path.dirname(target))
    yield* Effect.tryPromise({
      try: async () => {
        const destination = path.join(parent, path.basename(target))
        const existing = await lstat(destination).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return undefined
          throw cause
        })
        if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
          throw new Error(`backup destination is not a regular file: ${destination}`)
        }
        const temporary = path.join(parent, `.${path.basename(target)}.tmp-${process.pid}-${backupCounter++}`)
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        )
        try {
          await handle.writeFile(bytes)
          await rename(temporary, destination)
        } finally {
          await handle.close()
          await rm(temporary, { force: true })
        }
      },
      catch: io(`could not back up ${file}`)
    })
  })

/** Copies every existing declared path into the backup directory, byte for byte. */
const backup = (
  root: string,
  files: ReadonlyArray<string>,
  directory: string
): Effect.Effect<ReadonlyArray<Entry>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entries: Array<Entry> = []
    yield* privateDirectory(root, directory)
    for (const file of [...new Set(files)].sort()) {
      const source = absolute(path, root, file)
      yield* refuseLink(root, file, "copy it")
      const info = yield* optionalNotFound(fs.stat(source)).pipe(
        Effect.mapError(io(`could not inspect ${file} while taking its checkpoint`))
      )
      if (Option.isNone(info)) {
        entries.push({ path: file, state: "absent" })
        continue
      }
      if (info.value.type !== "File") {
        return yield* Effect.fail(
          make("checkpoint-failed", `declared migration path "${file}" is ${info.value.type}, not a regular file`)
        )
      }
      const bytes = yield* fs.readFile(source).pipe(
        Effect.mapError(io(`could not read ${file} while taking its checkpoint`))
      )
      const digest = sha256(bytes)
      const target = path.join(directory, ...file.split("/"))
      yield* writeBackup(root, directory, file, bytes)
      yield* verifiedBytes(fs, target, digest, `the backup of ${file}`)
      entries.push({ path: file, state: "file", digest, mode: info.value.mode & 0o777 })
    }
    return entries
  })

/**
 * Digests every file under the given roots.
 *
 * Most roots are project-relative. A gateway state directory is outside the
 * project and arrives absolute; it is digested where it is, keyed by its
 * absolute path, rather than joined under the root onto a path that holds
 * nothing — which is what used to make the byte-identity check cover a
 * nonexistent file while the real one went unwatched.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const digest = (
  root: string,
  roots: ReadonlyArray<string>
): Effect.Effect<
  ReadonlyArray<{ readonly path: string; readonly digest: string }>,
  MigrateError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: Array<{ path: string; digest: string }> = []
    // Directories already descended into, by real path. A run-state directory
    // reached through a symlink cycle would otherwise be walked forever, and
    // reached twice by two names it would be digested twice.
    const walked = new Set<string>()
    // Absolute roots are taken as they are; relative ones join under the
    // project. A child of either keeps its parent's form, because the walk
    // only ever appends a name.
    const target = (relative: string): string =>
      path.isAbsolute(relative) ? relative : path.join(root, ...relative.split("/"))
    const walk = (relative: string, rootEntry: boolean): Effect.Effect<void, MigrateError, never> =>
      Effect.gen(function*() {
        // A link is recorded by what it names and never followed, so a
        // run-state entry that points outside the tree is neither read nor
        // walked, and retargeting it still changes the digest.
        const link = yield* Fs.linkTarget(target(relative)).pipe(Effect.provideService(FileSystem.FileSystem, fs))
        if (link !== undefined) {
          found.push({ path: relative, digest: sha256(Fs.linkRecord(link)) })
          return
        }
        const info = yield* optionalNotFound(fs.stat(target(relative))).pipe(
          Effect.mapError(io(`could not inspect the run-state path "${relative}"`))
        )
        if (Option.isNone(info)) {
          if (rootEntry) return
          return yield* Effect.fail(make("io", `run-state path "${relative}" disappeared during checkpointing`))
        }
        if (info.value.type === "Directory") {
          const real = yield* fs.realPath(target(relative)).pipe(
            Effect.mapError(io(`could not resolve the run-state path "${relative}"`))
          )
          if (walked.has(real)) return
          walked.add(real)
          const entries = yield* fs.readDirectory(target(relative)).pipe(
            Effect.mapError(io(`could not list the run-state path "${relative}"`))
          )
          for (const entry of [...entries].sort()) yield* walk(`${relative}/${entry}`, false)
          return
        }
        const bytes = yield* fs.readFile(target(relative)).pipe(
          Effect.mapError(io(`could not read the run-state path "${relative}"`))
        )
        found.push({ path: relative, digest: sha256(bytes) })
      })
    for (const relative of [...roots].sort()) yield* walk(relative, true)
    return found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  }).pipe(Effect.mapError(io(`could not read the run-state paths under "${root}"`)))

/**
 * Directory names the whole-tree manifest never descends into, at any depth.
 *
 * Two are version control's own storage and one is the package manager's. All
 * three are written by the tools the migration runs — a checkpoint writes a git
 * ref, an install rewrites `node_modules` — so treating them as project files
 * would report the tool's own work as the unit's.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const unwalked: ReadonlyArray<string> = [".git", ".jj", "node_modules"]

/**
 * The files the project's own verification commands are expected to rewrite,
 * as exact project-relative paths.
 *
 * An install updates the lockfile, and a migration that adds packages makes it
 * do exactly that. A lockfile is therefore a legitimate write no unit declares,
 * and the one such file: everything else a command writes lands in
 * `node_modules`, in `.flows/`, or in the report directory, none of which the
 * manifest walks.
 *
 * Paths rather than names, and only at the root, because that is where the
 * install that writes them runs. A file called `src/pnpm-lock.yaml` is not a
 * lockfile any install would touch — it is a path an agent invented in a
 * directory nothing generates into — so it is an out-of-unit write like any
 * other, and the unit that wrote it fails with it named.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const generated: ReadonlyArray<string> = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]

/**
 * What one whole-tree manifest holds: the paths it left out, and a digest of
 * every file it kept.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Tree {
  readonly exclude: ReadonlyArray<string>
  readonly files: Readonly<Record<string, string>>
}

const excluded = (relative: string, exclude: ReadonlyArray<string>): boolean =>
  exclude.some((entry) => relative === entry || relative.startsWith(`${entry}/`))

/**
 * Digests every file in the project, minus {@link unwalked} and the paths the
 * caller excluded.
 *
 * This is the record an out-of-unit write is caught by. The unit's own file set
 * cannot be that record: a write the agent never declared is exactly the write
 * that is missing from it, which is why this walks the tree instead of the
 * declaration.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const tree = (
  root: string,
  exclude: ReadonlyArray<string> = []
): Effect.Effect<Tree, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files: Record<string, string> = {}
    const walk = (relative: string): Effect.Effect<void, MigrateError, never> =>
      Effect.gen(function*() {
        const target = relative === "" ? root : path.join(root, ...relative.split("/"))
        const entries = yield* fs.readDirectory(target).pipe(
          Effect.mapError(io(`could not list the project path "${relative || "."}"`))
        )
        for (const entry of [...entries].sort()) {
          if (unwalked.includes(entry)) continue
          const child = relative === "" ? entry : `${relative}/${entry}`
          if (excluded(child, exclude)) continue
          const childPath = path.join(root, ...child.split("/"))
          // A link is recorded by where it points and never followed. A
          // followed link to an ancestor (`docs/latest -> .`) recurses until
          // the process dies, and a followed link to a file outside the
          // project reads bytes that are not the project's. The link target
          // is what a change to it changes, and whatever it points at inside
          // the project is walked on its own path anyway.
          const link = yield* Fs.linkTarget(childPath).pipe(Effect.provideService(FileSystem.FileSystem, fs))
          if (link !== undefined) {
            files[child] = sha256(Fs.linkRecord(link))
            continue
          }
          const info = yield* fs.stat(childPath).pipe(
            Effect.mapError(io(`could not inspect the project path "${child}"`))
          )
          if (info.type === "Directory") {
            yield* walk(child)
            continue
          }
          if (info.type !== "File") continue
          const bytes = yield* fs.readFile(childPath).pipe(
            Effect.mapError(io(`could not read the project path "${child}"`))
          )
          files[child] = sha256(bytes)
        }
      })
    yield* walk("")
    return { exclude: [...exclude].sort(), files }
  }).pipe(Effect.mapError(io(`could not read the project tree under "${root}"`)))

/**
 * Every file that differs from the whole-tree manifest the checkpoint wrote.
 *
 * The answer is derived from bytes on disk and from nothing anyone said, which
 * is the point: it is what the unit report's `changedFiles` is built from, and
 * what a write outside the unit's declared file set is found by.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const treeDiff = (
  root: string,
  ref: Ref
): Effect.Effect<ReadonlyArray<Report.ChangedFile>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(ref.tree).pipe(
      Effect.mapError(io(`could not read the tree manifest "${ref.tree}"`))
    )
    const before = yield* Effect.try({
      try: () => JSON.parse(text) as Tree,
      catch: io(`the tree manifest "${ref.tree}" could not be read back`)
    })
    const after = yield* tree(root, before.exclude)
    const changes: Array<Report.ChangedFile> = []
    // The size comes from the stat, not from reading the file: a changed file
    // is reported by its length, and re-reading every byte of every changed
    // file to take `.length` costs the whole diff for nothing.
    const sizeOf = (file: string): Effect.Effect<number, MigrateError, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const info = yield* fs.stat(path.join(root, ...file.split("/"))).pipe(
          Effect.mapError(io(`could not inspect changed project path "${file}"`))
        )
        return Number(info.size)
      })
    for (const file of Object.keys(after.files).sort()) {
      const recorded = before.files[file]
      if (recorded === undefined) changes.push({ path: file, change: "added", bytes: yield* sizeOf(file) })
      else if (recorded !== after.files[file]) {
        changes.push({ path: file, change: "modified", bytes: yield* sizeOf(file) })
      }
    }
    for (const file of Object.keys(before.files).sort()) {
      if (after.files[file] === undefined) changes.push({ path: file, change: "deleted", bytes: 0 })
    }
    return changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  })

const trimmed = (text: string): string => text.trim()

const runVcs = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<Exec.Result, MigrateError, ChildProcessSpawner> =>
  Exec.run(command, { args, cwd, timeoutMs: 120_000 }).pipe(
    Effect.mapError((failure) => make("checkpoint-failed", `${command} ${args.join(" ")}: ${failure.reason}`))
  )

const gitRef = (unit: string, at: number): string =>
  `refs/smithers-migrate/${unit.replace(/[^A-Za-z0-9._-]+/g, "-")}/${at}`

/**
 * Takes the checkpoint. Never edits a project file: the jj path opens a new
 * change, the git path writes a ref, and both copy the unit's files aside.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const take = (payload: {
  readonly root: string
  readonly unit: string
  readonly files: ReadonlyArray<string>
  readonly backupDir: string
  readonly allowNoVcs: boolean
  readonly runStateRoots?: ReadonlyArray<string> | undefined
  readonly treeExclude?: ReadonlyArray<string> | undefined
}): Effect.Effect<Ref, MigrateError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const takenAt = yield* Clock.currentTimeMillis
    // Public callers receive the same protection as Command's project lock:
    // never replace the original backups while recovery is still pending.
    yield* Pending.assertClear(path.dirname(payload.backupDir))
    const vcs = yield* VcsInternal.requireCheckpoint(payload.root, payload.backupDir, payload.allowNoVcs)
    const directory = path.join(payload.backupDir, ...payload.unit.split(/[:/]/))
    const entries = yield* backup(payload.root, payload.files, directory)
    const files = entries.filter((entry) => entry.state === "file").map((entry) => entry.path)
    const digests = yield* digest(payload.root, payload.runStateRoots ?? [])
    // The whole tree, written beside the unit's backup rather than into it, so
    // the manifest can never collide with a source path the backup holds.
    const manifest = `${directory}.tree.json`
    const walked = yield* tree(payload.root, [
      ...new Set([...(payload.treeExclude ?? []), ...(payload.runStateRoots ?? [])])
    ])
    yield* Fs.writeAtomic(manifest, `${JSON.stringify(walked)}\n`).pipe(
      Effect.mapError(io(`could not record the tree manifest ${manifest}`))
    )
    const recorded = { backup: directory, files, entries, digests, takenAt, tree: manifest }

    if (vcs === "jj") {
      const shown = yield* runVcs("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], payload.root)
      if (shown.exitCode !== 0) {
        return yield* Effect.fail(
          make("checkpoint-failed", `jj could not read the working-copy change: ${Exec.tail(shown.stderr)}`)
        )
      }
      const change = trimmed(shown.stdout)
      // A new change for the migration keeps every edit the operator had not
      // committed in the change they were already working in.
      const opened = yield* runVcs("jj", ["new", "-m", `migrate-smithers-v1: ${payload.unit}`], payload.root)
      if (opened.exitCode !== 0) {
        return yield* Effect.fail(make("checkpoint-failed", `jj new failed: ${Exec.tail(opened.stderr)}`))
      }
      return yield* pending(payload, { vcs, ref: change, restore: `jj restore --from ${change}`, ...recorded })
    }

    if (vcs === "git") {
      // `stash create` builds a commit and prints its sha without touching the
      // working tree, the index, or the stash list. With nothing to stash it
      // prints nothing, and HEAD already is the checkpoint.
      const created = yield* runVcs("git", ["stash", "create"], payload.root)
      const head = yield* runVcs("git", ["rev-parse", "HEAD"], payload.root)
      const sha = trimmed(created.stdout) !== "" ? trimmed(created.stdout) : trimmed(head.stdout)
      if (sha === "") {
        return yield* Effect.fail(make(
          "checkpoint-failed",
          `git has no commit to check point against in "${payload.root}". Commit once, or rerun with --allow-no-vcs.`
        ))
      }
      const ref = gitRef(payload.unit, takenAt)
      const updated = yield* runVcs("git", ["update-ref", ref, sha], payload.root)
      if (updated.exitCode !== 0) {
        return yield* Effect.fail(make("checkpoint-failed", `git update-ref failed: ${Exec.tail(updated.stderr)}`))
      }
      return yield* pending(payload, { vcs, ref, restore: `git checkout ${ref} -- .`, ...recorded })
    }

    return yield* pending(payload, {
      vcs,
      ref: directory,
      restore: `cp -R ${directory}/. .`,
      ...recorded
    })
  })

/**
 * The unit's files as the checkpoint recorded them, keyed by project-relative
 * path. This is what the deterministic checks compare against.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const sources = (
  ref: Ref
): Effect.Effect<ReadonlyMap<string, string>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const recorded = new Map<string, string>()
    for (const entry of ref.entries) {
      if (entry.state !== "file") continue
      if (entry.digest === undefined) {
        return yield* Effect.fail(make("checkpoint-failed", `the checkpoint entry for "${entry.path}" has no digest`))
      }
      const file = path.join(ref.backup, ...entry.path.split("/"))
      const bytes = yield* verifiedBytes(fs, file, entry.digest, `the backup of ${entry.path}`)
      recorded.set(entry.path, new TextDecoder().decode(bytes))
    }
    return recorded
  })

/**
 * What changed between the checkpoint and now, for the paths named.
 *
 * Only the paths named: a file the unit never claimed is not this unit's
 * business, and reporting it would blame the migration for the operator's own
 * uncommitted work.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const diff = (
  root: string,
  ref: Ref,
  touched: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<Report.ChangedFile>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const changes: Array<Report.ChangedFile> = []
    const entries = new Map(ref.entries.map((entry) => [entry.path, entry] as const))
    for (const file of [...new Set(touched)].sort()) {
      const entry = entries.get(file)
      if (entry === undefined) {
        return yield* Effect.fail(
          make("checkpoint-failed", `path "${file}" was not declared in the checkpoint manifest`)
        )
      }
      const after = yield* optionalNotFound(fs.readFile(absolute(path, root, file))).pipe(
        Effect.mapError(io(`could not read ${file} while comparing it to the checkpoint`))
      )
      if (Option.isNone(after)) {
        if (entry.state === "file") changes.push({ path: file, change: "deleted", bytes: 0 })
        continue
      }
      if (entry.state === "absent") {
        changes.push({ path: file, change: "added", bytes: after.value.length })
        continue
      }
      if (entry.digest === undefined) {
        return yield* Effect.fail(make("checkpoint-failed", `the checkpoint entry for "${file}" has no digest`))
      }
      if (sha256(after.value) !== entry.digest) {
        changes.push({ path: file, change: "modified", bytes: after.value.length })
      }
    }
    return changes
  })

/**
 * Puts the named paths back the way the checkpoint recorded them, and deletes
 * the ones the checkpoint did not have.
 *
 * Files outside `touched` are left exactly as they are, which is the whole
 * point: a failed unit must not cost the operator work the unit never claimed.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const restore = (
  root: string,
  ref: Ref,
  touched: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<string>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const restored: Array<string> = []
    const entries = new Map(ref.entries.map((entry) => [entry.path, entry] as const))
    for (const file of [...new Set(touched)].sort()) {
      const target = absolute(path, root, file)
      const entry = entries.get(file)
      if (entry === undefined) {
        return yield* Effect.fail(
          make("checkpoint-failed", `path "${file}" was not declared in the checkpoint manifest`)
        )
      }
      yield* refuseLink(root, file, "restore it")
      if (entry.state === "absent") {
        yield* fs.remove(target, { recursive: true, force: true }).pipe(
          Effect.mapError(io(`could not remove post-checkpoint path ${file}`))
        )
        const remaining = yield* optionalNotFound(fs.stat(target)).pipe(
          Effect.mapError(io(`could not verify removal of post-checkpoint path ${file}`))
        )
        if (Option.isSome(remaining)) {
          return yield* Effect.fail(
            make("checkpoint-failed", `post-checkpoint path "${file}" still exists after rollback`)
          )
        }
        restored.push(file)
        continue
      }
      if (entry.digest === undefined) {
        return yield* Effect.fail(make("checkpoint-failed", `the checkpoint entry for "${file}" has no digest`))
      }
      const before = yield* verifiedBytes(
        fs,
        path.join(ref.backup, ...file.split("/")),
        entry.digest,
        `the backup of ${file}`
      )
      yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
        Effect.mapError(io(`could not create ${path.dirname(target)}`))
      )
      yield* fs.writeFile(target, before).pipe(Effect.mapError(io(`could not restore ${file}`)))
      // The mode goes back before the digest is verified: bytes and
      // permissions are the same record, and an executable source stays one.
      if (entry.mode !== undefined) {
        yield* fs.chmod(target, entry.mode).pipe(Effect.mapError(io(`could not restore the mode of ${file}`)))
      }
      yield* verifiedBytes(fs, target, entry.digest, `the restored path ${file}`)
      restored.push(file)
    }
    return restored
  })

/**
 * What a rollback could and could not put back.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Rollback {
  readonly restored: ReadonlyArray<string>
  readonly unrestored: ReadonlyArray<string>
  readonly deletedAdds: ReadonlyArray<{
    readonly path: string
    readonly backup: string
  }>
}

const preserveAdded = (
  root: string,
  ref: Ref,
  added: ReadonlyArray<string>
): Effect.Effect<Rollback["deletedAdds"], MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = `${ref.backup}.post-checkpoint`
    const preserved: Array<{ path: string; backup: string }> = []
    for (const file of added) {
      // An added link is removed with the other adds, never read through:
      // its target may be a file outside the project.
      if ((yield* Fs.linkOnPath(root, file)) !== undefined) continue
      const bytes = yield* optionalNotFound(fs.readFile(absolute(path, root, file))).pipe(
        Effect.mapError(io(`could not read the post-checkpoint file ${file}`))
      )
      if (Option.isNone(bytes)) continue
      const target = path.join(directory, ...file.split("/"))
      yield* writeBackup(root, directory, file, bytes.value)
      const digest = sha256(bytes.value)
      yield* verifiedBytes(fs, target, digest, `the preserved post-checkpoint file ${file}`)
      preserved.push({ path: file, backup: target })
    }
    return preserved
  })

/**
 * Puts a unit back the way the checkpoint found it, deciding what to put back
 * from the tree as it is at the moment of failure.
 *
 * Never from a set computed earlier. A restore list taken before the
 * deterministic checks and the archive covers only what the agent had done by
 * then, so a failure after the archive — a postcondition, a removal that could
 * not finish, any step a later version adds — would leave the sources in the
 * archive and the manifests rewritten while the unit reported that it changed
 * nothing. The checkpoint's manifest is fixed when the checkpoint is taken, so
 * a diff taken now covers everything the unit did afterwards, archive moves
 * included, and a step nobody has written yet is covered the same way.
 *
 * Three answers, one per kind of change:
 *
 * - Every file the checkpoint recorded goes back byte for byte, whether the
 *   unit edited it, deleted it, or moved it into the archive. The archive copy
 *   of a file that went back is removed with it: an archive is the record of a
 *   migration that happened.
 * - Every path added since is copied beside the checkpoint backup before it is
 *   removed, the unit's own targets included. The caller reports the copy.
 * - A file the unit modified or deleted that the checkpoint never copied is
 *   returned as `unrestored` rather than guessed at. The checkpoint copies the
 *   unit's own files and nothing else, so the honest answer is the path, which
 *   the caller reports with the checkpoint's own restore command.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const rollback = (
  root: string,
  ref: Ref,
  options: {
    /** The unit's declared file set, so a target under a path the manifest leaves out is undone too. */
    readonly paths?: ReadonlyArray<string> | undefined
    /** Where the unit's archive copies were written, when the archive had already run. */
    readonly archiveDir?: string | undefined
  } = {}
): Effect.Effect<Rollback, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entries = new Map(ref.entries.map((entry) => [entry.path, entry] as const))
    const recorded = new Set(ref.entries.filter((entry) => entry.state === "file").map((entry) => entry.path))
    const changes = yield* treeDiff(root, ref)
    const added = changes
      .filter((file) => file.change === "added" && !recorded.has(file.path))
      .map((file) => file.path)
    const unrestored = changes
      .filter((file) => file.change !== "added" && !recorded.has(file.path))
      .map((file) => file.path)
    const deletedAdds = yield* preserveAdded(root, ref, added)
    const declared = [...new Set(options.paths ?? [])]
    for (const file of declared) {
      if (!entries.has(file)) {
        return yield* Effect.fail(
          make("checkpoint-failed", `path "${file}" was not declared in the checkpoint manifest`)
        )
      }
    }
    const declaredAdds = added.filter((file) => entries.get(file)?.state === "absent")
    const outsideAdds = added.filter((file) => !entries.has(file))
    for (const file of outsideAdds) {
      const target = absolute(path, root, file)
      yield* fs.remove(target, { recursive: true, force: true }).pipe(
        Effect.mapError(io(`could not remove post-checkpoint path ${file}`))
      )
      const remaining = yield* optionalNotFound(fs.stat(target)).pipe(
        Effect.mapError(io(`could not verify removal of post-checkpoint path ${file}`))
      )
      if (Option.isSome(remaining)) {
        return yield* Effect.fail(
          make("checkpoint-failed", `post-checkpoint path "${file}" still exists after rollback`)
        )
      }
    }
    const restored = yield* restore(root, ref, [...recorded, ...declaredAdds, ...declared])
    if (options.archiveDir !== undefined) {
      for (const file of restored) {
        yield* fs.remove(path.join(options.archiveDir, ...file.split("/")), { recursive: true, force: true }).pipe(
          Effect.mapError(io(`could not remove rolled-back archive path ${file}`))
        )
      }
    }
    return { restored, unrestored, deletedAdds }
  })

/**
 * Records rollback damage in the pending marker when finish itself fails.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const recordRollback = (
  backupDir: string,
  ref: Ref,
  rollback: Rollback
): Effect.Effect<void, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = pendingFile(path, backupDir)
    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError(io(`could not read the pending checkpoint ${file}`))
    )
    const record = yield* Effect.try({
      try: () => JSON.parse(text) as Pending,
      catch: io(`could not read the pending checkpoint ${file}`)
    })
    if (record.checkpoint.ref !== ref.ref || record.takenAt !== ref.takenAt) return
    yield* Fs.writeAtomic(file, `${JSON.stringify({ ...record, rollback }, null, 2)}\n`).pipe(
      Effect.mapError(io(`could not update the pending checkpoint ${file}`))
    )
  })

/**
 * Removes this unit's marker only after its durable report exists.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const clearPending = (
  backupDir: string,
  ref: Ref
): Effect.Effect<void, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = pendingFile(path, backupDir)
    const text = yield* optionalNotFound(fs.readFileString(file)).pipe(
      Effect.mapError(io(`could not read the pending checkpoint ${file}`))
    )
    if (Option.isNone(text)) return
    const record = yield* Effect.try({
      try: () => JSON.parse(text.value) as Pending,
      catch: io(`could not read the pending checkpoint ${file}`)
    })
    if (record.checkpoint.ref !== ref.ref || record.takenAt !== ref.takenAt) return
    yield* fs.remove(file).pipe(Effect.mapError(io(`could not clear the pending checkpoint ${file}`)))
  })

/**
 * The checkpoint action's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = action.toLayer(take)

/**
 * Projects a checkpoint into the report's shape.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const toReport = (ref: Ref): Report.Checkpoint => ({
  vcs: ref.vcs,
  ref: ref.ref,
  restore: ref.restore
})
