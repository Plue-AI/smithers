/**
 * Host implementations of the registration steps. They read the served checkout with read-only
 * git, run the repository's own commands on an exported copy, read GitHub only through the
 * repository's proxy, and ask Jev only where evidence does not settle a question. No step writes
 * a credential into its result.
 */
import { Interpreter } from "@smthrs/flow"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, type FileSystem, Layer, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { RepositoryRemote } from "../repository/remote.ts"
import { cleanup, isSource } from "./cleanup.ts"
import Register from "./flow.ts"
import { agentShare, churn, commitGraph, contributors, LOG_FORMAT, parseLog } from "./history.ts"
import { checksClassifier, choose, classifyPulls, licenseClassifier, nameClassifier } from "./jev.ts"
import { canonicalRepo } from "./link.ts"
import {
  affectedPackages,
  ciEstimate,
  ciMinutes,
  firstReviewHours,
  intake,
  parsePulls,
  workspacePackages
} from "./pulls.ts"
import { readiness } from "./readiness.ts"
import { type Checks, type Clone, type CommandRun, type Languages, RegisterError, type Unavailable } from "./schema.ts"
import Setup from "./setup/flow.ts"
import {
  CHECK_OPTIONS,
  checkCommands,
  checkRunners,
  installCommand,
  LICENSE_FILES,
  licenseCandidates,
  licenseOptions,
  read,
  themeCandidates,
  themeColors,
  type Tree,
  workflowFiles
} from "./tree.ts"
import {
  AgentShareStep,
  ChecksStep,
  CiStep,
  CleanupStep,
  CloneStep,
  CommitsStep,
  ContributorsStep,
  IntakeStep,
  LanguagesStep,
  LicenseStep,
  ReadinessStep,
  ThemeStep,
  VerifyStep,
  WorkflowsStep
} from "./workflow.ts"

export interface HostOptions {
  /** The served checkout. Read with git; never written. */
  readonly repositoryPath: string
  readonly fs: FileSystem.FileSystem
  /**
   * A trusted spawner for hosts without a capability kernel (tests, local). Omitted, the
   * ambient spawner runs every command under the host's guards and the flow's envelope.
   */
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined
  /** The host's check environment (PATH, HOME, proxies). No credentials. */
  readonly environment: Readonly<Record<string, string>>
  /**
   * The GitHub `owner/repo` this checkout was imported from, and one REST GET relative to
   * `/repos/{owner}/{repo}` through the repository's proxy. Omitted, both come from the host's
   * `RepositoryRemote` when it has one.
   */
  readonly source?: Effect.Effect<string, unknown> | undefined
  readonly github?: ((path: string) => Effect.Effect<unknown, unknown>) | undefined
  readonly evaluator: Layer.Layer<Evaluator.Evaluator>
  /** Bounds for commands the repository declares. */
  readonly commandTimeoutMs?: number | undefined
}

const unavailable = (reason: string): Unavailable => ({ _tag: "unavailable", step: "", reason })
const failure = (code: RegisterError["code"], message: string) => new RegisterError({ code, message })
const LOG_BYTES = 64 * 1024 * 1024
const FILE_BYTES = 256 * 1024
const TREE_BYTES = 48 * 1024 * 1024
const BINARY =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|otf|eot|mp[34]|mov|wasm|so|dylib|dll|exe|bin|lockb)$/i

