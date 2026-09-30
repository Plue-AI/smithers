/**
 * Node.js `Jj` layer for programs that snapshot and restore workspace state.
 *
 * The exported layers satisfy the platform-independent `Jj` service by shelling
 * out to the `jj` CLI. There are two, and the difference between them is who
 * owns the child process:
 *
 * - {@link layer} spawns through `node:child_process` directly. `jj`
 *   invocations are argv arrays with no shell interpretation, and a host must
 *   be able to checkpoint work even where a spawner is unavailable, sandboxed,
 *   or gated behind a `proc:spawn` grant the user has not given.
 * - {@link layerSpawner} spawns through Effect's `ChildProcessSpawner`, so a
 *   host that decorates that service decorates jj as well. That is what puts a
 *   jj child in its own process group, in `@smthrs/kernel`'s `ProcessLedger`,
 *   and within reach of the reaper that sweeps a crashed incarnation: a
 *   `jj snapshot` that hangs is otherwise a process no host can account for.
 *   `@smthrs/platform-node`'s contained host bundle uses this one.
 *
 * Both await a version probe through their operation runner before exposing
 * `Jj`, sharing its result per absolute executable path and runner. All later
 * operations use that same path, independent of repository cwd or PATH changes.
 *
 * Errors are classified from `jj`'s own stderr vocabulary onto the stable
 * `JjError` codes, the same way `NodeFileSystem` classifies errno, and both
 * layers share that classification.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as EffectChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as ChildProcess from "node:child_process"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { quoteGitPatchPaths } from "../internal/gitPatchPaths.ts"
import { isJjError, Jj, JjError, jjErrorCause } from "../Jj.ts"
import { resolveJjBinary } from "./resolveJjBinary.ts"

/** The `module` every failure this adapter produces names. */
const MODULE = "NodeJj"

/** The pin's compensating forget must not keep a cancelled caller waiting forever. */
const workspaceCleanupTimeoutMs = 5_000

/**
 * Minimum jj CLI version supported by the Node and Bun adapters.
 * Git patch path quoting is repaired by the shared adapter for 0.39.0.
 *
 * @category constants
 * @since 1.0.0
 */
export const minimumVersion = "0.39.0"

/**
 * Milliseconds a layer waits for its startup version probe, before cleanup.
 * Provide this reference to a layer to override the 5000 ms default. Values
 * must be positive, finite, and within the host timer range (2147483647 ms).
 *
 * @category configuration
 * @since 1.0.0
 */
export const StartupTimeoutMs = Context.Reference<number>("@smthrs/jj/NodeJj/StartupTimeoutMs", {
  defaultValue: () => 5_000
})

interface Output {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  /** The signal that terminated the child, when no exit code did. */
  readonly signal: NodeJS.Signals | null
}

/**
 * The argv rendered back as the command a human would have typed, bounded so a
 * caller-supplied `snapshot` message cannot drag an arbitrary payload into a
 * journaled error.
 */
const commandLimit = 512

const commandOf = (args: ReadonlyArray<string>): string => {
  const command = `jj ${args.join(" ")}`
  // The ellipsis is part of the budget, so a recorded command never exceeds the
  // limit this module names.
  return command.length > commandLimit ? `${command.slice(0, commandLimit - 1)}…` : command
}

/**
 * jj's revision vocabulary, anchored so a diagnostic about a PATH rather than a
 * revision is not read as one.
 *
 * `Path doesn't exist` and `Revision "x" doesn't exist` are both jj sentences;
 * only the second is `invalid_ref`, which `Jj.ts` defines as "the change id or
 * revision does not resolve". The wasm layer's own wording is
 * `revision "x" doesn't exist` (`crates/flows-jj/src/ops.rs`), and the codes are
 * durable identity in journals, so the two layers must agree.
 */
const REVISION_VOCABULARY = [
  /no such revision/,
  /revision not found/,
  /failed to parse revset/,
  /\b(?:revision|change)\b[^\n]*doesn't exist/,
  /no operation id matching/,
  // `exactly(commit_id(x), 1)` matching nothing, or an ambiguous prefix.
  /the revset has (?:fewer|more) than the expected/
]

/**
 * jj's conflict vocabulary, matched only on a line jj itself opened as a
 * diagnostic and only where `conflict` is a whole word.
 *
 * A bare `text.includes("conflict")` reads a ref named `conflict-fix` or a path
 * named `docs/conflict-resolution.md` as a conflicted repository, and it did so
 * ahead of the revision vocabulary, so a genuinely invalid ref was journaled
 * under the wrong durable code. The trailing guard is what excludes those: a
 * path or ref continues into `-`, `.`, `/`, or another word character, while a
 * sentence about conflicts does not.
 *
 * `Caused by:` is anchored as well as `Error:` because jj prints an error chain
 * and the conflict half is often the inner line.
 */
const CONFLICT_VOCABULARY = /^(?:error|caused by):[^\n]*conflict(?:s|ed|ing)?(?![\w./-])/m

const SNAPSHOT_REFUSAL = /^Warning: Refused to snapshot some files:/im

const refusedFiles = (stderr: string): boolean => SNAPSHOT_REFUSAL.test(stripVTControlCharacters(stderr))

const classify = (method: string, args: ReadonlyArray<string>, output: Output): JjError => {
  // jj reports on stderr; the stdout fallback is for a build that reports there
  // instead. Concatenating both let one stream's incidental wording outrank the
  // other's diagnosis. A child with NOTHING to report — the OS or an operator
  // killed it before it printed — still owes the journal how it ended: a signal
  // death as the signal, a silent nonzero exit as the code.
  const reported = output.stderr.trim() || output.stdout.trim() ||
    (output.signal !== null ? `terminated by signal ${output.signal}` : `exited with code ${output.exitCode}`)
  const text = reported.toLowerCase()
  const code: JjError["code"] = refusedFiles(output.stderr)
    ? "snapshot_refused"
    : REVISION_VOCABULARY.some((pattern) => pattern.test(text))
    ? "invalid_ref"
    : CONFLICT_VOCABULARY.test(text)
    ? "conflict"
    : "unknown"
  return new JjError({
    code,
    module: MODULE,
    method,
    command: commandOf(args),
    message: `jj ${method}: ${reported}`
  })
}

