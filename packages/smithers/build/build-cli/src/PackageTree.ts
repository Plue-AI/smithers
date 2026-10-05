/**
 * Host filesystem mechanics for build-system execution: PATH lookup and
 * version probes for tool references, the content-addressed artifact store
 * behind `Shell.Build` outDirs, git-based write-set snapshots with
 * out-of-set revert, and scratch copies for check-mode drift runs.
 *
 * Everything here is deliberately free of planning and scheduling concerns:
 * `PackageExec.ts` decides what to run and in which mode; this module owns
 * how trees are measured, captured, restored, and confined.
 *
 * @since 0.1.0
 */

import * as Exec from "@smthrs/targets/Exec"
import * as Data from "effect/Data"
import * as NodeChildProcess from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import * as Environment from "./Environment.ts"
import * as Path from "./internal/Path.ts"
import { byCodeUnit, posix } from "./internal/Text.ts"

const errno = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined

/**
 * The sha256 hex digest of one buffer.
 *
 * @category hashing
 * @since 0.1.0
 */
export const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/**
 * Whether a string is a lowercase sha256 hex digest: the only name the CAS
 * stores a blob under, and the only digest shape a manifest may carry.
 *
 * @category hashing
 * @since 0.1.0
 */
export const isSha256Hex = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

/** The digest and observed byte count of one streamed file. */
interface FileDigest {
  readonly digest: string
  readonly size: number
}

const digestFile = async (path: string): Promise<FileDigest> => {
  const hash = createHash("sha256")
  const handle = await Fs.open(path, "r")
  let size = 0
  try {
    const buffer = Buffer.allocUnsafe(1 << 16)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      size += bytesRead
    }
  } finally {
    await handle.close()
  }
  return { digest: hash.digest("hex"), size }
}

/**
 * The sha256 hex digest of one file's bytes, streamed.
 *
 * @category hashing
 * @since 0.1.0
 */
export const digestFileBytes = async (path: string): Promise<string> => (await digestFile(path)).digest

/**
 * Searches the host PATH for one executable, returning its absolute path or
 * undefined.
 *
 * The lookup is the exec boundary's own: plan-time tool resolution and the
 * spawn must agree about which file a bare command name is, or a Windows host
 * refuses a manager the spawn would have found. `options.platform` is there so
 * a POSIX host can ask for the Windows answer.
 *
 * @category tools
 * @since 0.1.0
 */
export const findOnPath = (
  name: string,
  environment: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment(),
  options?: { readonly platform?: NodeJS.Platform | undefined }
): string | undefined => {
  return findAllOnPath(name, environment, options)[0]
}

/**
 * Searches every PATH entry for an executable, preserving PATH order.
 *
 * @category tools
 * @since 0.1.0
 */
export const findAllOnPath = (
  name: string,
  environment: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment(),
  options?: { readonly platform?: NodeJS.Platform | undefined }
): ReadonlyArray<string> => Exec.findAllOnPath(name, environment, options)

/**
 * One completed `--version` probe: bounded output plus the exit code.
 *
 * @category tools
 * @since 0.1.0
 */
export interface Probe {
  readonly exitCode: number
  readonly output: string
}

const probeOutputLimit = 2 * 1024

/**
 * Runs `<path> --version` once and captures bounded output.
 *
 * Tools without a `--version` flag still probe deterministically: whatever
 * they print plus their exit code is the identity. The probe result is key
 * material, so callers memoize it per command.
 *
 * `args` overrides the probe argv for a tool whose version lives behind a
 * subcommand rather than a flag (`go version`), and `cwd` runs the probe
 * inside a directory whose configuration selects the version (a Go module
 * whose `go.mod` makes `GOTOOLCHAIN` switch toolchains).
 *
 * @category tools
 * @since 0.1.0
 */
export const probeVersion = (
  path: string,
  options?: {
    readonly cwd?: string | undefined
    readonly args?: ReadonlyArray<string> | undefined
    readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  }
): Promise<Probe> =>
  probeCommand(path, options?.args ?? ["--version"], {
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.environment === undefined ? {} : { environment: options.environment })
  })

/**
 * Runs one bounded tool identity/readiness command.
 *
 * The probe goes through the exec boundary's spawn shape, so a resolved
 * Windows batch shim is identified the same way it is run. Probing
 * `pnpm.cmd` directly would throw: Node has refused to spawn `.bat` and
 * `.cmd` without a shell since the v18 hardening.
 *
 * @category tools
 * @since 0.1.0
 */
export const probeCommand = (
  path: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly cwd?: string | undefined
    readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  }
): Promise<Probe> =>
  new Promise((resolve) => {
    const shape = Exec.spawnShape(
      [path, ...args],
      options?.environment === undefined ? {} : { env: options.environment }
    )
    NodeChildProcess.execFile(
      shape.file,
      [...shape.args],
      {
        timeout: 10_000,
        maxBuffer: 1 << 20,
        ...(shape.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.environment === undefined ? {} : { env: { ...options.environment } })
      },
      (error, stdout, stderr) => {
        const exitCode = error === null
          ? 0
          : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        const output = `${stdout}${stderr}`.slice(0, probeOutputLimit)
        resolve({ exitCode, output })
      }
    )
  })

/**
 * Runs git in a workspace and returns stdout, throwing on a non-zero exit.
 *
 * Output is streamed and decoded fatally, exactly as `Workspace`
 * decodes its own git output. A path is bytes on POSIX, and git prints those
 * bytes verbatim under `-z`. Decoding them leniently substitutes U+FFFD for
 * every byte that is not valid UTF-8, which silently renames the path: the
 * write-set guard then judges a name no file has, reports it out of set, and
 * "reverts" it with a removal that cannot fail because it targets nothing.
 * The real write stays in the tree while the node fails claiming otherwise.
 * A path this decoder cannot read is a loud failure instead.
 *
 * A local Git marker is required. Otherwise Git can walk out of a jj-only
 * workspace and census an unrelated ancestor checkout. Large valid inventories
 * are not limited by execFile's former 256 MiB capture ceiling; callers still
 * retain the returned text, and ignored-file stashes keep their own limits.
 *
 * @category git
 * @since 0.1.0
 */
export const runGit = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!NodeFs.existsSync(NodePath.join(root, ".git"))) {
      reject(new Error(`git ${args[0]} failed: workspace has no local .git; refusing ancestor repository discovery`))
      return
    }
    const child = NodeChildProcess.spawn(
      "git",
      ["-C", root, ...args],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CEILING_DIRECTORIES: NodePath.dirname(root) } }
    )
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const chunks: Array<string> = []
    let stderr = ""
    let failure: Error | undefined
    const invalidUtf8 = (): void => {
      failure = new Error(`git ${args[0]} returned stdout that is not valid UTF-8`)
      child.kill()
    }
    child.stdout.on("data", (bytes: Buffer) => {
      try {
        chunks.push(decoder.decode(bytes, { stream: true }))
      } catch {
        invalidUtf8()
      }
    })
    child.stderr.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString("utf8")).slice(0, 16 * 1024)
    })
    child.once("error", (error) => {
      failure = new Error(`git ${args[0]} failed: ${error.message}`)
    })
    child.once("close", (code, signal) => {
      if (failure !== undefined) {
        reject(failure)
        return
      }
      if (code !== 0) {
        reject(new Error(`git ${args[0]} failed: ${stderr.trim() || signal || `exit ${code}`}`))
        return
      }
      try {
        chunks.push(decoder.decode())
        resolve(chunks.join(""))
      } catch {
        reject(new Error(`git ${args[0]} returned stdout that is not valid UTF-8`))
      }
    })
  })

/**
 * Runs a resolved tool once at plan time and returns its stdout, throwing on
 * a non-zero exit with what the tool wrote to stderr. Unlike Git inventories,
 * these planner probes have a bounded capture: a planner asking `forge` or
 * `go` what it would do.
 *
 * @category planning
 * @since 0.1.0
 */
export const runCommand = (
  path: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  }
): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      path,
      [...args],
      {
        cwd: options.cwd,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        ...(options.environment === undefined ? {} : { env: { ...options.environment } })
      },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout)
      }
    )
  })

/**
 * Whether git can census the workspace, which needs its own `.git`.
 *
 * A `jj workspace add` checkout, or any tree without version control, has
 * none. jj lists neither ignored paths nor file modes and has no
 * checkout-style revert, so the write-set guard does not ask it: the
 * ignored census walks the whole tree from the filesystem instead, holds
 * every file in its stash, and restores from there. The git status census
 * is then empty, because every path is already the ignored census's.
 */
const censusedByGit = (root: string): boolean => NodeFs.existsSync(NodePath.join(root, ".git"))

/** `git status --porcelain -z` of the workspace, or no rows when git cannot census it. */
const statusZ = (root: string, ignored: boolean = false): Promise<string> =>
  censusedByGit(root) ?
    runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all", ...(ignored ? ["--ignored=matching"] : [])])
    : Promise.resolve("")

/** One `git status --porcelain -z` row. */
interface StatusEntry {
  readonly status: string
  readonly path: string
}

const parseStatusZ = (raw: string): Array<StatusEntry> => {
  const entries: Array<StatusEntry> = []
  const parts = raw.split("\0")
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!
    if (part === "") continue
    const status = part.slice(0, 2)
    const path = part.slice(3)
    if (path === "") continue
    entries.push({ status, path })
    // A rename/copy row carries the original path as the next NUL field.
    if (status.startsWith("R") || status.startsWith("C")) index += 1
  }
  return entries
}

/**
 * The recorded state of one dirty path.
 *
 * @category write sets
 * @since 0.1.0
 */
export type PathState =
  | { readonly kind: "missing" }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "file"; readonly digest: string; readonly mode: number }

/**
 * Measures the state of one absolute path: missing, a symlink with its
 * target, or a file with its content digest and full permission bits.
 *
 * @category write sets
 * @since 0.1.0
 */
export const pathState = (absolute: string): Promise<PathState> => statePath(absolute)

