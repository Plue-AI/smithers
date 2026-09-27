/**
 * Process-side implementation of the `S.Bundler.Rspack` actions.
 *
 * The bundler is never imported into this process. Each action run writes a
 * small runner script plus a JSON request into a scratch directory and spawns
 * the host `node` on it through the shared {@link Exec.run} boundary (workspace
 * confinement, narrowed environment, bounded capture, kill-on-timeout). The
 * runner resolves `@rsbuild/core` from the *target workspace's* own
 * `node_modules`, loads the workspace's rsbuild config, and:
 *
 * - **resolve**: matches the requested entries to the config's environments,
 *   runs one development-mode compile with every emit and bundler cache
 *   redirected into the scratch directory, and enumerates `stats.modules`.
 *   A development compile is the documented choice: it is the cheapest
 *   complete module graph rspack produces (no minification, no module
 *   concatenation folding modules out of the stats), and rspack has no
 *   supported enumerate-without-compile API. The settled rows are written to
 *   a response file — never stdout, whose capture is bounded — and validated
 *   here against {@link BundlerTarget.ResolveResult} before anything trusts
 *   them.
 * - **build**: runs `rsbuild.build()` for exactly one environment and mode
 *   with the workspace's own config (real output paths, real bundler cache),
 *   and refuses a green exit whose declared outDirs were not created.
 *
 * A workspace without `@rsbuild/core`, a config without environments, an
 * entry matching no environment, and a truncated response all refuse loudly;
 * nothing degrades to an empty graph.
 *
 * @since 0.1.0
 */

import type { Action, FlowRuntime } from "@smthrs/flow"
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Exec from "@smthrs/targets/Exec"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { byCodeUnit } from "./internal/Text.ts"

/**
 * Host wiring for one bundler runner: where the workspace is, where scratch
 * files (runner script, request, response, redirected resolve emit and
 * bundler caches) live, and how long one child may run.
 *
 * `scratchDirectory` must be absolute. It is host state, never key material.
 * Resolve runs direct every emit path there, so a read-only workspace can be
 * resolved without writing a byte into it; build runs write the workspace's
 * own declared output paths, exactly like every other build target.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunnerOptions {
  readonly workspaceRoot: string
  readonly scratchDirectory: string
  /** Wall-clock bound for one bundler child. Defaults to 15 minutes. */
  readonly timeoutMs?: number | undefined
}

/**
 * Default wall-clock bound for one bundler child process.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultTimeoutMs = 15 * 60 * 1000

/** Ceiling for one response file read; a larger response is refused. */
const maximumResponseBytes = 128 * 1024 * 1024

/** The typed refusal a malformed runner payload or response answers with. */
const execError = (
  argv: readonly [string, ...Array<string>],
  message: string
): Exec.ExecError => ({
  _tag: "smithers-build/ExecError",
  argv: [...argv] as [string, ...Array<string>],
  cwd: ".",
  exitCode: -1,
  code: "invalid_payload",
  stdout: "",
  stderr: message.length <= Exec.stderrTailLimit ? message : message.slice(0, Exec.stderrTailLimit)
})

/**
 * The script the child runs. It is deliberately dependency-free: node
 * builtins plus the target workspace's own `@rsbuild/core`, resolved through
 * that workspace's `node_modules`, so the bundler doing the resolving is the
 * one the workspace ships.
 */
