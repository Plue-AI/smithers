/**
 * File-backed evaluation commands over the public fixed-suite APIs.
 *
 * @since 1.0.0
 */

import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { Baseline, CaseExecutor, Gate, Regression, Runner, Suite } from "@smthrs/evals"
import { EvalError } from "@smthrs/evals/EvalError"
import { Effect } from "effect"
import { z } from "incur"
import { randomUUID } from "node:crypto"
import { link, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import * as CliError from "../CliError.ts"
import type * as Environment from "../Environment.ts"
import * as Project from "../Project.ts"

/**
 * Executable suite modules export this value as default, or export its two fields.
 * @category models
 * @since 1.0.0
 */
export interface EvaluationModule {
  readonly suite: Suite.Suite | Promise<Suite.Suite> | Effect.Effect<Suite.Suite, unknown>
  readonly executor: CaseExecutor.Service
}

/**
 * Project selection accepted by local evaluation operations.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly root?: string | undefined
  readonly remote?: string | undefined
}

/**
 * Resolves the local project root and refuses remote execution.
 * @category constructors
 * @since 1.0.0
 */
export const localRoot = (options: Options, environment?: Environment.Source): string =>
  Project.localRoot(options, environment ?? process.env)

/** File suffixes recognized as executable evaluation suites. */
const modulePattern = /\.eval\.(?:ts|mts|js|mjs)$/

/**
 * Discovery does not import modules or run any suite/executor code.
 * @category constructors
 * @since 1.0.0
 */
export const list = async (root: string) => {
  const directory = join(root, "evals")
  const found: Array<{ name: string; file: string }> = []
  const visit = async (path: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === "ENOENT" && path === directory) return
      if (code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
        throw new CliError.Refused({
          fault: "user",
          code: "eval_directory_unreadable",
          message: `Cannot read ${path} as a directory`
        })
      }
      throw cause
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const name = prefix + entry.name
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`)
      else if (entry.isFile() && modulePattern.test(name)) {
        found.push({ name: name.replace(modulePattern, ""), file: join(path, entry.name) })
      }
    }
  }
  await visit(directory, "")
  return found
}

/**
 * Resolves an explicit file selector inside the project's evals directory.
 * Loading imports the module, so an escaping selector would execute arbitrary
 * local code; refuse it before the import rather than after validating the
 * exports of a module whose top level already ran.
 */
const suiteFile = async (root: string, selector: string): Promise<string> => {
  const directory = join(root, "evals")
  const file = resolve(root, selector)
  const refusal = () =>
    new CliError.UsageError({
      message: `${selector} is not a suite module under ${directory}; list the selectable suites first`
    })
  if (!modulePattern.test(file)) throw refusal()
  let contained: boolean
  try {
    // Compare real paths so a link inside evals cannot select code outside it.
    const [real, base] = await Promise.all([realpath(file), realpath(directory)])
    contained = real.startsWith(base + sep)
  } catch {
    throw refusal()
  }
  if (!contained) throw refusal()
  return file
}

/**
 * Loads and validates one discovered evaluation module.
 * @category constructors
 * @since 1.0.0
 */
export const load = async (root: string, selector: string, runtime: RuntimeConfig = {}): Promise<{
  readonly file: string
  readonly suite: Suite.Suite
  readonly executor: CaseExecutor.Service
}> => {
  runtime.signal?.throwIfAborted()
  const files = await list(root)
  const matches = files.filter((entry) => entry.name === selector)
  if (matches.length > 1) {
    throw new CliError.UsageError({ message: `Ambiguous evaluation suite ${selector}; specify its file` })
  }
  const file = matches[0]?.file ?? await suiteFile(root, selector)
  runtime.signal?.throwIfAborted()
  let imported: unknown
  try {
    imported = await import(pathToFileURL(file).href)
  } catch {
    // The module's own error text is the author's code, not a sentence for
    // this command; running the file directly shows it.
    throw new CliError.Refused({
      fault: "user",
      code: "eval_module_failed",
      message: `Could not import ${file}; run it directly to see why`
    })
  }
  runtime.signal?.throwIfAborted()
  const exports = imported as Record<string, unknown>
  const candidate = (exports.default ?? exports) as Partial<EvaluationModule>
  if (candidate.suite === undefined || typeof candidate.executor?.run !== "function") {
    throw new CliError.Refused({
      fault: "user",
      code: "eval_module_invalid",
      message: `${file} must export { suite, executor }, where executor is a CaseExecutor.Service`
    })
  }
  const declaration = candidate.suite
  const resolvedSuite = await Effect.runPromise(
    Effect.isEffect(declaration) ? declaration : Effect.promise(() => Promise.resolve(declaration)),
    { signal: runtime.signal }
  )
  const suite = await Effect.runPromise(Suite.make(resolvedSuite), { signal: runtime.signal })
  return { file, suite, executor: candidate.executor }
}

/** Non-empty identity shared by persisted evaluation records. */
const identity = z.string().min(1)
/** Fields common to score and inconclusive observations. */
const observationBase = {
  case: identity,
  scorer: identity,
  scorerName: z.string().optional(),
  stepKey: identity,
  at: identity,
  reason: z.string().optional(),
  meta: z.unknown().optional()
}
/** Persisted observation schema. */
const observation = z.discriminatedUnion("kind", [
  z.object({ ...observationBase, kind: z.literal("score"), score: z.number().finite().min(0).max(1) }),
  z.object({ ...observationBase, kind: z.literal("inconclusive"), reason: z.string() })
])

/**
 * Artifacts intentionally exclude executable flow/scorer objects.
 * @category schemas
 * @since 1.0.0
 */
export const RunArtifact = z.object({
  version: z.literal(1),
  runId: identity,
  suite: identity,
  cases: z.array(z.object({
    case: identity,
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    observations: z.array(observation),
    trials: z.object({
      n: z.number(),
      passes: z.number(),
      rate: z.number(),
      passAt1: z.number(),
      passAtK: z.number(),
      passHatK: z.number(),
      stderr: z.number()
    }).optional()
  })),
  observations: z.array(observation),
  trials: z.object({
    cases: z.number(),
    passAt1: z.number(),
    passAtK: z.number(),
    passHatK: z.number(),
    allPass: z.number(),
    perCase: z.record(
      z.string(),
      z.object({
        n: z.number(),
        passes: z.number(),
        rate: z.number(),
        passAt1: z.number(),
        passAtK: z.number(),
        passHatK: z.number(),
        stderr: z.number()
      })
    )
  }).optional(),
  k: z.number().optional()
})
/**
 * JSON-safe result of an evaluation run.
 * @category models
 * @since 1.0.0
 */
export type RunArtifact = z.infer<typeof RunArtifact>

/**
 * Removes executable values from a runner result for persistence.
 * @category constructors
 * @since 1.0.0
 */
export const artifactOf = (run: Runner.RunResult): RunArtifact =>
  RunArtifact.parse({
    version: 1,
    runId: run.runId,
    suite: run.suite,
    cases: run.cases.map((result) => ({
      case: result.case,
      ...(result.error === undefined ? {} : { error: { code: result.error.code, message: result.error.message } }),
      observations: result.observations,
      ...(result.trials === undefined ? {} : { trials: result.trials })
    })),
    observations: run.observations,
    ...(run.trials === undefined ? {} : { trials: run.trials, k: run.k })
  })

/**
 * Rehydrates a persisted artifact for baseline and regression APIs.
 * @category constructors
 * @since 1.0.0
 */
export const runOf = (artifact: RunArtifact): Runner.RunResult => ({
  runId: artifact.runId,
  suite: artifact.suite,
  cases: artifact.cases.map((result) => ({
    case: result.case,
    observations: result.observations,
    ...(result.trials === undefined ? {} : { trials: result.trials }),
    ...(result.error === undefined ? {} : {
      error: new EvalError({ code: "executor", message: `${result.error.code}: ${result.error.message}` })
    })
  })),
  observations: artifact.observations,
  ...(artifact.trials === undefined ? {} : { trials: artifact.trials, k: artifact.k })
})

/**
 * A caller-supplied identity cannot escape the artifact directory.
 * @category constructors
 * @since 1.0.0
 */
export const runPath = (root: string, runId: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) {
    throw new CliError.UsageError({ message: "Run IDs must contain only letters, digits, '.', '_' or '-'" })
  }
  return join(Project.stateDirectory(root), "evals", "runs", `${runId}.json`)
}

/**
 * Writes a JSON artifact atomically and refuses replacement by default.
 * @category constructors
 * @since 1.0.0
 */
export const writeJson = async (
  file: string,
  source: string,
  overwrite = false,
  signal?: AbortSignal
): Promise<void> => {
  signal?.throwIfAborted()
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  // Enter cleanup only after exclusive creation proves we own this path.
  // A colliding file or symlink belongs to another writer and must survive.
  const handle = await open(temporary, "wx", 0o600)
  try {
    try {
      await handle.writeFile(source, { encoding: "utf8" })
    } finally {
      await handle.close()
    }
    signal?.throwIfAborted()
    // link is an atomic no-replace publication; a crash never exposes partial JSON.
    if (overwrite) await rename(temporary, file)
    else await link(temporary, file)
  } finally {
    await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause
    })
  }
}

/**
 * Executes a suite and returns its persistable artifact.
 * @category constructors
 * @since 1.0.0
 */
export const execute = async (
  suite: Suite.Suite,
  executor: CaseExecutor.Service,
  options: { readonly runId: string; readonly at: string; readonly trials?: number; readonly k?: number },
  runtime: RuntimeConfig = {}
): Promise<RunArtifact> =>
  artifactOf(
    await Effect.runPromise(
      Runner.run(suite, options).pipe(Effect.provideService(CaseExecutor.CaseExecutor, executor)),
      { signal: runtime.signal }
    )
  )

/**
 * Reads a saved run by identity or path.
 * @category constructors
 * @since 1.0.0
 */
export const readRun = async (root: string, selector: string): Promise<RunArtifact> => {
  const file = isAbsolute(selector) || selector.includes("/") || selector.endsWith(".json")
    ? resolve(root, selector)
    : runPath(root, selector)
  let source: string
  try {
    source = await readFile(file, "utf8")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
    throw new CliError.Refused({
      fault: "user",
      code: "eval_run_not_found",
      message: `No saved evaluation run at ${file}; run the suite first`
    })
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    value = undefined
  }
  const parsed = RunArtifact.safeParse(value)
  if (!parsed.success) {
    throw new CliError.Refused({
      fault: "user",
      code: "eval_run_invalid",
      message: `${file} is not a saved evaluation run`
    })
  }
  return parsed.data
}

/**
 * Reads a committed baseline file.
 * @category constructors
 * @since 1.0.0
 */
export const readBaseline = async (file: string): Promise<string> => {
  try {
    return await readFile(file, "utf8")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
    throw new CliError.Refused({
      fault: "user",
      code: "eval_baseline_not_found",
      message: `No baseline at ${file}; write one with eval baseline`
    })
  }
}

/**
 * Returns the committed baseline path for a suite.
 * @category constructors
 * @since 1.0.0
 */
export const defaultBaselinePath = (root: string, suite: string): string => {
  const safeName = encodeURIComponent(suite)
  return join(root, "evals", `${safeName}.baseline.json`)
}

/**
 * Serializes a complete run as a baseline.
 * @category constructors
 * @since 1.0.0
 */
export const baseline = async (run: RunArtifact): Promise<string> =>
  Effect.runPromise(
    Baseline.fromRun(runOf(run)).pipe(Effect.map(Baseline.write))
  )

/**
 * Compares a run with a baseline and returns its CI verdict.
 * @category constructors
 * @since 1.0.0
 */
export const compare = async (
  run: RunArtifact,
  source: string,
  options: Gate.Options = {}
) =>
  Effect.runPromise(Effect.gen(function*() {
    const committed = yield* Baseline.load(source)
    const report = yield* Regression.compare(committed, runOf(run))
    const verdict = yield* Gate.check(report, options)
    return { report, verdict, ...Gate.ciGrade(verdict) }
  }))
