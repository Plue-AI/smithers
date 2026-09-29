/**
 * Incur command surface for smithers build.
 *
 * Every command returns structured data for incur's envelope. Progress and
 * the human-facing rendering of that data go through {@link Reporter}: a
 * person at a terminal sees a live or coloured account on standard error and
 * a tree or table on standard output. Agents and CI get quiet structured
 * results with follow-up commands; an explicit format changes data encoding,
 * independently of a human's progress display.
 *
 * @since 0.1.0
 */

import metadata from "@smthrs/build-cli/package.json" with { type: "json" }
import * as Config from "@smthrs/targets/Config"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import { Cli, z } from "incur"
import * as NodePath from "node:path"
import * as Affected from "./Affected.ts"
import * as Ansi from "./Ansi.ts"
import * as Audience from "./Audience.ts"
import { normalizePublishNamespace } from "./Cache.ts"
import * as CacheAdmin from "./CacheAdmin.ts"
import * as CreateApp from "./CreateApp.ts"
import * as Diagnostic from "./Diagnostic.ts"
import * as Executor from "./Executor.ts"
import * as GitHooks from "./GitHooks.ts"
import * as GraphOutput from "./GraphOutput.ts"
import * as KnownRed from "./KnownRed.ts"
import * as Label from "./Label.ts"
import * as Owners from "./Owners.ts"
import * as PackageDiscovery from "./PackageDiscovery.ts"
import * as PackageExec from "./PackageExec.ts"
import * as PackageIndex from "./PackageIndex.ts"
import * as PackageLoader from "./PackageLoader.ts"
import * as Planner from "./Planner.ts"
import * as Positionals from "./Positionals.ts"
import * as Query from "./Query.ts"
import * as RepoResolution from "./RepoResolution.ts"
import * as Reporter from "./Reporter.ts"
import * as TargetIndex from "./TargetIndex.ts"
import * as Watch from "./Watch.ts"
import { type RemoteCacheAccess, remoteCacheOf, type ResolvedRemoteCache } from "./Workspace.ts"

const workspaceOption = z.object({
  workspace: z.string().default(process.cwd()).describe("Directory inside a workspace containing WORKSPACE.ts"),
  cacheDir: z.string().optional().describe(
    "Workspace-relative cache directory; overrides the WORKSPACE.ts declaration"
  )
})

const executionOptions = workspaceOption.extend({
  verbose: z.boolean().default(false).describe("Show plain progress for agent and pipe consumers"),
  plan: z.boolean().default(false).describe("Print the inert plan instead of executing"),
  jobs: z.number().int().min(1).optional().describe(
    "Maximum concurrent targets; defaults to host parallelism. Exclusive targets run alone after ready ordinary work"
  ),
  includeExclusive: z.boolean().default(false).describe(
    "Include exclusive targets in wildcard ci/test selections; explicit labels already include them"
  ),
  cache: z.boolean().default(true).describe("Consult the result cache before running; --no-cache bypasses reads"),
  knownRed: z.string().optional().describe(
    "JSON list of targets already red, with owner and expiry; their failures are reported but fail only when newly red"
  )
})

/** The flags outward and agent targets take: the commit message override, the sweep, and payload inputs. */
const invocationOptions = {
  message: z.string().optional().describe("Commit message for a Git.Commit target; wins over the declared message"),
  sweep: z.boolean().default(false).describe(
    "Let a Git.Commit target with no declared path scope commit the whole working tree"
  ),
  input: z.array(z.string()).optional().describe("Payload input for agent targets as name=value; repeatable")
}

const runOptions = executionOptions.extend({
  name: z.string().optional().describe("Package name supplied to scaffold targets"),
  ...invocationOptions
})

const executionAlias = { workspace: "w", jobs: "j" }

const invocationAlias = { message: "m", input: "i" }

const patternArgument = z.object({
  pattern: z.string().describe("Bazel label or recursive pattern")
})

const patternsArgument = z.object({
  patterns: z.array(z.string()).min(1).describe("Bazel labels or recursive patterns; the verb runs their union")
})

/** The options every command accepts, parsed before the command is resolved. */
const globalOptions = z.object({
  audience: z.enum(["auto", "human", "agent"]).default("auto").describe(
    "Presentation audience; auto detects agent harnesses, CI, and terminals"
  ),
  silent: z.boolean().default(false).describe("Suppress progress; retain the result and actionable failures"),
  ui: z.enum(Reporter.uiModes).default("auto").describe(
    "Terminal renderer: tty draws in place, stream colours without cursor motion, plain prints bare lines; " +
      "auto shows live human progress; agent, --silent, pipe and dumb-terminal policies take precedence"
  )
})

/** The flags every command shares.
 * @category models
 * @since 0.1.0
 */
export interface WorkspaceFlags {
  readonly workspace: string
  readonly cacheDir?: string | undefined
}

/** The flags shared by commands that execute targets.
 * @category models
 * @since 0.1.0
 */
export interface ExecutionFlags extends WorkspaceFlags {
  readonly plan: boolean
  readonly jobs?: number | undefined
  readonly includeExclusive?: boolean | undefined
  readonly cache: boolean
}

/**
 * Process-scoped configuration captured before declaration evaluation.
 *
 * `stdout` and `stderr` default to the process streams; tests inject
 * in-memory terminals. `exit` records the exit code of a failure a
 * human renderer has already explained, so the envelope's error block is not
 * printed twice; without it the structured error is returned instead. The
 * process entry point supplies it, because deciding the exit code is a
 * choice only a process owner may make.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeConfig {
  readonly cliName?: string | undefined
  readonly cliVersion?: string | undefined
  readonly cliDescription?: string | undefined
  readonly cacheUrl?: string | undefined
  readonly cacheToken?: string | undefined
  /** Optional durable step-cache commands supplied by the unified CLI. */
  readonly cacheSteps?: ReturnType<typeof Cli.create> | undefined
  readonly signal?: AbortSignal | undefined
  /**
   * The environment PACKAGE.ts execution reads for agent-fake selection
   * (`SMTHRS_AGENT_FAKE`), backend PATH lookups, and outward preconditions.
   * Defaults to `process.env`; tests inject a hermetic record.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly stdout?: Reporter.Terminal | undefined
  readonly stderr?: Reporter.Terminal | undefined
  readonly presentation?: Audience.Policy | undefined
  readonly exit?: ((code: number) => void) | undefined
}

/** The slice of an incur command context the presentation helpers read. */
interface Presentation {
  readonly agent: boolean
  readonly formatExplicit: boolean
  readonly options?: { readonly workspace?: string | undefined; readonly verbose?: boolean | undefined } | undefined
  readonly globals: {
    readonly ui?: Reporter.UiMode | undefined
    readonly audience?: "auto" | "human" | "agent" | undefined
    readonly silent?: boolean | undefined
  }
}

/** incur's error result constructor, as the command context exposes it. */
interface NextCommand {
  readonly command: string
  readonly description: string
  readonly options?: Record<string, string> | undefined
}

type ErrorResult = (options: {
  readonly code: string
  readonly exitCode?: number | undefined
  readonly message: string
  readonly retryable?: boolean | undefined
  readonly cta?: { readonly commands: Array<NextCommand>; readonly description?: string | undefined } | undefined
}) => never

type SuccessResult = (data: unknown, meta?: { cta: { commands: Array<NextCommand> } }) => never

const environmentOf = (config: RuntimeConfig): Ansi.Environment => config.environment ?? process.env

/**
 * The trust domain this process publishes cache results into.
 *
 * Which domain a job belongs to is a property of the job, not of the workspace
 * it builds, so it comes from the environment rather than target declarations. An
 * unset value means the trusted domain, which is what a post-merge build has.
 */
const publishNamespaceOf = (config: RuntimeConfig): string | undefined => {
  const declared = environmentOf(config)["SMITHERS_CACHE_NAMESPACE"]?.trim()
  return declared === undefined || declared === ""
    ? undefined
    : normalizePublishNamespace(declared, "SMITHERS_CACHE_NAMESPACE")
}