const runnerScript = `import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import * as fs from "node:fs"
import * as path from "node:path"

const fail = (message) => {
  process.stderr.write("rspack-runner: " + message + "\\n")
  process.exit(1)
}

const requestPath = process.argv[2]
if (typeof requestPath !== "string" || requestPath === "") fail("no request file was given")
let request
try {
  request = JSON.parse(fs.readFileSync(requestPath, "utf8"))
} catch (cause) {
  fail("the request file could not be read: " + (cause && cause.message ? cause.message : String(cause)))
}
const { kind, configPath, responsePath } = request
// The bundler's resolver returns real paths (symlinks resolved), so the root
// every module is classified against must be the real one too; otherwise a
// workspace reached through a symlinked ancestor (macOS /var, a linked
// checkout) classifies every one of its own sources as outside itself.
let workspaceRoot
try {
  workspaceRoot = fs.realpathSync(request.workspaceRoot)
} catch (cause) {
  fail("the workspace root could not be resolved: " + (cause && cause.message ? cause.message : String(cause)))
}

const workspaceRequire = createRequire(path.join(workspaceRoot, "package.json"))
let corePath
try {
  corePath = workspaceRequire.resolve("@rsbuild/core")
} catch {
  fail("the workspace does not provide @rsbuild/core in its own node_modules; " +
    "S.Bundler.Rspack runs the workspace's own bundler and cannot substitute one")
}
const core = await import(pathToFileURL(corePath).href)
const { loadConfig, createRsbuild, mergeRsbuildConfig } = core

const loaded = await loadConfig({ cwd: workspaceRoot, path: path.join(workspaceRoot, configPath) })
const config = loaded.content
if (typeof config !== "object" || config === null) fail("the rsbuild config did not evaluate to an object")
const environments = config.environments
if (typeof environments !== "object" || environments === null || Object.keys(environments).length === 0) {
  fail("the rsbuild config declares no environments; S.Bundler.Rspack requires named environments")
}

const posix = (value) => value.split(path.sep).join("/")
const normalizeEntry = (value) => posix(value).replace(/^\\.\\//, "")
const entryValuesOf = (environment) => {
  const entry = environment && environment.source && environment.source.entry
  const values = []
  const push = (value) => {
    if (typeof value === "string") values.push(value)
    else if (Array.isArray(value)) for (const item of value) push(item)
    else if (value && typeof value === "object" && "import" in value) push(value.import)
  }
  if (entry && typeof entry === "object") for (const value of Object.values(entry)) push(value)
  return values
}

const environmentsForEntry = (entry) => {
  const suffix = normalizeEntry(entry)
  const matched = []
  for (const [name, environment] of Object.entries(environments)) {
    const hit = entryValuesOf(environment).some((value) => {
      const candidate = normalizeEntry(value)
      return candidate === suffix || candidate.endsWith("/" + suffix)
    })
    if (hit) matched.push(name)
  }
  return matched
}

const writeResponse = (value) => {
  const scratch = responsePath + ".tmp"
  fs.writeFileSync(scratch, JSON.stringify(value))
  fs.renameSync(scratch, responsePath)
}

const buildErrors = (stats) => {
  try {
    const summary = stats.toJson({ all: false, errors: true })
    const errors = []
    const collect = (node) => {
      for (const error of node.errors ?? []) errors.push(error.message ?? String(error))
      for (const child of node.children ?? []) collect(child)
    }
    collect(summary)
    return errors.slice(0, 20).join("\\n")
  } catch {
    return "the build reported errors that could not be rendered"
  }
}

if (kind === "resolve") {
  const selected = new Set()
  for (const entry of request.entries) {
    const matched = environmentsForEntry(entry)
    if (matched.length === 0) {
      fail("entry " + JSON.stringify(entry) + " matches no environment entry in " + configPath +
        "; declared environments: " + Object.keys(environments).join(", "))
    }
    for (const name of matched) selected.add(name)
  }
  const names = [...selected]
  const overrides = {
    mode: request.mode,
    dev: { progressBar: false },
    environments: Object.fromEntries(names.map((name) => [
      name,
      { output: { distPath: { root: path.join(request.distRoot, name) } } }
    ])),
    tools: {
      rspack: (bundlerConfig) => {
        bundlerConfig.experiments = {
          ...(bundlerConfig.experiments ?? {}),
          cache: {
            type: "persistent",
            storage: { type: "filesystem", directory: request.cacheDirectory }
          }
        }
        bundlerConfig.cache = true
        return bundlerConfig
      }
    }
  }
  const rsbuild = await createRsbuild({
    cwd: workspaceRoot,
    environment: names,
    rsbuildConfig: mergeRsbuildConfig(config, overrides)
  })
  const { stats, close } = await rsbuild.build()
  if (stats === undefined) fail("rsbuild returned no stats for the resolve compile")
  if (typeof stats.hasErrors === "function" && stats.hasErrors()) {
    fail("the resolve compile reported errors:\\n" + buildErrors(stats))
  }
  const summary = stats.toJson({ all: false, modules: true, nestedModules: true })
  const children = Array.isArray(summary.children) && summary.children.length > 0 ? summary.children : [summary]
  const resources = new Set()
  const visit = (module) => {
    if (Array.isArray(module.modules)) for (const nested of module.modules) visit(nested)
    const named = typeof module.nameForCondition === "string" ? module.nameForCondition : undefined
    const identified = typeof module.identifier === "string"
      ? module.identifier.split("!").pop().split("?")[0]
      : undefined
    const resource = named ?? identified
    if (typeof resource === "string" && path.isAbsolute(resource) && !resource.includes("|")) {
      let real
      try {
        real = fs.realpathSync(resource)
      } catch {
        real = path.resolve(resource)
      }
      resources.add(real)
    }
  }
  for (const child of children) for (const module of child.modules ?? []) visit(module)
  const files = new Map()
  const packages = new Set()
  // A name such as "..foo" is still inside the workspace; only a complete
  // parent segment escapes it.
  const escapes = (relative) =>
    relative === ".." || relative.startsWith(".." + path.sep) || relative.startsWith("../")
  for (const resource of resources) {
    const marker = resource.lastIndexOf(path.sep + "node_modules" + path.sep)
    if (marker >= 0) {
      const tail = posix(resource.slice(marker + ("/node_modules/").length))
      const segments = tail.split("/")
      const name = segments[0].startsWith("@") && segments.length > 1
        ? segments[0] + "/" + segments[1]
        : segments[0]
      if (name !== "" && name !== ".") packages.add(name)
      continue
    }
    const relative = path.relative(workspaceRoot, resource)
    if (relative === "" || escapes(relative) || path.isAbsolute(relative)) continue
    let stat
    try {
      stat = fs.statSync(resource)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const digest = createHash("sha256").update(fs.readFileSync(resource)).digest("hex")
    files.set(posix(relative), digest)
  }
  const rows = [...files.entries()]
    .map(([filePath, digest]) => ({ path: filePath, digest }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  writeResponse({
    kind: "resolve",
    environments: names,
    moduleCount: resources.size,
    files: rows,
    packages: [...packages].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  })
  await close()
  process.exit(0)
}

if (kind === "build") {
  if (!(request.environment in environments)) {
    fail("environment " + JSON.stringify(request.environment) + " is not declared in " + configPath +
      "; declared environments: " + Object.keys(environments).join(", "))
  }
  const rsbuild = await createRsbuild({
    cwd: workspaceRoot,
    environment: [request.environment],
    rsbuildConfig: mergeRsbuildConfig(config, { mode: request.mode, dev: { progressBar: false } })
  })
  const { stats, close } = await rsbuild.build()
  if (stats !== undefined && typeof stats.hasErrors === "function" && stats.hasErrors()) {
    fail("the build reported errors:\\n" + buildErrors(stats))
  }
  await close()
  const missing = request.outDirs.filter((outDir) => !fs.existsSync(path.join(workspaceRoot, outDir)))
  if (missing.length > 0) {
    fail("the build exited green without creating its declared outDirs: " + missing.join(", "))
  }
  writeResponse({ kind: "build", environment: request.environment, mode: request.mode })
  process.stdout.write("rspack-runner: built " + request.environment + " (" + request.mode + ")\\n")
  process.exit(0)
}

fail("unknown request kind " + JSON.stringify(kind))
`