/**
 * A revision this adapter hands to jj: `@`, `@-`, a hex commit id (prefix), or a
 * reverse-hex change id (prefix). Anything else is refused before argv exists.
 *
 * jj reads a revision argument as a revset, so an unchecked string such as
 * `root()` or `x) | root() | (x` would restore, diff, revert, or pin a lane to
 * a tree other than the one the journal recorded.
 */
const REVISION_SHAPE = /^(?:@-?|[0-9a-f]+|[k-z]+)$/

/**
 * The revset for one validated revision. An id is wrapped in `commit_id()` or
 * `change_id()` because a bare symbol resolves a bookmark or tag of the same
 * name first, and anyone who can write the repository can create one named
 * after a recorded commit id. A `revset-aliases` entry can still redefine
 * `commit_id(x)`; the adapter refuses to run while the checkout holds config jj
 * would import ({@link unmigratedConfig}), so only config already in jj's
 * trusted store, which the operator controls, can do that. `exactly(…, 1)` keeps an ambiguous prefix or a
 * divergent change from widening to several revisions, as the wasm layer's
 * `resolve_revision` (`crates/flows-jj`) refuses both.
 */
const revsetOf = (revision: string): string =>
  revision.startsWith("@")
    ? revision
    : `exactly(${/^[0-9a-f]+$/.test(revision) ? "commit_id" : "change_id"}(${revision}), 1)`

/**
 * Mirrors the wasm layer's guard in `resolve_revision` (`crates/flows-jj`):
 * an empty revision string is `invalid_ref` before anything is spawned —
 * `jj`'s own answer would be a clap usage error that classifies `unknown`,
 * and the two layers must agree on durable error identity. A string that is
 * not a revision shape ({@link REVISION_SHAPE}) is refused the same way.
 */
const requireRevision = (method: string, command: string, revision: string): Effect.Effect<string, JjError> =>
  REVISION_SHAPE.test(revision)
    ? Effect.succeed(revsetOf(revision))
    : Effect.fail(
      new JjError({
        code: "invalid_ref",
        module: MODULE,
        method,
        // The refusal lands before any argv exists, so the command is the one
        // the operation WOULD have run. A failure without it would be the only
        // one this adapter produces that a caller cannot attribute.
        command,
        message: revision.length === 0
          ? `jj ${method}: empty revision string`
          : `jj ${method}: ${JSON.stringify(revision.slice(0, 80))} is not a commit id or change id`
      })
    )

/** The absolute executable selected once for a layer and its diagnostic hint. */
interface Binary {
  readonly command: string
  readonly hint?: string | undefined
}

const notInstalledMessage = (hint: string | undefined): string =>
  hint === undefined ? "jj: command not found on PATH" : `jj: ${hint}`

/** Whether a directory a child would be started in can actually be used. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The directory a command should run in for a path that may name a file. */
const directoryOf = (from: string): string => {
  try {
    return statSync(from).isDirectory() ? from : dirname(from)
  } catch {
    // Nothing is there. Pass it through so the spawn failure names it.
    return from
  }
}

/** Strips the terminal line ending a command prints, and nothing else. */
const stripLineEnding = (output: string): string => output.replace(/\r?\n$/, "")

/**
 * A spawn that never produced a process, as a typed failure.
 *
 * A bad working directory is reported ahead of everything else because it makes
 * every other diagnosis unreliable: `spawn(jj, { cwd })` reports a MISSING
 * directory as `ENOENT` — indistinguishable from a missing binary — and a cwd
 * that is a file as a synchronous `ENOTDIR` throw, so `layerAt` pointed at a
 * directory that is gone would otherwise report that jj is not installed while
 * jj sits on `PATH`.
 */
const spawnFailure = (
  method: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  hint: string | undefined,
  cause: unknown,
  missingBinary: boolean
): JjError => {
  const shared = { module: MODULE, method, command: commandOf(args), cause: jjErrorCause(cause) }
  if (cwd !== undefined && !isDirectory(cwd)) {
    return new JjError({ ...shared, code: "unknown", message: `jj ${method}: cannot run in ${cwd}: not a directory` })
  }
  return missingBinary
    ? new JjError({ ...shared, code: "not_installed", message: notInstalledMessage(hint) })
    : new JjError({ ...shared, code: "unknown", message: `jj ${method}: ${shared.cause.message}` })
}

/**
 * How many BYTES of one stream a single `jj` invocation may buffer.
 *
 * The engine is a long-lived process and a child's output is unbounded, so a
 * command that never stops printing would otherwise be a memory leak no caller
 * can see. The ceiling is far above anything jj prints for a working copy a
 * step snapshots — a `jj diff --git` of a very large change is single-digit
 * megabytes — so reaching it means the output is not one a run can journal
 * anyway, and a named failure is a better answer than an exhausted host.
 *
 * It is counted in bytes, before decoding, so the bound is the same for a diff
 * of Japanese source as for one of ASCII: counting decoded characters would let
 * three-byte code points through at three times the promised size.
 */
const outputLimit = 64 * 1024 * 1024

/** The one wording both runners use when a child outran {@link outputLimit}. */
const outputTooLarge = (method: string, args: ReadonlyArray<string>): JjError =>
  new JjError({
    code: "unknown",
    module: MODULE,
    method,
    command: commandOf(args),
    message: `jj ${method}: output exceeded the ${outputLimit}-byte ceiling`
  })