const terminalsOf = (
  config: RuntimeConfig
): { readonly stdout: Reporter.Terminal; readonly stderr: Reporter.Terminal } => ({
  stdout: config.stdout ?? Reporter.terminalOf(process.stdout),
  stderr: config.stderr ?? Reporter.terminalOf(process.stderr)
})

const policyFor = (context: Presentation, config: RuntimeConfig): Audience.Policy => {
  const base = config.presentation
  const { stdout, stderr } = terminalsOf(config)
  const protocol = context.agent && context.formatExplicit && Object.keys(context.globals ?? {}).length === 0
  const override = context.globals.audience === "human" || context.globals.audience === "agent"
    ? context.globals.audience
    : undefined
  const policy = Audience.resolve({
    env: environmentOf(config),
    stdout: stdout.isTTY,
    stderr: stderr.isTTY,
    audience: override ?? base?.audience ?? "auto",
    mcp: protocol || base?.source === "mcp",
    silent: context.globals.silent === true || (override === undefined && base?.progress === "silent"),
    verbose: context.options?.verbose === true || (base?.audience === "agent" && base.progress !== "silent"),
    formatExplicit: context.formatExplicit || base?.structured === true
  })
  return base !== undefined && override === undefined && !protocol
    ? { ...policy, source: base.source, harnesses: base.harnesses }
    : policy
}

/**
 * The renderer one command draws with. Execution progress goes to standard
 * error, so both streams are consulted; a tree or table goes to standard
 * output, so only that stream matters.
 */
const rendererFor = (context: Presentation, config: RuntimeConfig, bound: "stdout" | "stderr"): Reporter.Renderer => {
  const policy = policyFor(context, config)
  if (policy.audience === "agent" || policy.progress === "silent" || policy.progress === "plain") return "plain"
  const { stderr, stdout } = terminalsOf(config)
  const streams = bound === "stderr"
    ? { stdout: stdout.isTTY, stderr: stderr.isTTY }
    : { stdout: stdout.isTTY, stderr: stdout.isTTY }
  return Reporter.resolveRenderer(context.globals.ui ?? "auto", environmentOf(config), streams)
}

/** Human result ownership is audience policy, never Incur's TTY-only agent heuristic. */
const forPeople = (context: Presentation, config: RuntimeConfig): boolean => !policyFor(context, config).structured

const reporterFor = (context: Presentation, config: RuntimeConfig): Reporter.Reporter =>
  Reporter.make({
    renderer: rendererFor(context, config, "stderr"),
    terminal: terminalsOf(config).stderr,
    env: environmentOf(config),
    presentation: policyFor(context, config)
  })

/**
 * Hands data to a person as rendered text on standard output, or to incur as
 * the envelope's data.
 */
const present = <A>(
  context: Presentation,
  config: RuntimeConfig,
  data: A,
  render: (style: Ansi.Palette) => string
): A | undefined => {
  if (!forPeople(context, config)) return data
  const { stdout } = terminalsOf(config)
  const env = environmentOf(config)
  const palette = rendererFor(context, config, "stdout") === "plain" ? Ansi.none : Ansi.palette(env, stdout.isTTY)
  stdout.write(`${render(palette)}\n`)
  return undefined
}

/**
 * Binds a resolved remote cache to the readers that fetch its credentials.
 *
 * The declared token is not read here. The cache transport receives a reader
 * and invokes it only while constructing an outbound request. Removing the
 * name from `process.env` here would mutate state the caller owns: `makeCli`
 * is a library entry point, and two concurrent commands with different
 * declared token names would delete each other's credentials. The
 * child-process boundary is where the credential is withheld, and `ExecLive`
 * already strips both `SMITHERS_CACHE_URL` and every name in `sensitiveEnv`
 * from a spawned tool's environment. The process entry point in `main.ts`
 * captures and clears the default names for its own short-lived process,
 * which is a choice only a process owner may make.
 */
const remoteCacheAccess = (
  remoteCache: ResolvedRemoteCache | undefined,
  runtime: RuntimeConfig
): RemoteCacheAccess | undefined => {
  if (remoteCache === undefined) return undefined
  // The process entry point captures and clears the default name, so its
  // value arrives as `cacheToken`; every other declared name is read from
  // the environment at the instant a request is built.
  const tokenAt = (name: string) => (): string | undefined =>
    name === "SMITHERS_CACHE_TOKEN"
      ? runtime.cacheToken ?? environmentOf(runtime)[name]
      : environmentOf(runtime)[name]
  const credentials = remoteCache.credentials
  const publishNamespace = publishNamespaceOf(runtime)
  switch (credentials._tag) {
    case "shared": {
      // One declared credential authenticates both directions, which is the
      // posture every deployment had before the split existed.
      const readToken = tokenAt(credentials.tokenEnv)
      return { ...remoteCache, readToken, writeToken: readToken, publishNamespace }
    }
    case "split":
      return {
        ...remoteCache,
        readToken: tokenAt(credentials.readTokenEnv),
        writeToken: tokenAt(credentials.writeTokenEnv),
        publishNamespace
      }
    case "public":
      // The committed literal reads; the environment publishes. The literal
      // never reaches a child process: it is not an environment variable.
      return {
        ...remoteCache,
        readToken: () => credentials.publicReadToken,
        writeToken: tokenAt(credentials.writeTokenEnv),
        publishNamespace
      }
    case "anonymous": {
      // Discovered from the Smithers Cloud remote with nothing committed: reads go out
      // bare (a public repository answers them), and a credential in the
      // environment, when one is there, serves both directions.
      const token = tokenAt(credentials.writeTokenEnv)
      return { ...remoteCache, readToken: token, writeToken: token, publishNamespace }
    }
  }
}

/**
 * Opens the target index rooted by the nearest WORKSPACE.ts declaration.
 * @category querying
 * @since 0.1.0
 */
export const openPackageIndex = async (
  flags: WorkspaceFlags,
  runtime: RuntimeConfig = {}
): Promise<PackageIndex.PackageIndex> => {
  runtime.signal?.throwIfAborted()
  const root = await PackageDiscovery.findWorkspaceRoot(NodePath.resolve(flags.workspace))
  if (root === undefined) {
    throw new Error("not a workspace; create .smithers/WORKSPACE.ts")
  }
  // Evaluate the one root declaration before walking: its cache, its opaque
  // child repositories, and its `discovery.prune` paths are discovery
  // boundaries. The full graph load
  // imports the same module instance together with the admitted Packages.
  const workspaceFile = await PackageDiscovery.workspaceFileOf(root)
  if (workspaceFile === undefined) throw new Error("not a workspace; create .smithers/WORKSPACE.ts")
  const workspace = await PackageLoader.loadWorkspaceDeclaration(root, workspaceFile)
  const cacheDirectory = flags.cacheDir === undefined
    ? workspace.cache.directory
    : Config.normalizeCacheDirectory(flags.cacheDir)
  const discovery = await PackageDiscovery.discover(root, {
    cacheDirectory,
    repositories: workspace.repos,
    prune: workspace.discovery?.prune,
    signal: runtime.signal
  })
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.PackageIndex.make(loaded, NodePath.resolve(flags.workspace))
}