interface PreparedRun {
  readonly argv: readonly [string, ...Array<string>]
  readonly directory: string
  readonly responsePath: string
  readonly distRoot: string
  readonly cacheDirectory: string
}

/** Writes one request into fresh scratch, cleaning up if preparation fails. */
const prepare = async (
  options: RunnerOptions,
  request: Record<string, unknown>
): Promise<PreparedRun> => {
  if (!NodePath.isAbsolute(options.scratchDirectory)) {
    throw new Error(`the bundler scratch directory must be absolute: ${options.scratchDirectory}`)
  }
  const directory = NodePath.join(options.scratchDirectory, `bundler-${randomUUID()}`)
  try {
    await Fs.mkdir(directory, { recursive: true })
    const runnerPath = NodePath.join(directory, "runner.mjs")
    const requestPath = NodePath.join(directory, "request.json")
    const responsePath = NodePath.join(directory, "response.json")
    const distRoot = NodePath.join(directory, "dist")
    // The bundler's persistent cache is shared across calls so a second resolve
    // of the same workspace can reuse it; everything else is per call.
    const cacheDirectory = NodePath.join(options.scratchDirectory, "rspack-cache")
    await Fs.writeFile(runnerPath, runnerScript, "utf8")
    await Fs.writeFile(
      requestPath,
      JSON.stringify({ ...request, responsePath, distRoot, cacheDirectory }),
      "utf8"
    )
    return {
      argv: [process.execPath, runnerPath, requestPath],
      directory,
      responsePath,
      distRoot,
      cacheDirectory
    }
  } catch (cause) {
    await Fs.rm(directory, { recursive: true, force: true })
    throw cause
  }
}