interface RepositoryLock {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

const repositoryLocks = new Map<string, RepositoryLock>()
const lockName = "smithers.lock"
const lockAcquireWithinMs = 120_000

const errnoIs = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

const lockFailure = (method: string, cause: unknown): JjError =>
  new JjError({
    code: "unknown",
    module: MODULE,
    method,
    command: `jj ${method}`,
    cause: jjErrorCause(cause),
    message: `jj ${method}: repository lock failed: ${jjErrorCause(cause).message}`
  })

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return !errnoIs(cause, "ESRCH")
  }
}

/** Canonicalize aliases so layers rooted at a nested path or symlink share a permit. */
const workspaceRootOf = (from: string): string | undefined => {
  let directory = resolve(from)
  for (;;) {
    if (isDirectory(join(directory, ".jj"))) return realpathSync(directory)
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Remove only this unique owner's entry, then remove the directory IF empty.
 * Another claimant may already have replaced the empty directory with its own
 * populated one; rmdir cannot delete that live lock. A read-then-unlink of a
 * single lock file would instead let two stale-lock reclaimers delete a new owner.
 */
const removeLockOwner = async (lockPath: string, owner: string): Promise<void> => {
  try {
    await unlink(join(lockPath, owner))
  } catch (cause) {
    if (!errnoIs(cause, "ENOENT")) throw cause
  }
  try {
    await rmdir(lockPath)
  } catch (cause) {
    if (!errnoIs(cause, "ENOENT") && !errnoIs(cause, "ENOTEMPTY") && !errnoIs(cause, "EEXIST")) throw cause
  }
}

const reclaimDeadLock = async (lockPath: string): Promise<void> => {
  try {
    const owners = await readdir(lockPath)
    for (const owner of owners) {
      const match = /^(.*)-(\d+)-[^-]+$/.exec(owner)
      if (match !== null && match[1] === hostname() && !processIsAlive(Number(match[2]))) {
        await removeLockOwner(lockPath, owner)
      }
    }
  } catch (cause) {
    if (!errnoIs(cause, "ENOENT")) throw cause
  }
}

/**
 * Publish a populated directory with one atomic rename. No contender can see a
 * half-written owner record, and rename cannot replace a populated live lock.
 * Temporary candidates left by a killed process do not block future callers.
 */
const withLockFile = <A, E, R>(
  method: string,
  lockPath: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | JjError, R> => {
  const io = <T>(run: () => Promise<T>) => Effect.tryPromise({ try: run, catch: (cause) => lockFailure(method, cause) })
  const cleanup = (run: () => Promise<unknown>) =>
    io(run).pipe(Effect.catch((failure) => Effect.logWarning("Failed to release the jj repository lock", failure)))
  return Effect.acquireUseRelease(
    io(() => mkdtemp(join(dirname(lockPath), ".smithers-lock-"))),
    (candidate) =>
      Effect.gen(function*() {
        const owner = `${hostname()}-${process.pid}-${candidate.slice(candidate.lastIndexOf("-") + 1)}`
        yield* io(() => writeFile(join(candidate, owner), "", { flag: "wx", mode: 0o600 }))
        const acquire = Effect.gen(function*() {
          const startedAt = Date.now()
          for (;;) {
            const claimed = yield* io(async () => {
              try {
                await rename(candidate, lockPath)
                return true
              } catch (cause) {
                if (!errnoIs(cause, "ENOTEMPTY") && !errnoIs(cause, "EEXIST")) throw cause
                await reclaimDeadLock(lockPath)
                return false
              }
            })
            if (claimed) return
            if (Date.now() - startedAt >= lockAcquireWithinMs) {
              return yield* Effect.fail(lockFailure(method, new Error("timed out waiting for another jj operation")))
            }
            // Only the wait is interruptible: acquisition and registration of
            // its finalizer must be inseparable, or cancellation leaks a lock.
            yield* Effect.interruptible(Effect.sleep("25 millis"))
          }
        })
        return yield* Effect.acquireUseRelease(acquire, () =>
          effect, () =>
          cleanup(() => removeLockOwner(lockPath, owner)))
      }),
    (candidate) => cleanup(() => rm(candidate, { recursive: true, force: true }))
  )
}

/**
 * The repository store every workspace of one repository shares. The first
 * workspace holds it as `.jj/repo`; every later one holds a file naming it,
 * relative to that workspace's `.jj`.
 */
const repositoryStoreOf = (root: string): string => {
  const store = join(root, ".jj", "repo")
  return realpathSync(isDirectory(store) ? store : resolve(root, ".jj", readFileSync(store, "utf8").trim()))
}

/** One in-process permit and one on-disk lock per key. */
const withLock = <A, E, R>(
  method: string,
  key: string,
  lockPath: string | undefined,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | JjError, R> => {
  let entry = repositoryLocks.get(key)
  if (entry === undefined) {
    entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
    repositoryLocks.set(key, entry)
  }
  entry.users += 1
  const held = entry
  return held.semaphore.withPermit(lockPath === undefined ? effect : withLockFile(method, lockPath, effect)).pipe(
    Effect.ensuring(Effect.sync(() => {
      held.users -= 1
      if (held.users === 0) repositoryLocks.delete(key)
    }))
  )
}

/** Fibers and independently constructed layers share a permit per workspace. */
const withRepositoryLock = <A, E, R>(
  method: string,
  from: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | JjError, R> =>
  Effect.suspend(() => {
    const root = workspaceRootOf(from)
    return withLock(
      method,
      `workspace:${root ?? resolve(from)}`,
      root === undefined ? undefined : join(root, ".jj", lockName),
      effect
    )
  })

/**
 * Every workspace of one repository shares a permit for changes to which
 * workspaces exist. Taken only while the workspace permit is held, so the two
 * are always acquired in the same order.
 */
const withStoreLock = <A, E, R>(
  method: string,
  from: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | JjError, R> =>
  Effect.suspend(() => {
    const root = workspaceRootOf(from)
    if (root === undefined) return withLock(method, `store:${resolve(from)}`, undefined, effect)
    return Effect.flatMap(
      Effect.try({ try: () => repositoryStoreOf(root), catch: (cause) => lockFailure(method, cause) }),
      (store) => withLock(method, `store:${store}`, join(store, lockName), effect)
    )
  })

/**
 * Overrides every Node and Bun jj command carries so repository config cannot
 * start a program on the host. `--config` outranks every config file.
 *
 * `signing.behavior=drop` stops jj from signing: `keep` still re-signs a
 * rewritten commit that was already signed, which a snapshot of a signed `@`
 * does. Each signing backend's program is pinned to `/dev/null`, which cannot
 * be executed, because jj also starts the backend program to VERIFY a
 * signature whenever a template asks for one, and a template alias can ask.
 * The cost is that a commit this adapter rewrites comes out unsigned.
 */
const HOST_ONLY_CONFIG: ReadonlyArray<string> = [
  "--config",
  "signing.behavior=drop",
  "--config",
  "signing.backends.gpg.program=/dev/null",
  "--config",
  "signing.backends.gpgsm.program=/dev/null",
  "--config",
  "signing.backends.ssh.program=/dev/null",
  "--config",
  "fsmonitor.backend=none"
]

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The legacy config file jj would import from inside the checkout on its next
 * command, or `undefined` when there is none.
 *
 * jj keeps repository and workspace config in the user's config directory,
 * keyed by `.jj/repo/config-id` and `.jj/workspace-config-id`. When an id file
 * is missing and the legacy `.jj/repo/config.toml` or
 * `.jj/workspace-config.toml` exists, jj migrates that file into its trusted
 * store. Both files are writable by whatever runs in the checkout, so a planted
 * file would supply signing programs, revset aliases that make
 * `commit_id(x)` resolve to `root()`, and template aliases that rewrite what
 * `snapshot` reads. The workspace is found the way jj finds it: the nearest
 * ancestor holding a `.jj` directory. A secondary workspace's `.jj/repo` is a
 * file naming the repository directory relative to its `.jj`.
 *
 * The check runs just before the spawn, so a writer that races it can still
 * slip a file past; {@link HOST_ONLY_CONFIG} keeps that race from starting a
 * program, but aliases would apply to that one command.
 */
const unmigratedConfig = (directory: string): string | undefined => {
  let current = resolve(directory)
  for (;;) {
    const dotJj = join(current, ".jj")
    if (isDirectory(dotJj)) {
      if (isFile(join(dotJj, "workspace-config.toml")) && !isFile(join(dotJj, "workspace-config-id"))) {
        return join(dotJj, "workspace-config.toml")
      }
      let repository = join(dotJj, "repo")
      if (isFile(repository)) {
        try {
          repository = resolve(dotJj, stripLineEnding(readFileSync(repository, "utf8")))
        } catch {
          return undefined
        }
      }
      return isFile(join(repository, "config.toml")) && !isFile(join(repository, "config-id"))
        ? join(repository, "config.toml")
        : undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Refuses a command in a checkout whose `.jj` holds config jj would import.
 * An operator who wrote that file themselves runs any jj command once to
 * migrate it; the engine never does so on the checkout's behalf.
 */
const refuseUnmigratedConfig = (
  method: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined
): Effect.Effect<void, JjError> =>
  Effect.suspend(() => {
    const planted = unmigratedConfig(cwd ?? process.cwd())
    return planted === undefined ? Effect.void : Effect.fail(
      new JjError({
        code: "unknown",
        module: MODULE,
        method,
        command: commandOf(args),
        message: `jj ${method}: refusing to run with unmigrated repository config ${planted}; `
          + "jj would import it from the checkout. Review it, then run any jj command yourself to migrate it"
      })
    )
  })

/** How one `jj` invocation reaches the operating system. */
type Run = (method: string, args: ReadonlyArray<string>, cwd?: string) => Effect.Effect<string, JjError>

/** Turns a finished invocation into either its stdout or a classified failure. */
const settle = (method: string, args: ReadonlyArray<string>, output: Output): Effect.Effect<string, JjError> =>
  output.exitCode === 0 && !refusedFiles(output.stderr)
    ? Effect.succeed(output.stdout)
    : Effect.fail(classify(method, args, output))

/** Runs `jj` with argv (never a shell string) in `cwd`. */
const jj = (binary: Binary): Run => (method, args, cwd) =>
  Effect.callback<Output, JjError>((resume) => {
    const { command, hint } = binary
    let child: ChildProcess.ChildProcess
    try {
      // `node:child_process` delivers only EACCES, EAGAIN, EMFILE, ENFILE, and
      // ENOENT as an `error` event and THROWS every other spawn failure, so an
      // argument carrying a NUL byte or a `cwd` that is a file would leave the
      // typed channel as a defect no caller of `Jj` can catch.
      child = ChildProcess.spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] })
    } catch (cause) {
      resume(Effect.fail(spawnFailure(method, args, cwd, hint, cause, false)))
      return Effect.void
    }
    let stdout = ""
    let stderr = ""
    // The first outcome wins. Stopping an over-talkative child makes its
    // `close` arrive after the invocation has already failed, and a spawn
    // `error` is followed by a `close` of its own.
    let settled = false
    const finish = (outcome: Effect.Effect<Output, JjError>): void => {
      if (settled) return
      settled = true
      resume(outcome)
    }
    // `setEncoding` puts Node's own `StringDecoder` on the stream, so a
    // multibyte code point split across two chunks decodes once rather than
    // becoming two replacement characters. `layerSpawner` gets that property
    // from `Stream.decodeText`, and the two layers must not disagree.
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    // Past the ceiling the child is stopped rather than read further: leaving
    // it running would keep filling a buffer nobody will ever look at. The
    // count is of BYTES received, not of decoded characters, so it matches the
    // spawner runner, which counts before it decodes.
    let stdoutBytes = 0
    let stderrBytes = 0
    const bound = (bytes: number): void => {
      if (bytes <= outputLimit) return
      child.kill("SIGKILL")
      finish(Effect.fail(outputTooLarge(method, args)))
    }
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
      stdoutBytes += Buffer.byteLength(chunk, "utf8")
      bound(stdoutBytes)
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
      stderrBytes += Buffer.byteLength(chunk, "utf8")
      bound(stderrBytes)
    })
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(Effect.fail(spawnFailure(method, args, cwd, hint, error, error.code === "ENOENT"))))
    child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) =>
      // The signal is half the termination diagnosis: a killed child has a null
      // exit code, and discarding the signal leaves a silent kill with an empty
      // error message (review finding flows-jj/robustness/2).
      finish(Effect.succeed({ stdout, stderr, exitCode: exitCode ?? 1, signal })))
    return Effect.callback<void>((done) => {
      settled = true
      // Close our pipes even if a wrapper left a descendant holding its ends.
      // Await the direct child's close event so cancellation does not return
      // while that child is still alive.
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        done(Effect.void)
        return
      }
      child.once("close", () =>
        done(Effect.void))
      child.kill("SIGKILL")
    })
  }).pipe(Effect.flatMap((output) =>
    settle(method, args, output)
  ))