/** Evaluates a query against the target index. */
const packageQuery = async (
  index: PackageIndex.PackageIndex,
  expression: string,
  environment: Readonly<Record<string, string | undefined>>
): Promise<Query.Listing | Query.Dependencies | Query.Dependents | Query.PackageOwners> => {
  const dependentsMatch = expression.match(/^rdeps\((.+)\)$/)
  if (dependentsMatch?.[1] !== undefined) {
    const label = dependentsMatch[1].trim()
    const rows = index.resolve(label)
    if (rows.length !== 1) throw new Error("rdeps() requires one exact or default target")
    return { query: expression, root: rows[0]!.label, dependents: Owners.rdeps(index, label) }
  }
  const ownersMatch = expression.match(/^owners\((.+)\)$/)
  if (ownersMatch?.[1] !== undefined) {
    const rows = index.resolve(ownersMatch[1].trim())
    if (rows.length !== 1) throw new Error("owners() requires one exact or default target")
    const packagePath = rows[0]!.packagePath
    const directory = packagePath === "" ? "PACKAGE.ts" : `${packagePath}/PACKAGE.ts`
    return {
      query: expression,
      package: packagePath === "" ? "//" : `//${packagePath}`,
      owners: Owners.packageOwners(index, packagePath).map((entry) => ({
        owner: entry.owner,
        role: entry.role,
        reasons: entry.reasons.map(Owners.reasonText)
      })),
      agentPolicy: Owners.agentPolicyOf(index, directory),
      upstream: Owners.upstreamPackages(index, packagePath).map((path) => path === "" ? "//" : `//${path}`)
    }
  }
  const dependencyMatch = expression.match(/^deps\((.+)\)$/)
  if (dependencyMatch?.[1] !== undefined) {
    const rows = index.resolve(dependencyMatch[1].trim())
    if (rows.length !== 1) throw new Error("deps() requires one exact or default target")
    const root = rows[0]!
    const closure = new Set<string>()
    const stack = [root.target]
    const seen = new Set<Target.AnyTarget>()
    while (stack.length > 0) {
      const current = stack.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      const label = index.labelOf(current)
      if (label !== undefined && label !== root.label) closure.add(label)
      for (const dependency of Target.metadata(current).dependencies) stack.push(dependency)
    }
    return {
      query: expression,
      root: root.label,
      dependencies: [...closure].sort(),
      edges: index.edges(rows)
    }
  }
  const resolver = RepoResolution.resolver(index, environment)
  const rows = index.resolve(expression)
  return {
    query: expression,
    targets: await Promise.all(rows.map(async (row) => {
      const metadata = Target.metadata(row.target)
      const resolution = metadata.target === "Repo.Target"
        ? await RepoResolution.resolve(resolver, row.target)
        : undefined
      return {
        label: row.label,
        target: metadata.target,
        kinds: await RepoResolution.effectiveKinds(resolver, row.target),
        ...presentationOf(metadata),
        ...(resolution?.refusal === undefined ? {} : { refusal: resolution.refusal })
      }
    }))
  }
}

/** The listing's presentation columns: only the facts a declaration stated, so an unannotated row stays `{ label, target, kinds }`. */
const presentationOf = (metadata: Target.Metadata): { readonly summary?: string; readonly featured?: true } => ({
  ...(metadata.summary === undefined ? {} : { summary: metadata.summary }),
  ...(metadata.featured ? { featured: true as const } : {})
})

/** PACKAGE.ts `graph`: labeled nodes plus classified local and repository edges. */
const packageGraph = async (
  index: PackageIndex.PackageIndex,
  pattern: string,
  mermaid: boolean,
  environment: Readonly<Record<string, string | undefined>>
): Promise<{
  readonly rows: ReadonlyArray<GraphOutput.PackageRow>
  readonly edges: ReadonlyArray<GraphOutput.PackageEdge>
  readonly data: unknown
}> => {
  const rows = index.resolve(pattern)
  const localEdges = index.edges(rows)
  const resolver = RepoResolution.resolver(index, environment)
  const resolutions = await Promise.all(rows.map(async (row) =>
    Target.metadata(row.target).target === "Repo.Target"
      ? { row, resolution: await RepoResolution.resolve(resolver, row.target) }
      : undefined
  ))
  const repositoryEdges = resolutions
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .map(({ resolution, row }) => ({ from: row.label, to: resolution.externalLabel, kind: "repo" as const }))
  const edges = [...localEdges, ...repositoryEdges]
  const renderRows = rows.map((row) => {
    const refusal = resolutions.find((entry) => entry?.row === row)?.resolution?.refusal
    return {
      label: row.label,
      target: Target.metadata(row.target).target,
      ...(refusal === undefined ? {} : { refusal })
    }
  })
  const targets = await Promise.all(rows.map(async (row) => {
    const resolution = resolutions.find((entry) => entry?.row === row)?.resolution
    const metadata = Target.metadata(row.target)
    return {
      label: row.label,
      target: metadata.target,
      kinds: await RepoResolution.effectiveKinds(resolver, row.target),
      ...presentationOf(metadata),
      ...(resolution?.refusal === undefined ? {} : { refusal: resolution.refusal })
    }
  }))
  return {
    rows: renderRows,
    edges,
    data: {
      pattern,
      format: mermaid ? "mermaid" : "text",
      graph: mermaid ? GraphOutput.packageMermaid(renderRows, edges) : GraphOutput.packageText(renderRows, edges),
      roots: rows.map((row) => row.label),
      targets,
      edges,
      warnings: []
    }
  }
}

/** The plan printed by `ci --plan`: all CI verb plans merged over one pattern. */
interface CiPlan extends Executor.MergedPlan {
  readonly verb: "ci"
  readonly pattern: string
}

/** Removes executor-private fields from the stable plan envelope. */
const plannedTarget = (target: Planner.PlannedTarget): Planner.PlannedTarget => ({
  label: target.label,
  target: target.target,
  kinds: target.kinds,
  attrs: target.attrs,
  dependencies: target.dependencies,
  declaredInputs: target.declaredInputs,
  declaredOutputs: target.declaredOutputs,
  cacheable: target.cacheable,
  cacheLookup: target.cacheLookup,
  wouldRun: target.wouldRun,
  keyMaterial: target.keyMaterial,
  keyPreview: target.keyPreview,
  ...(target.nixEnvironment === undefined ? {} : { nixEnvironment: target.nixEnvironment })
})

/** The mode and invocation flags the PACKAGE.ts execution surface accepts.
 * @category models
 * @since 0.1.0
 */
export interface ModeFlags {
  readonly name?: string | undefined
  readonly write?: boolean | undefined
  readonly fix?: boolean | undefined
  readonly message?: string | undefined
  readonly sweep?: boolean | undefined
  readonly input?: ReadonlyArray<string> | undefined
}

/** Parses repeated `--input name=value` flags into the agent payload record. */
const parseInputs = (entries: ReadonlyArray<string> | undefined): Readonly<Record<string, string>> | undefined => {
  if (entries === undefined || entries.length === 0) return undefined
  const values: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf("=")
    if (separator <= 0) throw new Error(`--input expects name=value, received ${JSON.stringify(entry)}`)
    const name = entry.slice(0, separator)
    if (name in values) throw new Error(`--input names ${JSON.stringify(name)} twice`)
    values[name] = entry.slice(separator + 1)
  }
  return values
}

/**
 * Runs one execution verb through the build executor.
 * @category execution
 * @since 0.1.0
 */
export const runPackageVerb = async (
  verb: PackageExec.PackageVerb,
  patterns: ReadonlyArray<string>,
  flags: ExecutionFlags & ModeFlags,
  config: RuntimeConfig,
  reporter: Reporter.Reporter
): Promise<Executor.Summary | PackageExec.PlanReport> => {
  const index = await openPackageIndex(flags, config)
  const cacheDirectory = flags.cacheDir === undefined
    ? index.workspace.cache.directory
    : Config.normalizeCacheDirectory(flags.cacheDir)
  // The WORKSPACE.ts declaration and SMITHERS_CACHE_URL both reach execution
  // here, under the workspace declaration's precedence.
  const remoteCache = remoteCacheAccess(
    remoteCacheOf(index.workspace.cache.remote, config.cacheUrl),
    config
  )
  return PackageExec.run({
    index,
    cacheDirectory,
    ...(remoteCache === undefined ? {} : { remoteCache }),
    verb,
    patterns,
    write: flags.write,
    fix: flags.fix,
    plan: flags.plan,
    includeExclusive: flags.includeExclusive,
    jobs: flags.jobs,
    readCache: flags.cache,
    signal: config.signal,
    reporter,
    message: flags.message,
    sweep: flags.sweep,
    inputs: parseInputs(flags.input),
    environment: config.environment,
    packageName: flags.name
  })
}

/**
 * The `git-hooks` command: renders the WORKSPACE.ts hook bindings to
 * `.git/hooks` scripts, byte-checks them by default, installs them under
 * `--write`. Drift is a red exit, like every other generated file.
 */