const statePath = async (absolute: string): Promise<PathState> => {
  let stats: NodeFs.Stats
  try {
    stats = await Fs.lstat(absolute)
  } catch {
    return { kind: "missing" }
  }
  if (stats.isSymbolicLink()) return { kind: "link", target: await Fs.readlink(absolute) }
  if (stats.isFile()) {
    return {
      kind: "file",
      digest: await digestFileBytes(absolute),
      mode: stats.mode & 0o7777
    }
  }
  return { kind: "missing" }
}

const sameState = (left: PathState, right: PathState): boolean => {
  if (left.kind !== right.kind) return false
  if (left.kind === "link" && right.kind === "link") return left.target === right.target
  if (left.kind === "file" && right.kind === "file") {
    return left.digest === right.digest && left.mode === right.mode
  }
  return true
}

/**
 * A snapshot of the workspace's dirty state relative to git HEAD: every
 * modified, deleted, and untracked path with its content state, plus a stash
 * of the dirty files' bytes so an out-of-set change to an already-dirty file
 * can be reverted to exactly what it held before the tool ran.
 * Clean tracked files retain their observed modes separately because Git
 * records only the executable bit, not their full permissions.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface TreeSnapshot {
  readonly root: string
  readonly states: ReadonlyMap<string, PathState>
  readonly trackedModes: ReadonlyMap<string, number>
  readonly stashDirectory: string
}

/**
 * Whether one path segment names host state the write-set guard never
 * measures, wherever it sits in the tree.
 *
 * Version-control internals are never workspace source. The installed
 * dependency tree is host state too: in the e2e clone the root one is a
 * symlink into the live checkout, its cache writes are expected, and a
 * workspace installs one under every package (the nested ones on this
 * repository held 15,000 ignored files and 672 MiB, 11,500 of them under
 * `marketing/hermes-site/node_modules`). The rule applies at every depth,
 * because a root-only skip left each nested one in the census.
 */
const hostStateSegment = (segment: string): boolean =>
  segment === "node_modules" || segment === ".git" || segment === ".jj"

/**
 * Whether a path lies in one of the host trees a caller named: a directory a
 * declared toolchain owns, skipped whole like `node_modules` above.
 *
 * These are named by path, not by segment. `node_modules` means the same
 * thing wherever it appears; `target` does not, so only the directory the
 * workspace's own Rust toolchain declaration puts it at is host state and a
 * source directory of that name anywhere else is still workspace source.
 */
const insideHostTree = (hostTrees: ReadonlyArray<string>, path: string): boolean =>
  hostTrees.some((tree) => path === tree || path.startsWith(`${tree}/`))

const skipStatusPath = (cacheDirectory: string, path: string, hostTrees: ReadonlyArray<string> = []): boolean =>
  path === cacheDirectory || path.startsWith(`${cacheDirectory}/`) || path.split("/").some(hostStateSegment) ||
  insideHostTree(hostTrees, path)

/**
 * Records the dirty state of a git workspace before a tool runs.
 * Requires trusted, coordinated writers from capture through rollback;
 * filesystem operations are path-based, not descriptor-anchored isolation.
 *
 * @category write sets
 * @since 0.1.0
 */
export const snapshotTree = async (root: string, cacheDirectory: string): Promise<TreeSnapshot> => {
  // Gitignored paths are handled by the separate ignored guard
  // ({@link snapshotIgnored}), which carries its own ceilings: hashing the
  // whole ignored tree here, with the build artifacts among it, would be a
  // per-run cost out of all proportion to the dirty source set this measures.
  const raw = await statusZ(root)
  const states = new Map<string, PathState>()
  const trackedModes = new Map<string, number>()
  const stashDirectory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-writeset-"))
  try {
    const trackedPaths = censusedByGit(root) ? await runGit(root, ["ls-files", "-z"]) : ""
    for (const path of trackedPaths.split("\0")) {
      if (path === "" || skipStatusPath(cacheDirectory, path)) continue
      const stats = await Fs.lstat(NodePath.join(root, path)).catch((cause: unknown) => {
        if (errno(cause) === "ENOENT" || errno(cause) === "ENOTDIR") return undefined
        throw cause
      })
      if (stats?.isFile()) trackedModes.set(path, stats.mode & 0o7777)
    }
    for (const entry of parseStatusZ(raw)) {
      if (skipStatusPath(cacheDirectory, entry.path)) continue
      const absolute = NodePath.join(root, entry.path)
      const state = await statePath(absolute)
      states.set(entry.path, state)
      if (state.kind === "file") {
        const stashFile = NodePath.join(stashDirectory, digestBytes(Buffer.from(entry.path, "utf8")))
        await Fs.copyFile(absolute, stashFile)
      } else if (state.kind === "link") {
        // Link state is fully described by its target text; nothing to stash.
      }
    }
    return { root, states, trackedModes, stashDirectory }
  } catch (cause) {
    // The caller never received a snapshot to release; retain the acquisition error.
    await Fs.rm(stashDirectory, { recursive: true, force: true }).catch(() => {})
    throw cause
  }
}

/**
 * The set of paths whose state changed since a snapshot, resolved through
 * symlinks: a write through an in-tree link is judged by where it landed.
 *
 * @category write sets
 * @since 0.1.0
 */
export const changedSinceSnapshot = async (
  snapshot: TreeSnapshot,
  cacheDirectory: string
): Promise<ReadonlyArray<string>> => {
  const raw = await statusZ(snapshot.root)
  const after = new Map<string, PathState>()
  for (const entry of parseStatusZ(raw)) {
    if (skipStatusPath(cacheDirectory, entry.path)) continue
    after.set(entry.path, await statePath(NodePath.join(snapshot.root, entry.path)))
  }
  const changed = new Set<string>()
  for (const [path, state] of after) {
    const before = snapshot.states.get(path)
    if (before === undefined || !sameState(before, state)) changed.add(path)
  }
  for (const path of snapshot.states.keys()) {
    if (after.has(path)) continue
    // The path settled back to its HEAD state: the tool overwrote or removed
    // a difference that existed before it ran, which is a change.
    changed.add(path)
  }
  // Git ignores most permission bits. Publishing identical bytes can still
  // clear special bits, which rollback must restore after a later failure.
  for (const [path, mode] of snapshot.trackedModes) {
    if (changed.has(path)) continue
    const stats = await Fs.lstat(NodePath.join(snapshot.root, path)).catch((cause: unknown) => {
      if (errno(cause) === "ENOENT" || errno(cause) === "ENOTDIR") return undefined
      throw cause
    })
    if (!stats?.isFile() || (stats.mode & 0o7777) !== mode) changed.add(path)
  }
  return [...changed].sort()
}

/**
 * Resolves one changed path through symlinks to the workspace-relative
 * location the bytes actually landed at, or undefined when the real location
 * leaves the workspace.
 *
 * @category write sets
 * @since 0.1.0
 */
export const resolveChangedPath = (root: string, path: string): string | undefined => {
  const absolute = NodePath.join(root, path)
  let real: string
  try {
    real = NodeFs.realpathSync(absolute)
  } catch {
    // The path no longer exists (a deletion); judge it by its lexical spot
    // resolved through the nearest existing ancestor.
    try {
      real = NodePath.join(NodeFs.realpathSync(NodePath.dirname(absolute)), NodePath.basename(absolute))
    } catch {
      return posix(path)
    }
  }
  const realRoot = NodeFs.realpathSync(root)
  const relative = Path.containedRelative(realRoot, real)
  if (relative === undefined || relative === "") return undefined
  return posix(relative)
}

/**
 * The changes a guarded body could have made: those whose resolved location
 * lies inside one of the workspace-relative `admitted` locations (`""` is the
 * whole workspace). Anything else was written by someone else while the body
 * ran, because the body could not write there, and the guard leaves it alone.
 * `undefined` admits every change: nothing bounds where the body wrote.
 *
 * @category write sets
 * @since 1.0.0
 */
export const judgedChanges = (
  root: string,
  changed: ReadonlyArray<string>,
  admitted: ReadonlyArray<string> | undefined
): ReadonlyArray<string> => {
  if (admitted === undefined) return changed
  return changed.filter((path) => {
    const resolved = resolveChangedPath(root, path)
    if (resolved === undefined) return false
    return admitted.some((location) => location === "" || resolved === location || resolved.startsWith(`${location}/`))
  })
}

/**
 * Where the write-set guard keeps the bytes it removes from the tree: one
 * directory per guarded body under `<cacheDirectory>/reverted/`, created on
 * the first copy. The guard judges a whole-tree difference and cannot always
 * tell the body's write from another writer's edit made while the body ran,
 * so it never removes bytes it has not first copied here. The cache directory
 * is outside both censuses, so a quarantine is never itself judged.
 *
 * @category write sets
 * @since 1.0.0
 */
export interface Quarantine {
  readonly root: string
  /** Workspace-relative directory the copies land in, mirroring each path. */
  readonly directory: string
  /** Workspace-relative paths copied so far. */
  readonly held: Array<string>
}

/**
 * Names the quarantine for one guarded body. Nothing is created until a
 * revert copies bytes into it.
 *
 * @category write sets
 * @since 1.0.0
 */