/**
 * Runs `jj` through a `ChildProcessSpawner`.
 *
 * The classification is the same as {@link jj}'s, including the `not_installed`
 * answer: a spawner reports a missing binary as a `NotFound` `PlatformError`,
 * which is `ENOENT` with a different name on it.
 */
const viaSpawner = (spawner: ChildProcessSpawner["Service"]) => (binary: Binary): Run => (method, args, cwd) =>
  Effect.suspend(() => {
    const { command, hint } = binary
    /**
     * One stream as text, refused rather than buffered past
     * {@link outputLimit}. `Stream.mkString` is as unbounded as string
     * concatenation is, and the two layers owe callers the same answer.
     *
     * The bytes are counted BEFORE `decodeText`, which is both the honest
     * measure of what arrived and the same thing the direct runner counts.
     */
    const boundedText = (
      stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>
    ): Effect.Effect<string, PlatformError.PlatformError | JjError> => {
      let bytes = 0
      return Stream.mkString(
        Stream.decodeText(
          Stream.mapEffect(stream, (chunk) => {
            bytes += chunk.length
            return bytes > outputLimit ? Effect.fail(outputTooLarge(method, args)) : Effect.succeed(chunk)
          })
        )
      )
    }
    return Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(
          EffectChildProcess.make(command, [...args], cwd === undefined ? {} : { cwd })
        )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [boundedText(handle.stdout), boundedText(handle.stderr), handle.exitCode],
          { concurrency: 3 }
        )
        // A `ChildProcessSpawner` handle reports only an exit code, so the
        // signal half of the diagnosis is not this runner's to name.
        return { stdout, stderr, exitCode, signal: null }
      })
    ).pipe(
      Effect.catch((error: PlatformError.PlatformError | JjError) =>
        Effect.fail(
          isJjError(error)
            ? error
            : spawnFailure(method, args, cwd, hint, error, error.reason._tag === "NotFound")
        )
      ),
      Effect.flatMap((output) => settle(method, args, output))
    )
  })