/** Reads and parses the runner's response file with a hard size ceiling. */
const readResponse = async (responsePath: string): Promise<unknown> => {
  const stats = await Fs.stat(responsePath).catch(() => undefined)
  if (stats === undefined) {
    throw new Error("the bundler child exited green without writing its response file")
  }
  if (!stats.isFile() || stats.size > maximumResponseBytes) {
    throw new Error(`the bundler response exceeds ${maximumResponseBytes} bytes`)
  }
  return JSON.parse(await Fs.readFile(responsePath, "utf8"))
}

const decodeResolveResponse = Schema.decodeUnknownSync(Schema.Struct({
  kind: Schema.Literal("resolve"),
  environments: Schema.Array(Schema.NonEmptyString),
  moduleCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  files: Schema.Array(BundlerTarget.ResolvedFile),
  packages: Schema.Array(Schema.NonEmptyString)
}))

const decodeBuildResponse = Schema.decodeUnknownSync(Schema.Struct({
  kind: Schema.Literal("build"),
  environment: Schema.NonEmptyString,
  mode: BundlerTarget.Mode
}))

/** Refuses unsorted or duplicated rows from the untrusted child. */
const assertSortedUnique = (values: ReadonlyArray<string>, what: string): void => {
  for (let index = 1; index < values.length; index += 1) {
    if (byCodeUnit(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(`the bundler response ${what} are not sorted and unique at ${JSON.stringify(values[index])}`)
    }
  }
}

const failureMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/**
 * Resolves one module graph by running the workspace's own bundler.
 *
 * The settled result is validated row by row and its {@link
 * BundlerTarget.graphDigest} is computed here, from the validated rows, so a
 * child that wrote an inconsistent response can never publish a digest for a
 * graph it did not report. The per-call scratch tree is released after the
 * child exits and the response is read, including on failure or interruption.
 *
 * @category execution
 * @since 0.1.0
 */
export const resolveGraph = (
  options: RunnerOptions,
  payload: BundlerTarget.ResolvePayload
): Effect.Effect<BundlerTarget.ResolveResult, Exec.ExecError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        prepare(options, {
          kind: "resolve",
          workspaceRoot: options.workspaceRoot,
          configPath: payload.configPath,
          entries: payload.entries,
          mode: payload.mode
        }),
      catch: (cause) => execError([process.execPath], failureMessage(cause))
    }),
    (prepared) =>
      Exec.run({ workspaceRoot: options.workspaceRoot }, {
        cwd: ".",
        argv: [...prepared.argv] as [string, ...Array<string>],
        env: {
          NODE_ENV: payload.mode,
          // The resolve compile of a large workspace can exceed node's default
          // old-space; the bound matches what the audited workspaces set.
          NODE_OPTIONS: "--max-old-space-size=4096"
        },
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: options.timeoutMs ?? defaultTimeoutMs
      }).pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: async () => {
              const decoded = decodeResolveResponse(await readResponse(prepared.responsePath))
              assertSortedUnique(decoded.files.map((file) => file.path), "file rows")
              assertSortedUnique(decoded.packages, "package names")
              return {
                files: decoded.files,
                packages: decoded.packages,
                moduleCount: decoded.moduleCount,
                graphDigest: BundlerTarget.graphDigest(decoded)
              }
            },
            catch: (cause) => execError(prepared.argv, failureMessage(cause))
          })
        )
      ),
    (prepared) =>
      Effect.tryPromise({
        try: () => Fs.rm(prepared.directory, { recursive: true, force: true }),
        catch: (cause) => execError(prepared.argv, failureMessage(cause))
      })
  )