const collect = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  Stream.runFold(stream, () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }), (state, chunk) => {
    const room = Math.max(0, limit - state.bytes)
    if (room > 0) state.chunks.push(chunk.subarray(0, room))
    state.bytes += chunk.length
    return state
  }).pipe(Effect.map((state) => {
    const bytes = new Uint8Array(Math.min(state.bytes, limit))
    let offset = 0
    for (const chunk of state.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return { bytes, truncated: state.bytes > limit }
  }))

interface Ran {
  readonly stdout: { readonly bytes: Uint8Array; readonly truncated: boolean }
  readonly exitCode: number
  readonly ms: number
  readonly timedOut: boolean
}
const notRun = (exitCode: number, ms: number, timedOut: boolean): Ran => ({
  stdout: { bytes: new Uint8Array(), truncated: false },
  exitCode,
  ms,
  timedOut
})
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** Runs one fixed argv without a shell; a process that cannot start is exit 127. */
const run = (
  options: HostOptions,
  argv: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
  limit = 1024 * 1024,
  environment: Readonly<Record<string, string>> = options.environment,
  stdin?: string
): Effect.Effect<Ran, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const started = Date.now()
    const process = yield* spawner.spawn(ChildProcess.make(argv[0]!, argv.slice(1), {
      cwd,
      env: { ...environment, CI: "1", GIT_TERMINAL_PROMPT: "0" },
      extendEnv: false,
      stdin: stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(stdin))
    }))
    const [stdout, , exitCode] = yield* Effect.all([
      collect(process.stdout, limit),
      collect(process.stderr, 64 * 1024),
      process.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, exitCode: Number(exitCode), ms: Date.now() - started, timedOut: false }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(notRun(-1, timeoutMs, true)) }),
    Effect.catch(() => Effect.succeed(notRun(127, 0, false))),
    // A host without a capability kernel passes its own spawner; otherwise the ambient, guarded one runs it.
    (effect) =>
      options.spawner === undefined
        ? effect
        : Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, options.spawner)
  )

/** A read-only git command over the checkout; `partial` accepts output cut at `limit`. */
const git = (
  options: HostOptions,
  args: ReadonlyArray<string>,
  limit = 8 * 1024 * 1024,
  partial = false,
  stdin?: string
) =>
  run(
    options,
    ["git", "-C", options.repositoryPath, ...args],
    options.repositoryPath,
    120_000,
    limit,
    options.environment,
    stdin
  )
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0 && (partial || !result.stdout.truncated)
          ? Effect.succeed(result.stdout)
          : Effect.fail(failure("unavailable", `git ${args[0]} could not read this checkout`))
      )
    )

interface Entry {
  readonly path: string
  readonly size: number
}

/**
 * Tracked files at HEAD, and the text of the regular files small enough to analyze, read as git
 * blobs so a symlink or an uncommitted edit is never read.
 */