export const openQuarantine = (root: string, cacheDirectory: string, label: string): Quarantine => {
  const slug = label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_.]+|_+$/g, "") || "body"
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`
  return { root, directory: `${posix(cacheDirectory)}/reverted/${slug}-${stamp}`, held: [] }
}

/** Copies the current bytes at `path` into the quarantine before a revert removes them. */
const quarantinePath = async (quarantine: Quarantine | undefined, path: string): Promise<void> => {
  if (quarantine === undefined) return
  const absolute = NodePath.join(quarantine.root, path)
  const present = await Fs.lstat(absolute).then(() => true, () => false)
  if (!present) return
  const destination = NodePath.join(quarantine.root, quarantine.directory, path)
  await Fs.mkdir(NodePath.dirname(destination), { recursive: true })
  await Fs.cp(absolute, destination, { recursive: true, verbatimSymlinks: true, force: true, errorOnExist: false })
  quarantine.held.push(path)
}

/**
 * Restores one path to its snapshot state, first copying whatever stands at
 * the path now into `quarantine`.
 * Writers must remain trusted and coordinated throughout snapshot, execution,
 * and rollback; these path-based operations do not anchor parent descriptors.
 *
 * @category write sets
 * @since 0.1.0
 */
export const revertPath = async (snapshot: TreeSnapshot, path: string, quarantine?: Quarantine): Promise<void> => {
  const absolute = NodePath.join(snapshot.root, path)
  await quarantinePath(quarantine, path)
  const before = snapshot.states.get(path)
  if (before === undefined) {
    // The path was clean before the tool ran: a tracked file goes back to
    // the index, a fresh untracked file is deleted.
    const tracked = await runGit(snapshot.root, ["ls-files", "--stage", "-z", "--error-unmatch", "--", path]).then(
      (entries) => entries.split("\0").filter((entry) => entry.slice(entry.indexOf("\t") + 1) === path),
      () => undefined
    )
    if (tracked !== undefined) {
      // Git's ordinary checkout leaves gitlinks alone. Never replace a
      // populated submodule with checkout-index's directory placeholder.
      if (tracked.length === 0 || tracked.some((entry) => entry.startsWith("160000 "))) return
      // Stage on the same filesystem in mkdtemp's private 0700 directory:
      // checkout must not expose bytes under Git's broader default mode or
      // mutate a hard-link alias. Keep the destination until staging succeeds.
      const parent = NodePath.dirname(absolute)
      await Fs.mkdir(parent, { recursive: true })
      const directory = await Fs.mkdtemp(NodePath.join(parent, ".smthrs-rollback-"))
      try {
        const checkoutArguments = [
          "--force",
          `--prefix=${directory}${NodePath.sep}`,
          "--",
          path
        ]
        try {
          await runGit(snapshot.root, ["checkout-index", "--ignore-skip-worktree-bits", ...checkoutArguments])
        } catch (cause) {
          // Older Git checks out skip-worktree entries without this option.
          // Retry only its unsupported-option diagnostic, never a checkout failure.
          if (
            !(cause instanceof Error) ||
            !/unknown option ['"`](?:--)?ignore-skip-worktree-bits['"`]/.test(cause.message)
          ) throw cause
          await runGit(snapshot.root, ["checkout-index", ...checkoutArguments])
        }
        const staged = NodePath.join(directory, path)
        const stagedState = await Fs.lstat(staged)
        if (!stagedState.isFile() && !stagedState.isSymbolicLink()) {
          throw new Error(`cannot restore non-file index entry ${JSON.stringify(path)}`)
        }
        const mode = snapshot.trackedModes.get(path)
        if (mode !== undefined && stagedState.isFile()) await Fs.chmod(staged, mode)
        const current = await Fs.lstat(absolute).catch((cause: unknown) => {
          if (errno(cause) === "ENOENT") return undefined
          throw cause
        })
        // Files and symlinks publish atomically. A replacement directory must
        // first be removed, but only after checkout and permissions succeed.
        if (current?.isDirectory()) await Fs.rm(absolute, { recursive: true, force: true })
        await Fs.rename(staged, absolute)
      } finally {
        await Fs.rm(directory, { recursive: true, force: true })
      }
    } else {
      await Fs.rm(absolute, { recursive: true, force: true })
    }
    return
  }
  if (before.kind === "missing") {
    await Fs.rm(absolute, { recursive: true, force: true })
    return
  }
  if (before.kind === "link") {
    await Fs.rm(absolute, { recursive: true, force: true })
    await Fs.symlink(before.target, absolute)
    return
  }
  const stashFile = NodePath.join(snapshot.stashDirectory, digestBytes(Buffer.from(path, "utf8")))
  await Fs.rm(absolute, { recursive: true, force: true })
  await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
  await Fs.copyFile(stashFile, absolute)
  await Fs.chmod(absolute, before.mode)
}

/**
 * Releases the stash a snapshot holds.
 *
 * @category write sets
 * @since 0.1.0
 */
export const releaseSnapshot = async (snapshot: TreeSnapshot): Promise<void> => {
  await Fs.rm(snapshot.stashDirectory, { recursive: true, force: true })
}

/**
 * The recorded `lstat` identity of one gitignored path, plus what restoring
 * it needs.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface IgnoredEntry {
  readonly kind: "file" | "link" | "dir"
  readonly size: number
  readonly mtimeMs: number
  /** Permission bits, restored with the bytes so a `0600` secret stays one. */
  readonly mode: number
  /** A link's target text, which describes the link completely; empty for anything else. */
  readonly target: string
}

/**
 * The ceilings the gitignored census may not cross.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface IgnoredLimits {
  /** Gitignored files, links, and unentered directories counted. */
  readonly entries: number
  /** Bytes across every gitignored file the census holds in its stash. */
  readonly totalBytes: number
}

/**
 * The ceilings the gitignored census may not cross.
 *
 * The census records every gitignored path by `lstat` identity, and holds the
 * bytes of the ones the body's declared write set can name so a write to one
 * can be restored exactly. A stash shared across a run ({@link IgnoredStash})
 * is refreshed incrementally: a file whose identity the stash already holds is
 * not read again, so an unchanged file costs one `lstat` per census and only
 * the files that changed since the previous census are copied. A tree over
 * either ceiling is refused with {@link IgnoredCensusError} rather than
 * guarded partially: the guard has no mode in which a claimed rollback can
 * silently fail to hold. `node_modules` at any depth, the cache directory,
 * and version-control internals never count.
 *
 * Both ceilings count what the guard insures, which is the developer's own
 * gitignored state. They once counted a declared toolchain's build directory
 * too, which made `totalBytes` a census of the host's build artifacts: a
 * checkout with a built Rust `target/` crossed 1 GiB before any target ran
 * and had every `--write` refused. Those directories are host state now, so
 * the ceilings measure the guard's own work again — see
 * {@link IgnoredSnapshot}.
 *
 * @category write sets
 * @since 0.1.0
 */
export const ignoredLimits = {
  /** Gitignored files, links, and unentered directories counted. */
  entries: 50_000,
  /** Bytes across every gitignored file the census holds in its stash. */
  totalBytes: 1024 * 1024 * 1024
} as const satisfies IgnoredLimits

/**
 * A gitignored tree the write-set guard cannot restore exactly, so the
 * target behind it is refused before it runs.
 *
 * @category errors
 * @since 0.1.0
 */
export class IgnoredCensusError extends Data.TaggedError("smithers-build/IgnoredCensusError")<{
  /** The ceiling crossed, or `unreadable` when a gitignored file could not be stashed. */
  readonly reason: "entries" | "totalBytes" | "unreadable"
  /** The workspace-relative gitignored path at which the census stopped. */
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}> {
  constructor(
    reason: "entries" | "totalBytes" | "unreadable",
    path: string,
    limits: IgnoredLimits,
    options?: ErrorOptions
  ) {
    super({
      reason,
      path,
      message: reason === "entries"
        ? `the write-set guard cannot restore the gitignored tree: more than ${limits.entries} entries, at ${path}`
        : reason === "totalBytes"
        ? `the write-set guard cannot restore the gitignored tree: more than ${limits.totalBytes} bytes, at ${path}`
        : `the write-set guard cannot restore the gitignored tree: ${path} could not be read`,
      ...(options?.cause === undefined ? {} : { cause: options.cause })
    })
  }
}

/**
 * A stash of gitignored files' bytes, shared by every census taken over one
 * run so an unchanged file is copied once and afterwards only measured.
 *
 * `held` records the identity of the bytes each stash file holds, keyed by
 * workspace-relative path. A census refreshes it: a file whose current
 * identity matches is reused, one whose identity moved is copied again, and
 * one the census no longer lists is dropped, so the stash is never larger
 * than the census it serves. One census at a time may refresh a stash; the
 * package executor serializes guarded bodies through its tree gate.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface IgnoredStash {
  readonly directory: string
  readonly held: Map<string, IgnoredEntry>
}

/**
 * Opens an empty stash for gitignored bytes, removed by
 * {@link releaseIgnoredStash}.
 *
 * @category write sets
 * @since 0.1.0
 */
export const openIgnoredStash = async (): Promise<IgnoredStash> => ({
  directory: await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-ignored-")),
  held: new Map()
})

/**
 * Removes a stash and every file it holds.
 *
 * @category write sets
 * @since 0.1.0
 */
export const releaseIgnoredStash = async (stash: IgnoredStash): Promise<void> => {
  stash.held.clear()
  await Fs.rm(stash.directory, { recursive: true, force: true })
}

/**
 * What one gitignored census recorded and what it cost: the tool's own
 * account of its work, so the claim that unchanged files are measured and
 * not copied is checkable without a stopwatch.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface IgnoredCensus {
  /** Gitignored files, links, and unentered directories recorded. */
  readonly entries: number
  /** Bytes across every gitignored file recorded, all of which the stash holds. */
  readonly bytes: number
  /** Files this census copied into the stash because it did not hold their current identity. */
  readonly copied: number
  /** Bytes those copies read. */
  readonly copiedBytes: number
  /** Files whose held bytes this census reused unchanged, at the cost of one `lstat` each. */
  readonly reused: number
}

/**
 * A snapshot of the workspace's gitignored paths before a tool runs: each
 * path's identity, backed by a stash that holds every gitignored file's
 * bytes.
 *
 * `git status` omits ignored paths unless asked, so a write to a gitignored
 * path is invisible to {@link changedSinceSnapshot}. This guard closes that
 * gap. It records each ignored path's `lstat` identity and holds each
 * ignored file's bytes in the stash, so an overwritten, deleted, or replaced
 * ignored path goes back to exactly what it was. That is what the guard is
 * for, and it is not narrowed by the write set: the case it was built for is
 * a tool that overwrites the developer's `.env`, which no write set names.
 * A directory git does not enter (a nested repository) is recorded by
 * identity alone: a change under it can be reported, never restored.
 *
 * What the census never measures is host state: `node_modules` at any depth,
 * the cache, version-control internals, and the `hostTrees` a declared
 * toolchain owns. A toolchain's build directory is the same kind of thing as
 * an installed dependency tree — the tool that wrote it rebuilds it, and no
 * byte in it is a developer's only copy — so insuring it bought nothing and
 * cost everything: a checkout with a built Rust `target/` carried 908 MiB of
 * `.rmeta` past the byte ceiling and had every `--write` refused over files
 * no target could have named.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface IgnoredSnapshot {
  readonly root: string
  readonly entries: ReadonlyMap<string, IgnoredEntry>
  readonly stash: IgnoredStash
  /**
   * The toolchain-owned directories this census skipped, which
   * {@link changedIgnored} must skip too so a build that writes one is not
   * read as a tree of created and deleted paths.
   */
  readonly hostTrees: ReadonlyArray<string>
  /** Whether the snapshot opened its own stash, which {@link releaseIgnored} then removes. */
  readonly ownsStash: boolean
  readonly limits: IgnoredLimits
  readonly census: IgnoredCensus
}