const runGitHooks = async (
  flags: WorkspaceFlags & { readonly write: boolean },
  config: RuntimeConfig
): Promise<
  | { readonly mode: "check"; readonly clean: boolean; readonly entries: ReadonlyArray<GitHooks.CheckEntry> }
  | { readonly mode: "install"; readonly installed: ReadonlyArray<string> }
> => {
  const index = await openPackageIndex(flags, config)
  const bindings = GitHooks.resolveHookLabels(index.workspace, index)
  const rendered = GitHooks.render(bindings)
  if (flags.write) {
    const { wrote } = await GitHooks.install(index.root, rendered)
    return { mode: "install", installed: wrote }
  }
  const report = await GitHooks.check(index.root, rendered)
  return { mode: "check", clean: report.clean, entries: report.entries }
}

/** Plans one verb and executes it unless `--plan` asked for the inert print.
 * @category execution
 * @since 0.1.0
 */
export const runVerb = async (
  verb: "build" | "test" | "lint" | "run" | "docs" | "review",
  patterns: ReadonlyArray<string>,
  flags: ExecutionFlags & ModeFlags,
  config: RuntimeConfig,
  reporter: Reporter.Reporter
): Promise<Planner.Plan | Executor.Summary | PackageExec.PlanReport> => {
  return runPackageVerb(verb, patterns, flags, config, reporter)
}

/**
 * The verbs `ci` merges, in planning order.
 *
 * Views with the same label and `keyPreview` are deduplicated by `mergePlans`.
 * When keys differ, the lint view takes priority regardless of plan order;
 * conflicting non-lint views are rejected. A generator selected by both
 * `build` and `lint` therefore uses its non-mutating lint form.
 *
 * `review` is absent for the same reason `run` is. A review target expands a
 * git diff against a base revision at plan time and then spawns a model CLI,
 * so planning one on a shallow pull-request checkout kills the aggregate plan
 * before any target runs, and executing one needs a binary and a credential no
 * hosted runner has. The reviews are their own verb, asked for by name.
 */
const ciKinds = ["lint", "build", "test", "docs"] as const

/** Plans every CI-safe verb over the patterns' union and executes the merged graph. */
const runCi = async (
  patterns: ReadonlyArray<string>,
  flags: ExecutionFlags,
  config: RuntimeConfig,
  reporter: Reporter.Reporter
): Promise<CiPlan | Executor.Summary> => {
  const index = await openPackageIndex(flags, config)
  const pattern = patterns.join(" ")
  {
    const cacheDirectory = flags.cacheDir === undefined
      ? index.workspace.cache.directory
      : Config.normalizeCacheDirectory(flags.cacheDir)
    const remoteCache = remoteCacheAccess(
      remoteCacheOf(index.workspace.cache.remote, config.cacheUrl),
      config
    )
    const packagePlans: Array<{ readonly kind: (typeof ciKinds)[number]; readonly plan: PackageExec.PackagePlan }> = []
    const refusals: Array<Planner.UnsupportedVerbError> = []
    const accepted = new Set<string>()
    for (const kind of ciKinds) {
      let remaining = [...patterns]
      while (remaining.length > 0) {
        try {
          packagePlans.push({
            kind,
            plan: await PackageExec.plan({
              index,
              cacheDirectory,
              ...(remoteCache === undefined ? {} : { remoteCache }),
              verb: kind,
              patterns: remaining,
              plan: flags.plan,
              includeExclusive: flags.includeExclusive,
              jobs: flags.jobs,
              readCache: flags.cache,
              signal: config.signal,
              reporter,
              environment: config.environment,
              // CI never spawns an agent: the docs-verb page writers stay out.
              unattended: true
            })
          })
          for (const pattern of remaining) accepted.add(pattern)
          break
        } catch (cause) {
          if (
            !(cause instanceof Planner.UnsupportedVerbError) || cause.verb !== kind ||
            !remaining.includes(cause.pattern)
          ) {
            throw cause
          }
          // One incompatible exact selector must not discard this kind's
          // compatible roots. Keep planning their union so overlaps run once.
          refusals.push(cause)
          remaining = remaining.filter((pattern) => pattern !== cause.pattern)
        }
      }
    }
    const unsupported = patterns.find((pattern) => !accepted.has(pattern))
    if (unsupported !== undefined) {
      throw refusals.find((refusal) => refusal.pattern === unsupported) ??
        new Error(`no targets selected by ${unsupported}`)
    }
    if (packagePlans.length === 0) throw refusals[0] ?? new Error(`no targets selected by ${pattern}`)
    const merged = Executor.mergePlans(packagePlans.map(({ kind, plan }) => ({
      verb: kind,
      pattern,
      roots: plan.roots,
      targets: plan.workList,
      edges: plan.workList.flatMap((node) => node.dependencies.map((from) => ({ from, to: node.label }))),
      warnings: []
    })))
    if (flags.plan) return { verb: "ci", pattern, ...merged, targets: merged.targets.map(plannedTarget) }
    // Services and key-only dependencies are planned but never scheduled.
    // Keep them available to consumers when merging the runnable CI graph.
    const nodes = new Map(packagePlans.flatMap(({ plan }) => [...plan.nodes]))
    for (const target of merged.targets) nodes.set(target.label, target as PackageExec.PackageNode)
    const closures = new Map(packagePlans.flatMap(({ plan }) => [...plan.closures]))
    return PackageExec.execute(
      {
        roots: merged.roots,
        workList: merged.targets as ReadonlyArray<PackageExec.PackageNode>,
        nodes,
        closures
      },
      {
        index,
        cacheDirectory,
        ...(remoteCache === undefined ? {} : { remoteCache }),
        verb: "ci",
        patterns,
        jobs: flags.jobs,
        readCache: flags.cache,
        signal: config.signal,
        reporter,
        environment: config.environment
      }
    )
  }
}

/** Every outcome an execution command can return before settling. */
type Outcome = Planner.Plan | CiPlan | Executor.Summary | PackageExec.PlanReport

/** Whether an outcome is an execution summary rather than an inert plan. */
const isSummary = (outcome: Outcome): outcome is Executor.Summary => "ok" in outcome

/** Whether an outcome is an execution summary that went red. */
const failedSummary = (outcome: Outcome): outcome is Executor.Summary => isSummary(outcome) && !outcome.ok

const failureMessage = (summary: Executor.Summary): string =>
  `${summary.counts.failed} of ${summary.results.length} targets failed` +
  (summary.counts.skipped === 0 ? "" : ` (${summary.counts.skipped} skipped)`) +
  ("knownRed" in summary
    ? `; ${(summary as KnownRed.JudgedSummary).knownRed.newlyRed.length} not on the known-red list` +
      `, ${(summary as KnownRed.JudgedSummary).knownRed.unrun.length} not run`
    : "")

/**
 * Turns an execution outcome into the command's return.
 *
 * A red summary is the structured `targets_failed` error, unless a human
 * renderer already told a person what failed, in which case only the exit
 * code remains to record. A green summary is the envelope's data, unless the
 * same renderer already drew it, in which case standard output stays empty.
 * An inert plan is always data.
 */
const settle = <A extends Outcome>(
  context: Presentation & { readonly error: ErrorResult; readonly ok: SuccessResult },
  config: RuntimeConfig,
  outcome: A
): A | undefined => {
  const policy = policyFor(context, config)
  const people = forPeople(context, config) && policy.progress !== "silent"
  const failed = isSummary(outcome) ? outcome.results.filter((row) => row.status === "failed") : []
  const firstLabel = failed[0]?.label ?? (isSummary(outcome) ? outcome.results[0]?.label : undefined)
  const workspace = context.options?.workspace
  const commandOptions: Record<string, string> = workspace === undefined ? {} : { workspace: `'${workspace.replaceAll("'", "'\\''")}'` }
  const commands: Array<NextCommand> = [
    ...(firstLabel === undefined
      ? []
      : [{
        command: `explain '${firstLabel.replaceAll("'", "'\\''")}'`,
        description: "Inspect the target and its dependencies",
        options: commandOptions
      }]),
    { command: "targets", description: "Discover available targets", options: commandOptions },
    { command: "cache status", description: "Inspect local cache usage", options: commandOptions }
  ]
  if (failedSummary(outcome)) {
    if (people && config.exit !== undefined) {
      config.exit(1)
      return undefined
    }
    return context.error({
      code: "targets_failed",
      exitCode: 1,
      message: failureMessage(outcome),
      retryable: false,
      cta: { commands }
    })
  }
  if (people && isSummary(outcome)) return undefined
  return context.ok(outcome, { cta: { commands } })
}