const readTreeOnce = (options: HostOptions) =>
  Effect.gen(function*() {
    const listing = text(
      (yield* git(options, ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"], 64 * 1024 * 1024)).bytes
    )
    const entries: Array<Entry & { readonly sha: string; readonly regular: boolean }> = listing.split("\0").flatMap(
      (line) => {
        const match = /^(\d+) blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/.exec(line)
        return match === null ? [] : [{
          path: match[4]!,
          sha: match[2]!,
          size: match[3] === "-" ? 0 : Number(match[3]),
          regular: match[1] === "100644" || match[1] === "100755"
        }]
      }
    )
    let budget = TREE_BYTES
    const wanted = entries.filter((entry) => {
      if (!entry.regular || entry.size > FILE_BYTES || BINARY.test(entry.path) || budget - entry.size < 0) return false
      budget -= entry.size
      return true
    })
    const batch = (yield* git(
      options,
      ["cat-file", "--batch"],
      TREE_BYTES + wanted.length * 64,
      false,
      wanted.map((entry) => `${entry.sha}\n`).join("")
    )).bytes
    const files: Array<{ path: string; text: string }> = []
    let offset = 0
    for (const entry of wanted) {
      const newline = batch.indexOf(10, offset)
      if (newline < 0) break
      const header = text(batch.subarray(offset, newline)).split(" ")
      const size = Number(header[2])
      if (header[1] !== "blob" || !Number.isSafeInteger(size)) break
      const body = batch.subarray(newline + 1, newline + 1 + size)
      offset = newline + 1 + size + 1
      if (!body.includes(0)) files.push({ path: entry.path, text: text(body) })
    }
    const tree: Tree = { paths: entries.map((entry) => entry.path), files }
    // Unreadable source counts toward coverage at an average 40 bytes a line.
    const readable = new Map(files.map((file) => [file.path, file.text.split("\n").length]))
    const sourceLines = entries.filter((entry) => isSource(entry.path))
      .reduce((sum, entry) => sum + (readable.get(entry.path) ?? Math.ceil(entry.size / 40)), 0)
    return { tree, sourceLines }
  })

const historyOnce = (options: HostOptions) =>
  Effect.gen(function*() {
    const read = yield* git(
      options,
      [
        "log",
        "--since=13.months",
        "-n",
        "50000",
        `--format=${LOG_FORMAT}`,
        "--numstat",
        "HEAD"
      ],
      LOG_BYTES,
      true
    )
    // A log cut at its bound keeps every complete record before the cut.
    const log = text(read.bytes)
    const commits = parseLog(read.truncated ? log.slice(0, log.lastIndexOf("\x1e")) : log)
    const now = Number(text((yield* git(options, ["log", "-1", "--format=%ct", "HEAD"])).bytes).trim())
    return { commits, now }
  })

/**
 * Parallel steps share one read per commit: the first caller reads, the rest await it. Keyed by
 * checkout and HEAD; a failed read is dropped so the next step reads again; two commits at most.
 */
const memo = <A, E, R>(read: (options: HostOptions) => Effect.Effect<A, E, R>) => {
  const reads = new Map<string, Effect.Effect<A, E, R>>()
  return (options: HostOptions) =>
    git(options, ["rev-parse", "HEAD"]).pipe(Effect.flatMap((head) => {
      const key = `${options.repositoryPath}\u0000${text(head.bytes).trim()}`
      let cached = reads.get(key)
      if (cached === undefined) {
        cached = Effect.runSync(Effect.cached(
          read(options).pipe(Effect.onExit((exit) =>
            Effect.sync(() => {
              if (exit._tag === "Failure") reads.delete(key)
            })
          ))
        ))
        if (reads.size >= 2) reads.delete(reads.keys().next().value!)
        reads.set(key, cached)
      }
      return cached
    }))
}

/** A step reads evidence; if the evidence is unreadable it answers `unavailable` instead of failing the run. */
const soft = <A extends { readonly _tag: string }, R>(
  step: string,
  effect: Effect.Effect<A | Unavailable, unknown, R>
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.succeed(unavailable(error instanceof RegisterError ? error.message : "The evidence could not be read"))
    ),
    // The card finds each result by its tag; an unavailable one names its step.
    Effect.map((value): A | Unavailable => value._tag === "unavailable" ? { ...(value as Unavailable), step } : value)
  )

const remote = Effect.serviceOption(RepositoryRemote).pipe(Effect.map(Option.getOrUndefined))
const githubJson = (options: HostOptions, path: string) =>
  Effect.gen(function*() {
    const read = options.github ?? (yield* remote)?.github
    if (read === undefined) return yield* failure("unavailable", "GitHub is not reachable from this workspace")
    return yield* read(path).pipe(Effect.mapError(() => failure("unavailable", "GitHub did not answer")))
  })
/** The imported source's `owner/repo`; undefined only on a host with no repository binding at all. */
const sourceOf = (options: HostOptions) =>
  Effect.gen(function*() {
    const source = options.source ?? (yield* remote)?.githubSource
    if (source === undefined) return undefined
    return yield* source.pipe(
      Effect.mapError(() => failure("unavailable", "Smithers could not confirm which repository this workspace serves"))
    )
  })

const LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.(ts|tsx|mts|cts)$/, "TypeScript"],
  [/\.(js|jsx|mjs|cjs)$/, "JavaScript"],
  [/\.py$/, "Python"],
  [/\.go$/, "Go"],
  [/\.rs$/, "Rust"],
  [/\.(java|kt|scala)$/, "JVM"],
  [/\.rb$/, "Ruby"],
  [/\.php$/, "PHP"],
  [/\.cs$/, "C#"],
  [/\.(c|cc|cpp|h|hpp)$/, "C/C++"],
  [/\.swift$/, "Swift"],
  [/\.sh$/, "Shell"]
]
export const languages = (tree: Tree): Languages => {
  const counts = new Map<string, number>()
  for (const file of tree.files.filter((entry) => isSource(entry.path))) {
    const name = LANGUAGES.find(([pattern]) => pattern.test(file.path))?.[1]
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + file.text.split("\n").length)
  }
  return {
    _tag: "languages",
    languages: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, lines]) => ({ name, lines }))
  }
}