/** The identity of one gitignored path now, or undefined once it is gone. */
const identityOf = async (absolute: string): Promise<IgnoredEntry | undefined> => {
  let stats: NodeFs.Stats
  try {
    stats = await Fs.lstat(absolute)
  } catch {
    return undefined
  }
  const kind = stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : "file"
  return {
    kind,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode & 0o7777,
    target: kind === "link" ? await Fs.readlink(absolute) : ""
  }
}

const sameIgnored = (left: IgnoredEntry, right: IgnoredEntry): boolean =>
  left.kind === right.kind && left.size === right.size && left.mtimeMs === right.mtimeMs &&
  left.mode === right.mode && left.target === right.target

const recordIgnored = (
  entries: Map<string, IgnoredEntry>,
  path: string,
  entry: IgnoredEntry,
  limits: IgnoredLimits
): void => {
  entries.set(path, entry)
  if (entries.size > limits.entries) throw new IgnoredCensusError("entries", path, limits)
}

/**
 * Records every gitignored path under one directory git reported as ignored.
 *
 * A directory that matches an ignore pattern is ignored whole: git never
 * re-includes a path whose parent is excluded, so every entry under it is
 * gitignored and the walk needs no pattern matching of its own. It stops
 * where git stops, at a nested repository (a `.git` entry), which is
 * recorded by identity alone, and it skips host state (`node_modules`,
 * version-control internals, the cache directory) at any depth. Symlinks are
 * recorded, never followed. A directory it cannot read fails the census:
 * a guard that cannot measure must fail its target.
 */
const walkIgnored = async (
  root: string,
  cacheDirectory: string,
  directory: string,
  entries: Map<string, IgnoredEntry>,
  limits: IgnoredLimits,
  hostTrees: ReadonlyArray<string>
): Promise<void> => {
  let dirents: Array<NodeFs.Dirent>
  try {
    dirents = await Fs.readdir(NodePath.join(root, directory), { withFileTypes: true })
  } catch (cause) {
    throw new IgnoredCensusError("unreadable", directory, limits, { cause })
  }
  if (dirents.some((dirent) => dirent.name === ".git")) {
    const entry = await identityOf(NodePath.join(root, directory))
    if (entry !== undefined) recordIgnored(entries, directory, entry, limits)
    return
  }
  for (const dirent of dirents) {
    const path = directory === "" ? dirent.name : `${directory}/${dirent.name}`
    if (skipStatusPath(cacheDirectory, path, hostTrees)) continue
    if (dirent.isDirectory()) {
      await walkIgnored(root, cacheDirectory, path, entries, limits, hostTrees)
      continue
    }
    const entry = await identityOf(NodePath.join(root, path))
    if (entry !== undefined) recordIgnored(entries, path, entry, limits)
  }
}

const listIgnored = async (
  root: string,
  cacheDirectory: string,
  limits: IgnoredLimits,
  hostTrees: ReadonlyArray<string> = []
): Promise<Map<string, IgnoredEntry>> => {
  // The failure propagates instead of reading as an empty census. This runs
  // once before the body and once after: swallowing a failure after leaves the
  // guard silently blind to writes to gitignored paths, and swallowing one
  // before makes every gitignored path read as newly created after, sending
  // each one to `revertIgnored` as a path the tool created, which removes it.
  // Either way a guard that cannot measure must fail its target, not report
  // that it found nothing.
  //
  // `--ignored=matching` reports the paths that match an ignore pattern and
  // does not enter a matched directory. That keeps git out of every
  // `node_modules` tree (600,000 files and 13 s per status on this
  // repository, under the `traditional` mode that listed each file) and
  // leaves the walk under each matched directory to `walkIgnored`, which
  // skips host state at any depth. A path reported with a trailing slash is
  // a directory; every other one is a file or a symlink.
  //
  // Without a local `.git` the whole tree is walked (see `censusedByGit`).
  const entries = new Map<string, IgnoredEntry>()
  if (!censusedByGit(root)) {
    await walkIgnored(root, cacheDirectory, "", entries, limits, hostTrees)
    return entries
  }
  const raw = await statusZ(root, true)
  for (const status of parseStatusZ(raw)) {
    if (!status.status.startsWith("!!")) continue
    const directory = status.path.endsWith("/")
    const path = directory ? status.path.slice(0, -1) : status.path
    if (path === "" || skipStatusPath(cacheDirectory, path, hostTrees)) continue
    if (directory) {
      await walkIgnored(root, cacheDirectory, path, entries, limits, hostTrees)
      continue
    }
    const entry = await identityOf(NodePath.join(root, path))
    if (entry !== undefined) recordIgnored(entries, path, entry, limits)
  }
  return entries
}

const stashFileFor = (stash: IgnoredStash, path: string): string =>
  NodePath.join(stash.directory, digestBytes(Buffer.from(path, "utf8")))

/**
 * Records the gitignored paths present before a tool runs and brings the
 * stash up to date with their bytes, or refuses with
 * {@link IgnoredCensusError} when the tree crosses `limits` or holds a path
 * the census cannot read.
 *
 * The census is an `lstat` walk. With a `stash` from an earlier census, only
 * a file whose identity moved since the stash last held it is copied, and
 * one the stash already holds costs its `lstat` alone; without one the
 * snapshot opens a private stash, copies every file into it, and removes it
 * in {@link releaseIgnored}. The `census` field on the result accounts for
 * both.
 *
 * `hostTrees` names the directories a declared toolchain owns, which the
 * census skips whole exactly as it skips `node_modules`: see
 * {@link IgnoredSnapshot}.
 *
 * @category write sets
 * @since 0.1.0
 */
export const snapshotIgnored = async (
  root: string,
  cacheDirectory: string,
  limits: IgnoredLimits = ignoredLimits,
  stash?: IgnoredStash,
  hostTrees: ReadonlyArray<string> = []
): Promise<IgnoredSnapshot> => {
  const entries = await listIgnored(root, cacheDirectory, limits, hostTrees)
  const ownsStash = stash === undefined
  const held = stash ?? await openIgnoredStash()
  try {
    let bytes = 0
    let copied = 0
    let copiedBytes = 0
    let reused = 0
    for (const [path, entry] of entries) {
      if (entry.kind !== "file") continue
      bytes += entry.size
      if (bytes > limits.totalBytes) throw new IgnoredCensusError("totalBytes", path, limits)
      const holding = held.held.get(path)
      if (holding !== undefined && sameIgnored(holding, entry)) {
        reused += 1
        continue
      }
      held.held.delete(path)
      try {
        // A reflink where the filesystem offers one, a byte copy elsewhere:
        // the stash is exact either way, and cheap where it can be.
        await Fs.copyFile(NodePath.join(root, path), stashFileFor(held, path), NodeFs.constants.COPYFILE_FICLONE)
      } catch (cause) {
        throw new IgnoredCensusError("unreadable", path, limits, { cause })
      }
      held.held.set(path, entry)
      copied += 1
      copiedBytes += entry.size
    }
    // A path the census no longer lists as a file leaves the stash, so the
    // stash never outgrows the census it serves.
    for (const path of [...held.held.keys()]) {
      if (entries.get(path)?.kind === "file") continue
      held.held.delete(path)
      await Fs.rm(stashFileFor(held, path), { force: true })
    }
    return {
      root,
      entries,
      stash: held,
      hostTrees,
      ownsStash,
      limits,
      census: { entries: entries.size, bytes, copied, copiedBytes, reused }
    }
  } catch (cause) {
    if (ownsStash) await releaseIgnoredStash(held)
    throw cause
  }
}

/**
 * The gitignored paths a tool created, overwrote, replaced, or deleted since
 * the snapshot, resolved through symlinks like {@link changedSinceSnapshot}.
 *
 * @category write sets
 * @since 0.1.0
 */
export const changedIgnored = async (
  snapshot: IgnoredSnapshot,
  cacheDirectory: string
): Promise<ReadonlyArray<string>> => {
  const after = await listIgnored(snapshot.root, cacheDirectory, snapshot.limits, snapshot.hostTrees)
  const changed = new Set<string>()
  for (const [path, entry] of after) {
    const before = snapshot.entries.get(path)
    if (before === undefined || !sameIgnored(before, entry)) changed.add(path)
  }
  for (const [path, before] of snapshot.entries) {
    if (after.has(path)) continue
    // A path the census no longer lists was deleted, or it merely stopped
    // being ignored (a rewritten `.gitignore`) and still stands as it was.
    const now = await identityOf(NodePath.join(snapshot.root, path))
    if (now === undefined || !sameIgnored(before, now)) changed.add(path)
  }
  return [...changed].sort()
}

/** Whether an ancestor of `path` is a directory the census recorded without entering. */
const insideUnmeasured = (snapshot: IgnoredSnapshot, path: string): boolean => {
  let ancestor = NodePath.posix.dirname(path)
  while (ancestor !== ".") {
    if (snapshot.entries.get(ancestor)?.kind === "dir") return true
    ancestor = NodePath.posix.dirname(ancestor)
  }
  return false
}

/**
 * Restores one gitignored path to its snapshot state and reports whether it
 * could. A created path is removed; an overwritten or deleted file gets its
 * stashed bytes and mode back; a replaced link gets its target back. What
 * stands at the path now is first copied into `quarantine`.
 *
 * A path the census never measured, a directory git does not enter or
 * anything inside one, is left exactly as the tool left it and reported as
 * not restored: its contents were never stashed, so removal would be the
 * data loss this guard exists to prevent.
 *
 * @category write sets
 * @since 0.1.0
 */