/**
 * Runs one execution command under a reporter that is closed however the
 * run ends, so a live renderer always hands the terminal back.
 */
const executeCommand = async <A extends Outcome>(
  context: Presentation & { readonly error: ErrorResult; readonly ok: SuccessResult },
  config: RuntimeConfig,
  code: string,
  body: (reporter: Reporter.Reporter) => Promise<A>
): Promise<A | undefined> => {
  const reporter = reporterFor(context, config)
  let outcome: A
  try {
    outcome = await body(reporter)
  } catch (cause) {
    return context.error({ code, exitCode: 1, message: Diagnostic.describe(cause) })
  } finally {
    reporter.close()
  }
  const knownRed = (context.options as { readonly knownRed?: string | undefined } | undefined)?.knownRed
  if (knownRed === undefined || !isSummary(outcome)) return settle(context, config, outcome)
  let judged: KnownRed.JudgedSummary
  try {
    const list = await KnownRed.read(context.options?.workspace ?? process.cwd(), knownRed)
    judged = KnownRed.judge(outcome, list, { platform: process.platform, today: KnownRed.today() })
  } catch (cause) {
    return context.error({ code, exitCode: 1, message: Diagnostic.describe(cause) })
  }
  const lines = KnownRed.describe(judged.knownRed)
  if (lines.length > 0) terminalsOf(config).stderr.write(`${lines.join("\n")}\n`)
  return settle(context, config, judged as unknown as A)
}

const optionalPattern = z.object({ pattern: z.string().default("//...").describe("Target label or recursive pattern") })
const optionalPatterns = z.object({
  patterns: z.array(z.string()).default(["//..."]).describe("Target labels or recursive patterns; their union")
})
const targetKinds = ["build", "test", "lint", "docs", "review", "run", "ci"] as const
const selectionArgs = z.object({
  verb: z.enum(targetKinds).describe("Target verb to execute"),
  ...optionalPatterns.shape
})

const cacheDirectoryOf = (index: PackageIndex.PackageIndex, flags: WorkspaceFlags): string =>
  flags.cacheDir === undefined ? index.workspace.cache.directory : Config.normalizeCacheDirectory(flags.cacheDir)

const workspaceInfo = async (flags: WorkspaceFlags, config: RuntimeConfig) => {
  const index = await openPackageIndex(flags, config)
  const cacheDirectory = cacheDirectoryOf(index, flags)
  const remote = remoteCacheOf(index.workspace.cache.remote, config.cacheUrl)
  return {
    name: index.workspace.name,
    root: index.root,
    declaration: await PackageDiscovery.workspaceFileOf(index.root),
    currentPackage: index.currentPackage,
    repository: index.workspace.repository,
    packages: new Set(index.targets().map((row) => row.packagePath)).size,
    targets: index.targets().length,
    runtime: index.workspace.runtime,
    packageManager: index.workspace.packageManager,
    toolchains: index.workspace.toolchains,
    sandboxProviders: Object.keys(index.workspace.sandboxes?.sandboxes ?? {}),
    cache: { directory: NodePath.join(index.root, cacheDirectory, "cache"), remote: remote?.endpoint ?? null },
    host: { node: process.version, platform: process.platform, arch: process.arch },
    cli: { name: config.cliName ?? "smithers-build", version: config.cliVersion ?? metadata.version }
  }
}

/** Plans the union once, preserving CI's lint-first deduplication and dependency scheduling. */
const runSelected = async (
  index: PackageIndex.PackageIndex,
  labels: ReadonlyArray<string>,
  verb: (typeof targetKinds)[number] | "auto",
  patterns: ReadonlyArray<string>,
  flags: ExecutionFlags,
  config: RuntimeConfig,
  reporter: Reporter.Reporter
): Promise<Executor.Summary | PackageExec.PlanReport> => {
  const options = {
    index,
    cacheDirectory: cacheDirectoryOf(index, flags),
    remoteCache: remoteCacheAccess(remoteCacheOf(index.workspace.cache.remote, config.cacheUrl), config),
    jobs: flags.jobs,
    readCache: flags.cache,
    signal: config.signal,
    reporter,
    environment: config.environment,
    plan: flags.plan,
    includeExclusive: flags.includeExclusive
  }
  const plans: Array<PackageExec.PackagePlan> = []
  const selectedLabels = new Set(labels)
  const resolver = RepoResolution.resolver(index, environmentOf(config))
  const selections = await Promise.all(patterns.map(async (pattern) => ({
    pattern,
    rows: await Promise.all(
      index.resolve(pattern).map(async (row) => ({
        row,
        kinds: await RepoResolution.effectiveKinds(resolver, row.target, config.signal)
      }))
    )
  })))
  const bare = (pattern: string) => {
    const parsed = Label.parse(pattern, index.currentPackage ?? "")
    return parsed._tag === "Subtree" && parsed.target === undefined
  }
  for (const kind of verb === "ci" ? ciKinds : [verb]) {
    for (const { pattern, rows } of selections) {
      // What the wildcard itself leaves out does not count against planning the wildcard whole.
      const eligible = rows.filter((entry) =>
        (kind === "auto" || entry.kinds.includes(kind)) &&
        !(kind !== "auto" && bare(pattern) && PackageExec.wildcardOmits(entry.row.target, {
          verb: kind,
          unattended: verb === "ci",
          includeExclusive: flags.includeExclusive
        }))
      )
      const roots = eligible.length > 0 && eligible.every((entry) => selectedLabels.has(entry.row.label))
        ? [pattern]
        : eligible.filter((entry) => selectedLabels.has(entry.row.label)).map((entry) => entry.row.label)
      for (const root of roots) {
        try {
          plans.push(await PackageExec.plan({ ...options, verb: kind, patterns: [root], unattended: verb === "ci" }))
        } catch (cause) {
          if (!(cause instanceof Planner.UnsupportedVerbError)) throw cause
        }
      }
    }
  }
  const nodes = new Map(plans.flatMap((plan) => [...plan.nodes]))
  const work = new Map<string, PackageExec.PackageNode>()
  for (const plan of plans) for (const node of plan.workList) if (!work.has(node.label)) work.set(node.label, node)
  for (const [label, node] of work) nodes.set(label, node)
  const combined: PackageExec.PackagePlan = {
    roots: [...new Set(plans.flatMap((plan) => plan.roots))],
    workList: [...work.values()],
    nodes,
    closures: new Map(plans.flatMap((plan) => [...plan.closures]))
  }
  if (flags.plan) {
    return {
      verb,
      pattern: patterns.join(" "),
      roots: combined.roots,
      targets: combined.workList.map((node) => ({
        label: node.label,
        rule: node.rule,
        mode: node.mode,
        key: node.keyPreview,
        cacheable: node.cacheable,
        dependencies: node.dependencies,
        ...(node.refusal === undefined ? {} : { refusal: node.refusal })
      }))
    }
  }
  const summary = await PackageExec.execute(combined, { ...options, verb, patterns })
  // A planned target the executor holds no record of never ran; that is red.
  const missing = Affected.unrecorded(combined.workList.map((node) => node.label), summary)
  if (missing.length > 0) throw new Error(`Planned targets have no execution record: ${missing.join(", ")}`)
  return summary
}

