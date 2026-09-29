/**
 * Commits that touched the paths a task needs, with the mythical note each
 * carries.
 *
 * History comes from `jj log`; notes come from `refs/notes/mythical`, which
 * only the stack service writes. A repository with neither answers no
 * commits.

 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import { headOf, run } from "./repo.ts"

/**
 * One candidate commit. `text` is what Jev reads and what a pack renders.
 *
 * @since 1.0.0
 * @private
 */
export interface Commit {
  readonly commitId: string
  readonly changeId: string
  readonly text: string
}

/**
 * The most commits one call reads.
 *
 * @since 1.0.0
 * @private
 */
export const maxCommits = 60

/**
 * The most of one commit's description and note a candidate carries.
 *
 * @since 1.0.0
 * @private
 */
export const commitBytes = 1024

/**
 * The notes ref the mythical stack service writes.
 *
 * @since 1.0.0
 * @private
 */
export const notesRef = "refs/notes/mythical"

const field = "\u001f"
const record = "\u001e"
// The description is JSON-escaped, so a separator character inside it cannot
// split one commit into two rows.
const template = `commit_id ++ "${field}" ++ change_id ++ "${field}" ++ description.escape_json() ++ "${record}"`

/** A jj fileset string literal for one repository-relative path. */
const quoted = (path: string): string => `root-file:${JSON.stringify(path)}`

/**
 * Commit ids named in free text: 12 to 40 lowercase hex characters.
 *
 * @since 1.0.0
 * @private
 */
export const commitIds = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(/\b[0-9a-f]{12,40}\b/g)].map((match) => match[0]))
]

const parse = (stdout: string): Array<{ commitId: string; changeId: string; description: string }> =>
  stdout.split(record).filter((entry) => entry.trim() !== "").map((entry) => {
    const [commitId, changeId, description] = entry.trim().split(field) as [string, string, string]
    return { commitId, changeId, description: (JSON.parse(description) as string).trim() }
  })

/** The notes ref as a map from annotated commit id to note blob id. */
const noteBlobs = (root: string) =>
  Effect.map(run("git", ["notes", `--ref=${notesRef}`, "list"], root), (listed) =>
    new Map(
      (listed ?? "").split("\n").flatMap((line) => {
        const [blob, commit] = line.trim().split(/\s+/)
        return blob === undefined || commit === undefined ? [] : [[commit, blob] as const]
      })
    ))

/**
 * Commits that touched `paths` (newest first, at most {@link maxCommits}),
 * then any `seeds` the task named by id, each with its mythical note.
 *
 * @since 1.0.0
 * @private
 */
export const read = (root: string, paths: ReadonlyArray<string>, seeds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const touched = paths.length === 0 ? "" : yield* run("jj", [
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-n",
      String(maxCommits),
      "-r",
      `::@ & ~empty() & files(${paths.map(quoted).join(" | ")})`,
      "-T",
      template
    ], root)
    const named = seeds.length === 0 ? "" : yield* run("jj", [
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-r",
      seeds.map((id) => `present(${id})`).join(" | "),
      "-T",
      template
    ], root)
    const rows = [...parse(named ?? ""), ...parse(touched ?? "")]
    const unique = rows.filter((row, index) => rows.findIndex((other) => other.commitId === row.commitId) === index)
    if (unique.length === 0) return []
    const blobs = yield* noteBlobs(root)
    return yield* Effect.forEach(unique, (row) =>
      Effect.gen(function*() {
        const blob = blobs.get(row.commitId)
        const note = blob === undefined ? undefined : yield* run("git", ["cat-file", "-p", blob], root)
        const text = note === undefined ? row.description : `${row.description}\n\nnote:\n${note.trim()}`
        return { commitId: row.commitId, changeId: row.changeId, text: headOf(text, commitBytes) }
      }), { concurrency: 8 })
  })