export const revertIgnored = async (
  snapshot: IgnoredSnapshot,
  path: string,
  quarantine?: Quarantine
): Promise<boolean> => {
  const before = snapshot.entries.get(path)
  if (before?.kind === "dir" || insideUnmeasured(snapshot, path)) return false
  const absolute = NodePath.join(snapshot.root, path)
  const now = await identityOf(absolute)
  if (now?.kind === "dir") return false
  if (now !== undefined) await quarantinePath(quarantine, path)
  if (now !== undefined) await Fs.rm(absolute, { force: true })
  if (before === undefined) return true
  await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
  if (before.kind === "link") {
    await Fs.symlink(before.target, absolute)
    return true
  }
  await Fs.copyFile(stashFileFor(snapshot.stash, path), absolute)
  await Fs.chmod(absolute, before.mode)
  return true
}

/**
 * Releases an ignored snapshot: the stash it opened for itself is removed,
 * and a stash it was given is left for the next census.
 *
 * @category write sets
 * @since 0.1.0
 */
export const releaseIgnored = async (snapshot: IgnoredSnapshot): Promise<void> => {
  if (snapshot.ownsStash) await releaseIgnoredStash(snapshot.stash)
}

/**
 * One in-workspace symlink whose real target lies outside the workspace: a
 * portal a tool could write through to escape the tree, judged by resolved
 * location per the write-set rules.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface Portal {
  readonly link: string
  readonly realTarget: string
  readonly states: ReadonlyMap<string, PathState>
}

/**
 * A snapshot of every escaping-symlink portal's target contents before a tool
 * runs, plus a stash of their file bytes so a write through a portal can be
 * reverted.
 *
 * @category write sets
 * @since 0.1.0
 */
export interface PortalSnapshot {
  readonly root: string
  readonly portals: ReadonlyArray<Portal>
  readonly stashDirectory: string
}

/**
 * The largest portal target the guard measures.
 *
 * A larger one cannot be confined by this mechanism, so the target that would
 * have run behind it is refused rather than run unconfined.
 *
 * @category write sets
 * @since 0.1.0
 */
export const portalEntryCap = 20_000

/**
 * A portal whose target could not be measured, so the write-set guard cannot
 * hold over it.
 *
 * The census used to swallow every failure — the documented overflow, but also
 * a permission error or a directory racing the walk — log a line, and run the
 * target anyway. A stated confinement guarantee that silently does not hold is
 * worse than no guarantee, so an unmeasurable portal now refuses the target.
 *
 * @category errors
 * @since 0.1.0
 */
export class PortalCensusError extends Data.TaggedError("smithers-build/PortalCensusError")<{
  /** `too-large` when the target crossed {@link portalEntryCap}, `unreadable` otherwise. */
  readonly reason: "too-large" | "unreadable"
  /** The workspace-relative symlink whose target could not be measured. */
  readonly link: string
  readonly message: string
  readonly cause?: unknown
}> {
  constructor(reason: "too-large" | "unreadable", link: string, options?: ErrorOptions) {
    super({
      reason,
      link,
      message: reason === "too-large"
        ? `the write-set guard cannot confine ${link}: its target has more than ${portalEntryCap} entries`
        : `the write-set guard cannot confine ${link}: its target could not be read`,
      ...(options?.cause === undefined ? {} : { cause: options.cause })
    })
  }
}

/** The sentinel `walkPortalTarget` throws when the entry cap is crossed. */
class PortalOverflow extends Data.TaggedError("smithers-build/PortalOverflow")<{ readonly message: string }> {}

const portalStashKey = (index: number, relative: string): string =>
  digestBytes(Buffer.from(`${index}\0${relative}`, "utf8"))

/** Resolves a missing path through the nearest ancestor that can be resolved. */
const resolveFromExistingAncestor = async (absolute: string): Promise<string> => {
  let ancestor = absolute
  while (true) {
    try {
      const realAncestor = await Fs.realpath(ancestor)
      return NodePath.resolve(realAncestor, NodePath.relative(ancestor, absolute))
    } catch (cause) {
      const code = errno(cause)
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cause
      const parent = NodePath.dirname(ancestor)
      if (parent === ancestor) throw cause
      ancestor = parent
    }
  }
}

/** Walks one portal target into a relative-path → state map, or throws on overflow. */
const walkPortalTarget = async (realTarget: string): Promise<Map<string, PathState>> => {
  const states = new Map<string, PathState>()
  let count = 0
  let rootStats: NodeFs.Stats
  try {
    rootStats = await Fs.lstat(realTarget)
  } catch (cause) {
    if (errno(cause) === "ENOENT") return states
    throw cause
  }
  if (!rootStats.isDirectory()) {
    states.set("", await statePath(realTarget))
    return states
  }
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await Fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      count += 1
      if (count > portalEntryCap) throw new PortalOverflow({ message: "portal target too large" })
      const childAbsolute = NodePath.join(directory, entry.name)
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(childAbsolute, childRelative)
      } else {
        states.set(childRelative, await statePath(childAbsolute))
      }
    }
  }
  await walk(realTarget, "")
  return states
}

const listTrackedSymlinks = async (root: string): Promise<Array<string>> => {
  // Without a local `.git` every link comes from the whole-tree census.
  if (!censusedByGit(root)) return []
  // Same rule as the ignored census: an unmeasured portal set is a disarmed
  // guard, so the failure reaches the target rather than reading as no links.
  const raw = await runGit(root, ["ls-files", "-s", "-z"])
  const paths: Array<string> = []
  for (const part of raw.split("\0")) {
    if (part === "") continue
    const tab = part.indexOf("\t")
    if (tab < 0) continue
    if (part.slice(0, tab).startsWith("120000")) paths.push(part.slice(tab + 1))
  }
  return paths
}

/**
 * Records every escaping-symlink portal's target before a tool runs.
 *
 * Portals are the in-workspace symlinks, tracked, untracked, or gitignored,
 * whose real target leaves the workspace. `node_modules` at any depth,
 * version-control internals, and the cache are excluded (`node_modules` is
 * installed host state whose writes are expected). Git cannot see a write
 * that lands through such a symlink, so the portal's contents are measured
 * directly here and again after the run.
 *
 * The links under gitignored directories come from the gitignored census,
 * taken from `ignored` when the caller already holds that snapshot so the
 * tree is walked once per guarded body, and otherwise measured here under
 * {@link ignoredLimits} without descending into `hostTrees`, the same
 * declared host caches {@link snapshotIgnored} skips.
 *
 * A portal the census cannot measure — over {@link portalEntryCap} entries, or
 * unreadable — raises {@link PortalCensusError} and refuses the target. The
 * guard has no partial mode: a confinement claim it cannot keep is not made.
 *
 * @category write sets
 * @since 0.1.0
 */
export const snapshotPortals = async (
  root: string,
  cacheDirectory: string,
  ignored?: IgnoredSnapshot,
  hostTrees: ReadonlyArray<string> = []
): Promise<PortalSnapshot> => {
  const realRoot = await Fs.realpath(root)
  const candidates = new Set<string>(await listTrackedSymlinks(root))
  const statusRaw = await statusZ(root)
  for (const entry of parseStatusZ(statusRaw)) {
    const path = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path
    if (path !== "") candidates.add(path)
  }
  const ignoredEntries = ignored?.entries ?? await listIgnored(root, cacheDirectory, ignoredLimits, hostTrees)
  for (const [path, entry] of ignoredEntries) {
    if (entry.kind === "link") candidates.add(path)
  }
  const stashDirectory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-portal-"))
  try {
    const portals: Array<Portal> = []
    let index = 0
    for (const link of [...candidates].sort()) {
      if (skipStatusPath(cacheDirectory, link)) continue
      const absolute = NodePath.join(root, link)
      let stats: NodeFs.Stats
      try {
        stats = await Fs.lstat(absolute)
      } catch {
        continue
      }
      if (!stats.isSymbolicLink()) continue
      let realTarget: string
      let states: Map<string, PathState> | undefined
      try {
        realTarget = await Fs.realpath(absolute)
      } catch (realpathCause) {
        try {
          const target = await Fs.readlink(absolute)
          const intended = NodePath.resolve(NodePath.dirname(absolute), target)
          realTarget = await resolveFromExistingAncestor(intended)
        } catch (cause) {
          throw new PortalCensusError("unreadable", link, { cause: cause ?? realpathCause })
        }
        // The target does not exist yet. An in-workspace destination remains
        // covered by git; an escaping destination starts as an empty portal so
        // a file created through the dangling link is visible after the run.
        if (Path.contains(realRoot, realTarget)) continue
        states = new Map()
      }
      // A symlink resolving inside the workspace is judged by the git write-set,
      // not here; only an escaping one is a portal.
      if (Path.contains(realRoot, realTarget)) continue
      if (states === undefined) {
        try {
          states = await walkPortalTarget(realTarget)
        } catch (cause) {
          throw new PortalCensusError(cause instanceof PortalOverflow ? "too-large" : "unreadable", link, {
            cause
          })
        }
      }
      for (const [relativePath, state] of states) {
        if (state.kind === "file") {
          const source = relativePath === "" ? realTarget : NodePath.join(realTarget, ...relativePath.split("/"))
          await Fs.copyFile(source, NodePath.join(stashDirectory, portalStashKey(index, relativePath)))
        }
      }
      portals.push({ link, realTarget, states })
      index += 1
    }
    return { root, portals, stashDirectory }
  } catch (cause) {
    // The caller never received a snapshot to release; retain the acquisition error.
    await Fs.rm(stashDirectory, { recursive: true, force: true }).catch(() => {})
    throw cause
  }
}

/**
 * Reverts every write that landed through a portal since the snapshot and
 * returns the escaped paths, workspace-relative through their portal link.
 *
 * @category write sets
 * @since 0.1.0
 */