// == operations

/**
 * Every `Jj` operation over one way of running `jj`.
 *
 * The two layers below differ only in the `run` they are given, so the
 * command vocabulary and the error classification have exactly one definition:
 * a jj child that goes through a host spawner must behave the same as one that
 * does not, or the containment story would be bought with a behavior change.
 */
const operations = (spawn: Run, repositoryRoot?: string) => {
  const run: Run = (method, args, cwd) =>
    Effect.flatMap(refuseUnmigratedConfig(method, args, cwd ?? repositoryRoot), () => spawn(method, args, cwd))
  const inRepository = (method: string, args: ReadonlyArray<string>) => {
    // jj can snapshot on any repository command. Keep global options before
    // the positional delimiter used to protect opaque workspace names.
    // `--color=never` overrides a user's `ui.color = "always"`, which would
    // otherwise wrap change ids and diffs in ANSI escapes.
    const delimiter = args.indexOf("--")
    const at = delimiter === -1 ? args.length : delimiter
    return run(
      method,
      [
        ...args.slice(0, at),
        "--color=never",
        "--config",
        "snapshot.max-new-file-size=0",
        ...HOST_ONLY_CONFIG,
        ...args.slice(at)
      ],
      repositoryRoot
    )
  }
  /**
   * Fences one working-copy operation on the workspace it runs in.
   *
   * The bound root is the workspace when there is one; an unbound layer runs
   * jj in the caller's working directory, so that is where the fence looks.
   */
  const repositoryCritical = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => withRepositoryLock(method, repositoryRoot ?? process.cwd(), effect))

  /**
   * Fences a change to which workspaces exist, or a restore that would drop
   * one, against the same change from any workspace of the repository.
   */
  const registrationCritical = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
    repositoryCritical(method, Effect.suspend(() => withStoreLock(method, repositoryRoot ?? process.cwd(), effect)))

  /**
   * Capture the working copy without closing a change.
   *
   * `jj op log` snapshots the working copy and names the operation that holds
   * it; `jj log --at-op` then reads `@` at exactly that operation, so the
   * commit and the operation name the same capture even if another process
   * operates on the repository in between. Nothing is committed, described,
   * or opened: a compensable attempt leaves no change of its own in the log.
   * The commit id stays resolvable after later edits rewrite `@`, because jj
   * keeps every commit an operation references. `message` is not written to
   * the repository; the engine keeps its label in the journal.
   */
  const snapshot = (_message?: string) =>
    repositoryCritical(
      "snapshot",
      Effect.gen(function*() {
        const operationId = (yield* inRepository("snapshot", ["op", "log", "-n1", "--no-graph", "-T", "id"])).trim()
        const output = yield* inRepository("snapshot", [
          "log",
          `--at-op=${operationId}`,
          "-r",
          "@",
          "--no-graph",
          "-T",
          "commit_id ++ \"\\n\" ++ change_id.short()"
        ])
        const [commitId = "", changeId = ""] = output.split("\n").map((line) => line.trim())
        // Template aliases can rewrite what these templates print. A value that
        // is not an id is refused here instead of being journaled as one.
        if (!/^[0-9a-f]+$/.test(commitId) || !/^[k-z]+$/.test(changeId) || !/^[0-9a-f]+$/.test(operationId)) {
          return yield* Effect.fail(
            new JjError({
              code: "unknown",
              module: MODULE,
              method: "snapshot",
              command: "jj log",
              message: `jj snapshot: ${JSON.stringify(output.slice(0, 200))} and operation `
                + `${JSON.stringify(operationId.slice(0, 200))} are not a commit id, change id, and operation id`
            })
          )
        }
        return { commitId, changeId, operationId }
      })
    )

  const restore = (revision: string) =>
    Effect.asVoid(
      Effect.flatMap(
        requireRevision("restore", "jj restore", revision),
        (revision) => repositoryCritical("restore", inRepository("restore", ["restore", "--from", revision]))
      )
    )

  const diff = (from: string, to: string) =>
    Effect.flatMap(
      Effect.all([requireRevision("diff", "jj diff", from), requireRevision("diff", "jj diff", to)]),
      ([fromRevision, toRevision]) =>
        repositoryCritical(
          "diff",
          Effect.gen(function*() {
            // Pin both reads before resolving moving refs such as @. Neither
            // a later file write nor an external jj operation may change the
            // paths between rendering the patch and reading its metadata.
            const operationId = (yield* inRepository("diff", ["op", "log", "-n1", "--no-graph", "-T", "id"])).trim()
            const args = ["diff", "--from", fromRevision, "--to", toRevision, `--at-op=${operationId}`]
            const patch = yield* inRepository("diff", [...args, "--git"])
            const paths = yield* inRepository("diff", [
              ...args,
              "--template",
              "json(source.path()) ++ \"\\n\" ++ json(target.path()) ++ \"\\n\""
            ])
            return yield* Effect.try({
              try: () => quoteGitPatchPaths(patch, paths),
              catch: (cause) =>
                new JjError({
                  code: "unknown",
                  module: MODULE,
                  method: "diff",
                  command: "jj diff",
                  message: "jj diff: could not quote patch paths",
                  cause: jjErrorCause(cause)
                })
            })
          })
        )
    )

  const forgetWorkspace = (name: string) =>
    Effect.asVoid(inRepository("workspaceForget", ["workspace", "forget", "--", name]))

  const workspaceForget = (name: string) => registrationCritical("workspaceForget", forgetWorkspace(name))

  /**
   * `--name=` and the `--` terminator are what make the claim "a workspace name
   * is opaque argv" true for a value that starts with `-`. Without them clap
   * reads a lane named `-dash-lane` as a bundle of short flags and a lane path
   * of `--config-file=/tmp/x.toml` as a jj global option, rather than as the
   * value and the positional they are meant to be.
   *
   * A pinned lane opens a NEW change on the revision's parents and restores
   * the revision's tree into it. A snapshot's commit id is usually a hidden
   * earlier version of the parent's working-copy change; building on it would
   * revive it beside the parent's current `@` as a divergent change.
   */
  const workspaceAdd = (name: string, path: string, revision?: string) =>
    Effect.asVoid(
      revision === undefined
        ? registrationCritical(
          "workspaceAdd",
          inRepository("workspaceAdd", ["workspace", "add", `--name=${name}`, "--", path])
        )
        : Effect.flatMap(requireRevision("workspaceAdd", "jj workspace add", revision), (pinned) =>
          // The commands remain cancellable; only the handoff from a completed
          // add to the pin's cleanup finalizer is protected from interruption.
          registrationCritical(
            "workspaceAdd",
            Effect.uninterruptibleMask((restore) =>
              restore(inRepository("workspaceAdd", [
                "workspace",
                "add",
                `--name=${name}`,
                `--revision=parents(${pinned})`,
                "--",
                path
              ])).pipe(
                Effect.andThen(
                  restore(run(
                    "workspaceAdd",
                    [
                      "restore",
                      "--from",
                      pinned,
                      "--color=never",
                      "--config",
                      "snapshot.max-new-file-size=0",
                      ...HOST_ONLY_CONFIG
                    ],
                    resolve(repositoryRoot ?? process.cwd(), path)
                  )).pipe(
                    Effect.onExit((exit) =>
                      Exit.isSuccess(exit)
                        ? Effect.void
                        : Effect.interruptible(forgetWorkspace(name)).pipe(
                          Effect.timeout(workspaceCleanupTimeoutMs),
                          // Keep the pin failure as the result if cleanup also fails.
                          Effect.catch((cleanupFailure) =>
                            Effect.logWarning("Failed to forget workspace after pinning failed", cleanupFailure)
                          )
                        )
                    )
                  )
                )
              )
            )
          ))
    )

  const status = () => inRepository("status", ["status"])

  /**
   * `jj root` prints the workspace root for whatever directory it runs in,
   * which is the same answer walking up looking for `.jj` would give and one jj
   * is allowed to change its mind about (colocated repositories, workspaces).
   *
   * The contract's `from` is "a lane directory or a file an agent named", so a
   * file is resolved to the directory that holds it: handing a file to `spawn`
   * as a `cwd` throws `ENOTDIR` synchronously. Only the terminal line ending is
   * stripped, never surrounding whitespace, because a repository root may end
   * in a space and `trim()` would report a path that does not exist.
   *
   * `from` is passed directly rather than through `inRepository`: the argument
   * names the directory jj must run in, so a bound layer deliberately does not
   * redirect it.
   */
  const root = (from: string) =>
    Effect.flatMap(
      Effect.sync(() => directoryOf(from)),
      (directory) => Effect.map(run("root", ["root", "--color=never", ...HOST_ONLY_CONFIG], directory), stripLineEnding)
    )

  /**
   * A revert is `jj revert --insert-before @`: the reverse of the change is
   * inserted underneath the working copy, so the working copy holds the
   * reverted tree instead of holding a commit that undoes it somewhere else in
   * the graph.
   *
   * The paths are read BEFORE the revert runs. They are the paths the reverted
   * change touched, which is what the caller means by "what was undone", and
   * reading them first keeps the answer independent of where the revert lands.
   */
  const revert = (changeId: string) =>
    Effect.flatMap(
      requireRevision("revert", "jj revert", changeId),
      (revision) =>
        // One fenced unit: the paths read and the revert see the same graph.
        repositoryCritical(
          "revert",
          inRepository("revert", ["diff", "-r", revision, "--name-only"]).pipe(
            Effect.flatMap((names) =>
              Effect.as(
                inRepository("revert", ["revert", "-r", revision, "--insert-before", "@"]),
                {
                  // Split on line endings only. `jj diff --name-only` emits raw
                  // unquoted bytes, so a tracked file named " lead.txt" or
                  // "trail .txt" comes back with its spaces, and trimming each
                  // line would report paths that do not exist.
                  reverted: names.split(/\r?\n/).filter((line) => line.length > 0)
                }
              )
            )
          )
        )
    )

  /**
   * `jj op restore` puts back the whole repository view the operation
   * recorded. Only a hex id is passed, so a value cannot be read as a flag.
   */
  const opRestore = (operationId: string) =>
    /^[0-9a-f]+$/.test(operationId)
      ? registrationCritical(
        "opRestore",
        Effect.gen(function*() {
          // `jj op restore` resets every workspace's working-copy commit and
          // drops workspaces added after the operation. Refuse unless every
          // other workspace is exactly as the operation recorded it.
          const workspaces = (at: ReadonlyArray<string>) =>
            inRepository("opRestore", [
              "workspace",
              "list",
              ...at,
              "-T",
              "name ++ \" \" ++ if(target.current_working_copy(), \"@\", target.commit_id()) ++ \"\\n\""
            ])
          const now = yield* workspaces([])
          const then = yield* workspaces([`--at-op=${operationId}`])
          if (now !== then) {
            const recorded = new Set(then.split("\n"))
            const changed = now.split("\n").filter((line) => line !== "" && !recorded.has(line))
              .map((line) => line.slice(0, line.lastIndexOf(" ")))
            return yield* Effect.fail(
              new JjError({
                code: "conflict",
                module: MODULE,
                method: "opRestore",
                command: "jj op restore",
                message: `jj opRestore: workspace(s) changed after operation ${operationId.slice(0, 12)}: ${
                  changed.join(", ").slice(0, 400)
                }`
              })
            )
          }
          // `repo` only: what jj knows about remotes is not rolled back, so a
          // push made after the operation is not forgotten.
          yield* inRepository("opRestore", ["op", "restore", "--what=repo", operationId])
        })
      )
      : Effect.fail(
        new JjError({
          code: "invalid_ref",
          module: MODULE,
          method: "opRestore",
          command: "jj op restore",
          message: `jj opRestore: ${JSON.stringify(operationId.slice(0, 80))} is not an operation id`
        })
      )

  return { snapshot, restore, diff, workspaceAdd, workspaceForget, status, root, revert, opRestore }
}

