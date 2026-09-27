/**
 * The revision a host's sources were read from.
 *
 * A plan card and a run's journal both carry where each node was declared —
 * a path and a line inside the workspace — and a reader opens that file to
 * see the code the node runs. The path alone does not say WHICH bytes: the
 * working tree moves under the host, and a file read after an edit or a
 * branch switch is a different file at the same address. This module answers
 * the missing half: an immutable name for the tree the host read its flows
 * out of, which a content route can be asked to serve by.
 *
 * Two version-control systems can answer it, and they are not equally able:
 *
 *   - `jj` commits the working copy on every command, so `@`'s commit id
 *     names the tree INCLUDING uncommitted work, and the id stays readable
 *     after the working copy has moved on. That is the whole answer.
 *   - `git` names only what was committed. A tree with any change — staged,
 *     unstaged or untracked, and a new flow file is untracked — is not
 *     described by `HEAD`, so a dirty git checkout answers NOTHING rather
 *     than a commit that does not hold the bytes that were loaded.
 *
 * Nothing here invents a revision. A host with neither tool, a tool that
 * fails, or a git tree that has moved answers `undefined`, which the readers
 * downstream state as an absent Code tab rather than a file they cannot
 * bind.
 *
 * @since 1.0.0
 */

import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Effect, Option, Stream } from "effect"

/**
 * Runs one read-only command in `cwd` and answers its stdout, or nothing.
 *
 * Injected so the decision below is tested without a repository: every
 * branch of {@link read} is a different set of answers from this.
 *
 * @since 1.0.0
 * @category models
 */
export type Reader = (file: string, args: ReadonlyArray<string>, cwd: string) => Effect.Effect<string | undefined>

/**
 * The object id in an answer, or nothing.
 *
 * Both tools print a 40-character hexadecimal id and nothing else under the
 * templates below. Anything else — a hint, an error the tool printed on
 * stdout, an empty answer — is refused rather than passed on as a ref that
 * would 404 at the far end with no explanation.
 *
 * @since 1.0.0
 * @category accessors
 */
export const objectId = (answer: string | undefined): string | undefined => {
  if (answer === undefined) return undefined
  const trimmed = answer.trim()
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : undefined
}

/**
 * The default reader: the command's stdout on success, nothing on any
 * failure.
 *
 * `stderr` is drained without retaining it: `jj` prints hints and bookmark
 * warnings there on a healthy repository, and a missing binary, a directory
 * that is not a repository and a non-zero exit all refuse, which is the one
 * answer this module has for all of them.
 *
 * @since 1.0.0
 * @category constructors
 */
export const spawnReader: Reader = (file, args, cwd) =>
  Effect.gen(function*() {
    const child = yield* ScopedProcess.spawn({
      command: file,
      args,
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    })
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ""
    const [status] = yield* Effect.all([
      ScopedProcess.status(child),
      Stream.runForEach(child.stdout, (chunk) =>
        Effect.suspend(() => {
          bytes += chunk.byteLength
          if (bytes > 1_000_000) return Effect.fail(new Error("revision output exceeded its limit"))
          text += decoder.decode(chunk, { stream: true })
          return Effect.void
        })),
      Stream.runDrain(child.stderr)
    ], { concurrency: "unbounded" })
    return status.code === 0 ? text + decoder.decode() : undefined
  }).pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.scoped
  )

/**
 * The revision the tree at `root` is at, or nothing.
 *
 * @since 1.0.0
 * @category accessors
 */
export const read = (root: string, reader: Reader = spawnReader): Effect.Effect<string | undefined> =>
  Effect.gen(function*() {
    /*
     * `jj log -r @` snapshots the working copy first, so the id it prints
     * names the tree as it is on disk right now, uncommitted work included,
     * and that id keeps resolving after the working copy has moved on.
     */
    const jj = objectId(yield* reader("jj", ["log", "-r", "@", "--no-graph", "--color=never", "-T", "commit_id"], root))
    if (jj !== undefined) return jj
    /*
     * git has no name for work that is not committed. `--porcelain` lists
     * every change including untracked files, so a single line means `HEAD`
     * does not describe what this host loaded and there is no honest revision
     * to record. An unreadable status is the same answer: not knowing whether
     * the tree moved is not knowing the revision.
     */
    const status = yield* reader("git", ["status", "--porcelain"], root)
    if (status === undefined || status.trim() !== "") return undefined
    return objectId(yield* reader("git", ["rev-parse", "HEAD"], root))
  })