export const revertChangedPortals = async (snapshot: PortalSnapshot): Promise<ReadonlyArray<string>> => {
  const escaped: Array<string> = []
  for (const [index, portal] of snapshot.portals.entries()) {
    let after: Map<string, PathState>
    try {
      after = await walkPortalTarget(portal.realTarget)
    } catch (cause) {
      // The pre-run census proved this target measurable. If the post-run one
      // cannot, the guard cannot say what the body wrote through it, and
      // "cannot prove" is a failure, not a pass.
      throw new PortalCensusError(cause instanceof PortalOverflow ? "too-large" : "unreadable", portal.link, {
        cause
      })
    }
    const changed = new Set<string>()
    for (const [relativePath, state] of after) {
      const before = portal.states.get(relativePath)
      if (before === undefined || !sameState(before, state)) changed.add(relativePath)
    }
    for (const relativePath of portal.states.keys()) {
      if (!after.has(relativePath)) changed.add(relativePath)
    }
    for (const relativePath of [...changed].sort()) {
      const target = relativePath === ""
        ? portal.realTarget
        : NodePath.join(portal.realTarget, ...relativePath.split("/"))
      const before = portal.states.get(relativePath)
      if (before === undefined || before.kind === "missing") {
        await Fs.rm(target, { recursive: true, force: true })
      } else if (before.kind === "link") {
        await Fs.rm(target, { recursive: true, force: true })
        await Fs.mkdir(NodePath.dirname(target), { recursive: true })
        await Fs.symlink(before.target, target)
      } else {
        await Fs.rm(target, { recursive: true, force: true })
        await Fs.mkdir(NodePath.dirname(target), { recursive: true })
        await Fs.copyFile(NodePath.join(snapshot.stashDirectory, portalStashKey(index, relativePath)), target)
        await Fs.chmod(target, before.mode)
      }
      escaped.push(relativePath === "" ? portal.link : `${portal.link}/${relativePath}`)
    }
  }
  return escaped.sort()
}

/**
 * Releases the stash a portal snapshot holds.
 *
 * @category write sets
 * @since 0.1.0
 */
export const releasePortals = async (snapshot: PortalSnapshot): Promise<void> => {
  await Fs.rm(snapshot.stashDirectory, { recursive: true, force: true })
}

/**
 * Copies the workspace to a scratch directory for a check-mode run.
 *
 * Version-control state (`.git`, `.jj`), the cache directory, the root
 * `node_modules` contents, and every nested checkout (a directory carrying
 * its own `.git`, such as an agent worktree or a vendored clone) are skipped;
 * a package's own `node_modules` is copied because under pnpm it is a
 * directory of symlinks into the root store, which the scratch tree needs; symlinks — the e2e clone's
 * node_modules among them — are copied verbatim, so the scratch tree reads
 * the same installed tools without duplicating them. `skip` names further
 * workspace-relative roots the caller is going to clear anyway — an overlay
 * build's own `outDirs` — so a large previous output is not copied only to be
 * deleted. `hostTrees` names the declared host caches, which are linked like
 * the root `node_modules`: a tool reads the same cache, and a read-only cache
 * such as Go's module cache is neither copied nor left in a scratch tree its
 * removal cannot unlink.
 *
 * @category scratch
 * @since 0.1.0
 */
export const scratchCopy = async (
  root: string,
  cacheDirectory: string,
  skip: ReadonlyArray<string> = [],
  hostTrees: ReadonlyArray<string> = []
): Promise<string> => {
  const destination = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-scratch-"))
  const cacheAbsolute = NodePath.join(root, ...cacheDirectory.split("/"))
  const nodeModulesAbsolute = NodePath.join(root, "node_modules")
  const skipped = new Set(skip.map((path) => NodePath.join(root, ...path.split("/"))))
  const linked = [nodeModulesAbsolute, ...hostTrees.map((path) => NodePath.join(root, ...path.split("/")))]
  const versionControl = new Set([".git", ".jj"])
  const nestedCheckout = (source: string): boolean =>
    source !== root && NodeFs.existsSync(NodePath.join(source, ".git"))
  try {
    await Fs.cp(root, destination, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) =>
        source !== cacheAbsolute && !linked.includes(source) && !skipped.has(source) &&
        !versionControl.has(NodePath.basename(source)) && !nestedCheckout(source)
    })
    for (const source of linked) {
      if (!(await Fs.lstat(source).then(() => true, () => false))) continue
      const target = NodePath.join(destination, NodePath.relative(root, source))
      await Fs.mkdir(NodePath.dirname(target), { recursive: true })
      await Fs.symlink(source, target, "dir")
    }
    return destination
  } catch (error) {
    // Neither copying nor linking dependencies can leave a half-built tree
    // in the temporary directory for the next run to find.
    await Fs.rm(destination, { recursive: true, force: true })
    throw error
  }
}

/**
 * One entry of a captured output tree.
 *
 * @category artifacts
 * @since 0.1.0
 */
export interface ManifestEntry {
  readonly path: string
  readonly kind: "file" | "link"
  readonly digest: string
  readonly executable: boolean
  readonly target: string
}

/**
 * One captured output root: the workspace-relative outDir plus its entries.
 *
 * @category artifacts
 * @since 0.1.0
 */
export interface OutDirManifest {
  readonly outDir: string
  readonly entries: ReadonlyArray<ManifestEntry>
}

/** One captured file output stored in the same content-addressed blob set.
 *
 * @category artifacts
 * @since 0.1.0
 */
export interface FileManifest {
  readonly path: string
  readonly digest: string
  readonly executable: boolean
}

const casDirectory = (root: string, cacheDirectory: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "cas")

/** One collision-resistant temp-name scrap: the pid plus real entropy, never `Math.random`. */
const tempToken = (): string => `${process.pid}-${randomBytes(8).toString("hex")}`

const unsupportedSync = new Set(["EINVAL", "EPERM", "EISDIR", "EACCES", "ENOTSUP"])

/**
 * Flushes one path on the hosts that support fsync on it: a freshly written
 * temp blob before its publishing rename, and the parent directory after one.
 */
const syncForPublish = async (path: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof Fs.open>> | undefined
  try {
    handle = await Fs.open(path, "r")
    await handle.sync()
  } catch (cause) {
    const code = errno(cause)
    if (code === undefined || !unsupportedSync.has(code)) throw cause
  } finally {
    if (handle !== undefined) await handle.close()
  }
}

/**
 * Writes one produced file into the CAS under its digest.
 *
 * A blob is content-addressed, so an existing one of the right name is
 * usually the right bytes. It is not trusted on name alone: a tampered or
 * truncated blob is re-verified against its digest and rewritten from the
 * freshly produced file, so a rebuild heals the CAS instead of leaving it
 * poisoned for every later run to miss on. A fresh blob is copied to a temp
 * sibling, flushed, and renamed into place — Bazel's `DiskCacheClient` does
 * the same, "fsync temp before we rename it to avoid data loss in the case
 * of machine crashes (the OS may reorder the writes and the rename)" — and a
 * publish that fails removes its temp so the store never accretes scraps.
 */
const putBlob = async (cas: string, source: string, digest: string): Promise<void> => {
  const blob = NodePath.join(cas, digest)
  let present: boolean
  try {
    present = (await digestFileBytes(blob)) === digest
  } catch {
    present = false
  }
  if (present) return
  const temp = `${blob}.tmp-${tempToken()}`
  try {
    await Fs.copyFile(source, temp)
    await syncForPublish(temp)
    await Fs.rename(temp, blob)
  } catch (cause) {
    try {
      await Fs.rm(temp, { force: true })
    } catch {
      // The failed publish is the story; a failed cleanup must not mask it.
    }
    throw cause
  }
}

/**
 * Configurable ceilings for one captured outDir.
 *
 * @category artifacts
 * @since 0.1.0
 */
export interface OutDirLimits {
  /** Directory nesting below the outDir root. */
  readonly depth: number
  /** Files, directories, and symlinks visited. */
  readonly entries: number
  /** UTF-8 bytes in one entry's outDir-relative path. */
  readonly pathBytes: number
  /** Bytes in one captured file. */
  readonly fileBytes: number
  /** Bytes across every captured file in one outDir. */
  readonly totalBytes: number
  /** UTF-8 bytes in the encoded manifest entry array. */
  readonly manifestBytes: number
}

/**
 * The ceilings one captured outDir may not cross.
 *
 * The capture walk used to have none, while the portal census sixty lines
 * above capped itself at {@link portalEntryCap} for exactly the reason an
 * unbounded walk is a hazard. A deep tree overflowed the stack, a very large
 * one exhausted memory and disk while hashing, and either published a cache
 * record every later run had to fetch. A crossed ceiling aborts the capture
 * before anything reaches the CAS, naming the path and the limit.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const outDirLimits = {
  /** Directory nesting below the outDir root. */
  depth: 64,
  /** Files, directories, and symlinks visited. */
  entries: 200_000,
  /** UTF-8 bytes in one entry's outDir-relative path. */
  pathBytes: 4_096,
  /** Bytes in one captured file. */
  fileBytes: 4 * 1024 * 1024 * 1024,
  /** Bytes across every captured file in one outDir. */
  totalBytes: 16 * 1024 * 1024 * 1024,
  /** UTF-8 bytes in the encoded manifest entry array. */
  manifestBytes: 64 * 1024 * 1024
} as const satisfies OutDirLimits

/**
 * A captured tree that crosses one of {@link outDirLimits}.
 *
 * @category errors
 * @since 0.1.0
 */
export class OutDirLimitError extends Data.TaggedError("smithers-build/OutDirLimitError")<{
  /** Which ceiling the tree crossed. */
  readonly limit: keyof OutDirLimits
  readonly message: string
}> {
  constructor(limit: keyof OutDirLimits, path: string, ceiling: number = outDirLimits[limit]) {
    super({ limit, message: `captured output ${path} crosses the ${limit} limit of ${ceiling}` })
  }
}

/**
 * Proves an output path cannot escape through its nearest existing ancestor.
 *
 * Restore callers run this before `mkdir`: resolving only the completed
 * parent would discover an escaping symlink after recursive creation had
 * already written directories outside the workspace.
 */