// Cache only within the runner that performed the check. A direct probe cannot
// establish what a contained spawner can execute at the same absolute path.
const versionProbes = new Map<string, Effect.Effect<string, JjError>>()
const spawnerVersionProbes = new WeakMap<ChildProcessSpawner["Service"], Map<string, Effect.Effect<string, JjError>>>()

/** Check and bind the executable before exposing repository operations. */
const checkedOperations = (
  makeRun: (binary: Binary) => Run,
  repositoryRoot?: string,
  spawner?: ChildProcessSpawner["Service"]
): Effect.Effect<Jj, JjError> =>
  Effect.gen(function*() {
    const binary = resolveJjBinary()
    if (binary.ignored !== undefined) {
      yield* Effect.logWarning(
        `${binary.ignored.variable} names ${binary.ignored.path}, which does not exist; using ${binary.path}`
      ).pipe(Effect.annotateLogs({ variable: binary.ignored.variable, path: binary.ignored.path }))
    }
    const startupTimeoutMs = yield* StartupTimeoutMs
    if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > 2_147_483_647) {
      return yield* Effect.fail(
        new JjError({
          code: "unknown",
          module: MODULE,
          method: "version",
          command: `${binary.path} --version`,
          message: `jj version: invalid startup timeout ${startupTimeoutMs}ms for ${binary.path}`,
          cause: { code: "EINVAL", message: "StartupTimeoutMs must be positive and at most 2147483647" }
        })
      )
    }
    // The unresolved fallback is diagnostic data, never a command to resolve
    // in a different runner environment or repository working directory.
    if (!isAbsolute(binary.path)) {
      return yield* Effect.fail(spawnFailure(
        "version",
        ["--version"],
        undefined,
        binary.hint,
        { code: "ENOENT", message: "No executable jj found on host PATH" },
        true
      ))
    }
    const run = makeRun({ command: binary.path, hint: binary.hint })
    let probes = versionProbes
    if (spawner !== undefined) {
      const cached = spawnerVersionProbes.get(spawner)
      probes = cached ?? new Map()
      if (cached === undefined) spawnerVersionProbes.set(spawner, probes)
    }
    let probe = probes.get(binary.path)
    if (probe === undefined) {
      probe = yield* Effect.cached(
        // The repository may not exist until runtime storage creates it.
        run("version", ["--version"]).pipe(
          // Cancellation produced no version result; a later layer must retry.
          Effect.onInterrupt(() => Effect.sync(() => probes.delete(binary.path)))
        )
      )
      probes.set(binary.path, probe)
    }
    // Bound each layer's wait, including a wait on another layer's cached
    // probe. Interrupting the runner cleans it up and invalidates its cache;
    // a timeout is never cached as a version result.
    const output = yield* probe.pipe(Effect.timeoutOrElse({
      duration: startupTimeoutMs,
      orElse: () =>
        Effect.fail(
          new JjError({
            code: "unknown",
            module: MODULE,
            method: "version",
            command: `${binary.path} --version`,
            message: `jj version: startup probe for ${binary.path} timed out after ${startupTimeoutMs}ms`,
            cause: { name: "TimeoutError", code: "ETIMEDOUT", message: "jj startup version probe timed out" }
          })
        )
    }))
    const actual = /^jj (\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/.exec(output.trim())
    const required = minimumVersion.split(".").map(Number)
    let comparison = 0
    if (actual !== null) {
      for (let index = 0; index < required.length && comparison === 0; index += 1) {
        comparison = Number(actual[index + 1]) - required[index]!
      }
    }
    return yield* actual !== null && comparison >= 0
      ? Effect.succeed(operations(run, repositoryRoot))
      : Effect.fail(
        new JjError({
          code: "unsupported_version",
          module: MODULE,
          method: "version",
          command: "jj --version",
          message: `jj requires version ${minimumVersion} or newer; found ${output.trim()}`
        })
      )
  })