/** The repository's commands, run once on an exported copy of the commit: install first, then each check. */
export const runChecks = (options: HostOptions, commit: string, checks: Checks | Unavailable, tree: Tree) =>
  Effect.gen(function*() {
    if (checks._tag === "unavailable" || checks.commands.length === 0) return [] as ReadonlyArray<CommandRun>
    const path = yield* Path.Path
    const hostHome = options.environment.HOME
    const parent = hostHome === undefined ? undefined : path.join(hostHome, ".cache", "smithers-register")
    if (parent !== undefined) yield* options.fs.makeDirectory(parent, { recursive: true })
    const scratch = yield* options.fs.makeTempDirectoryScoped({
      prefix: "register-",
      ...(parent ? { directory: parent } : {})
    })
    const archive = path.join(scratch, "source.tar"), root = path.join(scratch, "source")
    yield* options.fs.makeDirectory(root)
    const exported = yield* run(
      options,
      ["git", "-C", options.repositoryPath, "archive", "--format=tar", "-o", archive, commit],
      scratch,
      300_000
    )
    const unpacked = exported.exitCode === 0
      ? yield* run(options, ["tar", "-xf", archive, "-C", root], scratch, 300_000)
      : exported
    if (unpacked.exitCode !== 0) return yield* failure("unavailable", "The commit could not be exported for its checks")
    const timeout = options.commandTimeoutMs ?? 600_000
    // Repository commands see a scratch HOME, never the host's.
    const home = path.join(scratch, "home")
    yield* options.fs.makeDirectory(home)
    const environment = { ...options.environment, HOME: home, XDG_CACHE_HOME: path.join(home, ".cache") }
    const install = installCommand(tree)
    const installed = install === undefined
      ? undefined
      : yield* run(options, install, root, timeout, 256 * 1024, environment)
    const runs: Array<CommandRun> = []
    for (const command of checks.commands) {
      const result = yield* run(options, command.argv, root, timeout, 256 * 1024, environment)
      runs.push({
        kind: command.kind,
        command: command.argv.join(" "),
        status: result.timedOut
          ? "timeout"
          : result.exitCode === 127
          ? "error"
          : result.exitCode === 0
          ? "passed"
          : "failed",
        ms: Math.round(result.ms)
      })
    }
    const installRun: ReadonlyArray<CommandRun> = installed === undefined ? [] : [{
      kind: "build",
      command: install!.join(" "),
      status: installed.timedOut
        ? "timeout"
        : installed.exitCode === 127
        ? "error"
        : installed.exitCode === 0
        ? "passed"
        : "failed",
      ms: Math.round(installed.ms)
    }]
    return [...installRun, ...runs]
  }).pipe(Effect.scoped)