const showTarget = async (
  label: string,
  flags: WorkspaceFlags & { readonly verb?: Target.Kind | undefined },
  config: RuntimeConfig
) => {
  const index = await openPackageIndex(flags, config)
  const rows = index.resolve(label)
  if (rows.length !== 1) throw new Error("show target requires one exact or default target")
  const row = rows[0]!
  const metadata = Target.metadata(row.target)
  const planned = await PackageExec.plan({
    index,
    patterns: [row.label],
    verb: flags.verb ?? "auto",
    cacheDirectory: cacheDirectoryOf(index, flags),
    plan: true,
    signal: config.signal,
    environment: config.environment
  })
  const node = planned.nodes.get(planned.roots[0]!)!
  const cached = await CacheAdmin.inspect(index.root, cacheDirectoryOf(index, flags), node.keyPreview)
  const candidate = cached?.exitOk && cached.label === node.label && cached.target === node.target
  return {
    label: row.label,
    rule: metadata.target,
    kinds: metadata.kinds,
    summary: metadata.summary,
    package: row.packagePath,
    mode: node.mode,
    owners: Owners.packageOwners(index, row.packagePath).map((owner) => ({ owner: owner.owner, role: owner.role })),
    dependencies: node.dependencies,
    inputs: node.declaredInputs,
    outputs: node.declaredOutputs,
    cache: {
      key: node.keyPreview,
      cacheable: node.cacheable,
      local: candidate ? "candidate" : "miss",
      storedAt: candidate ? cached.storedAt : undefined,
      reason: !node.cacheable ? "Target is not cacheable" : candidate
        ? "Local result exists; execution still validates outputs and dependency results"
        : "No successful local result matches this target and key",
      executionKey: node.keyTemplate === undefined ? "planned" : "depends-on-runtime-graph",
      remote: "not-probed"
    },
    keyInputs: { layers: node.keyMaterial.layers, capabilities: node.keyMaterial.capabilities },
    refusal: node.refusal
  }
}

