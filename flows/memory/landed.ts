/**
 * Landed-fix labels: the files a landed commit touched are the files its task
 * needed.
 *
 * For each of the last `n` non-empty commits on `main`, the task is the
 * commit's description plus its mythical note's `issue:` when one exists, and
 * the needed set is the touched files that existed in the parent (modified or
 * deleted). `Memory.select` runs over the task at a 32 KiB budget in a
 * temporary jj workspace checked out at the commit's parent, so neither the
 * fix's text nor the commit itself is visible to Jev; recall@budget is the
 * share of needed files the selection kept, and every file and directory Jev
 * judged becomes a label.
 *
 * The workspace sits outside the repository and is forgotten and deleted
 * afterwards. Creating it snapshots the root workspace's working copy, as any
 * jj command without `--ignore-working-copy` does. A jj workspace has no git
 * directory, so commit candidates carry their descriptions without mythical
 * notes. A description that names a path makes that path a seed, so `seeded`
 * is reported beside recall.
 */
import * as Memory from "@smthrs/agent/Memory"
import { Fault } from "@smthrs/flow"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Labels from "./labels.ts"

/** A landed-fix evaluation that could not read the repository. */
export class LandedFailed extends Schema.TaggedError<LandedFailed>()("flows/memory/LandedFailed", {
  message: Schema.String
}) {}
// jj or git could not answer about landed history.
Fault.register("flows/memory/LandedFailed", "infra")

const decoder = () => new TextDecoder()

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) => {
  const text = decoder()
  return Stream.runFold(stream, () => "", (all, chunk: Uint8Array) => all + text.decode(chunk, { stream: true }))
}

/** Runs `command` in `cwd` with the inherited environment; a non-zero exit is {@link LandedFailed}. */
const run = (command: string, args: ReadonlyArray<string>, cwd: string) => {
  const shown = `${command} ${args.join(" ")}`
  return Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd }))
    return yield* Effect.all([collect(handle.stdout), collect(handle.stderr), handle.exitCode], { concurrency: 3 })
  })).pipe(
    Effect.mapError((cause) => new LandedFailed({ message: `${shown}: ${cause.message}` })),
    Effect.flatMap(([stdout, stderr, code]) =>
      code === 0
        ? Effect.succeed(stdout)
        : Effect.fail(new LandedFailed({ message: `${shown}: exit ${code}: ${stderr.trim()}` }))
    )
  )
}

/** One landed commit. */
export interface Landed {
  readonly commit: string
  readonly parent: string
  readonly description: string
  readonly issue?: number | undefined
  /** Every path the commit touched: both sides of a rename or copy. */
  readonly touched: ReadonlyArray<string>
  /**
   * Touched paths that existed in the parent: the source of a modified,
   * removed, renamed or copied file.
   */
  readonly existing: ReadonlyArray<string>
}

/** The `issue:` field of a mythical note's front matter. */
export const noteIssue = (note: string): number | undefined => {
  const front = /^---\n([\s\S]*?)\n---/.exec(note)?.[1]
  const issue = front === undefined ? undefined : /^issue:\s*(\d+)\s*$/m.exec(front)?.[1]
  return issue === undefined ? undefined : Number(issue)
}

/** One changed file: jj's status, then its source and target paths. */
type Change = readonly [status: string, source: string, target: string]

const template = [
  String.raw`commit_id ++ "\t" ++ parents.map(|c| c.commit_id()).join(",") ++ "\t" ++ json(description) ++ "\t"`,
  String
    .raw`"[" ++ diff.files().map(|f| "[" ++ json(f.status()) ++ "," ++ json(f.source().path()) ++ "," ++ json(f.target().path()) ++ "]").join(",") ++ "]\n"`
].join(" ++ ")

/** Statuses whose source path existed in the parent. */
const fromParent = new Set(["modified", "removed", "renamed", "copied"])

/** The last `n` non-empty commits on `main`, newest first. */
export const landedCommits = (root: string, n: number) =>
  Effect.gen(function*() {
    const log = yield* run(
      "jj",
      ["log", "-r", `latest(ancestors(main) & ~empty(), ${n})`, "--no-graph", "--ignore-working-copy", "-T", template],
      root
    )
    const gitDir = yield* Effect.result(run("jj", ["git", "root", "--ignore-working-copy"], root))
    const commits: Array<Landed> = []
    for (const line of log.split("\n").filter((row) => row !== "")) {
      const [commit = "", parents = "", described = "\"\"", files = "[]"] = line.split("\t")
      const parent = parents.split(",")[0] ?? ""
      const note = gitDir._tag === "Success"
        ? yield* Effect.result(
          run("git", [
            "--git-dir",
            gitDir.success.trim(),
            "notes",
            "--ref=refs/notes/mythical",
            "show",
            commit
          ], root)
        )
        : undefined
      const changes = JSON.parse(files) as ReadonlyArray<Change>
      commits.push({
        commit,
        parent,
        description: JSON.parse(described) as string,
        issue: note?._tag === "Success" ? noteIssue(note.success) : undefined,
        touched: [...new Set(changes.flatMap(([, source, target]) => [source, target]))],
        existing: [...new Set(changes.filter(([status]) => fromParent.has(status)).map(([, source]) => source))]
      })
    }
    return commits
  })