const confinedAncestor = async (root: string, absolute: string, path: string): Promise<void> => {
  const realRoot = await Fs.realpath(root)
  let ancestor = NodePath.dirname(absolute)
  while (true) {
    try {
      await Fs.lstat(ancestor)
    } catch (cause) {
      const code = errno(cause)
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error(`declared output ${path} has no readable parent directory`, { cause })
      }
      const parent = NodePath.dirname(ancestor)
      if (parent === ancestor) {
        throw new Error(`declared output ${path} has no readable parent directory`, { cause })
      }
      ancestor = parent
      continue
    }
    let realAncestor: string
    try {
      realAncestor = await Fs.realpath(ancestor)
    } catch (cause) {
      throw new Error(`declared output ${path} has no readable parent directory`, { cause })
    }
    if (!Path.contains(realRoot, realAncestor)) {
      throw new Error(`declared output ${path} resolves outside the workspace through a symlinked parent`)
    }
    return
  }
}

/**
 * Proves one output path's parent directory really is inside the workspace.
 *
 * {@link isConfinedRelative} is lexical: it refuses `..` and absolute text and
 * nothing else. If an existing parent component is an in-workspace symlink to
 * an external directory, a capture reads foreign bytes into the CAS and a
 * restore writes outside the tree, both past the write-set confinement that
 * exists to stop exactly that. Resolving the parent and the root through
 * `realpath` closes it.
 */
const confinedParent = async (root: string, absolute: string, path: string): Promise<void> => {
  const realRoot = await Fs.realpath(root)
  const parent = NodePath.dirname(absolute)
  let realParent: string
  try {
    realParent = await Fs.realpath(parent)
  } catch (cause) {
    throw new Error(`declared output ${path} has no readable parent directory`, { cause })
  }
  if (!Path.contains(realRoot, realParent)) {
    throw new Error(`declared output ${path} resolves outside the workspace through a symlinked parent`)
  }
}

/**
 * Captures one produced outDir tree into the CAS and returns its manifest.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const captureOutDir = async (
  root: string,
  cacheDirectory: string,
  outDir: string,
  storeRoot: string = root,
  limits: Readonly<OutDirLimits> = outDirLimits
): Promise<OutDirManifest> => {
  const absolute = NodePath.join(root, ...outDir.split("/"))
  let stats: NodeFs.Stats
  try {
    stats = await Fs.lstat(absolute)
  } catch {
    throw new Error(`declared outDir was not created: ${outDir}`)
  }
  if (!stats.isDirectory()) throw new Error(`declared outDir is not a directory: ${outDir}`)
  await confinedParent(root, absolute, outDir)
  const entries: Array<ManifestEntry> = []
  const files: Array<{
    readonly absolute: string
    readonly relative: string
    readonly digest: string
    readonly size: number
    readonly executable: boolean
  }> = []
  let visited = 0
  let totalBytes = 0
  // The walk stays recursive on purpose: `limits.depth` bounds the nesting at
  // 64 frames, so it cannot overflow the stack, and an iterative rewrite would
  // trade a readable traversal for an explicit stack that proves nothing more.
  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > limits.depth) throw new OutDirLimitError("depth", `${outDir}/${relative}`, limits.depth)
    const names = (await Fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => byCodeUnit(left.name, right.name))
    for (const entry of names) {
      const childAbsolute = NodePath.join(directory, entry.name)
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`
      visited += 1
      if (visited > limits.entries) {
        throw new OutDirLimitError("entries", `${outDir}/${childRelative}`, limits.entries)
      }
      if (Buffer.byteLength(childRelative, "utf8") > limits.pathBytes) {
        throw new OutDirLimitError("pathBytes", `${outDir}/${childRelative}`, limits.pathBytes)
      }
      if (entry.isSymbolicLink()) {
        entries.push({
          path: childRelative,
          kind: "link",
          digest: "",
          executable: false,
          target: await Fs.readlink(childAbsolute)
        })
      } else if (entry.isDirectory()) {
        await walk(childAbsolute, childRelative, depth + 1)
      } else if (entry.isFile()) {
        // The cheap `lstat` size rejects an oversized file before it is read;
        // the streamed count below rejects one that grew after the stat, which
        // is the only way past the first check.
        if ((await Fs.lstat(childAbsolute)).size > limits.fileBytes) {
          throw new OutDirLimitError("fileBytes", `${outDir}/${childRelative}`, limits.fileBytes)
        }
        const observed = await digestFile(childAbsolute)
        if (observed.size > limits.fileBytes) {
          throw new OutDirLimitError("fileBytes", `${outDir}/${childRelative}`, limits.fileBytes)
        }
        totalBytes += observed.size
        if (totalBytes > limits.totalBytes) {
          throw new OutDirLimitError("totalBytes", `${outDir}/${childRelative}`, limits.totalBytes)
        }
        const mode = (await Fs.stat(childAbsolute)).mode
        const executable = (mode & 0o111) !== 0
        files.push({
          absolute: childAbsolute,
          relative: childRelative,
          digest: observed.digest,
          size: observed.size,
          executable
        })
        entries.push({
          path: childRelative,
          kind: "file",
          digest: observed.digest,
          executable,
          target: ""
        })
      }
    }
  }
  await walk(absolute, "", 0)
  if (Buffer.byteLength(JSON.stringify(entries), "utf8") > limits.manifestBytes) {
    throw new OutDirLimitError("manifestBytes", outDir, limits.manifestBytes)
  }

  // Validation and hashing finish before the store is created or changed. A
  // later path or aggregate limit therefore cannot leave a partial CAS write.
  const cas = casDirectory(storeRoot, cacheDirectory)
  await Fs.mkdir(cas, { recursive: true })
  for (const file of files) {
    await putBlob(cas, file.absolute, file.digest)
  }
  return { outDir, entries }
}

/** Captures one declared output file into the CAS.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const captureFile = async (
  root: string,
  cacheDirectory: string,
  path: string,
  storeRoot: string = root
): Promise<FileManifest> => {
  if (!isConfinedRelative(path)) throw new Error(`declared output file leaves the workspace: ${path}`)
  const absolute = NodePath.join(root, ...path.split("/"))
  const stats = await Fs.lstat(absolute).catch(() => undefined)
  if (stats === undefined || !stats.isFile()) throw new Error(`declared output file was not created: ${path}`)
  await confinedParent(root, absolute, path)
  const digest = await digestFileBytes(absolute)
  const cas = casDirectory(storeRoot, cacheDirectory)
  await Fs.mkdir(cas, { recursive: true })
  await putBlob(cas, absolute, digest)
  return { path, digest, executable: (stats.mode & 0o111) !== 0 }
}

/** Decodes an untrusted file manifest.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const decodeFileManifest = (value: unknown): FileManifest | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const path = (value as { readonly path?: unknown }).path
  const digest = (value as { readonly digest?: unknown }).digest
  const executable = (value as { readonly executable?: unknown }).executable
  if (typeof path !== "string" || !isConfinedRelative(path)) return undefined
  if (typeof digest !== "string" || !isSha256Hex(digest) || typeof executable !== "boolean") return undefined
  return { path, digest, executable }
}

/** Verifies that one file manifest's CAS blob exists and matches its name.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const verifyFileManifest = async (
  root: string,
  cacheDirectory: string,
  manifest: FileManifest
): Promise<string | undefined> => {
  const blob = NodePath.join(casDirectory(root, cacheDirectory), manifest.digest)
  const digest = await digestFileBytes(blob).catch(() => undefined)
  if (digest === undefined) return `cas blob missing for ${manifest.path}`
  if (digest !== manifest.digest) return `cas blob tampered for ${manifest.path}`
  return undefined
}

/** Atomically restores one captured file output from the CAS.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const materializeFile = async (
  root: string,
  cacheDirectory: string,
  manifest: FileManifest
): Promise<void> => {
  if (!isConfinedRelative(manifest.path)) throw new Error(`materialize refused path: ${manifest.path}`)
  const destination = NodePath.join(root, ...manifest.path.split("/"))
  const blob = NodePath.join(casDirectory(root, cacheDirectory), manifest.digest)
  await confinedAncestor(root, destination, manifest.path)
  await Fs.mkdir(NodePath.dirname(destination), { recursive: true })
  await confinedParent(root, destination, manifest.path)
  const temporary = `${destination}.smthrs-${tempToken()}`
  try {
    await Fs.copyFile(blob, temporary)
    await Fs.chmod(temporary, manifest.executable ? 0o755 : 0o644)
    await Fs.rename(temporary, destination)
  } finally {
    // Cleanup must not replace the copy, chmod, or publication error.
    await Fs.rm(temporary, { force: true }).catch(() => {})
  }
}

const safeManifestPath = /^(?!\.\.(\/|$))(?!\/)[^\0]+$/

/**
 * A workspace-relative path that cannot escape its root: non-empty, not
 * absolute, no `..` segment (in either separator), no NUL. Used for a
 * manifest's `outDir` and its entry paths, both read back from an untrusted
 * cache.
 */
const isConfinedRelative = (value: string): boolean =>
  value !== "" &&
  !value.includes("\0") &&
  !NodePath.isAbsolute(value) &&
  !value.startsWith("/") &&
  !value.split("/").includes("..") &&
  !value.split(NodePath.sep).includes("..")

/**
 * A symlink target that cannot point out of the tree it is materialized into:
 * not absolute, no `..` segment. A capture only ever records such targets;
 * an untrusted manifest that names an absolute or `..`-bearing target is
 * refused, because materializing it — or writing a later entry through it —
 * would leave the outDir.
 */
const isConfinedLinkTarget = (value: string): boolean =>
  value !== "" &&
  !value.includes("\0") &&
  !NodePath.isAbsolute(value) &&
  !value.startsWith("/") &&
  !value.split("/").includes("..") &&
  !value.split(NodePath.sep).includes("..")