export const stepLayers = (options: HostOptions) => {
  const readTree = memo(readTreeOnce), history = memo(historyOnce)
  const withJev = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, options.evaluator)
  return Layer.mergeAll(
    CloneStep.toLayer(({ link }) =>
      Effect.gen(function*() {
        const repo = canonicalRepo(link)
        if (repo === undefined) return yield* failure("invalid_link", "That is not a GitHub repository link")
        const source = yield* sourceOf(options)
        if (source !== undefined && source.toLowerCase() !== repo) {
          return yield* failure("wrong_repository", `This workspace serves ${source.toLowerCase()}, not ${repo}`)
        }
        const commit = text((yield* git(options, ["rev-parse", "HEAD"])).bytes).trim()
        // A tree too large to list still registers; the steps that need it report unavailable.
        const counted = yield* readTree(options).pipe(
          Effect.map(({ sourceLines, tree }) => ({ files: tree.paths.length, lines: sourceLines })),
          Effect.orElseSucceed(() => ({ files: 0, lines: 0 }))
        )
        return { _tag: "clone" as const, repo, commit, ...counted } satisfies Clone
      })
    ),
    ThemeStep.toLayer(({ clone }) =>
      soft(
        "theme",
        withJev(Effect.gen(function*() {
          const { tree } = yield* readTree(options)
          const candidates = themeCandidates(tree, clone.repo)
          const readme = tree.files.find((file) => /^readme/i.test(file.path))?.text.slice(0, 600) ?? ""
          const name = yield* choose(
            nameClassifier,
            clone.repo,
            candidates.names.map((value) => ({ value, evidence: readme }))
          )
          return {
            _tag: "theme" as const,
            name: name.value,
            colors: [...themeColors(tree, candidates.logo)],
            logo: candidates.logo
          }
        }))
      )
    ),
    LicenseStep.toLayer(({ clone }) =>
      soft(
        "license",
        withJev(Effect.gen(function*() {
          const { tree } = yield* readTree(options)
          const candidates = licenseCandidates(tree)
          if (candidates.length === 0) {
            const unknown = tree.paths.some((path) => LICENSE_FILES.test(path))
            if (unknown) return unavailable("The license text is not one Smithers recognizes")
            return {
              _tag: "license" as const,
              spdx: "None",
              choice: { options: licenseOptions("None"), chosen: "None", by: "detected" as const, evidence: [] }
            }
          }
          const picked = yield* choose(
            licenseClassifier,
            clone.repo,
            candidates.map((entry) => ({
              value: entry.spdx,
              evidence: `${entry.evidence}: ${(read(tree, entry.evidence) ?? "").slice(0, 400)}`
            }))
          )
          return {
            _tag: "license" as const,
            spdx: picked.value,
            choice: {
              options: licenseOptions(picked.value),
              chosen: picked.value,
              by: picked.by,
              evidence: candidates.map((entry) => entry.evidence)
            }
          }
        }))
      )
    ),
    ChecksStep.toLayer(({ clone }) =>
      soft(
        "checks",
        withJev(Effect.gen(function*() {
          const { tree } = yield* readTree(options)
          const runners = checkRunners(tree)
          const picked = runners.length === 0
            ? { value: "None yet", by: "detected" as const }
            : yield* choose(
              checksClassifier,
              clone.repo,
              runners.map((entry) => ({
                value: entry.runner,
                evidence: `${entry.evidence}: ${(read(tree, entry.evidence) ?? "").slice(0, 600)}`
              }))
            )
          return {
            _tag: "checks" as const,
            choice: {
              options: [
                picked.value,
                ...CHECK_OPTIONS.filter((option) => option !== picked.value && option !== "None yet")
              ].slice(0, 3),
              chosen: picked.value,
              by: picked.by,
              evidence: runners.map((entry) => entry.evidence)
            },
            commands: [...checkCommands(tree)],
            workflows: workflowFiles(tree)
          }
        }))
      )
    ),
    ReadinessStep.toLayer(({ clone, checks }) =>
      soft(
        "readiness",
        Effect.gen(function*() {
          const { tree } = yield* readTree(options)
          const runs = yield* runChecks(options, clone.commit, checks, tree)
          const install = runs.find((entry) => installCommand(tree)?.join(" ") === entry.command)
          const installed = install === undefined || install.status === "error"
            ? undefined
            : install.status === "passed"
          return readiness(tree, runs.filter((entry) => entry !== install), installed)
        })
      )
    ),
    CleanupStep.toLayer(() =>
      soft(
        "cleanup",
        Effect.gen(function*() {
          const { tree, sourceLines } = yield* readTree(options)
          const { commits, now } = yield* history(options)
          return cleanup(tree, sourceLines, churn(commits, now))
        })
      )
    ),
    AgentShareStep.toLayer(() =>
      soft(
        "agent-share",
        Effect.gen(function*() {
          const { tree } = yield* readTree(options)
          const { commits, now } = yield* history(options)
          return agentShare(commits, now, tree.paths)
        })
      )
    ),
    CommitsStep.toLayer(() =>
      soft(
        "commits",
        Effect.gen(function*() {
          const { commits, now } = yield* history(options)
          return commitGraph(commits, now)
        })
      )
    ),
    ContributorsStep.toLayer(() =>
      soft(
        "contributors",
        Effect.gen(function*() {
          const { commits, now } = yield* history(options)
          return contributors(commits, now)
        })
      )
    ),
    IntakeStep.toLayer(() =>
      soft(
        "intake",
        Effect.gen(function*() {
          const { tree } = yield* readTree(options)
          const pulls = parsePulls(yield* githubJson(options, "/pulls?state=all&per_page=50"))
          if (pulls.length === 0) return unavailable("No pull requests to read")
          const sampled = pulls.filter((pull) => pull.merged !== null).slice(0, 10)
          const hours = yield* Effect.forEach(sampled, (pull) =>
            githubJson(options, `/pulls/${pull.number}/reviews?per_page=10`).pipe(
              Effect.map((reviews) =>
                firstReviewHours(pull, reviews)
              ),
              Effect.orElseSucceed(() => null)
            ), { concurrency: 2 })
          return intake(
            tree,
            pulls,
            hours.filter((value): value is number =>
              value !== null
            )
          )
        })
      )
    ),
    WorkflowsStep.toLayer(() =>
      soft(
        "workflows",
        withJev(Effect.gen(function*() {
          // Squash and merge subjects carry pull-request titles, so git alone is enough when GitHub is not.
          const fromGitHub = yield* githubJson(options, "/pulls?state=closed&per_page=50").pipe(
            Effect.map((value) => parsePulls(value).filter((pull) => pull.merged !== null)),
            Effect.orElseSucceed(() => [])
          )
          const { commits } = yield* history(options)
          const pulls = fromGitHub.length > 0
            ? fromGitHub.slice(0, 30).map((pull) => ({ number: pull.number, title: pull.title, body: pull.body }))
            : commits.flatMap((commit) => {
              const match = /^(.+?)\s*\(#(\d+)\)\s*$/.exec(commit.subject)
              return match === null ? [] : [{ number: Number(match[2]), title: match[1]!, body: "" }]
            }).slice(0, 30)
          if (pulls.length === 0) return unavailable("No merged pull requests to read")
          const kinds = yield* classifyPulls(pulls)
          const refs = (list: ReadonlyArray<number>) =>
            list.slice(0, 5).map((number) => ({
              pr: number,
              title: pulls.find((pull) => pull.number === number)!.title
            }))
          return {
            _tag: "workflows" as const,
            lintRules: refs(kinds.lint),
            chores: refs(kinds.chore),
            scanned: pulls.length
          }
        }))
      )
    ),
    CiStep.toLayer(() =>
      soft(
        "ci",
        Effect.gen(function*() {
          const baseline = ciMinutes(
            yield* githubJson(options, "/actions/runs?event=pull_request&status=success&per_page=30")
          )
          if (baseline === null) return unavailable("No successful pull-request CI runs to measure")
          const merged = parsePulls(yield* githubJson(options, "/pulls?state=closed&per_page=20")).find((pull) =>
            pull.merged !== null
          )
          if (merged === undefined) return unavailable("No merged pull request to estimate")
          const files = yield* githubJson(options, `/pulls/${merged.number}/files?per_page=100`)
          if (!Array.isArray(files) || files.length >= 100) {
            return unavailable("The pull request's files could not all be read")
          }
          const changed = files.flatMap((entry) => {
            const name = typeof entry === "object" && entry !== null
              ? (entry as { filename?: unknown }).filename
              : undefined
            return typeof name === "string" ? [name] : []
          })
          const { tree } = yield* readTree(options)
          const packages = workspacePackages(tree)
          return ciEstimate(merged.number, baseline, packages.length, affectedPackages(packages, changed))
        })
      )
    ),
    LanguagesStep.toLayer(() =>
      readTree(options).pipe(
        Effect.map(({ tree }) => languages(tree)),
        Effect.orElseSucceed(() => ({ _tag: "languages" as const, languages: [] }))
      )
    ),
    VerifyStep.toLayer(({ commit, checks }) =>
      readTree(options).pipe(
        Effect.flatMap(({ tree }) => runChecks(options, commit, checks, tree)),
        Effect.mapError((error) =>
          error instanceof RegisterError ? error : failure("unavailable", "The checks could not run")
        )
      )
    )
  )
}

/**
 * Everything a host registers for `register-repository` and its setup child. The host provides the
 * one `Action.layerImplementations` table beside its `HumanTask` implementation.
 */
export const registration = (options: HostOptions) =>
  Layer.mergeAll(stepLayers(options), Interpreter.layer(Register), Interpreter.layer(Setup))
