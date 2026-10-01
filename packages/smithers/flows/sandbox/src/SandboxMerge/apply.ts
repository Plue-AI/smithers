/**
 * Applies a session's work to a host jj repository.
 *
 * @since 1.0.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Work } from "../Sandbox/Work.ts"
import { Conflicted, Merged, MergeError, type Outcome } from "./Outcome.ts"
import { make as repositoryAt, output, type Repository } from "./Repository.ts"
import { recordConflicts, type Strategy } from "./Strategy.ts"

/**
 * Where and how to apply work.
 *
 * @category models
 * @since 1.0.0
 */
export interface ApplyOptions<E = never, R = never> {
  /** The host jj repository's root directory. */
  readonly repository: string
  /** A jj revision naming one commit, the change's parent: `main`, `trunk()`. */
  readonly onto: string
  /** The change's description. */
  readonly message: string
  /**
   * What makes two applications the same application. Default: the work's
   * session, base and patch. Applying with a key already applied answers the
   * existing change's outcome and lands nothing new.
   */
  readonly key?: string | undefined
  /**
   * Arguments to `jj git fetch` when the work's base is not in the
   * repository: a session usually fetched its checkout from the same remote
   * moments before the host did. Default `[]`, the default remote; `false`
   * never fetches.
   */
  readonly fetch?: ReadonlyArray<string> | false | undefined
  /** What to do when the work conflicts with `onto`. Default {@link recordConflicts}. */
  readonly strategy?: Strategy<E, R> | undefined
}

/**
 * The jj change id for `key`: 16 bytes of its SHA-256 in jj's reverse-hex
 * alphabet, so one key always names one change.
 *
 * @category utils
 * @since 1.0.0
 */
export const changeIdOf = (key: string): Effect.Effect<string> =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")
        .replace(/[0-9a-f]/g, (digit) => "zyxwvutsrqponmlk"[Number.parseInt(digit, 16)]!)
    )
  )

const lines = (text: string): Array<string> => text.split("\n").filter((line) => line !== "")

/** The one commit `revision` names, or nothing. */
const single = (repository: Repository, revision: string) =>
  Effect.map(
    repository.jj(["log", "--no-graph", "-r", `present(${revision})`, "-T", "commit_id ++ \"\\n\""]),
    lines
  )

/** The change's current state, read from the repository. */
const outcomeOf = (repository: Repository, change: string) =>
  Effect.gen(function*() {
    const found = lines(
      yield* repository.jj([
        "log",
        "--no-graph",
        "-r",
        `change_id(${change})`,
        "-T",
        "commit_id ++ \"\\t\" ++ conflict ++ \"\\t\" ++ parents.map(|p| p.commit_id()).join(\",\") ++ \"\\n\""
      ])
    )
    if (found.length !== 1) {
      return yield* new MergeError({
        reason: "vcs_failed",
        message: `the change ${change} names ${found.length} commits; resolve the divergence with jj`
      })
    }
    const [commit, conflict, onto] = found[0]!.split("\t") as [string, string, string]
    if (conflict !== "true") return new Merged({ change, commit, onto })
    const paths = lines(
      yield* repository.jj(["file", "list", "-r", commit, "-T", "if(conflict, path.display() ++ \"\\n\")"])
    )
    return new Conflicted({ change, commit, onto, paths })
  })