/**
 * Validates one untrusted manifest read back from the cache.
 *
 * The manifest is untrusted input: the local `.flows` entry file, a shared
 * remote body, a backup, or a hand edit. Every path it names is bound to the
 * outDir tree here so a poisoned entry cannot escape the workspace. `outDir`
 * is confined to a workspace-relative path with no `..` segment, every entry
 * path is likewise confined, and every link target is confined so a later
 * file entry cannot be written through a symlink that leaves the tree. The
 * caller must still bind the returned `outDir` to a declared output root
 * before materializing it.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const decodeManifest = (value: unknown): OutDirManifest | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const outDir = (value as { readonly outDir?: unknown }).outDir
  const entries = (value as { readonly entries?: unknown }).entries
  if (typeof outDir !== "string" || !isConfinedRelative(outDir) || !Array.isArray(entries)) return undefined
  const decoded: Array<ManifestEntry> = []
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return undefined
    const path = (entry as { readonly path?: unknown }).path
    const kind = (entry as { readonly kind?: unknown }).kind
    const digest = (entry as { readonly digest?: unknown }).digest
    const executable = (entry as { readonly executable?: unknown }).executable
    const target = (entry as { readonly target?: unknown }).target
    if (
      typeof path !== "string" || !safeManifestPath.test(path) || !isConfinedRelative(path) ||
      (kind !== "file" && kind !== "link") ||
      typeof digest !== "string" ||
      (kind === "file" && !isSha256Hex(digest)) ||
      typeof executable !== "boolean" ||
      typeof target !== "string" ||
      (kind === "link" && !isConfinedLinkTarget(target))
    ) return undefined
    decoded.push({ path, kind, digest, executable, target })
  }
  return { outDir, entries: decoded }
}

/**
 * Verifies every blob a manifest names, returning the first problem or
 * undefined when the store can materialize the whole tree.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const verifyManifestBlobs = async (
  root: string,
  cacheDirectory: string,
  manifest: OutDirManifest
): Promise<string | undefined> => {
  const cas = casDirectory(root, cacheDirectory)
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue
    const blob = NodePath.join(cas, entry.digest)
    let digest: string
    try {
      digest = await digestFileBytes(blob)
    } catch {
      return `cas blob missing for ${manifest.outDir}/${entry.path}`
    }
    if (digest !== entry.digest) return `cas blob tampered for ${manifest.outDir}/${entry.path}`
  }
  return undefined
}

/** Restores a destination-owned backup while its publication lock is held. */
const recoverStrandedTree = async (parent: string, absolute: string, owner: string): Promise<void> => {
  try {
    await Fs.lstat(absolute)
    return
  } catch (cause) {
    if (errno(cause) !== "ENOENT") throw cause
  }
  const oldTrees = (await Fs.readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`.smthrs-old-${owner}-`))
  // Never infer ownership of legacy generic names or sibling backups. More
  // than one owned backup is ambiguous too, so leave those for an operator.
  if (oldTrees.length === 1) await Fs.rename(NodePath.join(parent, oldTrees[0]!.name), absolute)
}

/**
 * Materializes one manifest tree by fully staging a sibling, then publishing
 * with two renames. Replacing an existing output has a brief absence window;
 * readers must coordinate with publishers when they require continuous
 * visibility. A failed publication rename attempts rollback; if rollback also
 * fails, the error identifies the preserved backup.
 *
 * A destination-specific filesystem lock excludes competing publishers and
 * protects recovery of that destination's backup. Contention fails immediately.
 * After a process crash, remove its stranded lock only after confirming the
 * publisher has stopped, then retry to recover its uniquely owned backup.
 * Legacy unowned backups and ambiguous backups are left for an operator.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const materializeManifest = async (
  root: string,
  cacheDirectory: string,
  manifest: OutDirManifest
): Promise<void> => {
  const cas = casDirectory(root, cacheDirectory)
  const absolute = NodePath.join(root, ...manifest.outDir.split("/"))
  const parent = NodePath.dirname(absolute)
  await confinedAncestor(root, absolute, manifest.outDir)
  await Fs.mkdir(parent, { recursive: true })
  await confinedParent(root, absolute, manifest.outDir)
  // Canonicalize the parent so alternate workspace paths share one lock and
  // backup namespace, without following an existing output-root symlink.
  const owner = createHash("sha256")
    .update(NodePath.join(await Fs.realpath(parent), NodePath.basename(absolute)))
    .digest("hex")
  const stamp = tempToken()
  const temp = NodePath.join(parent, `.smthrs-mat-${owner}-${stamp}`)
  const lock = NodePath.join(parent, `.smthrs-lock-${owner}`)
  try {
    await Fs.mkdir(lock)
  } catch (cause) {
    if (errno(cause) !== "EEXIST") throw cause
    throw new Error(`materialize publication lock exists for ${manifest.outDir}: ${lock}`, { cause })
  }
  try {
    await recoverStrandedTree(parent, absolute, owner)
    await Fs.mkdir(temp, { recursive: true })
    // The temp tree is a sibling of the destination, so proving every entry
    // stays under `tempReal` proves nothing if `tempReal` itself already left
    // the workspace through a symlinked output parent.
    await confinedParent(root, temp, manifest.outDir)
    const tempReal = await Fs.realpath(temp)
    for (const entry of manifest.entries) {
      const destination = NodePath.join(temp, ...entry.path.split("/"))
      const parentDirectory = NodePath.dirname(destination)
      await Fs.mkdir(parentDirectory, { recursive: true })
      // Confine every write to the temp tree. `decodeManifest` already refuses
      // `..` and absolute paths and link targets, but a poisoned manifest that
      // slipped a symlink entry ahead of a file entry beneath it would have the
      // file written through the link; resolving the real parent and checking
      // it stays under the temp root closes that write-through path regardless.
      const realParent = await Fs.realpath(parentDirectory)
      if (!Path.contains(tempReal, realParent)) {
        throw new Error(`materialize refused a path that leaves the outDir: ${entry.path}`)
      }
      if (entry.kind === "link") {
        await Fs.symlink(entry.target, destination)
      } else {
        await Fs.copyFile(NodePath.join(cas, entry.digest), destination)
        await Fs.chmod(destination, entry.executable ? 0o755 : 0o644)
      }
    }
    const old = NodePath.join(parent, `.smthrs-old-${owner}-${stamp}`)
    let hadOld = false
    try {
      await Fs.rename(absolute, old)
      hadOld = true
    } catch (cause) {
      // Only "it was not there" is tolerated. Treating every failure as absence
      // set `hadOld` false on a permission or I/O error, and the rename below
      // then failed against a directory that was still there, with the real
      // reason long since swallowed.
      const code = (cause as NodeJS.ErrnoException | null)?.code
      if (code !== "ENOENT") throw cause
    }
    try {
      await Fs.rename(temp, absolute)
    } catch (cause) {
      // The swap is the publication point. Without this, a failure here left
      // the declared output absent and the previous tree stranded beside it as
      // `.smthrs-old-<destination>-<stamp>`, which is worse than either the old
      // state or the new one.
      if (hadOld) {
        try {
          await Fs.rename(old, absolute)
        } catch (restoreCause) {
          throw new Error(
            `materialize could not publish ${manifest.outDir} and could not restore the previous tree from ${old}`,
            { cause: restoreCause }
          )
        }
      }
      throw cause
    }
    await syncForPublish(parent)
    if (hadOld) await Fs.rm(old, { recursive: true, force: true })
  } catch (cause) {
    await Fs.rm(temp, { recursive: true, force: true }).catch(() => {})
    throw cause
  } finally {
    await Fs.rmdir(lock).catch(() => {})
  }
}

/**
 * Compares one manifest against the current working tree, returning the first
 * difference or undefined when the tree matches it exactly.
 *
 * "Exactly" is what the caller acts on: `PackageExec` skips materialization
 * entirely when this answers undefined. Iterating only the manifest's own
 * entries and comparing only kind and digest therefore let a stale extra file
 * from a previous build and a lost or gained executable bit survive a cache hit
 * into the declared output tree. The tree is enumerated with the same no-follow
 * policy the capture uses, and the file and symlink sets are compared both
 * ways.
 *
 * A manifest omits directories, so their exact set is derived from every
 * entry's ancestors plus the outDir root. Any other directory is stale output
 * and makes the tree differ.
 *
 * @category artifacts
 * @since 0.1.0
 */
export const treeMatchesManifest = async (
  root: string,
  manifest: OutDirManifest
): Promise<string | undefined> => {
  const absolute = NodePath.join(root, ...manifest.outDir.split("/"))
  for (const entry of manifest.entries) {
    const state = await statePath(NodePath.join(absolute, ...entry.path.split("/")))
    if (entry.kind === "link") {
      if (state.kind !== "link" || state.target !== entry.target) {
        return `${manifest.outDir}/${entry.path} does not match the captured symlink`
      }
    } else if (state.kind !== "file" || state.digest !== entry.digest) {
      return `${manifest.outDir}/${entry.path} does not match the captured content`
    } else if (((state.mode & 0o111) !== 0) !== entry.executable) {
      return `${manifest.outDir}/${entry.path} does not match the captured mode`
    }
  }
  const declared = new Set(manifest.entries.map((entry) => entry.path))
  const declaredDirectories = new Set<string>([""])
  for (const entry of manifest.entries) {
    const segments = entry.path.split("/")
    segments.pop()
    let directory = ""
    for (const segment of segments) {
      directory = directory === "" ? segment : `${directory}/${segment}`
      declaredDirectories.add(directory)
    }
  }
  let extra: string | undefined
  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (extra !== undefined) return
    if (depth > outDirLimits.depth) {
      extra ??= `${manifest.outDir}/${relative} is deeper than the captured tree`
      return
    }
    let names: Array<NodeFs.Dirent>
    try {
      names = await Fs.readdir(directory, { withFileTypes: true })
    } catch {
      // A tree that cannot be read cannot be proven to match.
      extra ??= `${manifest.outDir}/${relative} could not be read`
      return
    }
    for (const entry of names.sort((left, right) => byCodeUnit(left.name, right.name))) {
      if (extra !== undefined) return
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!declaredDirectories.has(childRelative)) {
          extra ??= `${manifest.outDir}/${childRelative} is not in the captured tree`
          return
        }
        await walk(NodePath.join(directory, entry.name), childRelative, depth + 1)
        continue
      }
      if (!declared.has(childRelative)) {
        extra ??= `${manifest.outDir}/${childRelative} is not in the captured tree`
      }
    }
  }
  await walk(absolute, "", 0)
  return extra
}