/**
 * Runs one bundler build for one environment and mode in the workspace.
 *
 * The child's green exit is not trusted alone: the runner refuses a build
 * that created none of its declared outDirs, and the response file must
 * confirm the run reached its end. Content verification of the produced
 * trees belongs to the target's output-capture step, not here.
 *
 * @category execution
 * @since 0.1.0
 */
export const runBuild = (
  options: RunnerOptions,
  payload: BundlerTarget.BuildPayload
): Effect.Effect<Exec.Result, Exec.ExecError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        prepare(options, {
          kind: "build",
          workspaceRoot: options.workspaceRoot,
          configPath: payload.configPath,
          environment: payload.environment,
          mode: payload.mode,
          outDirs: payload.outDirs
        }),
      catch: (cause) => execError([process.execPath], failureMessage(cause))
    }),
    (prepared) =>
      Exec.run({ workspaceRoot: options.workspaceRoot }, {
        cwd: ".",
        argv: [...prepared.argv] as [string, ...Array<string>],
        env: {
          NODE_ENV: payload.mode,
          NODE_OPTIONS: "--max-old-space-size=4096",
          ...payload.env
        },
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: options.timeoutMs ?? defaultTimeoutMs
      }).pipe(
        Effect.flatMap((result) =>
          Effect.tryPromise({
            try: async () => {
              decodeBuildResponse(await readResponse(prepared.responsePath))
              return result
            },
            catch: (cause) => execError(prepared.argv, failureMessage(cause))
          })
        )
      ),
    (prepared) =>
      Effect.tryPromise({
        try: () => Fs.rm(prepared.directory, { recursive: true, force: true }),
        catch: (cause) => execError(prepared.argv, failureMessage(cause))
      })
  )

/**
 * Implements {@link BundlerTarget.Resolve} with {@link resolveGraph}.
 *
 * @category layers
 * @since 0.1.0
 */
export const ResolveLive = (
  options: RunnerOptions
): Layer.Layer<Action.Requirement<"smithers-build/bundler-resolve">, never, FlowRuntime.FlowRuntime> =>
  BundlerTarget.Resolve.toLayer((payload) => resolveGraph(options, payload))

/**
 * Implements {@link BundlerTarget.Build} with {@link runBuild}.
 *
 * @category layers
 * @since 0.1.0
 */
export const BuildLive = (
  options: RunnerOptions
): Layer.Layer<Action.Requirement<"smithers-build/bundler-build">, never, FlowRuntime.FlowRuntime> =>
  BundlerTarget.Build.toLayer((payload) => runBuild(options, payload))