/**
 * Lands `work` in the host repository as one jj change on `onto`.
 *
 * The patch is applied to its own base, never to `onto`, so it applies
 * exactly as captured; the change is then rebased onto `onto`, and jj merges
 * whatever `onto` gained since the base. A clean merge answers
 * {@link Merged}. An overlapping edit answers {@link Conflicted}: the change
 * still exists, with jj's conflict markers recorded in it, unless the
 * strategy decides otherwise. {@link Unchanged} work applies as nothing.
 *
 * Applying is idempotent per key, including after a crash part-way: the
 * change's id derives from the key, and an application interrupted between
 * creating the change and rebasing it finishes on the next attempt.
 *
 * No working copy is read or written. The change is built from git objects
 * in the repository's git store, imported through a short-lived
 * `smithers-sandbox/<change>` bookmark that is deleted once the change is
 * rebased. The host needs `jj` and `git` on its `PATH`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const apply = <E = never, R = never>(
  work: Work,
  options: ApplyOptions<E, R>
): Effect.Effect<Outcome, MergeError | E, R | ChildProcessSpawner | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (work._tag === "Unchanged") return work
    const repository = yield* repositoryAt(options.repository)
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const strategy: Strategy<E, R> = options.strategy ?? recordConflicts
    const change = yield* changeIdOf(options.key ?? `${work.session}\0${work.base}\0${work.patch}`)
    const pending = `smithers-sandbox/${change}`
    const exists = (yield* single(repository, `change_id(${change})`)).length > 0
    const interrupted = (yield* single(repository, `bookmarks(exact:"${pending}")`)).length > 0
    // Fetch before resolving `onto`: the fetch that brings the base usually moves `onto` too.
    if (!exists) {
      if ((yield* single(repository, work.base)).length === 0 && options.fetch !== false) {
        yield* repository.jj(["git", "fetch", ...(options.fetch ?? [])])
      }
      if ((yield* single(repository, work.base)).length === 0) {
        return yield* new MergeError({
          reason: "base_not_found",
          message: `the work's base ${work.base} is not in ${options.repository}`
        })
      }
    }
    const onto = yield* single(repository, options.onto)
    if (onto.length !== 1) {
      return yield* new MergeError({
        reason: "onto_unresolved",
        message: `${options.onto} names ${onto.length} commits in ${options.repository}`
      })
    }
    if (!exists) {
      const gitDir = (yield* repository.jj(["git", "root"])).trim()
      const git = (args: ReadonlyArray<string>, env?: Record<string, string>, stdin?: string) =>
        output(spawner, "git", ["--git-dir", gitDir, ...args], { cwd: options.repository, env, stdin })
      // A private index, so the repository's own index and working copy are untouched.
      const index = { GIT_INDEX_FILE: `${gitDir}/smithers-sandbox-${change}.index` }
      const tree = yield* Effect.ensuring(
        Effect.gen(function*() {
          yield* git(["read-tree", work.base], index)
          yield* Effect.mapError(
            git(["apply", "--cached", "--binary", "-"], index, work.patch),
            (cause) =>
              new MergeError({
                reason: "patch_rejected",
                message: `the patch does not apply to its base ${work.base}: ${cause.message}`
              })
          )
          return (yield* git(["write-tree"], index)).trim()
        }),
        Effect.ignore(fs.remove(index.GIT_INDEX_FILE, { force: true }))
      )
      // jj's built-in defaults set both to "", so an unconfigured identity reads as empty.
      const name = (yield* repository.jj(["config", "get", "user.name"])).trim()
      const email = (yield* repository.jj(["config", "get", "user.email"])).trim()
      const signature = `${name || "Smithers"} <${email || "sandbox@smithers.invalid"}> ${
        Math.floor((yield* Clock.currentTimeMillis) / 1000)
      } +0000`
      // jj takes the change id from the commit's `change-id` header on import.
      const commit = (yield* git(
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        undefined,
        `tree ${tree}\nparent ${work.base}\nauthor ${signature}\ncommitter ${signature}\nchange-id ${change}\n\n${
          options.message.endsWith("\n") ? options.message : `${options.message}\n`
        }`
      )).trim()
      yield* git(["update-ref", `refs/heads/${pending}`, commit])
      yield* repository.jj(["git", "import"])
    }
    if (!exists || interrupted) {
      yield* repository.jj(["rebase", "-r", `change_id(${change})`, "-d", onto[0]!])
      yield* repository.jj(["bookmark", "delete", pending])
      yield* repository.jj(["git", "export"])
    }
    const landed = yield* outcomeOf(repository, change)
    return landed._tag === "Conflicted" ? yield* strategy.onConflict(landed, repository) : landed
  })