const utf8 = new TextEncoder()

/** One commit's evaluation; `bytes` is the packed block's text, at most {@link budget}. */
export interface Evaluated {
  readonly commit: string
  readonly issue?: number | undefined
  readonly needed: ReadonlyArray<string>
  readonly found: ReadonlyArray<string>
  readonly seeded: number
  readonly recall: number | null
  readonly bytes: number
  readonly jevMs: number
  readonly unjudged?: string | undefined
  readonly labels: ReadonlyArray<Labels.Labelled>
}

/** The budget the landed-fix evaluation packs to. */
export const budget = 32 * 1024

/** The task text for a landed commit. */
export const taskOf = (landed: Landed): string =>
  landed.issue === undefined ? landed.description.trim() : `${landed.description.trim()}\n\nissue #${landed.issue}`

/**
 * A temporary jj workspace of `root`, outside it, forgotten and deleted when
 * the scope closes. {@link evaluateAll} moves it to each commit's parent.
 */
export const parentWorkspace = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "memory-calibrate-" }).pipe(
      Effect.mapError((cause) => new LandedFailed({ message: `temporary workspace: ${cause.message}` }))
    )
    const name = path.basename(temp)
    const dir = path.join(temp, "tree")
    // jj refuses `--ignore-working-copy` here: adding a workspace snapshots
    // the root workspace's working copy.
    yield* Effect.acquireRelease(
      run("jj", ["workspace", "add", "--name", name, "-r", "root()", dir], root),
      () => Effect.ignore(run("jj", ["workspace", "forget", name, "--ignore-working-copy"], root))
    )
    return dir
  })

/**
 * Evaluates one landed commit against `dir`, a workspace of the repository
 * checked out at `landed.parent`.
 */
export const evaluate = (dir: string, landed: Landed, options: Omit<Memory.Options, "root"> = {}) =>
  Effect.gen(function*() {
    const selection = yield* Memory.select({ task: taskOf(landed), maxBytes: budget }, { ...options, root: dir })
    const kept = selection.output.kept.filter((item) => item.kind === "file")
    const keptIds = new Set(kept.map((item) => item.id))
    const touched = new Set(landed.touched)
    const found = landed.existing.filter((path) => keptIds.has(path))
    const seen = new Set<string>()
    const labels = selection.asked.flatMap((asked) => Labels.judgedOf(asked)).flatMap((judged) => {
      if (judged.decision !== "file" && judged.decision !== "descend") return []
      const key = Labels.keyOf(judged.decision, judged.id)
      if (seen.has(key)) return []
      seen.add(key)
      const needed = judged.decision === "file"
        ? touched.has(judged.id)
        : landed.touched.some((path) => path.startsWith(`${judged.id}/`))
      return [{ ...judged, needed, source: "landed" as const }]
    })
    return {
      commit: landed.commit,
      issue: landed.issue,
      needed: landed.existing,
      found,
      seeded: kept.filter((item) => item.decided === "seed" && touched.has(item.id)).length,
      recall: landed.existing.length === 0 ? null : found.length / landed.existing.length,
      bytes: selection.kept.reduce((total, item) => total + utf8.encode(item.text).byteLength, 0),
      jevMs: selection.output.cost.jevMs,
      unjudged: selection.unjudged?.reason,
      labels
    } satisfies Evaluated
  })

/**
 * Evaluates each landed commit at its parent, in one temporary workspace of
 * `root` that is removed afterwards.
 */
export const evaluateAll = (
  root: string,
  commits: ReadonlyArray<Landed>,
  options: Omit<Memory.Options, "root"> = {}
) =>
  commits.length === 0
    ? Effect.succeed<ReadonlyArray<Evaluated>>([])
    : Effect.scoped(Effect.gen(function*() {
      const dir = yield* parentWorkspace(root)
      return yield* Effect.forEach(
        commits,
        (landed) => Effect.andThen(run("jj", ["new", landed.parent], dir), evaluate(dir, landed, options))
      )
    }))

/**
 * Pooled recall@budget: found needed files over needed files, across every
 * commit with a needed file that existed in its parent and a judged
 * selection. An unjudged selection kept seeds only, so it measures the judge's
 * absence, not retrieval; `unjudged` counts those commits apart.
 */
export const recallAtBudget = (results: ReadonlyArray<Evaluated>) => {
  const withNeeded = results.filter((result) => result.needed.length > 0)
  const counted = withNeeded.filter((result) => result.unjudged === undefined)
  const needed = counted.reduce((total, result) => total + result.needed.length, 0)
  const found = counted.reduce((total, result) => total + result.found.length, 0)
  return {
    recall: needed === 0 ? null : Number((found / needed).toFixed(4)),
    items: counted.length,
    unjudged: withNeeded.length - counted.length,
    needed,
    found,
    meanPerItem: counted.length === 0
      ? null
      : Number((counted.reduce((total, result) => total + (result.recall ?? 0), 0) / counted.length).toFixed(4))
  }
}