/**
 * Provides the `Jj` service backed by the `jj` CLI, spawning its own children.
 *
 * This is the layer for a program that has no spawner to offer, so it starts
 * its children outside whatever kill policy a host has decided on: a `jj` this
 * layer starts leads no process group the host recorded, appears in no
 * `ProcessLedger`, and is not reaped by a later incarnation of a host that
 * died holding it.
 *
 * That is a bounded exposure rather than a leak, and the bound is what makes
 * this layer usable at all. Every command below is short-lived and starts no
 * long-lived children of its own: each one writes to a pipe, so jj starts no
 * pager, and no command opens an editor, because `snapshot` either passes
 * `-m` or runs no `describe` at all (`jj describe` without `-m` starts
 * `$JJ_EDITOR` and waits for it, which is exactly the child this bound
 * denies). The invocation holds the handle it started, so cancelling a flow
 * signals the process rather than losing it
 * (`packages/smithers/flows/jj/test/NodeJjLifetime.test.ts`,
 * `packages/smithers/flows/jj/test/NodeJj.test.ts`). A host that wants the process GROUP
 * contained, and a record a crash leaves behind, composes
 * {@link layerSpawner} under a contained spawner instead;
 * `@smthrs/platform-node`'s `NodeHost.layerContained` does exactly that.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Jj, JjError> = Layer.effect(Jj, checkedOperations(jj))

/**
 * Provides `Jj` bound to one absolute repository root.
 *
 * Binding makes repository authority explicit: later changes to
 * `process.cwd()` cannot redirect snapshots, restores, or diffs into another
 * checkout.
 *
 * Two consequences a caller has to know. A RELATIVE `path` handed to
 * `workspaceAdd` resolves against `repositoryRoot` here and against the
 * caller's working directory under {@link layer}, so pass absolute lane paths.
 * And `root(from)` is exempt from the binding by design: its argument names the
 * directory jj must run in, which is the whole question it answers.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerAt = (repositoryRoot: string): Layer.Layer<Jj, JjError> => {
  if (!isAbsolute(repositoryRoot)) {
    throw new TypeError(`NodeJj.layerAt requires an absolute repository root: ${repositoryRoot}`)
  }
  return Layer.effect(Jj, checkedOperations(jj, repositoryRoot))
}

/**
 * Provides the `Jj` service backed by the `jj` CLI, spawning through the host's
 * `ChildProcessSpawner`.
 *
 * Use this one wherever the host contains what it starts. A jj child spawned
 * around the spawner leads no process group the host recorded, appears in no
 * `ProcessLedger`, and is never reaped, so a `jj` that hangs after the host
 * dies is a process nothing on the machine can account for. Routing it through
 * the spawner puts it under whatever policy the host has already decided on.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSpawner: Layer.Layer<Jj, JjError, ChildProcessSpawner> = Layer.effect(
  Jj,
  Effect.flatMap(ChildProcessSpawner, (spawner) => checkedOperations(viaSpawner(spawner), undefined, spawner))
)

/**
 * Provides repository-bound `Jj` through the host's process spawner.
 *
 * The binding behaves exactly as {@link layerAt}'s, including how a relative
 * `workspaceAdd` path resolves and `root`'s exemption from it.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSpawnerAt = (
  repositoryRoot: string
): Layer.Layer<Jj, JjError, ChildProcessSpawner> => {
  if (!isAbsolute(repositoryRoot)) {
    throw new TypeError(`NodeJj.layerSpawnerAt requires an absolute repository root: ${repositoryRoot}`)
  }
  return Layer.effect(
    Jj,
    Effect.flatMap(ChildProcessSpawner, (spawner) => checkedOperations(viaSpawner(spawner), repositoryRoot, spawner))
  )
}