const cacheCli = (config: RuntimeConfig) => {
  const cache = Cli.create("cache", { description: "Inspect and maintain local action-result caches" })
    .command("status", {
      description: "Report cache size and configured remote without exposing credentials",
      mcp: { annotations: { readOnlyHint: true } },
      options: workspaceOption,
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          const cacheDirectory = cacheDirectoryOf(index, context.options)
          const entries = await CacheAdmin.entries(index.root, cacheDirectory)
          const remote = remoteCacheOf(index.workspace.cache.remote, config.cacheUrl)
          return {
            scope: "local-action-results",
            directory: NodePath.join(index.root, cacheDirectory, "cache"),
            exists: await CacheAdmin.directory(index.root, cacheDirectory) !== undefined,
            entries: entries.length,
            bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
            remote: remote === undefined ? null : { endpoint: remote.endpoint, health: "not-probed" }
          }
        } catch (cause) {
          return context.error({ code: "cache_status_failed", message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("prune", {
      description: "Remove local action results older than the retention window",
      mcp: { annotations: { readOnlyHint: false } },
      options: workspaceOption.extend({
        olderThanDays: z.number().min(0).default(30),
        dryRun: z.boolean().default(false),
        yes: z.boolean().default(false)
      }),
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          return await CacheAdmin.remove({
            root: index.root,
            cacheDirectory: cacheDirectoryOf(index, context.options),
            olderThanDays: context.options.olderThanDays,
            dryRun: context.options.dryRun,
            yes: context.options.yes
          })
        } catch (cause) {
          return context.error({ code: "cache_prune_failed", message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("clear", {
      description: "Remove all local action results; durable runs and artifacts are preserved",
      mcp: { annotations: { readOnlyHint: false } },
      options: workspaceOption.extend({ dryRun: z.boolean().default(false), yes: z.boolean().default(false) }),
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          return await CacheAdmin.remove({
            root: index.root,
            cacheDirectory: cacheDirectoryOf(index, context.options),
            dryRun: context.options.dryRun,
            yes: context.options.yes
          })
        } catch (cause) {
          return context.error({ code: "cache_clear_failed", message: Diagnostic.describe(cause) })
        }
      }
    })
  return config.cacheSteps === undefined ? cache : cache.command(config.cacheSteps)
}

const makeCommands = (config: RuntimeConfig) =>
  Cli.create(config.cliName ?? "smithers-build", {
    description: config.cliDescription ?? "Execute declared targets and install the workspace with flows",
    version: config.cliVersion ?? metadata.version,
    globals: globalOptions
  })
    .command(cacheCli(config))
    .command(
      Cli.create("show", { description: "Inspect targets and workspace configuration" })
        .command("target", {
          description: "Show a target's inputs, outputs, dependencies, owners and cache identity",
          mcp: { annotations: { readOnlyHint: true } },
          args: z.object({ label: z.string() }),
          options: workspaceOption.extend({
            verb: z.enum(["build", "test", "lint", "docs", "review", "run"]).optional()
          }),
          async run(context) {
            try {
              return await showTarget(context.args.label, context.options, config)
            } catch (cause) {
              return context.error({ code: "show_target_failed", message: Diagnostic.describe(cause) })
            }
          }
        })
        .command("workspace", {
          description: "Show the resolved workspace, toolchain, cache and sandbox configuration",
          mcp: { annotations: { readOnlyHint: true } },
          options: workspaceOption,
          async run(context) {
            try {
              return await workspaceInfo(context.options, config)
            } catch (cause) {
              return context.error({ code: "show_workspace_failed", message: Diagnostic.describe(cause) })
            }
          }
        })
    )
    .command("targets", {
      description: "List available targets with their kinds and summaries",
      mcp: { annotations: { readOnlyHint: true } },
      args: optionalPattern,
      options: workspaceOption,
      async run(context) {
        try {
          const result = await packageQuery(
            await openPackageIndex(context.options, config),
            context.args.pattern,
            environmentOf(config)
          )
          return present(context, config, result, (style) => Query.text(result, style))
        } catch (cause) {
          return context.error({ code: "targets_failed", message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("info", {
      description: "Report workspace and host configuration for diagnosis",
      mcp: { annotations: { readOnlyHint: true } },
      options: workspaceOption,
      async run(context) {
        try {
          return await workspaceInfo(context.options, config)
        } catch (cause) {
          return context.error({ code: "info_failed", message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("explain", {
      description: "Explain a target's actual planned cache key and local cache state",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({ label: z.string() }),
      options: workspaceOption.extend({ verb: z.enum(["build", "test", "lint", "docs", "review", "run"]).optional() }),
      async run(context) {
        try {
          return await showTarget(context.args.label, context.options, config)
        } catch (cause) {
          return context.error({ code: "explain_failed", message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("affected", {
      description: "Execute targets affected by changed files, conservatively including ambient inputs",
      mcp: { annotations: { readOnlyHint: false } },
      args: selectionArgs,
      options: executionOptions.extend({
        base: z.string().default("HEAD").describe("Git base revision"),
        head: z.string().optional().describe(
          "Git head revision; defaults to the working tree including untracked files"
        ),
        files: z.array(z.string()).optional().describe("Explicit changed paths instead of Git discovery"),
        list: z.boolean().default(false).describe("List selected roots and reasons without executing")
      }),
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          const files = await Affected.changedPaths(index.root, {
            ...context.options,
            signal: config.signal,
            environment: environmentOf(config)
          })
          const changed = Affected.select(index, context.args.patterns, files)
          const kinds = context.args.verb === "ci" ? ciKinds : [context.args.verb]
          const resolver = RepoResolution.resolver(index, environmentOf(config))
          // A target only bare wildcards select is left out where the wildcard
          // itself would leave it (manual, exclusive, other-host, attended under
          // ci), and said so; a pattern that names it keeps it.
          const bare = (pattern: string) => {
            const parsed = Label.parse(pattern, index.currentPackage ?? "")
            return parsed._tag === "Subtree" && parsed.target === undefined
          }
          // A child repository that could not be read has no kinds; one that would
          // run is refused, not passed over, through any alias that wraps it.
          const refusalOf = async (target: Target.AnyTarget): Promise<string | undefined> => {
            const metadata = Target.metadata(target)
            if (metadata.target === "Repo.Target") {
              return (await RepoResolution.resolve(resolver, target, config.signal)).refusal
            }
            return metadata.target === "Alias" && metadata.dependencies[0] !== undefined
              ? refusalOf(metadata.dependencies[0])
              : undefined
          }
          const eligibility = await Promise.all(changed.targets.map(async (target) => {
            const row = index.resolve(target.label)[0]!
            return { target, kinds: await RepoResolution.effectiveKinds(resolver, row.target, config.signal) }
          }))
          const eligible = eligibility.filter((entry) => kinds.some((kind) => entry.kinds.includes(kind)))
            .map((entry) => entry.target)
          const omits = (label: string) => {
            const selecting = context.args.patterns.filter((pattern) =>
              index.resolve(pattern).some((row) => row.label === label)
            )
            const target = index.resolve(label)[0]!.target
            // An unattended plan drops a rule that spawns an agent however it was named.
            if (context.args.verb === "ci" && PackageExec.attended(target)) return true
            return selecting.length > 0 && selecting.every(bare) && kinds.some((kind) =>
              PackageExec.wildcardOmits(target, {
                verb: kind,
                unattended: context.args.verb === "ci",
                includeExclusive: context.options.includeExclusive
              })
            )
          }
          const kept = changed.targets.filter((target) => !omits(target.label))
          for (const target of kept) {
            const refusal = await refusalOf(index.resolve(target.label)[0]!.target)
            if (refusal !== undefined) throw new Error(refusal)
          }
          const selection = { ...changed, targets: eligible.filter((target) => !omits(target.label)) }
          const omitted = eligible.filter((target) => omits(target.label)).map((target) => target.label)
          if (context.options.list) return { ...selection, omitted }
          const resolved = context.args.patterns.map((pattern) => index.resolve(pattern).length)
          if (!context.options.plan && Affected.silent(files, resolved)) {
            return context.error({
              code: "affected_failed",
              message: `${files.length} changed files met patterns that name no target, so no gate ran`
            })
          }
          const labels = selection.targets.map((target) => target.label)
          try {
            return await executeCommand(context, config, "affected_failed", async (reporter) => {
              const outcome = await runSelected(
                index,
                labels,
                context.args.verb,
                context.args.patterns,
                context.options,
                config,
                reporter
              )
              if (!isSummary(outcome)) return outcome
              // Every selected gate the planner was left to plan must have run or been recorded.
              const unplanned = Affected.unrecorded(labels, outcome)
              if (unplanned.length > 0) throw new Error(`Affected gates were never planned: ${unplanned.join(", ")}`)
              return Affected.unskipped(labels, outcome)
            })
          } finally {
            if (omitted.length > 0) {
              terminalsOf(config).stderr.write(`Affected but not run here: ${omitted.join(", ")}\n`)
            }
          }
        } catch (cause) {
          return context.error({ code: "affected_failed", message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("clean", {
      description: "Execute only declared Clean targets selected by the patterns",
      mcp: { annotations: { readOnlyHint: false } },
      args: optionalPatterns,
      options: executionOptions,
      run: (context) =>
        executeCommand(context, config, "clean_failed", async (reporter) => {
          const index = await openPackageIndex(context.options, config)
          const { patterns } = context.args
          const labels = [
            ...new Set(
              patterns.flatMap((pattern) => index.resolve(pattern)).filter((row) =>
                Target.metadata(row.target).target === "Clean"
              ).map((row) => row.label)
            )
          ]
          if (labels.length === 0) throw new Error(`no declared Clean targets selected by ${patterns.join(" ")}`)
          return runSelected(index, labels, "auto", patterns, context.options, config, reporter)
        })
    })
    .command("watch", {
      mcp: false,
      description: "Replan and rerun a target graph when workspace files change",
      args: selectionArgs,
      options: executionOptions.extend({
        debounceMs: z.number().int().min(20).default(200),
        once: z.boolean().default(false).describe("Run one cycle and exit")
      }),
      async run(context) {
        const reporter = reporterFor(context, config)
        try {
          const index = await openPackageIndex(context.options, config)
          const ignored = [cacheDirectoryOf(index, context.options)]
          for (const row of index.targets()) {
            const outputs = Target.metadata(row.target).outputs
            if (outputs !== undefined) {
              for (const path of outputs.paths) {
                ignored.push(Input.resolvePath(outputs.cwd, path))
              }
            }
          }
          const args = [
            context.args.verb,
            ...context.args.patterns.map((pattern) =>
              pattern.startsWith(":") ? index.resolve(pattern)[0]!.label : pattern
            ),
            "--audience",
            policyFor(context, config).audience,
            ...(policyFor(context, config).progress === "silent" ? ["--silent"] : []),
            ...(context.options.verbose ? ["--verbose"] : []),
            ...(context.options.plan ? ["--plan"] : []),
            ...(context.options.jobs === undefined ? [] : ["--jobs", String(context.options.jobs)]),
            ...(context.options.cache ? [] : ["--no-cache"]),
            ...(context.options.cacheDir === undefined ? [] : ["--cache-dir", context.options.cacheDir])
          ]
          const streams = terminalsOf(config)
          const result = await Watch.run({
            root: index.root,
            args,
            ignored,
            signal: config.signal,
            environment: {
              ...environmentOf(config),
              ...(config.cacheUrl === undefined ? {} : { SMITHERS_CACHE_URL: config.cacheUrl }),
              ...(config.cacheToken === undefined ? {} : { SMITHERS_CACHE_TOKEN: config.cacheToken })
            },
            debounceMs: context.options.debounceMs,
            once: context.options.once,
            stdout: (text) => {
              if (context.options.plan && policyFor(context, config).audience === "human") reporter.note(text)
            },
            stderr: (text) => streams.stderr.write(text),
            cycleCompleted: (cycle) => {
              if (cycle.exitCode === 0) reporter.note(`Watch cycle ${cycle.number} complete`)
              else reporter.warn(`Watch cycle ${cycle.number} failed (exit ${cycle.exitCode})\n${cycle.output.trim()}`)
            }
          })
          if (context.options.once && result.exitCode !== 0) {
            return context.error({
              code: "watch_cycle_failed",
              message: "Watch execution failed",
              exitCode: result.exitCode
            })
          }
          return result
        } catch (cause) {
          return context.error({ code: "watch_failed", message: Diagnostic.describe(cause) })
        } finally {
          reporter.close()
        }
      }
    })
    .command("install", {
      description: "Plan and execute the install Flow under the toolchain the workspace declares",
      mcp: { annotations: { readOnlyHint: false } },
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        const reporter = reporterFor(context, config)
        try {
          const index = await openPackageIndex(context.options, config)
          const installs = index.targets().filter((row) =>
            row.packagePath === "" && Target.metadata(row.target).target === "Install"
          )
          if (installs.length !== 1) {
            throw new Error(
              installs.length === 0
                ? "the root PACKAGE.ts declares no Install target"
                : "the root PACKAGE.ts declares more than one Install target"
            )
          }
          const cacheDirectory = context.options.cacheDir === undefined
            ? index.workspace.cache.directory
            : Config.normalizeCacheDirectory(context.options.cacheDir)
          const remoteCache = remoteCacheAccess(
            remoteCacheOf(index.workspace.cache.remote, config.cacheUrl),
            config
          )
          const summary = await PackageExec.run({
            index,
            cacheDirectory,
            ...(remoteCache === undefined ? {} : { remoteCache }),
            verb: "run",
            patterns: [installs[0]!.label],
            environment: config.environment,
            signal: config.signal,
            reporter
          })
          return settle(context, config, summary)
        } catch (cause) {
          return context.error({
            code: "install_failed",
            exitCode: 1,
            message: Diagnostic.describe(cause),
            retryable: false
          })
        } finally {
          reporter.close()
        }
      }
    })
    .command("create-app", {
      description: "Scaffold a Smithers app from a @smthrs/create-app template",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ dir: z.string().describe("Directory to create; its name becomes the app name") }),
      options: z.object({
        template: z.string().default("default").describe("Template name")
      }),
      alias: { template: "t" },
      async run(context) {
        try {
          return await CreateApp.scaffold({
            directory: context.args.dir,
            template: context.options.template
          })
        } catch (cause) {
          return context.error({
            code: "create_app_failed",
            exitCode: 1,
            message: Diagnostic.describe(cause),
            retryable: false
          })
        }
      }
    })
    .command("build", {
      description: "Execute the build targets selected by a pattern",
      mcp: { annotations: { readOnlyHint: false } },
      args: patternsArgument,
      options: executionOptions,
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "build_failed",
          (reporter) => runVerb("build", context.args.patterns, context.options, config, reporter)
        )
    })
    .command("test", {
      description: "Execute test targets; wildcards omit exclusive tiers unless --include-exclusive is set",
      mcp: { annotations: { readOnlyHint: false } },
      args: patternsArgument,
      options: executionOptions,
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "test_failed",
          (reporter) => runVerb("test", context.args.patterns, context.options, config, reporter)
        )
    })
    .command("lint", {
      description: "Execute the lint targets selected by a pattern",
      mcp: { annotations: { readOnlyHint: false } },
      args: patternsArgument,
      options: executionOptions.extend({
        fix: z.boolean().default(false).describe("Apply agent lint fixes inside the declared fixes write-set")
      }),
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "lint_failed",
          (reporter) => runVerb("lint", context.args.patterns, context.options, config, reporter)
        )
    })
    .command("docs", {
      description:
        "Execute the documentation targets selected by a pattern: parity checks, freshness stamps, and Docs.Page writers",
      mcp: { annotations: { readOnlyHint: false } },
      args: patternsArgument,
      options: executionOptions.extend({
        write: z.boolean().default(false).describe(
          "Refresh the Docs.Check stamps of the selected pages instead of checking them"
        )
      }),
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "docs_failed",
          (reporter) => runVerb("docs", context.args.patterns, context.options, config, reporter)
        )
    })
    .command("review", {
      description:
        "Execute the model-review targets selected by a pattern (needs the engine CLI; skips where it is absent)",
      mcp: { annotations: { readOnlyHint: false } },
      args: patternsArgument,
      options: executionOptions,
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "review_failed",
          (reporter) => runVerb("review", context.args.patterns, context.options, config, reporter)
        )
    })
    .command("run", {
      description: "Execute run targets selected by a pattern",
      mcp: { annotations: { readOnlyHint: false } },
      args: patternsArgument,
      options: runOptions,
      alias: { ...executionAlias, ...invocationAlias, name: "n" },
      run: (context) =>
        executeCommand(
          context,
          config,
          "run_failed",
          (reporter) => runVerb("run", context.args.patterns, context.options, config, reporter)
        )
    })
    .command("target", {
      description: "Execute PACKAGE.ts labels with their flavor-implied verbs (the bare-label form)",
      mcp: { annotations: { readOnlyHint: false } },
      args: patternsArgument,
      options: executionOptions.extend({
        write: z.boolean().default(false).describe("Apply Diff/Generate/CiGen targets instead of checking drift"),
        fix: z.boolean().default(false).describe("Apply agent lint fixes inside the declared fixes write-set"),
        ...invocationOptions
      }),
      alias: { ...executionAlias, ...invocationAlias },
      run: (context) =>
        executeCommand(context, config, "target_failed", async (reporter) => {
          const outcome = await runPackageVerb("auto", context.args.patterns, context.options, config, reporter)
          return outcome
        })
    })
    .command("git-hooks", {
      aliases: ["gitHooks"],
      description: "Check the WORKSPACE.ts gitHooks scripts against .git/hooks, or install them with --write",
      mcp: { annotations: { readOnlyHint: false } },
      options: workspaceOption.extend({
        write: z.boolean().default(false).describe("Install the rendered hook scripts into .git/hooks")
      }),
      alias: { workspace: "w" },
      async run(context) {
        let outcome: Awaited<ReturnType<typeof runGitHooks>>
        try {
          outcome = await runGitHooks(context.options, config)
        } catch (cause) {
          return context.error({ code: "git_hooks_failed", exitCode: 1, message: Diagnostic.describe(cause) })
        }
        if (outcome.mode === "check" && !outcome.clean) {
          return context.error({
            code: "git_hooks_drift",
            exitCode: 1,
            message: `git hooks drift (run with --write to install): ${
              outcome.entries.filter((entry) => entry.status !== "clean").map((entry) =>
                `${entry.file}=${entry.status}`
              )
                .join(", ")
            }`,
            retryable: false
          })
        }
        return outcome
      }
    })
    .command("ci", {
      description:
        "Execute build, test, lint, and documentation targets; wildcards omit exclusive tiers unless --include-exclusive is set",
      mcp: { annotations: { readOnlyHint: false } },
      args: patternsArgument,
      options: executionOptions,
      alias: executionAlias,
      run: (context) =>
        executeCommand(
          context,
          config,
          "ci_failed",
          (reporter) => runCi(context.args.patterns, context.options, config, reporter)
        )
    })
    .command("query", {
      description: "List labels or evaluate deps(label), rdeps(label), or owners(label)",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({ expr: z.string().describe("Label, pattern, deps(label), rdeps(label), or owners(label)") }),
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          const result = await packageQuery(index, context.args.expr, environmentOf(config))
          return present(context, config, result, (style) => Query.text(result, style))
        } catch (cause) {
          return context.error({ code: "query_failed", exitCode: 1, message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("index", {
      description:
        "List every target a pattern selects as its declaration states it: rule, kinds, inputs, outputs, dependencies, and the declaring file",
      mcp: { annotations: { readOnlyHint: true } },
      args: patternArgument,
      options: workspaceOption,
      alias: { workspace: "w" },
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          const listing = await TargetIndex.build(index, context.args.pattern, environmentOf(config), config.signal)
          return present(context, config, listing, (style) => TargetIndex.text(listing, style))
        } catch (cause) {
          return context.error({ code: "index_failed", exitCode: 1, message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("owners", {
      description: "Resolve owners, reasons, and the agent policy for paths, or for the paths a diff touches",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({
        paths: z.array(z.string()).optional().describe("Workspace-relative paths; omit them and pass --diff instead")
      }),
      options: workspaceOption.extend({
        diff: z.string().optional().describe(
          "Also resolve every path changed since this git base, like S.gitDiff(base)"
        )
      }),
      alias: { workspace: "w", diff: "d" },
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          const paths = [...(context.args.paths ?? [])]
          if (context.options.diff !== undefined) {
            paths.push(...await Owners.changedPaths(index.root, context.options.diff))
          }
          if (paths.length === 0) throw new Error("owners needs at least one path, or --diff <base>")
          const resolution = Owners.resolve(index, paths)
          return present(context, config, Owners.toJson(resolution), (style) => Owners.text(resolution, style))
        } catch (cause) {
          return context.error({ code: "owners_failed", exitCode: 1, message: Diagnostic.describe(cause) })
        }
      }
    })
    .command("graph", {
      description: "Print the target graph without executing it",
      mcp: { annotations: { readOnlyHint: true } },
      args: patternArgument,
      options: workspaceOption.extend({
        mermaid: z.boolean().default(false).describe("Render Mermaid instead of a text tree")
      }),
      alias: { workspace: "w", mermaid: "m" },
      async run(context) {
        try {
          const index = await openPackageIndex(context.options, config)
          const { data, edges, rows } = await packageGraph(
            index,
            context.args.pattern,
            context.options.mermaid,
            environmentOf(config)
          )
          // Mermaid is meant for a file or a renderer, never a terminal.
          if (context.options.mermaid) return data
          return present(context, config, data, (style) => GraphOutput.packageText(rows, edges, style))
        } catch (cause) {
          return context.error({ code: "graph_failed", exitCode: 1, message: Diagnostic.describe(cause) })
        }
      }
    })

/**
 * Creates the configured smithers-build CLI; every command refuses surplus positionals.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeCli = (config: RuntimeConfig = {}) => Positionals.guard(makeCommands(config), globalOptions)

/**
 * Rewrites a bare-label argv into the `target` command.
 *
 * `smithers-build '//src:lint'` — a first argument that is a label rather than a
 * command — executes the label under its flavor-implied verb. Every other
 * argv passes through unchanged.
 *
 * @category parsing
 * @since 0.1.0
 * @slop
 */
export const normalizeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const first = argv[0]
  if (first !== undefined && (first.startsWith("//") || first.startsWith(":"))) {
    return ["target", ...argv]
  }
  return argv
}

/**
 * Programmatic CLI without process-scoped remote cache or interruption state.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const cli = makeCli()
