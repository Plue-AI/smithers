/**
 * Resolves the package graph and its content identities without executing target bodies.
 *
 * @since 1.0.0
 */

import * as PackageManager from "@smthrs/build/PackageManager"
import * as RuntimeService from "@smthrs/build/Runtime"
import * as AgentTarget from "@smthrs/targets/AgentTarget"
import type * as Anvil from "@smthrs/targets/Anvil"
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Cargo from "@smthrs/targets/Cargo"
import * as Compose from "@smthrs/targets/Compose"
import type * as Docker from "@smthrs/targets/Docker"
import type * as DocsCheck from "@smthrs/targets/DocsCheck"
import * as DocsPage from "@smthrs/targets/DocsPage"
import * as Exec from "@smthrs/targets/Exec"
import type * as GitTarget from "@smthrs/targets/GitTarget"
import * as Input from "@smthrs/targets/Input"
import type * as NodeArtifact from "@smthrs/targets/NodeArtifact"
import type * as NpmTarget from "@smthrs/targets/NpmTarget"
import * as RepoTarget from "@smthrs/targets/RepoTarget"
import * as RustToolchain from "@smthrs/targets/RustToolchain"
import * as Secret from "@smthrs/targets/Secret"
import * as Shell from "@smthrs/targets/Shell"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { minimatch } from "minimatch"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as AgentSession from "../AgentSession.ts"
import * as AnvilExec from "../AnvilExec.ts"
import { type CacheStore, openCache } from "../Cache.ts"
import * as CloudRunExec from "../CloudRunExec.ts"
import * as Diagnostic from "../Diagnostic.ts"
import * as DockerExec from "../DockerExec.ts"
import { targetToolchain } from "../engine.ts"
import * as FoundryExec from "../FoundryExec.ts"
import * as GitSubmoduleExec from "../GitSubmoduleExec.ts"
import * as GoExec from "../GoExec.ts"
import * as Label from "../Label.ts"
import * as NixExec from "../NixExec.ts"
import * as OverlayExec from "../OverlayExec.ts"
import * as OwnersResolution from "../Owners.ts"
import type * as PackageIndexModule from "../PackageIndex.ts"
import * as PackageTree from "../PackageTree.ts"
import * as Planner from "../Planner.ts"
import * as RepoResolution from "../RepoResolution.ts"
import * as Reporter from "../Reporter.ts"
import * as Resolver from "../Resolver.ts"
import * as StampExec from "../StampExec.ts"
import * as TargetIndex from "../TargetIndex.ts"
import * as Workspace from "../Workspace.ts"
import * as WorkspaceToolchain from "../WorkspaceToolchain.ts"
import * as ApprovalBridge from "./ApprovalBridge.ts"
import { collectTargets } from "./Attrs.ts"
import * as CoreRuleSelection from "./CoreRuleSelection.ts"
import { gitPathspecBatches } from "./GitPathspecBatches.ts"
import * as HostProbes from "./HostProbes.ts"
import { inputPackage } from "./InputPackage.ts"
import type {
  CrateRow,
  Mode,
  PackageNode,
  PackagePlan,
  RunOptions,
  TargetApprovals,
  TestOperandPlan
} from "./PackageOptions.ts"
import * as Path from "./Path.ts"
import type * as RuleContract from "./RuleContract.ts"
import * as RulePolicy from "./RulePolicy.ts"
import * as NativeRules from "./rules/NativeRules.ts"
import { posix, sha256Hex } from "./Text.ts"

/**
 * Cache-key salt for PACKAGE.ts execution semantics.
 *
 * @category keys
 * @since 0.1.0
 */
export const PACKAGE_EXECUTION_FORMAT = 3

/** Whether a node's workspace snapshot must exclude every concurrent peer.
 * @category execution
 * @since 0.1.0
 */
export const takesExclusiveTreePermit = (
  node: Pick<PackageNode, "rule" | "mode"> & Partial<Pick<PackageNode, "overlays">>
): boolean => node.mode === "write" || RulePolicy.of(node.rule).exclusive === true || (node.overlays?.length ?? 0) > 0

/**
 * The placeholder a bundler build's key template carries where the graph
 * dependency's key goes. Execution substitutes the resolved graph digest
 * (`bundler-graph:<digest>`) once the resolve node has settled, so a build
 * keys on the graph it bundles rather than on the declared universe; the
 * plan-time preview substitutes the digest when the cache already holds it
 * and the resolve node's own key otherwise.
 *
 * @category keys
 * @since 0.1.0
 */
export const graphKeySentinel = "{smthrs:bundler-graph-key}"

const replaceGraphKey = (value: unknown, key: string): unknown => {
  if (value === graphKeySentinel) return key
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) return value.map((entry) => replaceGraphKey(entry, key))
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const out: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(value)) out[name] = replaceGraphKey(entry, key)
  return out
}

/**
 * Substitutes the graph key into a bundler build's key template: the `graph`
 * attr reference and the dependency row both carry the sentinel.
 *
 * @category keys
 * @since 0.1.0
 */
export const keyMaterialWithGraph = (template: Planner.KeyMaterial, key: string): Planner.KeyMaterial => {
  const inputs = template.inputs as {
    readonly attrs: unknown
    readonly dependencies: ReadonlyArray<{ readonly label: string; readonly key: string }>
  }
  return {
    ...template,
    inputs: {
      ...inputs,
      attrs: replaceGraphKey(inputs.attrs, key),
      dependencies: inputs.dependencies.map((row) => row.key === graphKeySentinel ? { label: row.label, key } : row)
    }
  }
}

/**
 * Collects tagged records of one tag inside an attr value.
 *
 * @category internal
 * @since 1.0.0
 */
export const collectTagged = (
  value: unknown,
  tag: string,
  into: Array<Record<string, unknown>>,
  seen: Set<object>
): void => {
  if (typeof value !== "object" || value === null || seen.has(value) || Target.isTarget(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) collectTagged(entry, tag, into, seen)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  if ((value as { readonly _tag?: unknown })._tag === tag) into.push(value as Record<string, unknown>)
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && "value" in descriptor) collectTagged(descriptor.value, tag, into, seen)
  }
}

/**
 * Reads one own attribute without invoking an accessor.
 *
 * @category internal
 * @since 1.0.0
 */
export const attrMember = (attrs: unknown, name: string): unknown => {
  if (typeof attrs !== "object" || attrs === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(attrs, name)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

// Outward rules whose action has no transport in this executor. Refusing in
// the plan keeps `run` from spending gate runs on a target that cannot turn
// green; each rule leaves this refusal when its transport lands.
const notImplementedOutward = (rule: string): string =>
  `${rule}: not implemented by this executor; the plan refuses before any gate or outward effect`

// Non-outward rules with no runner in this executor. `Npm.Downstream` needs an
// isolated remote checkout that applies its overrides; until that runner lands
// the plan refuses it instead of scheduling a node whose only result is a failure.
const notImplementedRunner = (rule: string): string =>
  `${rule}: not implemented by this executor; the plan refuses before it runs`

const attrTargets = (attrs: unknown, name: string): ReadonlyArray<Target.AnyTarget> =>
  collectTargets(attrMember(attrs, name))

/** One resolved tool: the executable path plus its key-material identity. */
interface ResolvedTool {
  readonly path: string
  /** Fixed arguments for a one-shot reference, before the caller's arguments. */
  readonly args?: ReadonlyArray<string> | undefined
  readonly identity: unknown
}

/** A tool that could not be resolved: the typed refusal plus its identity. */
interface RefusedTool {
  readonly refusal: string
  readonly identity: unknown
}

type ToolOutcome = { readonly _tag: "resolved"; readonly tool: ResolvedTool } | {
  readonly _tag: "refused"
  readonly tool: RefusedTool
}

/**
 * Resolves the `.bin` entry name of one `S.NodeModule.Bin` reference.
 *
 * With no explicit `bin` argument the package's own manifest decides, the
 * npm/npx way: a string-form `bin` names the package basename; an object
 * `bin` selects the entry named after the package's unscoped name when the
 * map has one (`knip`, `@biomejs/biome` → `biome`); an object with exactly
 * one entry names its sole key whatever it is called; only a multi-entry
 * map with no package-name entry is ambiguous and requires the explicit
 * second argument. An unreadable manifest falls back to the package
 * basename, which the executable probe then refuses if absent.
 */
const binNameOf = async (
  root: string,
  packageName: string,
  bin: string | undefined
): Promise<{ readonly name: string } | { readonly problem: string }> => {
  if (bin !== undefined) return { name: bin }
  const parts = packageName.split("/")
  const basename = parts[parts.length - 1]!
  let declared: unknown
  try {
    const manifest = NodePath.join(root, "node_modules", ...packageName.split("/"), "package.json")
    declared = (JSON.parse(await Fs.readFile(manifest, "utf8")) as { readonly bin?: unknown }).bin
  } catch {
    return { name: basename }
  }
  if (typeof declared === "string") return { name: basename }
  if (typeof declared === "object" && declared !== null) {
    const names = Object.keys(declared)
    if (names.length === 1) return { name: names[0]! }
    if (names.includes(basename)) return { name: basename }
    if (names.length > 1) {
      return {
        problem: `package ${JSON.stringify(packageName)} exposes ${names.length} binaries (${names.join(", ")}); ` +
          "name one explicitly: S.NodeModule.Bin(package, bin)"
      }
    }
  }
  return { name: basename }
}

interface PlanContext {
  readonly root: string
  readonly cacheDirectory: string
  readonly index: PackageIndexModule.PackageIndex
  readonly signal: AbortSignal | undefined
  readonly log: (line: string) => void
  readonly flags: Readonly<Record<string, string>>
  readonly managerBinary: string | undefined
  /**
   * The package manager and runtime WORKSPACE.ts declares, filled into every
   * node whose rule names them; see {@link WorkspaceToolchain}.
   */
  readonly workspaceToolchain: WorkspaceToolchain.WorkspaceToolchain
  readonly tools: Map<string, ToolOutcome>
  /** One plan's byte reads only; every invocation allocates a fresh map. */
  readonly toolBytes: Map<string, Promise<string>>
  readonly probes: Map<string, PackageTree.Probe>
  /**
   * Host facts the native planners (Docker, Foundry, Anvil, mise) share across
   * every target of this invocation; keyed by executable, arguments and
   * environment, so a target env override never aliases the workspace probe.
   */
  readonly hostProbes: HostProbes.HostProbes
  readonly nodes: Map<string, PackageNode>
  readonly privateLabels: WeakMap<Target.AnyTarget, string>
  privateCounter: number
  readonly visiting: Set<Target.AnyTarget>
  readonly ambient: unknown
  /**
   * The mode each selected root is planned under, by label. `mode` is genuine
   * key material and each mode is a distinct view, but the scheduler, the
   * reports, and the cache all key by label, so one invocation plans one node
   * per label. When a Diff or Generate target is both a check-mode dependency
   * (or gate) and a `--write` root in the same invocation, the root's mode is
   * authoritative: the single node runs and applies, which also satisfies the
   * dependent that wanted it green. Cross-invocation mode views stay on
   * distinct keys because each invocation plans the label in exactly one mode.
   */
  readonly rootModes: ReadonlyMap<string, Mode>
  /** The invoker's `--input name=value` payload values, decoded per agent node at plan time. */
  readonly inputs: Readonly<Record<string, string>>
  /** Host and Nix environment used to resolve tools and construct their execution plans. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The workspace's resolved Nix environment, when it declares one; its PATH is `environment`'s. */
  readonly nixEnvironment: NixExec.ResolvedEnvironment | undefined
  /** Lazily opened cache store for plan-time closure rows and graph digests. */
  store: CacheStore | undefined
  storeWarned: boolean
  /** The remote cache the plan-time store reads through, when one is declared. */
  readonly remoteCache: Workspace.RemoteCacheAccess | undefined
  /** ImportClosure label → canonical result digest (plan-time, memoized). */
  /** Expanded crate sets, memoized per `S.Cargo.AppSet` label. */
  readonly crateSets: Map<string, ReadonlyArray<CrateRow>>
  readonly closureDigests: Map<string, string>
  /** ImportClosure label → computed closure result (plan-time, memoized). */
  readonly closureResults: Map<string, Compose.ClosureResult>
  /** Bundler resolve label → resolved graph digest (plan-time, memoized). */
  readonly graphDigests: Map<string, string>
  /** Repo.Target declaration → child query result for this operation. */
  readonly repoResolutions: RepoResolution.Resolver
  /** Whether Repo.Target must ask the child CLI for its inert plan. */
  readonly childPlan: boolean
  /** Receives the child CLI's plan output, so it reaches the run's terminals. */
  readonly reporter: Reporter.Reporter
  /** Whether the parent invocation selected write mode. */
  readonly write: boolean
  /** The verb-effective target view, absent only for the bare-label form. */
  readonly kind: Target.Kind | undefined
  /** The durable approvals a `required` target is checked against; absent refuses it. */
  readonly approvals: TargetApprovals | undefined
}

/** Opens (once) the cache store the planner uses for closure rows and graph digests. */
const planStore = async (context: PlanContext): Promise<CacheStore | undefined> => {
  if (context.store !== undefined) return context.store
  if (context.storeWarned) return undefined
  try {
    context.store = await openCache({
      workspaceRoot: context.root,
      cacheDirectory: context.cacheDirectory,
      endpoint: context.remoteCache?.endpoint,
      readToken: context.remoteCache?.readToken,
      writeToken: context.remoteCache?.writeToken,
      publishNamespace: context.remoteCache?.publishNamespace,
      warn: context.log
    })
    return context.store
  } catch (cause) {
    context.storeWarned = true
    context.log(`smthrs: plan-time cache unavailable: ${Diagnostic.describe(cause)}`)
    return undefined
  }
}

/**
 * The canonical digest of one closure result: files, packages, and issue
 * rows. Consumers of an ImportClosure key on it.
 *
 * @category keys
 * @since 0.1.0
 */
export const closureResultDigest = (result: Compose.ClosureResult): string =>
  sha256Hex(JSON.stringify({
    files: result.files,
    packages: result.packages,
    unresolved: result.unresolved,
    dynamic: result.dynamic
  }))

/** The implementation context payload accessors expect for one declaration. */
const contextOf = (metadata: Target.Metadata): Target.ImplementationContext => ({
  sourceFile: metadata.sourceFile,
  packageDirectory: metadata.sourceFile === undefined ? undefined : NodePath.dirname(metadata.sourceFile)
})

/**
 * Computes (memoized per label) the closure result of one ImportClosure
 * target. Runs the resolver at plan time: the result digest is what keys the
 * closure's consumers, so an edit to any file in the closure re-keys them
 * while an unrelated edit does not.
 */
const closureResultOf = async (
  context: PlanContext,
  label: string,
  closureTarget: Target.AnyTarget
): Promise<Compose.ClosureResult> => {
  const known = context.closureResults.get(label)
  if (known !== undefined) return known
  const metadata = Target.metadata(closureTarget)
  const entries = Compose.closureEntrySources(
    (metadata.attrs as { readonly entries: never }).entries,
    contextOf(metadata)
  )
  if (typeof entries === "string") throw new Error(`ImportClosure: ${entries}`)
  const store = await planStore(context)
  const result = await Resolver.closureOfEntries(
    {
      workspaceRoot: context.root,
      cacheDirectory: context.cacheDirectory,
      cache: store
    },
    entries
  )
  context.closureResults.set(label, result)
  context.closureDigests.set(label, closureResultDigest(result))
  return result
}

/**
 * Cache-output shape one bundler resolve stores.
 *
 * @category internal
 * @since 1.0.0
 */
export interface StoredResolve {
  readonly kind: "bundler-resolve"
  readonly result: BundlerTarget.ResolveResult
}

/**
 * Validates the cached bundler graph before it contributes to a key.
 *
 * @category internal
 * @since 1.0.0
 */
export const decodeStoredResolve = (output: unknown): BundlerTarget.ResolveResult | undefined => {
  if (typeof output !== "object" || output === null) return undefined
  if ((output as { readonly kind?: unknown }).kind !== "bundler-resolve") return undefined
  const result = (output as { readonly result?: unknown }).result
  try {
    return Schema.decodeUnknownSync(BundlerTarget.ResolveResult)(result)
  } catch {
    return undefined
  }
}

/**
 * The scratch directory bundler children redirect resolve emit and caches into.
 *
 * @category internal
 * @since 1.0.0
 */
export const bundlerScratchDirectory = (root: string, cacheDirectory: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "bundler-scratch")

/**
 * Reads (memoized per label) the resolved graph digest of one bundler
 * resolve node from the cache, under the resolve node's own key. The digest
 * substitutes for the graph dependency's key in every `Bundler.Rspack.build`
 * consumer, which is the caching win the spec names: an edit that does not
 * change the resolved file set replays the build from cache.
 *
 * Plan time is cache-only: the resolve target's universe (relay artifacts
 * and other data producers) may not be materialized before execution, so a
 * plan-time compile could be wrong or fail on a cold tree. With no cached
 * result the build keys conservatively on the resolve target's own key and
 * the execution of the resolve node stores the result for the next
 * invocation.
 */
const graphDigestOf = async (
  context: PlanContext,
  resolveNode: PackageNode
): Promise<string | undefined> => {
  const known = context.graphDigests.get(resolveNode.label)
  if (known !== undefined) return known
  if (resolveNode.lane?.kind !== "bundler-resolve") {
    throw new Error(`the graph of a bundler build must be a Bundler.Rspack.resolve target: ${resolveNode.label}`)
  }
  const store = await planStore(context)
  const cached = store === undefined ? null : await store.get(resolveNode.keyPreview).catch(() => null)
  if (cached !== null && cached.exitOk) {
    const result = decodeStoredResolve(cached.output)
    if (result !== undefined) {
      context.graphDigests.set(resolveNode.label, result.graphDigest)
      return result.graphDigest
    }
  }
  return undefined
}

const probeOnce = async (
  context: PlanContext,
  path: string,
  args: ReadonlyArray<string> = ["--version"]
): Promise<PackageTree.Probe> => {
  // A selected interpreter can probe both itself and a script launcher. Their
  // distinct argument vectors must never share a cached version observation.
  const key = JSON.stringify([path, args])
  const known = context.probes.get(key)
  if (known !== undefined) return known
  // A declared executable's version probe needs lookup capabilities, never
  // the CLI's credentials. Configuration lookup starts at the workspace just
  // as native target execution does. Target env overrides have separate maps.
  const names = new Set<string>(RuntimeService.lookupEnvironmentNames)
  const environment = Object.fromEntries(
    Object.entries(context.environment).filter(([name, value]) =>
      typeof value === "string" && names.has(process.platform === "win32" ? name.toUpperCase() : name)
    )
  )
  const probe = await PackageTree.probeVersion(path, { cwd: context.root, args, environment })
  context.probes.set(key, probe)
  return probe
}

/** Resolves and measures one declared JavaScript tool before native execution. */
const declaredJavaScriptTool = async (
  context: PlanContext,
  tag: string,
  declared: { readonly name: string; readonly executable: string; readonly version?: string | undefined }
): Promise<ToolOutcome> => {
  const executable = declared.executable
  const path = NodePath.isAbsolute(executable)
    ? executable
    : executable.includes(NodePath.sep) || executable.includes("/")
    ? NodePath.resolve(context.root, executable)
    : PackageTree.findOnPath(executable, context.environment)
  const identity = { tag, name: declared.name, requirement: declared.version ?? null, executable }
  if (path === undefined) {
    return {
      _tag: "refused",
      tool: {
        refusal: `workspace ${declared.name} executable ${JSON.stringify(executable)} is not present on PATH`,
        identity
      }
    }
  }
  const probe = await probeOnce(context, path)
  const measured = probe.output.trim()
  const measuredIdentity = { ...identity, path, probe }
  if (declared.version !== undefined) {
    if (
      probe.exitCode !== 0 ||
      !/^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(measured)
    ) {
      return {
        _tag: "refused",
        tool: {
          refusal: `cannot measure the declared ${declared.name} executable ${JSON.stringify(executable)}`,
          identity: measuredIdentity
        }
      }
    }
    const satisfies = RuntimeService.satisfies(declared.version, measured)
    if (satisfies !== true) {
      return {
        _tag: "refused",
        tool: {
          refusal: satisfies === "unsupported_requirement"
            ? `unsupported workspace ${declared.name} version requirement: ${declared.version}`
            : `workspace declares ${declared.name} ${declared.version}, but ${
              JSON.stringify(executable)
            } runs ${measured}`,
          identity: measuredIdentity
        }
      }
    }
  }
  return { _tag: "resolved", tool: { path, identity: measuredIdentity } }
}

/**
 * Identifies executable bytes and their interpreter chain for planning and revalidation.
 *
 * @category internal
 * @since 1.0.0
 */
export const binaryIdentity = async (
  context: {
    readonly root: string
    readonly toolBytes: Map<string, Promise<string>>
    readonly environment: Readonly<Record<string, string | undefined>>
  },
  path: string,
  ancestors: ReadonlySet<string> = new Set()
): Promise<unknown> => {
  const resolved = await Fs.realpath(path)
  if (ancestors.has(resolved)) throw new Error(`cyclic executable interpreter: ${path}`)
  let digest = context.toolBytes.get(resolved)
  if (digest === undefined) {
    digest = PackageTree.digestFileBytes(resolved)
    context.toolBytes.set(resolved, digest)
  }
  // Workspace installations stay relocatable; a host path selects a specific
  // installation, whose bytes can change without its version string changing.
  const portable = (file: string): string => {
    const relative = Path.containedRelative(context.root, file)
    return relative === undefined ? file : `${workspaceRootToken}/${posix(relative)}`
  }
  const interpreters: Array<unknown> = []
  // The kernel follows the shebang, and env then resolves its command on
  // PATH. Hashing only the script misses both executable dependencies.
  const handle = await Fs.open(resolved, "r")
  let header: string
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    header = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]!
  } finally {
    await handle.close()
  }
  const shebang = /^#!\s*(\S+)(?:\s+(.*))?$/.exec(header)
  if (shebang !== null) {
    const interpreter = shebang[1]!
    const next = new Set([...ancestors, resolved])
    interpreters.push(await binaryIdentity(context, interpreter, next))
    if (NodePath.basename(interpreter) === "env") {
      const args = (shebang[2] ?? "").trim().replace(/^(?:-S\s+|--split-string=)/, "")
      const command = /^([A-Za-z0-9_./+-]+)(?:\s|$)/.exec(args)?.[1]
      if (command === undefined || command.startsWith("-") || command.includes("=")) {
        throw new Error(`cannot identify env shebang interpreter: ${path}`)
      }
      const selected = NodePath.isAbsolute(command) ? command : PackageTree.findOnPath(command, context.environment)
      if (selected === undefined) throw new Error(`shebang interpreter ${JSON.stringify(command)} is not on PATH`)
      interpreters.push(await binaryIdentity(context, selected, next))
    }
  }
  return {
    _tag: "Executable",
    source: portable(path),
    path: portable(resolved),
    digest: await digest,
    interpreters
  }
}

/** Both explicit Go references and Go rules identify the selected SDK, not just its launcher. */
const goIdentity = async (
  context: PlanContext,
  resolved: Extract<Awaited<ReturnType<typeof GoExec.resolveGo>>, { readonly ok: true }>
): Promise<unknown> => ({
  resolution: resolved.identity,
  executables: await Promise.all(resolved.executables.map((path) => binaryIdentity(context, path))),
  // `go build` compiles the standard library from `$GOROOT/src` and reads
  // `$GOROOT/go.env` and `$GOROOT/lib`, none of which sit beside the
  // executables above. The SDK is one installed tree, so name its root here
  // and let the confinement admit the whole of it. The launcher's own host
  // path already keys, so the root adds no new key variation.
  sdkRoot: { _tag: "ExecutableRoot", path: resolved.sdkRoot }
})

const moduleVersion = async (root: string, packageName: string): Promise<string | null> => {
  try {
    const manifest = NodePath.join(root, "node_modules", ...packageName.split("/"), "package.json")
    const parsed = JSON.parse(await Fs.readFile(manifest, "utf8")) as { readonly version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : null
  } catch {
    return null
  }
}

/** Expands one `S.Cargo.AppSet` declaration to its member crates. */
const appSetCrates = async (
  context: PlanContext,
  target: Target.AnyTarget
): Promise<ReadonlyArray<CrateRow>> => {
  const label = labelOf(context, target)
  const known = context.crateSets.get(label)
  if (known !== undefined) return known
  const attrs = Target.metadata(target).attrs as Record<string, unknown>
  const packagePath = packagePathOf(context, target)
  const declared = attrs["manifests"]
  const globs = (Array.isArray(declared) ? declared : [declared]).filter(
    (entry): entry is Input.Glob =>
      typeof entry === "object" && entry !== null && (entry as { readonly _tag?: unknown })._tag === "Glob"
  )
  const paths = new Set<string>()
  for (const glob of globs) {
    for (
      const match of await Input.expandGlob(context.root, packagePath, glob, {
        cacheDirectory: context.cacheDirectory,
        signal: context.signal
      })
    ) paths.add(match)
  }
  const filter = Cargo.appSetFilter(attrs)
  const rows: Array<CrateRow> = []
  for (const manifest of [...paths].sort()) {
    let text: string
    try {
      text = await Fs.readFile(NodePath.join(context.root, ...manifest.split("/")), "utf8")
    } catch {
      continue
    }
    const facts = Cargo.manifestFacts(text)
    if (filter !== undefined && !Cargo.metadataMatches(facts.metadata, filter)) continue
    rows.push({ manifest, name: facts.name, digest: Input.digestText(text) })
  }
  context.crateSets.set(label, rows)
  return rows
}

/** The target one file-algebra operand names. */
const operandTarget = (value: unknown): Target.AnyTarget | undefined => {
  if (Target.isTarget(value)) return value
  if (
    typeof value === "object" && value !== null &&
    (value as { readonly _tag?: unknown })._tag === "TargetFiles" &&
    Target.isTarget((value as { readonly target?: unknown }).target)
  ) return (value as { readonly target: Target.AnyTarget }).target
  return undefined
}

/**
 * Reduces one declared `crates` selector to its member crates, or names the
 * reason it cannot be reduced.
 *
 * `S.Files.difference` composes over crate sets the same way it composes over
 * file sets: the right set is subtracted from the left by manifest path.
 */
const crateSetOf = async (
  context: PlanContext,
  value: unknown
): Promise<ReadonlyArray<CrateRow> | string> => {
  const target = operandTarget(value)
  if (target !== undefined) {
    if (!Cargo.isAppSet(target)) {
      return `crates must name S.Cargo.AppSet targets; ${labelOf(context, target)} is ${Target.metadata(target).target}`
    }
    return appSetCrates(context, target)
  }
  if (
    typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "FilesDifference"
  ) {
    const difference = value as { readonly left: unknown; readonly right: unknown }
    const left = await crateSetOf(context, difference.left)
    if (typeof left === "string") return left
    const right = await crateSetOf(context, difference.right)
    if (typeof right === "string") return right
    const removed = new Set(right.map((row) => row.manifest))
    return left.filter((row) => !removed.has(row.manifest))
  }
  return "crates must be an S.Cargo.AppSet target, or an S.Files.difference of two of them"
}

/**
 * The `CARGO_HOME` one `S.Cargo.Fetch` declaration delivers, workspace
 * relative.
 *
 * The fetch resource's first declared output directory is where it puts what
 * it fetched, so pinning `CARGO_HOME` there is what makes `--offline` on every
 * dependent mean "read what the fetch delivered" rather than "read whatever
 * this host happens to have in ~/.cargo".
 */
const fetchCargoHome = (context: PlanContext, target: Target.AnyTarget): string | undefined => {
  const declared = attrMember(Target.metadata(target).attrs, "outDirs")
  if (!Array.isArray(declared)) return undefined
  const first = declared.find((entry): entry is string => typeof entry === "string")
  return first === undefined ? undefined : Input.resolvePath(packagePathOf(context, target), first)
}

/**
 * The placeholder a planned argv carries where the absolute workspace root
 * goes.
 *
 * A path built from the workspace root would otherwise be key material that
 * differs between two checkouts of the same tree, so the plan keeps the
 * workspace-relative form and the spawn substitutes the root.
 *
 * @category keys
 * @since 0.1.0
 */
export const workspaceRootToken = "{smthrs:root}"

/**
 * The executable one target used as a tool edge produces, workspace relative,
 * or the reason it produces none.
 *
 * Only a `Cargo.Build` that declares exactly one `bins` entry produces an
 * addressable executable today: its path follows from the profile and the bin
 * name. Every other target refuses by name rather than being guessed at.
 */
const targetExecutable = (
  context: PlanContext,
  target: Target.AnyTarget
): { readonly path: string } | { readonly problem: string } => {
  const metadata = Target.metadata(target)
  const label = labelOf(context, target)
  if (metadata.target === "Cargo.Build") {
    const paths = Cargo.binaries(metadata.attrs)
    if (paths.length !== 1) {
      return {
        problem: `bin names ${label}, which declares ${paths.length} binaries; a tool edge needs exactly one`
      }
    }
    // Cargo puts every member's binaries in the workspace target directory,
    // so the path is workspace relative, not package relative.
    return { path: paths[0]! }
  }
  const out = attrMember(metadata.attrs, "out")
  if (typeof out === "string") return { path: Input.resolvePath(packagePathOf(context, target), out) }
  return { problem: `bin names ${label}, a ${metadata.target} target that declares no executable output` }
}

/** The declared files one `S.Cargo.Fetch` delivers, workspace relative. */
const fetchOutFiles = (context: PlanContext, target: Target.AnyTarget): ReadonlyArray<string> => {
  const declared = attrMember(Target.metadata(target).attrs, "outFiles")
  if (!Array.isArray(declared)) return []
  const packagePath = packagePathOf(context, target)
  return declared
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => Input.resolvePath(packagePath, entry))
}

const resolveTool = async (context: PlanContext, reference: Record<string, unknown>): Promise<ToolOutcome> => {
  const key = JSON.stringify(reference)
  const known = context.tools.get(key)
  if (known !== undefined) return known
  const tag = reference["_tag"]
  let outcome: ToolOutcome
  if (tag === "NodeModuleBin") {
    const packageName = String(reference["package"])
    const resolvedBin = await binNameOf(
      context.root,
      packageName,
      typeof reference["bin"] === "string" ? reference["bin"] : undefined
    )
    if ("problem" in resolvedBin) {
      outcome = {
        _tag: "refused",
        tool: {
          refusal: resolvedBin.problem,
          identity: { tag: "NodeModuleBin", package: packageName, ambiguous: true }
        }
      }
      context.tools.set(key, outcome)
      return outcome
    }
    const bin = resolvedBin.name
    const path = NodePath.join(context.root, "node_modules", ".bin", bin)
    const version = await moduleVersion(context.root, packageName)
    const identity = { tag: "NodeModuleBin", package: packageName, bin, version }
    let executable = false
    try {
      await Fs.access(path, 1)
      executable = true
    } catch {
      executable = false
    }
    outcome = executable
      ? { _tag: "resolved", tool: { path, identity } }
      : {
        _tag: "refused",
        tool: {
          refusal: `node_modules binary not found: ${posix(NodePath.relative(context.root, path))} ` +
            `(from S.NodeModule.Bin(${JSON.stringify(packageName)}))`,
          identity: { ...identity, absent: true }
        }
      }
  } else if (tag === "HostBin") {
    const name = String(reference["name"])
    const variable = typeof reference["env"] === "string" ? reference["env"] : undefined
    const selected = variable === undefined ? undefined : context.environment[variable]
    let path: string | undefined
    let problem: string | undefined
    if (selected !== undefined && selected !== "") {
      // The variable selects the binary exactly as the tool's own callers do;
      // PATH is never a fallback for a path that does not execute.
      if (!NodePath.isAbsolute(selected)) problem = `${variable} must name an absolute path to ${JSON.stringify(name)}`
      else if (!Exec.isExecutableFile(selected)) {
        problem = `${variable} names ${JSON.stringify(selected)}, which is not an executable file`
      } else path = selected
    } else {
      path = PackageTree.findOnPath(name, context.environment)
      if (path === undefined) {
        problem = `host binary ${JSON.stringify(name)} is declared in S.Host({ bins }) but is not present on PATH` +
          (variable === undefined ? "" : ` and ${variable} is unset`)
      }
    }
    if (path === undefined) {
      outcome = {
        _tag: "refused",
        tool: {
          refusal: problem!,
          identity: { tag: "HostBin", name, absent: true }
        }
      }
    } else {
      const probe = await probeOnce(context, path)
      outcome = {
        _tag: "resolved",
        tool: {
          path,
          identity: { tag: "HostBin", name, path, probe: { exitCode: probe.exitCode, output: probe.output } }
        }
      }
    }
  } else if (tag === "PackageManagerBin") {
    const manager = context.workspaceToolchain.packageManager
    const name = manager?.executable ?? context.managerBinary
    if (name === undefined) {
      outcome = {
        _tag: "refused",
        tool: {
          refusal: "workspace declares no Node package manager; S.PackageManager.bin is unavailable",
          identity: { tag: "PackageManagerBin", absent: true }
        }
      }
      context.tools.set(key, outcome)
      return outcome
    }
    outcome = await declaredJavaScriptTool(context, "PackageManagerBin", {
      name: manager?.name ?? name,
      executable: name,
      version: manager?.version
    })
    if (manager !== undefined && outcome._tag === "resolved") {
      const runtime = await declaredJavaScriptTool(context, "RuntimeBin", manager.runtime)
      outcome = runtime._tag === "refused" ? runtime : {
        _tag: "resolved",
        tool: { path: outcome.tool.path, identity: { manager: outcome.tool.identity, runtime: runtime.tool.identity } }
      }
    }
  } else if (tag === "GoBin" || tag === "GoRun") {
    const resolved = await GoExec.resolveGo({
      root: context.root,
      packagePath: "",
      workspace: context.index.workspace,
      environment: context.environment
    })
    outcome = resolved.ok
      ? {
        _tag: "resolved",
        tool: {
          path: resolved.path,
          identity: {
            ...await goIdentity(context, resolved) as object,
            ...(tag === "GoRun" ? { spec: reference["spec"] } : {})
          }
        }
      }
      : { _tag: "refused", tool: { refusal: resolved.refusal, identity: resolved.identity } }
  } else if (tag === "NixBin") {
    const resolved = await GoExec.resolveNix(String(reference["name"]), {
      signal: context.signal,
      root: context.root,
      packagePath: "",
      workspace: context.index.workspace,
      environment: context.environment,
      nix: context.nixEnvironment
    })
    outcome = resolved.ok
      ? { _tag: "resolved", tool: { path: resolved.path, identity: resolved.identity } }
      : { _tag: "refused", tool: { refusal: resolved.refusal, identity: resolved.identity } }
  } else if (tag === "RuntimeBin") {
    const runtime = context.workspaceToolchain.runtime
    outcome = runtime === undefined
      ? {
        _tag: "refused",
        tool: {
          refusal: "workspace declares no JavaScript runtime; S.Runtime.bin is unavailable",
          identity: { tag: "RuntimeBin", absent: true }
        }
      }
      : await declaredJavaScriptTool(context, "RuntimeBin", runtime)
  } else if (tag === "CargoBin") {
    // Cargo comes from the workspace toolchain layer, never from a guess: a
    // workspace that declares no layer refuses every cargo target by name.
    const layer = WorkspaceDeclaration.rustToolchain(context.index.workspace)
    if (layer === undefined) {
      outcome = {
        _tag: "refused",
        tool: {
          refusal: "the workspace declares no Rust toolchain layer; " +
            "add toolchains: [S.Rust.Toolchain({ ... })] to WORKSPACE.ts",
          identity: { tag: "CargoBin", absent: true }
        }
      }
    } else {
      const name = layer.cargo
      const path = NodePath.isAbsolute(name) ? name : PackageTree.findOnPath(name)
      if (path === undefined) {
        outcome = {
          _tag: "refused",
          tool: {
            refusal: `the workspace toolchain's cargo executable ${JSON.stringify(name)} is not present on PATH`,
            identity: { tag: "CargoBin", cargo: name, absent: true }
          }
        }
      } else {
        const probe = await probeOnce(context, path)
        const rustup = NodePath.isAbsolute(layer.rustup)
          ? layer.rustup
          : PackageTree.findOnPath(layer.rustup, context.environment)
        const components: Array<unknown> = []
        if (rustup !== undefined) {
          components.push(await binaryIdentity(context, rustup))
          // Cargo is commonly a hard link to the rustup proxy. The proxy's
          // bytes and version do not identify the selected compiler tools.
          const channel = context.environment["RUSTUP_TOOLCHAIN"] ?? layer.channel
          for (const name of ["cargo", "rustc", "cargo-clippy", "clippy-driver", "cargo-fmt", "rustfmt"]) {
            const selected = await PackageTree.probeVersion(rustup, {
              cwd: context.root,
              args: ["which", ...(channel === undefined ? [] : ["--toolchain", channel]), name],
              environment: context.environment
            })
            const selectedPath = selected.output.trim()
            if (selected.exitCode === 0 && NodePath.isAbsolute(selectedPath) && NodeFs.existsSync(selectedPath)) {
              components.push({ name, binary: await binaryIdentity(context, selectedPath) })
            } else {
              // Optional components may be uninstalled. Their absence is key
              // material; Cargo reports a missing required component on use.
              components.push({ name, absent: true })
            }
          }
        }
        // Without rustup this is a standalone Cargo installation. Its own
        // executable is hashed below; no rustup-selected SDK exists to key.
        outcome = {
          _tag: "resolved",
          tool: {
            path,
            identity: {
              tag: "CargoBin",
              toolchain: RustToolchain.toolchainIdentity(layer),
              components,
              path,
              probe: { exitCode: probe.exitCode, output: probe.output }
            }
          }
        }
      }
    }
  } else if (tag === "RuntimeNpx") {
    const runtime = await resolveTool(context, { _tag: "RuntimeBin" })
    const spec = String(reference["spec"])
    if (runtime._tag === "refused") {
      outcome = runtime
    } else if (context.workspaceToolchain.runtime?.name === "bun") {
      outcome = {
        _tag: "resolved",
        tool: {
          path: runtime.tool.path,
          args: ["x", "--bun", spec],
          identity: { tag: "RuntimeNpx", spec, runtime: runtime.tool.identity }
        }
      }
    } else {
      const path = PackageTree.findOnPath("npx", context.environment)
      if (path === undefined) {
        outcome = {
          _tag: "refused",
          tool: {
            refusal: "npx is not present on PATH",
            identity: { tag: "RuntimeNpx", spec: reference["spec"], absent: true }
          }
        }
      } else {
        // Run npm's JavaScript launcher with the selected Node, instead of
        // allowing its shebang to silently select another interpreter.
        const script = await Fs.realpath(path)
        if (/\.(?:cmd|bat)$/i.test(script)) {
          outcome = {
            _tag: "refused",
            tool: {
              refusal: "Runtime.npx under Node requires the JavaScript npx launcher on PATH, not a batch shim",
              identity: { tag: "RuntimeNpx", spec, path: script }
            }
          }
        } else {
          const relative = Path.containedRelative(context.root, script)
          const portable = relative === undefined ? script : `${workspaceRootToken}/${posix(relative)}`
          // The launcher can remain byte-identical across npm releases while
          // its imported implementation changes. Keep its reported version in
          // identity, measured by the same Node that will execute the command.
          const probe = await probeOnce(context, runtime.tool.path, [script, "--version"])
          outcome = {
            _tag: "resolved",
            tool: {
              path: runtime.tool.path,
              args: [script, spec],
              identity: {
                tag: "RuntimeNpx",
                spec,
                runtime: runtime.tool.identity,
                probe,
                // The launcher is script input to the measured interpreter;
                // its original shebang is intentionally not executed.
                launcher: {
                  _tag: "Executable",
                  source: portable,
                  path: portable,
                  digest: await Input.digestFile(script, { signal: context.signal }),
                  interpreters: []
                }
              }
            }
          }
        }
      }
    }
  } else if (tag === "MiseBin") {
    const resolved = await FoundryExec.resolveMiseBin(
      context.root,
      context.index.workspace,
      String(reference["name"]),
      context.environment,
      context.hostProbes
    )
    outcome = resolved.ok
      ? { _tag: "resolved", tool: { path: resolved.path, identity: resolved.identity } }
      : { _tag: "refused", tool: { refusal: resolved.refusal, identity: resolved.identity } }
  } else {
    outcome = {
      _tag: "refused",
      tool: { refusal: `unknown tool reference: ${key}`, identity: { tag: "unknown", key } }
    }
  }
  if (outcome._tag === "resolved") {
    outcome = {
      _tag: "resolved",
      tool: {
        ...outcome.tool,
        identity: { resolution: outcome.tool.identity, binary: await binaryIdentity(context, outcome.tool.path) }
      }
    }
  }
  context.tools.set(key, outcome)
  return outcome
}

const resolveBun = async (context: PlanContext): Promise<ToolOutcome> => {
  const key = "{bun}"
  const known = context.tools.get(key)
  if (known !== undefined) return known
  const path = PackageTree.findOnPath("bun")
  let outcome: ToolOutcome
  if (path === undefined) {
    outcome = {
      _tag: "refused",
      tool: {
        refusal: "bun is required for bun: templates but is not present on PATH",
        identity: { tag: "Bun", absent: true }
      }
    }
  } else {
    const probe = await probeOnce(context, path)
    outcome = {
      _tag: "resolved",
      tool: { path, identity: { tag: "Bun", path, probe: { exitCode: probe.exitCode, output: probe.output } } }
    }
  }
  context.tools.set(key, outcome)
  return outcome
}

const packagePathOf = (context: PlanContext, target: Target.AnyTarget): string => {
  const source = Target.metadata(target).sourceFile
  if (source !== undefined) {
    const relative = Path.containedRelative(context.root, NodePath.dirname(source))
    if (relative === "") return ""
    if (relative !== undefined) return posix(relative)
  }
  return context.index.ownerOf(target) ?? ""
}

const labelOf = (context: PlanContext, target: Target.AnyTarget): string => {
  const labeled = context.index.labelOf(target)
  if (labeled !== undefined) return labeled
  const known = context.privateLabels.get(target)
  if (known !== undefined) return known
  context.privateCounter += 1
  const label = `//${packagePathOf(context, target)}:__private_${
    Target.metadata(target).target.replace(/[^A-Za-z0-9]/g, "_")
  }_${context.privateCounter}`
  context.privateLabels.set(target, label)
  return label
}

/** Expands and digests one target's declared inputs against its package. */
const expandInputs = async (
  context: PlanContext,
  packagePath: string,
  declarations: ReadonlyArray<Input.Declared>
): Promise<ReadonlyArray<Workspace.ExpandedInput>> => {
  const expanded: Array<Workspace.ExpandedInput> = []
  for (const declaration of declarations) {
    if (declaration._tag === "File") {
      const path = Input.resolvePath(packagePath, declaration.path)
      const digest = await Input.digestFile(NodePath.join(context.root, path), {
        workspaceRoot: context.root,
        signal: context.signal
      })
      const files = [{ path, digest }]
      expanded.push({ declaration, files, digest: Input.digestText(JSON.stringify(files)) })
      continue
    }
    if (declaration._tag === "Glob") {
      const matches = await Input.expandGlob(context.root, packagePath, declaration, {
        cacheDirectory: context.cacheDirectory,
        repositoryBoundaries: Object.values(context.index.workspace.repos ?? {}).map((repo) => repo.path),
        signal: context.signal
      })
      const files = await Input.digestFiles(context.root, matches, { signal: context.signal })
      expanded.push({ declaration, files, digest: Input.digestText(JSON.stringify(files)) })
      continue
    }
    if (declaration._tag === "PnpmWorkspace") {
      const matches = await Input.expandPnpmWorkspace(context.root, packagePath, declaration, {
        cacheDirectory: context.cacheDirectory,
        signal: context.signal
      })
      const files = await Input.digestFiles(context.root, matches, { signal: context.signal })
      expanded.push({ declaration, files, digest: Input.digestText(JSON.stringify(files)) })
      continue
    }
    expanded.push(await expandGitDiff(context, declaration))
  }
  return expanded
}

/** One `git diff --name-status -z` row. */
interface DiffEntry {
  readonly status: string
  readonly path: string
}

const parseNameStatusZ = (raw: string): Array<DiffEntry> => {
  const parts = raw.split("\0")
  const entries: Array<DiffEntry> = []
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index]!
    if (status === "") continue
    // Rename/copy rows carry two paths; the post-image is the second one.
    if (status.startsWith("R") || status.startsWith("C")) {
      const post = parts[index + 2]
      if (post !== undefined && post !== "") entries.push({ status, path: post })
      index += 2
      continue
    }
    const path = parts[index + 1]
    if (path !== undefined && path !== "") entries.push({ status, path })
    index += 1
  }
  return entries
}

/**
 * Expands one declared git diff to key material: the filtered file digests
 * plus the filtered patch bytes. `paths` narrows by glob; `added` narrows to
 * added files matching its globs; `addedLines` contributes its source text
 * (the patch already carries the lines).
 */
const expandGitDiff = async (
  context: PlanContext,
  declaration: Extract<Input.Declared, { readonly _tag: "GitDiff" }>
): Promise<Workspace.ExpandedInput> => {
  const base = Input.validateGitBase(declaration.base)
  const raw = await PackageTree.runGit(context.root, [
    "diff",
    "--name-status",
    "-z",
    "--end-of-options",
    base,
    "--"
  ])
  const entries = parseNameStatusZ(raw)
  const matchesAny = (path: string, patterns: ReadonlyArray<string>): boolean =>
    patterns.some((pattern) => minimatch(path, pattern, { dot: true }))
  const selected = entries.filter((entry) => {
    if (declaration.paths !== undefined && !matchesAny(entry.path, declaration.paths)) return false
    if (declaration.added !== undefined) {
      if (!entry.status.startsWith("A")) return false
      if (!matchesAny(entry.path, declaration.added)) return false
    }
    return true
  })
  const paths = selected.map((entry) => entry.path).sort()
  const files = await Input.digestFiles(context.root, paths, { signal: context.signal })
  const patches: Array<string> = []
  let patchBytes = 0
  for (const batch of gitPathspecBatches(paths)) {
    const part = await PackageTree.runGit(context.root, ["diff", "--binary", "--end-of-options", base, "--", ...batch])
    patchBytes += Buffer.byteLength(part, "utf8")
    // Preserve runGit's output limit across all batches of this diff.
    if (patchBytes > 256 * 1024 * 1024) throw new Error("git diff failed: stdout maxBuffer length exceeded")
    patches.push(part)
  }
  const patch = patches.join("")
  return {
    declaration,
    files,
    digest: Input.digestText(JSON.stringify({ patch, files, addedLines: declaration.addedLines ?? null }))
  }
}

/**
 * The non-glob directory prefix of one write-set pattern.
 *
 * @category internal
 * @since 1.0.0
 */
export const staticPrefixOf = (pattern: string): string => {
  const segments = pattern.split("/")
  const kept: Array<string> = []
  for (const segment of segments) {
    if (/[*?{}[\]!]/.test(segment)) break
    kept.push(segment)
  }
  return kept.join("/")
}

interface VisitOptions {
  readonly mode: Mode
}

const visit = async (
  context: PlanContext,
  target: Target.AnyTarget,
  options: VisitOptions
): Promise<PackageNode> => {
  const label = labelOf(context, target)
  const known = context.nodes.get(label)
  if (known !== undefined) return known
  if (context.visiting.has(target)) throw new Error(`target dependency cycle reaches ${label}`)
  context.visiting.add(target)
  const metadata = Target.metadata(target)
  const rule = metadata.target
  const packagePath = packagePathOf(context, target)
  if (context.kind !== undefined && metadata.verbGate !== undefined && !metadata.verbGate.includes(context.kind)) {
    const allowed = metadata.verbGate.length === 0 ? "no verbs" : metadata.verbGate.join(", ")
    throw new Error(`target ${label} is gated to ${allowed} and cannot be included in the ${context.kind} verb`)
  }
  const view: Target.KindView = context.kind === undefined
    ? {
      attrs: metadata.attrs,
      dependencies: metadata.dependencies,
      dependencySelectors: metadata.dependencySelectors,
      inputs: metadata.inputs,
      cacheable: metadata.cacheable,
      outputs: metadata.outputs
    }
    : metadata.forKind(context.kind)
  // The workspace declares its package manager and its runtime once; a rule
  // that names them in `workspaceAttrs` gets them here rather than from a
  // PACKAGE.ts restating them. Filled before the key material is built, so the
  // tool identity is still keyed, and before the body runs, so the rule's own
  // argv builder is unchanged.
  const plannedMode = context.rootModes.get(label) ?? options.mode
  const attrs = await withTargetIndex(
    rule,
    withFactory(
      rule,
      withPlannedMode(
        rule,
        WorkspaceToolchain.fill(metadata.workspaceAttrs, view.attrs, context.workspaceToolchain),
        plannedMode
      ),
      context.index.factory
    ),
    context.repoResolutions,
    context.signal
  )

  if (rule === "CloudRun.Preview") CloudRunExec.tools(attrs as CloudRunExec.Attrs, context.environment)

  // Dependencies: always visited for key material; the execution edges are a
  // per-rule subset decided below.
  const depKeys = new Map<Target.AnyTarget, string>()
  const dependencyRows: Array<{ readonly label: string; readonly key: string }> = []
  const depLabels = new Map<Target.AnyTarget, string>()
  let graphResolveNode: PackageNode | undefined
  const directDependencies: Array<Target.AnyTarget> = [...view.dependencies]
  for (const selector of view.dependencySelectors) {
    const matches = context.index.resolve(selector.pattern).filter((row) => row.key === selector.target)
    if (matches.length === 0) {
      throw new Error(`target ${label} dependency selector ${selector.pattern}:${selector.target} matched no targets`)
    }
    directDependencies.push(...matches.map((row) => row.target))
  }
  for (const dependency of [...new Set(directDependencies)]) {
    const depMetadata = Target.metadata(dependency)
    const depRule = depMetadata.target
    const depMode: Mode = (RulePolicy.of(depRule).check === true) ? "check" : "execute"
    const planned = await visit(context, dependency, { mode: depMode })
    let depKey = planned.keyPreview
    // An ImportClosure dependency keys its consumer on the RESOLVED closure
    // (the sorted path+digest set), not on the closure declaration: editing a
    // file inside the closure re-keys the consumer, editing an unrelated file
    // does not. The closure itself carries no such key (it is not cacheable).
    if (depRule === "ImportClosure" && rule !== "Clean" && planned.refusal === undefined) {
      const result = await closureResultOf(context, planned.label, dependency)
      depKey = `import-closure:${closureResultDigest(result)}`
    }
    // A bundler build keys on the RESOLVED graph digest of its resolve target.
    // The digest is known only once the resolve node has settled, so the key
    // material carries a sentinel here; execution substitutes the digest, and
    // the plan-time preview substitutes it when the cache already holds one
    // (conservatively the resolve node's own key otherwise).
    // A `Cargo.Fetch` dependency keys its consumers on the lockfile it
    // delivered, not on the fetch declaration: relocking re-keys every offline
    // dependent, and a fetch that produced the same lockfile does not. The
    // vendored registry is deliberately not digested — it is the opaque half of
    // the resource, and the lockfile is what fixes what it contains.
    // The cargo home is the other half of what a dependent consumes: an
    // `--offline` run reads the registry the fetch delivered, so a fetch that
    // delivers to a different directory must re-key every dependent. Without
    // it a fetch that declares no `outFiles` would contribute a constant.
    if (depRule === "Cargo.Fetch" && rule !== "Clean" && planned.refusal === undefined) {
      const delivered = await Input.digestFiles(context.root, [...fetchOutFiles(context, dependency)], {
        signal: context.signal
      })
      const home = fetchCargoHome(context, dependency) ?? null
      depKey = `cargo-fetch:${Input.digestText(JSON.stringify({ home, delivered }))}`
    }
    if (rule === "Bundler.Rspack.build" && depRule === "Bundler.Rspack.resolve" && planned.refusal === undefined) {
      depKey = graphKeySentinel
      graphResolveNode = planned
    }
    depKeys.set(dependency, depKey)
    depLabels.set(dependency, planned.label)
    dependencyRows.push({ label: planned.label, key: depKey })
  }

  const declaredInputs = await expandInputs(context, inputPackage(metadata, packagePath), view.inputs)
  const inputDigests = new Map<Input.Declared, string>()
  for (const expanded of declaredInputs) inputDigests.set(expanded.declaration, expanded.digest)

  // Tool resolution. Everything resolved here is key material; an invalid
  // declaration is recorded on the node and fails execution with its reason.
  // A target can select another SDK or shebang interpreter through env.
  // Keep those resolutions separate while sharing this plan's byte memo.
  const declaredToolEnvironment = attrMember(attrs, "env")
  const toolContext = typeof declaredToolEnvironment === "object" && declaredToolEnvironment !== null
    ? {
      ...context,
      environment: { ...context.environment, ...declaredToolEnvironment as Record<string, string> },
      tools: new Map<string, ToolOutcome>(),
      probes: new Map<string, PackageTree.Probe>()
    }
    : context
  const toolchain: Array<unknown> = []
  const targetExecutablePaths: Array<string> = []
  let refusal: string | undefined
  const noteRefusal = (message: string): void => {
    refusal ??= message
  }
  // These catalog rules execute through TargetExecution, not a native argv.
  // Use its tool selection (including Vitest's Bun override) so a manager or
  // runtime replaced without a version change still moves the content key.
  // This is necessary identity, not permission to cache: installed tools and
  // each rule's complete read/write contract must also be accounted for.
  const catalogToolBody = ["TsBuild", "Typecheck", "Vitest", "EsLint", "Dprint"].includes(rule)
  if (catalogToolBody) {
    const declared = targetToolchain(rule, attrs)
    const tools = [declared.runtime, declared.packageManager, declared.packageManager?.runtime]
    const seen = new Set<string>()
    for (const tool of tools) {
      if (tool === undefined || seen.has(tool.executable)) continue
      seen.add(tool.executable)
      try {
        if (
          !NodePath.isAbsolute(tool.executable) &&
          (tool.executable.includes("/") || tool.executable.includes(NodePath.sep))
        ) {
          throw new Error("cwd-relative executable is unsupported for action-backed tools")
        }
        const searchPath = toolContext.environment["PATH"]
        if (
          searchPath !== undefined && searchPath.split(NodePath.delimiter).some((entry) => !NodePath.isAbsolute(entry))
        ) {
          throw new Error("cwd-relative PATH entry is unsupported for action-backed tools")
        }
        const path = NodePath.isAbsolute(tool.executable)
          ? tool.executable
          : PackageTree.findOnPath(tool.executable, toolContext.environment)
        if (path === undefined) throw new Error("executable is not on PATH")
        await Fs.access(path, 1)
        toolchain.push(await binaryIdentity(toolContext, path))
      } catch (cause) {
        noteRefusal(`cannot identify declared ${tool.name} executable: ${Diagnostic.describe(cause)}`)
      }
    }
  }
  let repositoryResolution: RepoResolution.Resolution | undefined
  let repositoryState: RepoResolution.GitState | undefined
  if (rule === "Repo.Target") {
    // Keep child declarations out of this process: query through the same CLI
    // and reduce a refusing child to node data rather than a parent-load error.
    RepoTarget.attrsOf(target)
    repositoryResolution = await RepoResolution.resolve(
      context.repoResolutions,
      target,
      context.signal
    )
    if (repositoryResolution.refusal !== undefined) {
      noteRefusal(repositoryResolution.refusal)
    } else {
      try {
        repositoryState = await RepoResolution.gitState(context.repoResolutions, repositoryResolution, context.signal)
      } catch (cause) {
        noteRefusal(`child repository @${repositoryResolution.repoName}: ${Diagnostic.describe(cause)}`)
      }
      if (context.childPlan && refusal === undefined) {
        const childLabel = `@${repositoryResolution.repoName}${repositoryResolution.label}`
        const resolution = repositoryResolution
        try {
          await ApprovalBridge.withBridge(
            context.approvals,
            (environment) =>
              RepoResolution.execute(context.repoResolutions, resolution, {
                plan: true,
                write: context.write,
                signal: context.signal,
                output: (stream, text) => context.reporter.toolOutput(childLabel, stream, text),
                environment
              })
          )
        } catch (cause) {
          noteRefusal(`child repository @${repositoryResolution.repoName} plan refused: ${Diagnostic.describe(cause)}`)
        }
      }
    }
  }
  // The services edge: every declared service must be a Serve target; the
  // consumer acquires it (readiness-gated) before dispatch and releases it
  // when done. Serve targets stay in the dependency rows (service identity is
  // key material) and are recorded as service labels for acquisition. They
  // are never execution edges: a Serve target is acquire-only, so its own
  // execution dependencies (the data its process needs) are hoisted onto the
  // consumer instead, and a service's own services are acquired first.
  const services = attrTargets(attrs, "services")
  const declaredSandbox = attrMember(attrs, "sandbox") as PackageNode["sandbox"]
  if (
    services.length > 0 && declaredSandbox !== "none" &&
    (typeof declaredSandbox !== "object" ||
      (declaredSandbox.network !== "loopback" && declaredSandbox.network !== true))
  ) {
    noteRefusal(
      "services require an explicit sandbox network declaration: use { network: \"loopback\" } where supported or { network: true }"
    )
  }
  const serviceDeps: Array<string> = []
  const hoistedDeps: Array<string> = []
  for (const service of services) {
    if (!RulePolicy.of(Target.metadata(service).target).service) {
      noteRefusal(`services entries must be service targets; ${depLabels.get(service) ?? "a member"} is not`)
      continue
    }
    const serviceLabel = depLabels.get(service) ?? labelOf(context, service)
    const serviceNode = context.nodes.get(serviceLabel)
    if (serviceNode !== undefined) {
      if (serviceNode.refusal !== undefined) noteRefusal(`service ${serviceLabel}: ${serviceNode.refusal}`)
      for (const nested of serviceNode.serviceDeps) {
        if (!serviceDeps.includes(nested)) serviceDeps.push(nested)
      }
      hoistedDeps.push(...serviceNode.dependencies)
    }
    if (!serviceDeps.includes(serviceLabel)) serviceDeps.push(serviceLabel)
  }

  const resolveToken = async (entry: string): Promise<string> => {
    if (entry.startsWith("{smthrs:tool:") && entry.endsWith("}")) {
      const reference = JSON.parse(entry.slice("{smthrs:tool:".length, -1)) as Record<string, unknown>
      const outcome = await resolveTool(toolContext, reference)
      toolchain.push(outcome.tool.identity)
      if (outcome._tag === "refused") {
        noteRefusal(outcome.tool.refusal)
        return entry
      }
      if (outcome.tool.args !== undefined) {
        noteRefusal("Runtime.npx references must be used as bin, not as a path argument")
        return entry
      }
      return outcome.tool.path
    }
    if (entry.startsWith("{smthrs:flag:") && entry.endsWith("}")) {
      const name = entry.slice("{smthrs:flag:".length, -1)
      const value = context.flags[name]
      if (value === undefined) {
        noteRefusal(`S.Flags.${name} names no declared workspace flag`)
        return entry
      }
      // The reference in attrs keys the name; the workspace-declared value
      // the argv actually receives is keyed here.
      toolchain.push({ tag: "Flag", name, value })
      return value
    }
    if (entry.startsWith("{smthrs:script:") && entry.endsWith("}")) {
      const declared = entry.slice("{smthrs:script:".length, -1)
      const resolved = Input.resolvePath(packagePath, declared)
      try {
        await Fs.access(NodePath.join(context.root, resolved))
      } catch {
        noteRefusal(`generator script not found: ${resolved}`)
      }
      return resolved
    }
    if (entry === Shell.bunToken) {
      const outcome = await resolveBun(toolContext)
      toolchain.push(outcome.tool.identity)
      if (outcome._tag === "refused") {
        noteRefusal(outcome.tool.refusal)
        return entry
      }
      return outcome.tool.path
    }
    return entry
  }

  /** Expands command prefixes and confines Runtime.npx to the executable slot. */
  const resolveCommand = async (
    entries: ReadonlyArray<string>,
    runtimeArguments = 0
  ): Promise<Array<string>> => {
    const resolved: Array<string> = []
    for (const [index, entry] of entries.entries()) {
      if (entry.startsWith("{smthrs:tool:") && entry.endsWith("}")) {
        const reference = JSON.parse(entry.slice("{smthrs:tool:".length, -1)) as Record<string, unknown>
        if (reference["_tag"] === "GoRun" || reference["_tag"] === "RuntimeNpx") {
          const outcome = await resolveTool(toolContext, reference)
          toolchain.push(outcome.tool.identity)
          if (outcome._tag === "refused") noteRefusal(outcome.tool.refusal)
          else if (reference["_tag"] === "GoRun") resolved.push(outcome.tool.path, "run", String(reference["spec"]))
          else if (index === 0) resolved.push(outcome.tool.path, ...outcome.tool.args!)
          else if (runtimeArguments > 0 && index === runtimeArguments + 1) resolved.push(...outcome.tool.args!)
          else noteRefusal("Runtime.npx references must be used as bin, not as a path argument")
          continue
        }
      }
      resolved.push(await resolveToken(entry))
    }
    return resolved
  }

  // The mode a target is planned under. A root's requested mode wins over the
  // dependency mode an earlier visitor asked for, so a `--write` root that is
  // also reached as a check-mode gate or dependency is planned once, in write
  // mode, and applies. See `PlanContext.rootModes`. It is resolved before the
  // per-rule extraction because a rule with both a checking and an applying
  // form — `Cargo.Fmt` — renders a different argv for each.
  const mode = context.rootModes.get(label) ?? options.mode

  // Per-rule extraction.
  let argv: Array<string> | undefined
  const shards = rule === "Shell.Test" && typeof attrMember(attrs, "shards") === "number"
    ? attrMember(attrs, "shards") as number
    : 1
  // A shard runs because the selector reaches the test runner as an argument.
  // The `shell` form spawns `/bin/sh -c <text>`, whose next operand is `$0`,
  // not an argument to the runner: fanning it out would run the identical
  // command once per shard and report every one of them green.
  if (shards > 1 && typeof attrMember(attrs, "shell") === "string") {
    noteRefusal(
      `Shell.Test shards cannot fan out a shell-form declaration; ` +
        `the shard selector has no argv slot in "/bin/sh -c". Declare bin, bun, or script instead`
    )
  }
  const timeout = attrMember(attrs, "timeout")
  const timeoutMs = typeof timeout === "string" ? Shell.durationMs(timeout) : Shell.packageExecTimeoutMs
  let commands: ReadonlyArray<ReadonlyArray<string>> | undefined
  let cargoCrates: ReadonlyArray<CrateRow> | undefined
  let cargoOutFiles: ReadonlyArray<string> = []
  const absoluteEnv: Array<string> = []
  const spawnedTools: Array<string> = []
  let env: Record<string, string> = {}
  let bunTemplate: PackageNode["bunTemplate"]
  let emit: PackageNode["emit"]
  let stdoutPath: string | undefined
  const writeSet: Array<string> = []
  const readSet: Array<string> = []
  const externalReads: Array<string> = []
  const outDirs: Array<string> = []
  const outFiles: Array<string> = []
  const members: Array<string> = []
  let aliasOf: string | undefined
  let materializeOf: string | undefined
  const cleanOutDirs: Array<string> = []
  const cleanPaths: Array<string> = []
  const secrets: Array<Secret.HttpCredential> = []
  const secretRecords: Array<Record<string, unknown>> = []
  collectTagged(attrMember(attrs, "secrets"), "HttpCredential", secretRecords, new Set())
  for (const record of secretRecords) {
    if (Secret.isHttpCredential(record)) secrets.push(record)
  }
  let sandbox = declaredSandbox

  const overlayResolution = await OverlayExec.resolve({
    root: context.root,
    consumer: target,
    packagePathOf: (candidate) => packagePathOf(context, candidate),
    labelOf: (candidate) => depLabels.get(candidate) ?? labelOf(context, candidate)
  })
  const overlays = overlayResolution.replacements
  if (overlayResolution.refusal !== undefined) noteRefusal(overlayResolution.refusal)

  let selection: RuleContract.Selection | undefined

  if (rule === "TsBuild") {
    const outDir = attrMember(attrs, "outDir")
    if (typeof outDir === "string") outDirs.push(Input.resolvePath(packagePath, outDir))
  }

  // A page's single `output` is its whole write-set.
  if (rule === "Docs.Page") {
    const output = attrMember(attrs, "output")
    if (typeof output === "string") writeSet.push(Input.resolvePath(packagePath, output))
  }

  const changes = attrMember(attrs, "changes")
  if (Array.isArray(changes)) {
    for (const pattern of changes) {
      if (typeof pattern === "string") writeSet.push(Input.resolvePath(packagePath, pattern))
    }
  }

  // The cargo home this node reads. A `Cargo.Fetch` owns the one it declares;
  // every target with a `data` edge on that fetch reads the same one, which is
  // what makes `--offline` mean the fetch resource's deliverables.
  let cargoHome: string | undefined
  if (rule === "Cargo.Fetch") cargoHome = fetchCargoHome(context, target)
  else {
    for (const dependency of directDependencies) {
      if (Target.metadata(dependency).target !== "Cargo.Fetch") continue
      cargoHome = fetchCargoHome(context, dependency)
      if (cargoHome !== undefined) break
    }
  }

  // Every tool spawns from the workspace root: the observed declarations are
  // written against it (root-relative config paths, `//`-anchored scripts,
  // shell text naming workspace paths), and tools that resolve their config
  // by walking upward behave identically. Package scoping happens through
  // declared inputs and write sets, not the process cwd.
  let cwd = "."
  const isShellExec = rule === "Shell.Build" || rule === "Shell.Test" || rule === "Shell.Run" ||
    rule === "Shell.Serve" || rule === "Shell.Diff"
  if (isShellExec && refusal === undefined) {
    const shellAttrs = attrs as Shell.ExecAttrs
    const payload = Shell.execPayload(shellAttrs)
    env = { ...(payload.env as Record<string, string>) }
    const resolved = await resolveCommand(
      payload.argv as ReadonlyArray<string>,
      (shellAttrs.bin as { readonly _tag?: string } | undefined)?._tag === "RuntimeNpx"
        ? shellAttrs.runtimeArgs?.length ?? 0
        : 0
    )
    if (shellAttrs.bun !== undefined) {
      const bun = await resolveBun(toolContext)
      const consts: Record<string, string> = {}
      for (const [name, reference] of Object.entries(shellAttrs.using ?? {})) {
        const outcome = await resolveTool(toolContext, reference as Record<string, unknown>)
        toolchain.push({ slot: `using:${name}`, identity: outcome.tool.identity })
        if (outcome._tag === "refused") noteRefusal(outcome.tool.refusal)
        else if (outcome.tool.args !== undefined) {
          noteRefusal("Runtime.npx references must be used as bin, not in using")
        } else consts[name] = outcome.tool.path
      }
      if (bun._tag === "resolved" && refusal === undefined) {
        bunTemplate = { template: shellAttrs.bun, consts, bunPath: bun.tool.path }
      }
    }
    // Tools the process spawns by itself never reach argv, so their bytes are
    // fingerprinted with the executable below rather than left to the host.
    for (const reference of shellAttrs.tools ?? []) {
      const outcome = await resolveTool(toolContext, reference as Record<string, unknown>)
      toolchain.push({ slot: "tool", identity: outcome.tool.identity })
      if (outcome._tag === "refused") noteRefusal(outcome.tool.refusal)
      else if (outcome.tool.args !== undefined) noteRefusal("Runtime.npx references must be used as bin, not in tools")
      else spawnedTools.push(outcome.tool.path)
    }
    // A Diff tool that names no path in its declared args is pointed at its
    // write set: the resolved patterns' static prefixes become trailing
    // arguments. `prettier --write` alone formats nothing; with the write
    // set's directory it formats exactly what the declaration confines it
    // to.
    if (
      rule === "Shell.Diff" &&
      shellAttrs.bin !== undefined &&
      (shellAttrs.args ?? []).every((entry) => typeof entry !== "string" || entry.startsWith("-"))
    ) {
      const appended = new Set<string>()
      for (const pattern of writeSet) {
        const prefix = staticPrefixOf(pattern)
        appended.add(prefix === "" ? "." : prefix)
      }
      for (const path of [...appended].sort()) resolved.push(path)
    }
    // A build target as the tool edge: the token stands for the one executable
    // the referenced target declares it produces.
    if (resolved.includes(Shell.targetBinToken) && Target.isTarget(shellAttrs.bin)) {
      const executable = targetExecutable(context, shellAttrs.bin)
      if ("problem" in executable) noteRefusal(executable.problem)
      else {
        toolchain.push({ tag: "TargetBin", label: labelOf(context, shellAttrs.bin), path: executable.path })
        // The producer key alone cannot identify an uncacheable Cargo.Build
        // output. Hash the produced executable after that dependency settles.
        targetExecutablePaths.push(executable.path)
        for (const [index, entry] of resolved.entries()) {
          if (entry === Shell.targetBinToken) resolved[index] = `${workspaceRootToken}/${executable.path}`
        }
      }
    }
    argv = resolved
    if (rule === "Shell.Build") {
      const declaredOut = attrMember(attrs, "outDirs")
      if (Array.isArray(declaredOut)) {
        for (const dir of declaredOut) {
          if (typeof dir === "string") outDirs.push(Input.resolvePath(packagePath, dir))
        }
      }
      const declaredFiles = attrMember(attrs, "outFiles")
      if (Array.isArray(declaredFiles)) {
        for (const file of declaredFiles) {
          if (typeof file === "string") outFiles.push(Input.resolvePath(packagePath, file))
        }
      }
    }
  }

  // The two ownership projections are Generate-shaped: they plan no process
  // and emit bytes rendered from the package index, so the emit check/write
  // machinery below is theirs unchanged.
  if ((rule === "Owners.Codeowners" || rule === "Owners.Tree") && refusal === undefined) {
    const entries: Array<NonNullable<PackageNode["emit"]>[number]> = []
    if (rule === "Owners.Codeowners") {
      const declared = attrMember(attrs, "path")
      const path = Input.resolvePath(packagePath, typeof declared === "string" ? declared : "//.github/CODEOWNERS")
      const org = String(attrMember(attrs, "org"))
      entries.push({ path, value: { kind: "bytes", text: OwnersResolution.renderCodeowners(context.index, org) } })
    } else {
      const file = attrMember(attrs, "file")
      for (
        const rendered of OwnersResolution.renderOwnersTree(context.index, typeof file === "string" ? file : "OWNERS")
      ) {
        entries.push({ path: rendered.path, value: { kind: "bytes", text: rendered.content } })
      }
    }
    for (const entry of entries) writeSet.push(entry.path)
    emit = entries
  }
  if (rule === "Generate" && refusal === undefined) {
    const script = attrMember(attrs, "script")
    const emitAttr = attrMember(attrs, "emit")
    const bin = attrMember(attrs, "bin")
    const command = attrMember(attrs, "command")
    if (script !== undefined && typeof (script as { readonly path?: unknown }).path === "string") {
      const resolved: Array<string> = []
      for (
        const entry of [
          Shell.scriptInterpreterToken((script as { readonly path: string }).path),
          Shell.scriptToken((script as { readonly path: string }).path)
        ]
      ) {
        resolved.push(await resolveToken(entry))
      }
      argv = resolved
      const declaredEnv = attrMember(attrs, "env")
      if (typeof declaredEnv === "object" && declaredEnv !== null) env = { ...(declaredEnv as Record<string, string>) }
    } else if (typeof command === "string") {
      const payload = Shell.execPayload({
        shell: command,
        env: attrMember(attrs, "env") as Shell.ExecAttrs["env"],
        secrets: attrMember(attrs, "secrets") as Shell.ExecAttrs["secrets"]
      })
      argv = [...payload.argv] as Array<string>
      env = { ...(payload.env as Record<string, string>) }
    } else if (emitAttr !== undefined && typeof emitAttr === "object" && emitAttr !== null) {
      const entries: Array<NonNullable<PackageNode["emit"]>[number]> = []
      for (const [name, value] of Object.entries(emitAttr)) {
        const path = Input.resolvePath(packagePath, name)
        if (typeof value === "string") {
          entries.push({ path, value: { kind: "bytes", text: value } })
        } else if (
          typeof value === "object" && value !== null &&
          (value as { readonly _tag?: unknown })._tag === "Symlink"
        ) {
          entries.push({ path, value: { kind: "link", target: (value as { readonly path: string }).path } })
        }
        writeSet.push(path)
      }
      emit = entries
    } else if (bin !== undefined) {
      {
        // The bin form plans the exec payload the Shell flavors plan; the
        // check-mode scratch copy and the write-mode write-set bracket around
        // the spawn are form-agnostic, so nothing else differs from the
        // script form.
        const payload = Shell.execPayload({
          bin: bin as Shell.ExecAttrs["bin"],
          args: attrMember(attrs, "args") as Shell.ExecAttrs["args"],
          env: attrMember(attrs, "env") as Shell.ExecAttrs["env"],
          secrets: attrMember(attrs, "secrets") as Shell.ExecAttrs["secrets"]
        })
        env = { ...(payload.env as Record<string, string>) }
        if (
          typeof bin === "object" && bin !== null &&
          ((bin as { readonly _tag?: unknown })._tag === "GoBin" ||
            (bin as { readonly _tag?: unknown })._tag === "GoRun")
        ) {
          env = {
            ...GoExec.toolchainEnvironment({ root: context.root, packagePath, workspace: context.index.workspace }),
            ...env
          }
        }
        const resolved = await resolveCommand(payload.argv as ReadonlyArray<string>)
        if (resolved.includes(Shell.targetBinToken) && Target.isTarget(bin)) {
          const executable = targetExecutable(context, bin)
          if ("problem" in executable) noteRefusal(executable.problem)
          else {
            toolchain.push({ tag: "TargetBin", label: labelOf(context, bin), path: executable.path })
            targetExecutablePaths.push(executable.path)
            for (const [index, entry] of resolved.entries()) {
              if (entry === Shell.targetBinToken) resolved[index] = `${workspaceRootToken}/${executable.path}`
            }
          }
        }
        argv = resolved
      }
    }
    // Every generator form that spawns a process can declare `stdout`; the
    // emit form plans no process, so it has no stream to redirect.
    const stdout = attrMember(attrs, "stdout")
    if (argv !== undefined && typeof stdout === "string") {
      stdoutPath = Input.resolvePath(packagePath, stdout)
      writeSet.push(stdoutPath)
    }
  }

  if (rule.startsWith("Go.") && refusal === undefined) {
    const go = await GoExec.resolveGo({
      root: context.root,
      packagePath,
      workspace: context.index.workspace,
      environment: toolContext.environment
    })
    toolchain.push(go.ok ? await goIdentity(toolContext, go) : go.identity)
    if (!go.ok) noteRefusal(go.refusal)
    else {
      // `go generate` runs the directives' commands off PATH, so a declared
      // generator has to be resolved here or the attr is decorative: its
      // version would never key and an absent one would surface as a
      // directive failure rather than as the missing tool.
      const generatorTools = rule === "Go.Generate" ? attrMember(attrs, "tools") : undefined
      const generatorPath: Array<string> = []
      if (Array.isArray(generatorTools)) {
        for (const reference of generatorTools) {
          const outcome = await resolveTool(toolContext, reference as Record<string, unknown>)
          toolchain.push({ slot: "tool", identity: outcome.tool.identity })
          if (outcome._tag === "refused") noteRefusal(outcome.tool.refusal)
          else if (outcome.tool.args !== undefined) {
            noteRefusal("Runtime.npx references must be used as bin, not as PATH tools")
          } else generatorPath.push(NodePath.dirname(outcome.tool.path))
        }
      }
      try {
        const plannedGo = await GoExec.planRule(rule, attrs as Record<string, unknown>, {
          signal: context.signal,
          root: context.root,
          packagePath,
          workspace: context.index.workspace,
          environment: toolContext.environment
        }, go.path)
        if (plannedGo.refusal !== undefined) noteRefusal(plannedGo.refusal)
        argv = plannedGo.argv === undefined ? undefined : [...plannedGo.argv]
        env = { ...plannedGo.env }
        // Go refuses a relative GOMODCACHE; the planned value stays
        // workspace-relative so two checkouts key alike, and is rooted at spawn.
        const moduleCache = env["GOMODCACHE"]
        if (moduleCache !== undefined && !NodePath.isAbsolute(moduleCache)) absoluteEnv.push("GOMODCACHE")
        if (generatorPath.length > 0) {
          // The directories join PATH for the spawn only. Their identities
          // already key above; a host path in `env` would key nothing extra
          // and would split the cache per machine.
          env["PATH"] = [...generatorPath, process.env["PATH"] ?? ""].filter(Boolean).join(NodePath.delimiter)
        }
        outDirs.push(...plannedGo.outDirs)
        writeSet.push(...plannedGo.writeSet)
        // `go` resolves its own module and package graph from import paths, so
        // the confinement has to admit the files the closure named or the
        // toolchain cannot find its own `go.mod`.
        readSet.push(...plannedGo.readSet)
        if (plannedGo.closureIdentity !== undefined) {
          toolchain.push({ tag: "GoClosure", value: plannedGo.closureIdentity })
        }
      } catch (cause) {
        noteRefusal(`Go planning failed: ${Diagnostic.describe(cause)}`)
      }
    }
  }

  if (rule === "Foundry.Build" || rule === "Foundry.Test" || rule === "Foundry.Fmt") {
    const planned = await FoundryExec.plan({
      root: context.root,
      packagePath,
      workspace: context.index.workspace,
      rule,
      mode: plannedMode,
      environment: context.environment,
      probes: context.hostProbes,
      attrs: attrs as never
    })
    toolchain.push(planned.toolchain)
    cwd = planned.cwd
    env = { ...planned.env }
    outDirs.push(...planned.outDirs)
    writeSet.push(...planned.writeSet)
    argv = planned.argv === undefined ? undefined : [...planned.argv]
    if (planned.refusal !== undefined) noteRefusal(planned.refusal)
  }

  if (rule === "Docker.Build" || rule === "Docker.Bake" || rule === "Docker.Push") {
    const planned = await DockerExec.plan({
      rule,
      packagePath,
      attrs: attrs as never,
      environment: context.environment,
      probes: context.hostProbes
    })
    toolchain.push(planned.toolchain)
    outDirs.push(...planned.outDirs)
    argv = planned.argv === undefined ? undefined : [...planned.argv]
    if (rule === "Docker.Push" && planned.commands !== undefined) {
      selection = { family: "container", rule, lane: { kind: "docker-push", commands: planned.commands } }
    }
    if (sandbox === undefined) sandbox = "none"
    if (planned.refusal !== undefined) noteRefusal(planned.refusal)
  }

  if (rule === "CloudRun.Preview") {
    selection = {
      family: "outward",
      rule,
      lane: {
        kind: "cloud-run-preview",
        commit: (await PackageTree.runGit(context.root, ["rev-parse", "HEAD"])).trim(),
        attrs: attrs as CloudRunExec.Attrs,
        packagePath,
        name: context.index.targets().find((row) => row.label === label)?.key ?? label.split(":").at(-1)!
      }
    }
    sandbox = "none"
  }

  if (rule === "Anvil.Fork") {
    const resolved = await AnvilExec.resolveAnvil(context.hostProbes)
    toolchain.push(resolved.identity)
    sandbox = { network: true }
    if (!resolved.ok) noteRefusal(resolved.refusal)
  }

  if (rule === "Docker.Serve" || rule === "Docker.Service") {
    const resolved = await DockerExec.resolveDocker(context.environment, context.hostProbes)
    toolchain.push(resolved.identity)
    sandbox = "none"
    if (!resolved.ok) noteRefusal(resolved.refusal)
  }

  // Cargo rules: resolve the toolchain layer, expand the crate set, and render
  // one cargo command per selected crate. `Cargo.AppSet` is a value, not a
  // run: it plans no process at all.
  if (rule.startsWith("Cargo.") && rule !== "Cargo.AppSet" && refusal === undefined) {
    const cargoPath = await resolveToken(Shell.toolToken({ _tag: "CargoBin" }))
    if (rule === "Cargo.Build" && attrMember(attrs, "container") === "docker") {
      noteRefusal(
        "Cargo.Build container \"docker\" declares no image or container command; a reproducible build cannot be inferred"
      )
    }
    const cargoPlugin = rule === "Cargo.Nextest" ? "cargo-nextest" : rule === "Cargo.Deny" ? "cargo-deny" : undefined
    if (cargoPlugin !== undefined) {
      const pluginPath = PackageTree.findOnPath(cargoPlugin, toolContext.environment)
      if (pluginPath === undefined) {
        noteRefusal(`host binary ${JSON.stringify(cargoPlugin)} is not present on PATH; ${rule} cannot run`)
      } else {
        const probe = await PackageTree.probeVersion(pluginPath, { environment: toolContext.environment })
        toolchain.push({
          tag: cargoPlugin,
          version: probe.output,
          exitCode: probe.exitCode,
          binary: await binaryIdentity(toolContext, pluginPath)
        })
      }
    }
    let selections: ReadonlyArray<Cargo.CrateSelection> | undefined
    const declared = Cargo.selectionOf(attrs)
    if (declared !== undefined) {
      selections = [
        declared._tag === "Manifest"
          ? { _tag: "Manifest", path: Input.resolvePath(packagePath, declared.path) }
          : declared
      ]
    } else if (rule === "Cargo.Fetch" && attrMember(attrs, "crates") === undefined) {
      // A fetch that names neither a manifest nor a crate set locks the
      // workspace it runs from: `cargo fetch` with no `--manifest-path`
      // resolves the manifest in its working directory, which is the
      // workspace root every target spawns from.
      selections = [{ _tag: "Workspace" }]
    } else if (rule === "Cargo.Deny") {
      selections = [{ _tag: "Workspace" }]
    } else if (rule === "Cargo.Fmt" && attrMember(attrs, "crates") === undefined) {
      selections = [{ _tag: "Workspace" }]
    } else {
      const crates = await crateSetOf(context, attrMember(attrs, "crates"))
      if (typeof crates === "string") noteRefusal(`${rule}: ${crates}`)
      else {
        cargoCrates = crates
        // The expanded set is key material: which crates ran, which manifests
        // said so, and what those manifests contained.
        toolchain.push({
          tag: "CrateSet",
          crates: crates.map((row) => ({ manifest: row.manifest, name: row.name ?? null, digest: row.digest }))
        })
        selections = crates.map((row) => ({ _tag: "Manifest", path: row.manifest }))
      }
    }
    if (selections !== undefined && refusal === undefined) {
      const config = attrMember(attrs, "config")
      const commandAttrs = rule === "Cargo.Deny" && typeof config === "object" && config !== null &&
          typeof (config as { readonly path?: unknown }).path === "string"
        ? {
          ...attrs as Record<string, unknown>,
          config: {
            ...config as Record<string, unknown>,
            path: Input.resolvePath(packagePath, (config as { readonly path: string }).path)
          }
        }
        : attrs
      commands = selections.map((selection) => [cargoPath, ...Cargo.packageArgs(rule, commandAttrs, selection, mode)])
      if (commands.length === 1) argv = [...commands[0]!]
    }
    const declaredOut = attrMember(attrs, "outDirs")
    if (Array.isArray(declaredOut)) {
      for (const dir of declaredOut) {
        if (typeof dir === "string") outDirs.push(Input.resolvePath(packagePath, dir))
      }
    }
    if (rule === "Cargo.Fetch") cargoOutFiles = fetchOutFiles(context, target)
    const declaredEnv = attrMember(attrs, "env")
    env = typeof declaredEnv === "object" && declaredEnv !== null ? { ...declaredEnv as Record<string, string> } : {}
    // The declared channel is selected, not hoped for: `RUSTUP_TOOLCHAIN` is
    // how rustup's cargo proxy picks a toolchain, and a cargo that is not a
    // proxy ignores it. A host without the pinned channel fails at the start
    // of the run, naming the channel, instead of mid-compile on a rustc
    // version the crates refuse.
    const layer = WorkspaceDeclaration.rustToolchain(context.index.workspace)
    if (layer?.channel !== undefined && env["RUSTUP_TOOLCHAIN"] === undefined) {
      env["RUSTUP_TOOLCHAIN"] = layer.channel
    }
    // `offline: true` says "resolve only from what the fetch delivered". The
    // `--offline` flag says that to this cargo and to nothing else, and a
    // cargo test that spawns a nested cargo — trybuild's compile-fail suites
    // are the common case — would have that nested process reach for the
    // registry and fail against the sandbox. `CARGO_NET_OFFLINE` is the same
    // statement in the form a child process inherits.
    if (attrMember(attrs, "offline") === true && env["CARGO_NET_OFFLINE"] === undefined) {
      env["CARGO_NET_OFFLINE"] = "true"
    }
  }
  if (cargoHome !== undefined && env["CARGO_HOME"] === undefined) {
    env["CARGO_HOME"] = cargoHome
    absoluteEnv.push("CARGO_HOME")
  }

  if (rule === "Suite") {
    for (const member of attrTargets(attrs, "tests")) members.push(depLabels.get(member) ?? labelOf(context, member))
  }
  if (rule === "Alias") {
    const aliased = attrTargets(attrs, "target")[0]
    if (aliased !== undefined) aliasOf = depLabels.get(aliased) ?? labelOf(context, aliased)
  }
  if (rule === "Materialize") {
    const inner = attrTargets(attrs, "target")[0]
    if (inner !== undefined) materializeOf = depLabels.get(inner) ?? labelOf(context, inner)
  }
  if (rule === "Clean") {
    for (const cleaned of attrTargets(attrs, "targets")) {
      const cleanedMetadata = Target.metadata(cleaned)
      const cleanedPath = packagePathOf(context, cleaned)
      const collectOut = (candidate: Target.AnyTarget, candidatePath: string): void => {
        const declaredOut = attrMember(Target.metadata(candidate).attrs, "outDirs")
        if (Array.isArray(declaredOut)) {
          for (const dir of declaredOut) {
            if (typeof dir === "string") cleanOutDirs.push(Input.resolvePath(candidatePath, dir))
          }
        }
      }
      collectOut(cleaned, cleanedPath)
      // A filegroup of build targets contributes its members' outDirs.
      for (const nested of cleanedMetadata.dependencies) collectOut(nested, packagePathOf(context, nested))
    }
    const paths = attrMember(attrs, "paths")
    if (Array.isArray(paths)) {
      for (const path of paths) {
        if (typeof path === "string") cleanPaths.push(path)
      }
    }
  }

  // Lane data: the per-rule execution payload of each W3 lane rule, reduced
  // from the validated attrs at plan time so execution never re-reads
  // declarations. A reduction that cannot settle is a typed refusal on the
  // node, never a partial payload.
  const implementationContext = contextOf(metadata)
  const labelFor = (member: Target.AnyTarget): string => depLabels.get(member) ?? labelOf(context, member)
  const testOperandPlan = (operand: Compose.FileSet): TestOperandPlan | string => {
    const operandTarget = Target.isTarget(operand) ? operand : operand.target
    if (Target.metadata(operandTarget).target === "Bundler.Rspack.resolve") {
      return { kind: "bundler-files", label: labelFor(operandTarget) }
    }
    const reduced = Compose.checkOperand(operand)
    if (typeof reduced === "string") return reduced
    return reduced._tag === "SourceSet"
      ? { kind: "sources", sources: reduced.sources }
      : { kind: "closure", entries: reduced.entries }
  }
  const gateLabelsOf = (gates: ReadonlyArray<Target.AnyTarget>): ReadonlyArray<readonly [string, string]> =>
    gates.map((gate) => [AgentTarget.targetIdentity(gate), labelFor(gate)] as const)
  const nativeRule = NativeRules.get(rule)
  if (nativeRule !== undefined && refusal === undefined) {
    const native = nativeRule.plan({
      rule,
      target,
      attrs,
      // The root package's canonical path is empty; Fetch output validation needs a cwd.
      packagePath: rule === "Fetch" && packagePath === "" ? "." : packagePath,
      labelFor,
      docsFiles: (check) => docsCheckFiles(context, check, declaredInputs, depLabels)
    })
    if (!native.ok) noteRefusal(native.refusal)
    else {
      selection = native.value
      outFiles.push(...native.value.outFiles ?? [])
      writeSet.push(...native.value.writeSet ?? [])
      if (native.value.sandbox !== undefined) sandbox = native.value.sandbox
    }
  }

  if (nativeRule === undefined) {
    switch (rule) {
      case "Shell.Serve": {
        const serveAttrs = attrs as (typeof Shell.ServeAttrs)["Type"]
        const command = CoreRuleSelection.argvOf(argv)
        if (command !== undefined) {
          selection = {
            family: "service",
            rule,
            argv: command,
            lane: { kind: "serve", readiness: serveAttrs.readiness, health: serveAttrs.health, stop: serveAttrs.stop }
          }
        }
        break
      }
      case "Docker.Serve":
      case "Docker.Service":
        selection = {
          family: "service",
          rule,
          lane: { kind: "docker-service", attrs: attrs as (typeof Docker.ServeAttrs)["Type"] }
        }
        break
      case "Anvil.Fork":
        selection = {
          family: "service",
          rule,
          lane: { kind: "anvil-fork", attrs: attrs as (typeof Anvil.ForkAttrs)["Type"] }
        }
        break
      case "ImportClosure": {
        const closureAttrs = attrs as (typeof Compose.ImportClosureAttrs)["Type"]
        const entries = Compose.closureEntrySources(closureAttrs.entries, implementationContext)
        if (typeof entries === "string") noteRefusal(`ImportClosure: ${entries}`)
        else selection = { family: "files", rule, lane: { kind: "closure", entries } }
        break
      }
      case "Test": {
        const testAttrs = attrs as (typeof Compose.TestAttrs)["Type"]
        if (testAttrs.expect._tag === "FilesDigest") {
          if (testAttrs.toBe === "empty") noteRefusal("Files.digest must compare to a declared file")
          else {
            selection = {
              family: "files",
              rule,
              lane: {
                kind: "files-digest",
                targetLabel: labelFor(testAttrs.expect.target),
                expectedPath: Input.resolvePath(packagePath, testAttrs.toBe.path)
              }
            }
          }
          break
        }
        if (testAttrs.toBe !== "empty") {
          noteRefusal("Files.difference can only compare to \"empty\"")
          break
        }
        const left = testOperandPlan(testAttrs.expect.left)
        const right = testOperandPlan(testAttrs.expect.right)
        if (typeof left === "string") noteRefusal(`Test: ${left}`)
        else if (typeof right === "string") noteRefusal(`Test: ${right}`)
        else selection = { family: "files", rule, lane: { kind: "files-test", left, right } }
        break
      }
      case "Bundler.Rspack.resolve": {
        const resolveAttrs = attrs as (typeof BundlerTarget.ResolveAttrs)["Type"]
        selection = {
          family: "bundler",
          rule,
          lane: {
            kind: "bundler-resolve",
            payload: {
              configPath: Input.resolvePath(packagePath, resolveAttrs.config.path),
              entries: [...resolveAttrs.entries],
              mode: "development"
            }
          }
        }
        break
      }
      case "Bundler.Rspack.build": {
        const buildAttrs = attrs as (typeof BundlerTarget.BuildAttrs)["Type"]
        if (Target.metadata(buildAttrs.graph).target !== "Bundler.Rspack.resolve") {
          noteRefusal(
            `the graph of a bundler build must be a Bundler.Rspack.resolve target: ${labelFor(buildAttrs.graph)}`
          )
          break
        }
        const buildOutDirs = buildAttrs.outDirs.map((dir) => Input.resolvePath(packagePath, dir))
        outDirs.push(...buildOutDirs)
        selection = {
          family: "bundler",
          rule,
          lane: {
            kind: "bundler-build",
            graphLabel: labelFor(buildAttrs.graph),
            payload: {
              configPath: Input.resolvePath(packagePath, buildAttrs.config.path),
              environment: buildAttrs.environment,
              mode: buildAttrs.mode,
              env: buildAttrs.env === undefined ? {} : { ...buildAttrs.env },
              outDirs: buildOutDirs
            }
          }
        }
        break
      }
      case "Agent.Lint": {
        const lintAttrs = attrs as (typeof AgentTarget.LintAttrs)["Type"]
        selection = {
          family: "agent",
          rule,
          lane: {
            kind: "agent",
            flavor: "lint",
            payload: AgentTarget.lintPayload(lintAttrs, implementationContext),
            gateLabels: [],
            dataLabels: dataLabelsOf(lintAttrs.data, depLabels)
          }
        }
        break
      }
      case "Agent.Diff": {
        const diffAttrs = attrs as (typeof AgentTarget.DiffAttrs)["Type"]
        selection = {
          family: "agent",
          rule,
          lane: {
            kind: "agent",
            flavor: "diff",
            payload: AgentTarget.diffPayload(diffAttrs, implementationContext),
            gateLabels: gateLabelsOf(diffAttrs.gates),
            dataLabels: dataLabelsOf(diffAttrs.data, depLabels)
          }
        }
        break
      }
      case "Agent.Pr": {
        const prAttrs = attrs as (typeof AgentTarget.PrAttrs)["Type"]
        selection = {
          family: "agent",
          rule,
          lane: {
            kind: "agent",
            flavor: "pr",
            payload: AgentTarget.prPayload(prAttrs, implementationContext),
            gateLabels: gateLabelsOf(prAttrs.gates),
            dataLabels: dataLabelsOf(prAttrs.data, depLabels)
          }
        }
        break
      }
      case "Docs.Page": {
        // A page is the docs-verb spelling of an Agent.Diff: same payload
        // shape, same candidate/gate loop, so it rides the diff lane and no
        // second agent runtime exists.
        const pageAttrs = attrs as DocsPage.PageAttrs
        selection = {
          family: "agent",
          rule,
          lane: {
            kind: "agent",
            flavor: "diff",
            payload: DocsPage.pagePayload(pageAttrs, implementationContext),
            gateLabels: gateLabelsOf(pageAttrs.gates),
            dataLabels: dataLabelsOf(DocsPage.dataOf(pageAttrs), depLabels)
          }
        }
        break
      }
      case "Git.Commit":
        selection = { family: "outward", rule, lane: { kind: "git-commit" } }
        break
      case "Github.CiGen":
        selection = { family: "generated", rule, lane: { kind: "ci-gen" } }
        break
      case "Github.Setup":
      case "Github.Workflow":
        selection = { family: "value", rule, lane: { kind: "github-decl" } }
        break
      case "Npm.Pack": {
        if (context.managerBinary === undefined) {
          noteRefusal(
            `${rule} needs the workspace Node package manager; declare runtime, packageManager, and nodeModules on S.Workspace`
          )
          break
        }
        const packAttrs = attrs as (typeof NpmTarget.PackAttrs)["Type"]
        const manifestPath = Input.resolvePath(packagePath, packAttrs.manifest.path)
        let manifest: { readonly name?: unknown; readonly version?: unknown }
        try {
          manifest = JSON.parse(await Fs.readFile(NodePath.join(context.root, ...manifestPath.split("/")), "utf8"))
        } catch (cause) {
          noteRefusal(`could not read package manifest ${manifestPath}: ${Diagnostic.describe(cause)}`)
          break
        }
        if (
          typeof manifest.name !== "string" || manifest.name === "" || typeof manifest.version !== "string" ||
          manifest.version === ""
        ) {
          noteRefusal(`package manifest ${manifestPath} must declare non-empty name and version`)
          break
        }
        const tarball = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`
        cwd = NodePath.posix.dirname(manifestPath)
        argv = [context.managerBinary, "pack"]
        outFiles.push(Input.resolvePath(cwd, tarball))
        selection = { family: "files", rule, lane: { kind: "npm-pack", manifestPath } }
        break
      }
      case "Git.Submodules":
      case "Git.Submodule": {
        const git = await resolveToken(Shell.toolToken({ _tag: "HostBin", name: "git" } as never))
        const submodulePlan = rule === "Git.Submodules"
          ? await GitSubmoduleExec.plan({
            root: context.root,
            packagePath,
            rule,
            attrs: attrs as (typeof GitTarget.SubmodulesAttrs)["Type"]
          })
          : await GitSubmoduleExec.plan({
            root: context.root,
            packagePath,
            rule,
            attrs: attrs as (typeof GitTarget.SubmoduleAttrs)["Type"]
          })
        if (submodulePlan.refusal !== undefined) noteRefusal(submodulePlan.refusal)
        argv = [
          git,
          "submodule",
          "update",
          "--init",
          "--recursive",
          "--",
          ...submodulePlan.paths
        ]
        outDirs.push(...submodulePlan.paths)
        // `git submodule update --init` registers each submodule in `.git/config`
        // and keeps its object store under `.git/modules`, and it reads the
        // superproject's index to learn the pinned gitlink, so the repository's
        // own directory is what the checkout writes besides the worktree paths.
        // The workspace's write-set guard still sees the worktree paths as the
        // declared outputs; `.git` is the tool's bookkeeping.
        writeSet.push(".git")
        externalReads.push(...submodulePlan.sources)
        sandbox = { network: true }
        selection = { family: "repository", rule, lane: { kind: "submodules", plan: submodulePlan } }
        break
      }
      case "Changesets.Version": {
        if (context.managerBinary === undefined) {
          noteRefusal(
            `${rule} needs the workspace Node package manager; declare runtime, packageManager, and nodeModules on S.Workspace`
          )
          break
        }
        argv = [context.managerBinary, "exec", "changeset", "version"]
        selection = { family: "value", rule, lane: { kind: "inert" } }
        break
      }
      case "Size.Budgets": {
        if (context.managerBinary === undefined) {
          noteRefusal(
            `${rule} needs the workspace Node package manager; declare runtime, packageManager, and nodeModules on S.Workspace`
          )
          break
        }
        argv = [context.managerBinary, "exec", "size-limit"]
        selection = { family: "value", rule, lane: { kind: "inert" } }
        break
      }
      case "Markdown.CodeBlocks": {
        if (context.managerBinary === undefined) {
          noteRefusal(
            `${rule} needs the workspace Node package manager; declare runtime, packageManager, and nodeModules on S.Workspace`
          )
          break
        }
        const codeAttrs = attrs as (typeof NodeArtifact.CodeBlocksAttrs)["Type"]
        selection = {
          family: "files",
          rule,
          lane: {
            kind: "markdown-code-blocks",
            file: Input.resolvePath(packagePath, codeAttrs.file.path),
            languages: [...codeAttrs.lang],
            context: (codeAttrs.context ?? []).map((page) => Input.resolvePath(packagePath, page.path))
          }
        }
        argv = [
          context.managerBinary,
          "exec",
          "tsc",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "Node16",
          "--moduleResolution",
          "Node16",
          // A workspace package whose `exports` point at `.ts` sources imports
          // its siblings with explicit `.ts` extensions; without this flag every
          // such file the block reaches fails TS5097 before the block is judged.
          "--allowImportingTsExtensions",
          // The options the workspace packages compile under, since a block that
          // imports a package also compiles the package: Node globals, the newest
          // lib the packages target, and the optional-property strictness Effect
          // Schema's types require. Without them the package's own sources fail
          // before the block is judged.
          "--target",
          "es2024",
          "--lib",
          "es2024,dom,dom.iterable",
          "--types",
          "node",
          "--exactOptionalPropertyTypes"
        ]
        break
      }
      case "Npm.Published": {
        if (context.managerBinary === undefined) {
          noteRefusal(
            `${rule} needs the workspace Node package manager; declare runtime, packageManager, and nodeModules on S.Workspace`
          )
          break
        }
        const publishedAttrs = attrs as (typeof NpmTarget.PublishedAttrs)["Type"]
        const manifestPath = Input.resolvePath(packagePath, publishedAttrs.manifest.path)
        const output = `.smthrs/npm-published/${sha256Hex(label).slice(0, 16)}`
        let manifest: { readonly name?: unknown }
        try {
          manifest = JSON.parse(await Fs.readFile(NodePath.join(context.root, ...manifestPath.split("/")), "utf8"))
        } catch (cause) {
          noteRefusal(`could not read package manifest ${manifestPath}: ${Diagnostic.describe(cause)}`)
          break
        }
        if (typeof manifest.name !== "string" || manifest.name === "") {
          noteRefusal(`package manifest ${manifestPath} must declare a non-empty name`)
          break
        }
        outDirs.push(output)
        argv = [context.managerBinary, "dlx", "pacote@21.0.0", "extract", manifest.name, output]
        sandbox = { network: true }
        selection = { family: "repository", rule, lane: { kind: "published", manifestPath } }
        break
      }
      case "Api.Compat": {
        const compatAttrs = attrs as (typeof NodeArtifact.ApiCompatAttrs)["Type"]
        selection = {
          family: "files",
          rule,
          lane: {
            kind: "api-compat",
            baselineLabel: labelFor(compatAttrs.baseline),
            surfaceLabel: labelFor(compatAttrs.surface),
            manifestPath: Input.resolvePath(packagePath, compatAttrs.manifest.path)
          }
        }
        break
      }
      case "Overlay":
        selection = { family: "files", rule, lane: { kind: "overlay" } }
        break
      case "Cron":
        selection = { family: "value", rule, lane: { kind: "inert" } }
        break
      case "Npm.Downstream":
        selection = { family: "value", rule, lane: { kind: "unimplemented" } }
        noteRefusal(notImplementedRunner(rule))
        break
      case "Npm.Publish":
      case "Changesets.Publish":
        selection = { family: "outward", rule, lane: { kind: "outward", required: ["NPM_TOKEN"] } }
        noteRefusal(notImplementedOutward(rule))
        break
      case "Github.Pr":
      case "Github.Release":
      case "Github.Pages":
      case "Git.Pr":
        selection = { family: "outward", rule, lane: { kind: "outward", required: ["GITHUB_TOKEN"] } }
        noteRefusal(notImplementedOutward(rule))
        break
      case "Memory.Retain":
        selection = { family: "outward", rule, lane: { kind: "memory-retain" } }
        break
      case "Cargo.Fetch":
      case "Cargo.Build":
      case "Cargo.Test":
      case "Cargo.Nextest":
      case "Cargo.Clippy":
      case "Cargo.Deny":
      case "Cargo.Fmt":
      case "Cargo.Doc":
        selection = {
          family: "language",
          rule,
          lane: {
            kind: "cargo",
            commands: commands ?? [],
            outFiles: cargoOutFiles,
            crates: cargoCrates,
            binaries: rule === "Cargo.Build" ? Cargo.binaries(attrs) : []
          }
        }
        break
      case "Repo.Target":
        if (repositoryResolution !== undefined && repositoryState !== undefined) {
          selection = {
            family: "repository",
            rule,
            lane: { kind: "repo-target", resolution: repositoryResolution, git: repositoryState }
          }
        }
        break
      default:
        break
    }
  }

  const lane = selection?.lane

  // Invoker preconditions settle at plan time, before any session, probe, or
  // gate runs: a missing or undeclared payload input is a typed needs-input
  // refusal; `approval: "required"` refuses unless the host's durable approval
  // store holds an approval for this exact revision, since an autonomous
  // invocation is never consent; and a gate that is itself an outward or Run target refuses the
  // consumer, since scheduling such a gate would execute its side effect in
  // the name of a check. Each is visible in `--plan` and costs nothing.
  if (lane?.kind === "agent" && lane.flavor !== "lint") {
    const decoded = Effect.runSyncExit(
      AgentSession.decodePayloadValues(lane.payload.payloadSpec, context.inputs)
    )
    if (Exit.isFailure(decoded)) {
      const value: unknown = Cause.squash(decoded.cause)
      noteRefusal(
        value instanceof AgentTarget.AgentNeedsInput
          ? `needs input: ${value.message} (expected: ${value.expected}); pass --input ${value.field}=<value>`
          : `needs input: ${Diagnostic.describe(value)}`
      )
    }
  }
  if (lane?.kind === "outward") {
    for (const required of lane.required) {
      const declaration = secrets.find((credential) => credential.secret.env === required)
      if (declaration === undefined) {
        noteRefusal(
          `${rule}: missing secret: declaration requires ` +
            `S.HttpSecret(S.Secret(${JSON.stringify(required)}), [...])`
        )
      }
    }
  }
  // A rule that drives the workspace package manager reads the declaration
  // that names it — the manifest a corepack shim resolves the manager version
  // from, and the lockfile and workspace file pnpm resolves the tree from.
  // They are declared on the workspace, so they never reach this target's
  // declared inputs and the confinement would hide them.
  if (context.managerBinary !== undefined && argv !== undefined) {
    readSet.push(...managerFilesOf(context.index.workspace))
    if (packagePath !== "") readSet.push(`${packagePath}/package.json`)
    // pnpm 11 verifies the dependency tree before `run` and `exec` and installs
    // when it disagrees. A keyed, confined check would then reach the registry
    // and rewrite `node_modules` as a side effect of running `tsc`. Installing
    // is the `Npm.NodeModules` resource's business; a consumer of it never
    // installs. The setting lives only in `pnpm-workspace.yaml`, so `--config.`
    // is the one spelling that reaches pnpm from here.
    if (context.managerBinary === "pnpm" && (argv[1] === "exec" || argv[1] === "run")) {
      argv = [argv[0]!, "--config.verifyDepsBeforeRun=false", ...argv.slice(1)]
      if (selection?.family === "service" && selection.rule === "Shell.Serve") {
        selection = { ...selection, argv: [argv[0]!, ...argv.slice(1)] }
      }
    }
  }
  // An approval names the values its target runs with, so stamps resolve
  // here, into the revision and the planned commands, instead of just before
  // spawn: moving HEAD after a grant is a new revision, and execution runs
  // exactly the approved values. buildTime differs on every run, so no
  // grant could ever match it.
  const approvalRequired = attrMember(attrs, "approval") === "required"
  let stamps: Record<string, string> | undefined
  if (approvalRequired) {
    const lane = selection?.lane
    const planned = [
      ...(argv ?? []),
      ...Object.values(env),
      ...(lane?.kind === "docker-push" ? lane.commands.flat() : [])
    ]
    const tokens = StampExec.tokensIn(planned)
    if (tokens.some((token) => StampExec.nameOf(token) === "buildTime")) {
      noteRefusal(
        `approval required: ${label} stamps buildTime, which changes on every run, so no approval can name it; ` +
          "use a stable stamp such as commit or version"
      )
    } else if (tokens.length > 0) {
      const resolved = await Effect.runPromise(
        Effect.exit(Effect.tryPromise(() => StampExec.resolveTokens(context.root, tokens)))
      )
      if (Exit.isFailure(resolved)) {
        noteRefusal(
          `approval required: ${label} stamps could not be resolved: ${
            Diagnostic.describe(Cause.squash(resolved.cause))
          }`
        )
      } else {
        const values = resolved.value
        const pin = (text: string) => StampExec.substitute(text, values)
        argv = argv?.map(pin)
        env = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, pin(value)]))
        if (selection !== undefined && lane?.kind === "docker-push") {
          selection = {
            ...selection,
            lane: { kind: "docker-push", commands: lane.commands.map((command) => command.map(pin)) }
          } as typeof selection
        }
        stamps = Object.fromEntries(tokens.map((token) => [token, values.get(token)!]))
      }
    }
  }
  // The approval binds to this exact revision: the label, the rule, the
  // effective attrs with each dependency's content key substituted, the
  // declared inputs, the dependency keys, the resolved tools, the
  // invocation's `--input` values and the pinned stamp values. Any edit,
  // rebuilt image, moved input or moved HEAD is a new revision that needs its
  // own approval.
  const approval = approvalRequired
    ? Planner.keyOf({
      body: { approval: label, target: rule },
      inputs: {
        attrs: Planner.attrsValue(attrs, depKeys, inputDigests),
        declared: declaredInputs,
        dependencies: dependencyRows,
        toolchain,
        invocation: context.inputs,
        ...(stamps === undefined ? {} : { stamps })
      },
      layers: [],
      capabilities: []
    })
    : undefined
  if (approval !== undefined) {
    if (context.approvals === undefined) {
      noteRefusal(
        `approval required: ${label} declares approval: "required"; this host has no approval store, ` +
          "so the invocation refuses before any effect"
      )
    } else if (!(await context.approvals.granted({ root: context.root, label, digest: approval }))) {
      noteRefusal(
        `approval required: ${label} declares approval: "required" and revision ${approval.slice(0, 12)} ` +
          `is not approved; approve it with: smthrs approvals grant ${label}`
      )
    }
  }
  if (rule === "Install") {
    // The workspace fills the manager in after the target was constructed, so
    // the constructor's Bun refusal cannot see it; refuse here, before any spawn.
    const manager = attrMember(attrs, "packageManager") as { readonly name?: unknown } | undefined
    if (manager?.name === "bun") noteRefusal(`unsupported: ${PackageManager.bunInstallUnsupportedMessage}`)
  }
  for (const gate of attrTargets(attrs, "gates")) {
    const gateRule = Target.metadata(gate).target
    if ((RulePolicy.of(gateRule).outward === true)) {
      noteRefusal(
        `gates must be check/test-capable targets; ${depLabels.get(gate) ?? labelOf(context, gate)} is ${gateRule}, ` +
          "an outward/Run target, and cannot gate"
      )
    }
  }
  // A declared HTTPS audience the planned payload never names through
  // `S.SecretOrigin` would spawn and then fail at the proxy, which cannot
  // substitute inside a TLS tunnel. The exec boundary refuses it too; here
  // the fix is visible in `--plan` before anything spawns. It is noted last, so
  // an approval or gate refusal, which blocks the invocation outright, wins.
  if (argv !== undefined && secrets.length > 0) {
    for (const problem of Exec.unservableAudiences({ argv, env, secrets })) noteRefusal(`${rule}: ${problem}`)
  }

  // NodeModule is an installation dependency, not an executable reference.
  // ambient.lockfile below hashes the FULL lockfile (not a package slice),
  // including integrity and patch records. That fixes installed bytes under
  // the immutable-install contract; arbitrary local edits to module contents
  // need file/closure inputs. NodeModuleBin additionally hashes its entry file.
  const moduleRefs: Array<Record<string, unknown>> = []
  collectTagged(attrs, "NodeModule", moduleRefs, new Set())
  for (const reference of moduleRefs) {
    const packageName = String(reference["package"])
    toolchain.push({ tag: "NodeModule", package: packageName, version: await moduleVersion(context.root, packageName) })
  }

  // Process generators key their cached checks by the current write set.
  // Declarative emit always checks through the confined generated-file readers;
  // fingerprinting it here would read outputs before their parent admission.
  let writeSetState: unknown = null
  if (
    emit === undefined && (
      rule === "Generate" || rule === "Shell.Diff" || rule === "Changesets.Version" ||
      rule === "Owners.Codeowners" || rule === "Owners.Tree"
    )
  ) {
    const states: Array<unknown> = []
    for (const pattern of writeSet) {
      // A write set is not an input glob over the declaring package: its
      // paths are the generator's own wherever they live, so a nested
      // package's PACKAGE.ts must not bound the expansion to nothing.
      const matches = await Input.expandGlob(context.root, "", pattern, {
        cacheDirectory: context.cacheDirectory,
        packageScoped: false,
        repositoryBoundaries: Object.values(context.index.workspace.repos ?? {}).map((repo) => repo.path),
        signal: context.signal
      })
      const files = await Input.digestFiles(context.root, matches, { signal: context.signal })
      states.push({ pattern, digest: Input.digestText(JSON.stringify(files)) })
    }
    writeSetState = states
  }

  const declaredGates = attrTargets(attrs, "gates").map((gate) => depLabels.get(gate) ?? labelOf(context, gate))
  // An Agent.Diff or Agent.Pr runs its gates inside the candidate/gate loop,
  // against each candidate, so they are not pre-act gates of the node: a gate
  // that is red on the pre-candidate tree (the test the fix must make pass)
  // is exactly what the loop exists to turn green. A Git.Commit judges its
  // gates against the tree it is about to record, which is not the live tree
  // when unstaged or untracked changes sit outside its scope. Their own
  // execution dependencies (the data a gate needs materialized) hoist onto
  // the consumer so the candidate run finds them settled.
  const loopGated = rule === "Agent.Diff" || rule === "Agent.Pr" || rule === "Docs.Page" || rule === "Git.Commit"
  const gateDeps = loopGated ? [] : declaredGates

  // Execution edges: what must settle green before this node runs.
  let executionDeps: Array<string>
  if ((RulePolicy.of(rule).keyOnly === true) || refusal !== undefined) {
    executionDeps = []
  } else if (rule === "Alias") {
    executionDeps = aliasOf === undefined ? [] : [aliasOf]
  } else if (rule === "Materialize") {
    executionDeps = materializeOf === undefined ? [] : [materializeOf]
  } else if (rule === "Suite") {
    executionDeps = [...members]
  } else {
    const serviceSet = new Set(serviceDeps)
    const loopGateSet = new Set(loopGated ? declaredGates : [])
    const loopGateNeeds = loopGated
      ? declaredGates.flatMap((gateLabel) => context.nodes.get(gateLabel)?.dependencies ?? [])
      : []
    executionDeps = [
      ...new Set([
        ...dependencyRows.map((row) => row.label).filter((depLabel) =>
          !serviceSet.has(depLabel) && !loopGateSet.has(depLabel)
        ),
        ...hoistedDeps,
        ...loopGateNeeds
      ])
    ]
  }

  const movingService = services.some((service) => {
    const serviceMetadata = Target.metadata(service)
    return serviceMetadata.target === "Anvil.Fork" &&
      attrMember(serviceMetadata.attrs, "forkBlockNumber") === "latest"
  })
  // `withPlannedMode` flips a declared `check` generator to `write` after the
  // rule evaluated its own `cache` predicate, so `view.cacheable` still carries
  // the declaration's answer: `TargetIndex` and `FactoryProjection` both say
  // "cacheable unless mode is write" and both were planned cacheable anyway.
  // A replayed verdict writes no file, so the second `--write` on a machine
  // that had written once was a silent no-op — `smthrs target
  // '//:targetIndex' --write` reported `hit` and left `.smithers/target-index.json`
  // stale, which is how run 11763 (main 2722d0e5) could fail `checks` on that
  // file alone. A planned write is therefore never cacheable.
  const plannedWrite = mode === "write" && plannedModeRules.has(rule)
  const cacheable = refusal === undefined && !movingService && !plannedWrite &&
    (view.cacheable || RulePolicy.cacheable(rule, mode, repositoryState?.dirty))

  const spawnEnvironment = Exec.toolEnvironment(
    env,
    context.remoteCache === undefined ? [] : Workspace.credentialEnvNames(context.remoteCache.credentials),
    {},
    context.nixEnvironment === undefined ? undefined : {
      path: context.nixEnvironment.path.join(NodePath.delimiter),
      variables: context.nixEnvironment.variables
    }
  )
  // Host directories vary across machines. Only declarations carry value
  // identity; PATH-selected executables are fingerprinted separately below.
  const declaredEnvironment = { ...context.nixEnvironment?.variables, ...env }
  const environmentDigest = sha256Hex(JSON.stringify(
    Object.keys(spawnEnvironment).sort()
      .filter((name) => name in declaredEnvironment || !["HOME", "TMPDIR", "TEMP", "TMP"].includes(name))
      .map((name) => [name, name in declaredEnvironment ? spawnEnvironment[name] : true])
  ))
  const executableCommands = argv === undefined ? [] : [argv[0]!, ...spawnedTools]
  // A command-form target spawns a shell, but its leading literal program
  // can change independently of that shell. Dynamic commands still need
  // declared bin/using tools to identify their executable dependencies.
  if (argv?.[0] === "/bin/sh" && argv[1] === "-c") {
    const program = argv[2]?.match(/^\s*(?:exec\s+)?([A-Za-z0-9_./+-]+)(?:\s|$)/)?.[1]
    if (program !== undefined) executableCommands.push(program)
  }
  const executable: Array<unknown> = []
  for (const command of executableCommands) {
    if (command.includes(workspaceRootToken)) continue
    const path = NodePath.isAbsolute(command)
      ? command
      : PackageTree.findOnPath(command, spawnEnvironment)
    if (path !== undefined && NodeFs.existsSync(path)) {
      executable.push(await binaryIdentity({ ...context, environment: spawnEnvironment }, path))
    }
  }
  // Native tools can live under the host's /tmp, which bubblewrap hides.
  // Admit both the launcher and its real installation, including shebang
  // interpreters. Docker gets its toolchain from the image instead.
  if (context.index.workspace.sandboxes?.sandboxes["default"]?._tag !== "SandboxDocker") {
    const temporaryRoots = new Set(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", NodeOs.tmpdir()])
    for (const root of [...temporaryRoots]) {
      if (NodeFs.existsSync(root)) temporaryRoots.add(NodeFs.realpathSync(root))
    }
    const identities: Array<Record<string, unknown>> = []
    collectTagged([toolchain, executable], "Executable", identities, new Set())
    for (const identity of identities) {
      for (const field of ["source", "path"]) {
        const path = String(identity[field])
        if (!NodePath.isAbsolute(path)) continue
        // npm executables often live in package/bin and import package/dist.
        // Admit that one installed package, never its sibling packages or the
        // containing node_modules tree. Use the final segment for pnpm stores.
        const installedPackage = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(path)?.[1]
        const directory = installedPackage ?? NodePath.dirname(path)
        // Keep the private temp root and undeclared workspace inputs hidden.
        const read = temporaryRoots.has(directory) || Path.contains(directory, context.root) ? path : directory
        if (!externalReads.includes(read)) externalReads.push(read)
      }
    }
    // A toolchain SDK is an installed tree, not a bin directory. Admitting
    // only the directories its executables sit in left the rest of the tree
    // hidden, which is invisible on a host whose SDK happens to live under a
    // broad runtime grant (`/usr`, `/opt/homebrew`, `/nix/store`) and fatal on
    // one where it does not: a Go under a hosted tool cache reported
    // "cannot find package" for every package in the module under test,
    // because `$GOROOT/src` was unreadable.
    const roots: Array<Record<string, unknown>> = []
    collectTagged([toolchain, executable], "ExecutableRoot", roots, new Set())
    for (const root of roots) {
      const path = String(root["path"])
      // A root that swallows the workspace, or one inside it, would open
      // undeclared workspace inputs; the executables above stay admitted.
      if (!NodePath.isAbsolute(path)) continue
      if (Path.contains(path, context.root) || Path.contains(context.root, path)) continue
      if (!externalReads.includes(path)) externalReads.push(path)
    }
  }

  const keyMaterial: Planner.KeyMaterial = {
    body: {
      flow: target._tag,
      target: rule,
      // `metadata.implementationDigest` is deliberately absent: function
      // identity carries per-process entropy (closures cannot be inspected),
      // so it can never answer a cross-process hit. The ambient
      // implementation fingerprint in `inputs` covers every byte of the
      // executor and rule implementations instead.
      schemas: metadata.schemaIdentity,
      mode,
      cwd,
      outputs: outDirs.length === 0 && outFiles.length === 0 ? null : { dirs: [...outDirs], files: [...outFiles] },
      executionFormat: Planner.EXECUTION_FORMAT,
      packageFormat: PACKAGE_EXECUTION_FORMAT
    },
    inputs: {
      ambient: context.ambient,
      attrs: Planner.attrsValue(attrs, depKeys, inputDigests),
      declared: declaredInputs,
      dependencies: dependencyRows,
      toolchain,
      execution: argv === undefined && !catalogToolBody ? null : { environmentDigest, executable },
      overlays: overlays.map(({ digest, path, source }) => ({ digest, path, source })),
      submodules: lane?.kind === "submodules"
        ? lane.plan.gitlinks.map((link) => ({ path: link.path, sha: link.sha }))
        : null,
      writeSetState,
      repository: repositoryResolution === undefined || repositoryState === undefined
        ? null
        : {
          name: repositoryResolution.repoName,
          path: repositoryResolution.repoPath,
          label: repositoryResolution.label,
          args: repositoryResolution.args,
          head: repositoryState.head,
          dirty: repositoryState.dirty,
          status: repositoryState.status
        }
    },
    layers: [],
    capabilities: RulePolicy.capabilities(rule, mode, sandbox)
  }

  // A bundler build's preview key substitutes the cached graph digest when
  // the store holds one; the template keeps the sentinel for execution.
  let keyTemplate: Planner.KeyMaterial | undefined
  let previewMaterial = keyMaterial
  if (graphResolveNode !== undefined) {
    keyTemplate = keyMaterial
    const digest = await graphDigestOf(context, graphResolveNode)
    previewMaterial = keyMaterialWithGraph(
      keyTemplate,
      digest === undefined ? graphResolveNode.keyPreview : `bundler-graph:${digest}`
    )
  }

  // Key-material forensics: SMTHRS_DEBUG_KEYS=<file> appends every node's
  // injective encoding, so two runs' keys can be diffed byte for byte.
  if (process.env["SMTHRS_DEBUG_KEYS"] !== undefined) {
    NodeFs.appendFileSync(
      process.env["SMTHRS_DEBUG_KEYS"],
      `=== ${label}\n${Planner.encodeKeyMaterial(previewMaterial)}\n`
    )
  }
  // Only complete native payloads become ordinary planned nodes. Failed
  // reductions have an explicit non-executable variant and keep their refusal.
  if (selection === undefined && refusal === undefined) selection = CoreRuleSelection.select(rule, argv)
  const chosen: RuleContract.Selection | RuleContract.Refused = selection ?? {
    family: "refused",
    rule,
    lane: undefined,
    refusal: refusal ?? `${rule} planned no executable`
  }
  const node: PackageNode = {
    label,
    target: rule,
    kinds: await RepoResolution.effectiveKinds(
      context.repoResolutions,
      target,
      context.signal
    ),
    attrs,
    dependencies: executionDeps,
    declaredInputs,
    declaredOutputs: view.outputs,
    cacheable,
    cacheLookup: "not-wired",
    wouldRun: true,
    keyMaterial: previewMaterial,
    keyPreview: Planner.keyOf(previewMaterial),
    ...(approval === undefined ? {} : { approval }),
    ...(targetExecutablePaths.length === 0 ? {} : { targetExecutablePaths }),
    ...(context.nixEnvironment === undefined ? {} : {
      nixEnvironment: {
        storePath: context.nixEnvironment.storePath,
        hash: context.nixEnvironment.hash,
        closure: context.nixEnvironment.closure,
        path: context.nixEnvironment.path,
        variables: context.nixEnvironment.variables
      }
    }),
    mode,
    packagePath,
    declaration: target,
    serviceDeps,
    keyTemplate,
    refusal,
    sandbox,
    secrets,
    argv,
    shards,
    timeoutMs,
    cwd,
    env,
    absoluteEnv,
    bunTemplate,
    writeSet,
    readSet,
    externalReads,
    outDirs,
    outFiles,
    overlays,
    emit,
    stdoutPath,
    members,
    aliasOf,
    materializeOf,
    gateDeps,
    cleanOutDirs,
    cleanPaths,
    ...chosen
  }
  context.visiting.delete(target)
  context.nodes.set(label, node)
  return node
}

/**
 * Resolves a `Docs.Check` `inputs` attr to the file rows the planner keyed:
 * a declared file or glob contributes its own expanded rows, and a Filegroup
 * contributes the declared inputs of its planned node and, through nested
 * groups, of theirs.
 *
 * The rows are the planner's, not a second reading of the tree. Confinement,
 * symlink policy, size limits, and ignore rules all live in
 * `Input.expandGlob`/`Input.digestFile`, so a fresh digest pass here could
 * disagree with the key the node was admitted under. Reusing the plan rows
 * makes the verdict and the cache key the same bytes by construction.
 *
 * Returns the refusal text when a member cannot be keyed by content.
 */
const docsCheckFiles = (
  context: PlanContext,
  attrs: DocsCheck.Attrs,
  declaredInputs: ReadonlyArray<Workspace.ExpandedInput>,
  depLabels: ReadonlyMap<Target.AnyTarget, string>
): ReadonlyArray<Input.FileDigest> | string => {
  const rows = new Map<string, Input.FileDigest>()
  const expanded = new Map<Input.Declared, Workspace.ExpandedInput>()
  for (const input of declaredInputs) expanded.set(input.declaration, input)
  const visited = new Set<string>()
  const walk = (label: string): void => {
    if (visited.has(label)) return
    visited.add(label)
    const dependency = context.nodes.get(label)
    if (dependency === undefined) return
    for (const input of dependency.declaredInputs) {
      if (input.declaration._tag === "GitDiff") continue
      for (const file of input.files) rows.set(file.path, file)
    }
    if (dependency.rule !== "Filegroup") return
    for (const inner of dependency.dependencies) walk(inner)
  }
  for (const member of attrs.inputs.flatMap((entry) => Array.isArray(entry) ? entry : [entry])) {
    if (Target.isTarget(member)) {
      const memberRule = Target.metadata(member).target
      const label = depLabels.get(member)
      if (label === undefined) return "Docs.Check inputs name a target that was not planned"
      if (memberRule !== "Filegroup") {
        return `Docs.Check inputs must be files, globs, or Filegroup targets; ${label} is a ${memberRule}`
      }
      walk(label)
      continue
    }
    const input = expanded.get(member)
    if (input === undefined) return `Docs.Check input was not expanded by the planner: ${JSON.stringify(member)}`
    for (const file of input.files) rows.set(file.path, file)
  }
  return [...rows.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

/** The planned labels of a lane's `data` members that are targets; declared inputs live on the node itself. */
const dataLabelsOf = (
  data: ReadonlyArray<unknown> | undefined,
  depLabels: ReadonlyMap<Target.AnyTarget, string>
): ReadonlyArray<string> => {
  const labels: Array<string> = []
  for (const member of data ?? []) {
    for (const entry of Array.isArray(member) ? member : [member]) {
      if (!Target.isTarget(entry)) continue
      const label = depLabels.get(entry)
      if (label !== undefined) labels.push(label)
    }
  }
  return labels
}

/**
 * The flow-body generators whose output handling is a `mode` attr the
 * invocation may override: `--write` flips the declared `check` to `write`,
 * and a `check` invocation forces `check` on a declaration that asked to
 * write, so `ci` never mutates the file. Every other rule keeps the attrs its
 * declaration and verb view produced; `GithubCiGen` and `Tsconfig` stay out
 * because their `build` verb writes whatever the declaration says today, and
 * the executor suite pins that.
 */
const plannedModeRules: ReadonlySet<string> = new Set(["FactoryProjection", "TargetIndex"])

const withPlannedMode = (rule: string, attrs: unknown, mode: Mode): unknown =>
  plannedModeRules.has(rule) && mode !== "execute" && typeof attrs === "object" && attrs !== null
    ? { ...attrs, mode }
    : attrs

/**
 * The factory projection carries the declarations the loader read from
 * `FACTORY.ts`, never ones a `PACKAGE.ts` wrote: the planner fills `factory`
 * and `home` here, the way the workspace toolchain fills a rule's runtime.
 * They ride in the attrs so the declaration's content is key material and
 * an edit to the factory re-keys the check. A workspace without a factory
 * leaves both unset, and the executor names the missing file.
 */
const withFactory = (rule: string, attrs: unknown, factory: PackageIndexModule.PackageIndex["factory"]): unknown =>
  rule === "FactoryProjection" && typeof attrs === "object" && attrs !== null
    ? {
      ...attrs,
      ...(factory === undefined ? {} : { factory: factory.factory }),
      ...(factory?.home === undefined ? {} : { home: factory.home })
    }
    : attrs

/**
 * The target index carries the rows the planner built from the loaded
 * declarations, never ones a `PACKAGE.ts` wrote: they ride in the attrs so
 * every declaration the pattern covers is key material, and an edit to any
 * of them re-keys the check. Nothing here plans a target: the rows are
 * metadata and labeled edges, plus the child query a `Repo.Target` row needs.
 */
const withTargetIndex = async (
  rule: string,
  attrs: unknown,
  resolver: RepoResolution.Resolver,
  signal: AbortSignal | undefined
): Promise<unknown> => {
  if (rule !== "TargetIndex" || typeof attrs !== "object" || attrs === null) return attrs
  const pattern = (attrs as { readonly pattern?: unknown }).pattern
  const listing = await TargetIndex.build(
    resolver.index,
    typeof pattern === "string" ? pattern : "//...",
    resolver.environment,
    signal
  )
  return { ...attrs, targets: listing.targets }
}

/** The mode one root executes under, given the invocation. */
const rootMode = (rule: string, options: RunOptions): Mode => {
  if (!(RulePolicy.of(rule).check === true)) return "execute"
  if (options.write === true || options.fix === true) return "write"
  if (options.verb === "run") return "write"
  return "check"
}

/**
 * The workspace-relative files the package manager itself opens before it runs
 * anything: the manifest that names it, the lockfile it validates against, and
 * the workspace file that bounds the tree.
 *
 * The declaration lives on the workspace, not on the target, so it never
 * reaches a consumer's declared inputs. Without it a confined `pnpm exec tsc`
 * dies reading `package.json` — the manifest is what a corepack shim resolves
 * the manager version from, and what pnpm resolves the workspace root from.
 *
 * @category internal
 * @since 1.0.0
 */
export const managerFilesOf = (workspace: PackageIndexModule.PackageIndex["workspace"]): ReadonlyArray<string> => {
  const manager = workspace.packageManager as
    | { readonly manifest?: unknown; readonly lockfile?: unknown; readonly workspaces?: unknown }
    | undefined
  const nodeModules = workspace.nodeModules as
    | { readonly packageJson?: unknown; readonly workspaces?: unknown }
    | undefined
  if (manager === undefined && nodeModules === undefined) return []
  const paths: Array<string> = ["package.json"]
  for (
    const candidate of [
      manager?.manifest,
      manager?.lockfile,
      manager?.workspaces,
      nodeModules?.packageJson,
      nodeModules?.workspaces
    ]
  ) {
    const path = (candidate as { readonly path?: unknown } | undefined)?.path
    if (typeof path === "string" && path !== "") paths.push(Input.resolvePath("", path))
  }
  return paths
}

const managerBinaryOf = (workspace: PackageIndexModule.PackageIndex["workspace"]): string | undefined => {
  if (workspace.packageManager === undefined) return undefined
  const manager = workspace.packageManager as { readonly _tag?: unknown; readonly name?: unknown }
  if (manager === undefined) return undefined
  if (manager._tag === "YarnPackageManager") return "yarn"
  if (manager._tag === "PnpmPackageManager") return "pnpm"
  if (typeof manager.name === "string") return manager.name
  return "pnpm"
}

/**
 * Whether a bare wildcard (`//...`, `//pkg/...`) leaves a target out: an
 * exclusive target under `test` or an unattended plan unless exclusive runs
 * were asked for, a target declared for other hosts, a manual target, and in
 * an unattended plan a rule that spawns an agent. A pattern that names the
 * target keeps it, except that an unattended plan drops attended rules always.
 *
 * @category planning
 * @since 1.0.0
 */
export const wildcardOmits = (
  target: Target.AnyTarget,
  options: {
    readonly verb: string
    readonly unattended?: boolean | undefined
    readonly includeExclusive?: boolean | undefined
    readonly platform?: string | undefined
  }
): boolean => {
  const metadata = Target.metadata(target)
  const omitExclusive = (options.verb === "test" || options.unattended === true) && options.includeExclusive !== true
  return (omitExclusive && Target.isExclusive(metadata.attrs)) ||
    !(metadata.hosts?.includes(options.platform ?? process.platform) ?? true) || metadata.manual === true ||
    (options.unattended === true && RulePolicy.of(metadata.target).attended === true)
}

/**
 * Whether a target is a rule that spawns an agent, which an unattended plan
 * drops however it was selected.
 *
 * @category planning
 * @since 1.0.0
 */
export const attended = (target: Target.AnyTarget): boolean =>
  RulePolicy.of(Target.metadata(target).target).attended === true

/**
 * Plans one PACKAGE.ts invocation: resolves roots, walks the graph,
 * resolves tools, and keys every node.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = async (options: RunOptions): Promise<PackagePlan> => {
  const index = options.index
  const reporter = Reporter.of(options)
  const log = reporter.note
  const verb = options.verb
  const repoResolutions = RepoResolution.resolver(index, options.environment ?? process.env)
  if (options.patterns.length === 0) throw new Error("no target pattern given")
  // Each pattern selects on its own terms; the plan roots are their union,
  // first selection first, so a target two patterns name is planned once.
  const selectedByLabel = new Map<string, PackageIndexModule.IndexedTarget>()
  // Roots a wildcard selected under the exclusive-tier omission. Only their
  // closure must stay clear of exclusive targets; a root a pattern named keeps
  // its exclusive dependencies.
  const wildcardRoots = new Set<string>()
  const rootLabels = options.rootLabels === undefined ? undefined : new Set(options.rootLabels)
  const platform = options.platform ?? process.platform
  for (const pattern of options.patterns) {
    const parsedPattern = Label.parse(pattern, index.currentPackage ?? "")
    const wildcard = parsedPattern._tag === "Subtree" && parsedPattern.target === undefined
    const omitExclusive = (verb === "test" || options.unattended === true) && wildcard &&
      options.includeExclusive !== true
    // A wildcard omits exclusive, other-host and manual targets; a pattern that
    // names one keeps it, and the closure check below refuses an other-host one.
    const rows = index.resolve(pattern).filter((row) =>
      !wildcard ||
      !wildcardOmits(row.target, {
        verb,
        unattended: options.unattended,
        includeExclusive: options.includeExclusive,
        platform
      })
    )
    const eligible = verb === "auto"
      ? rows
      : (await Promise.all(rows.map(async (row) => ({
        row,
        kinds: await RepoResolution.effectiveKinds(repoResolutions, row.target, options.signal)
      })))).filter((entry) => entry.kinds.includes(verb)).map((entry) => entry.row)
    // `ci` plans each kind it aggregates with the bare verb, so a rule that
    // spawns an agent under `docs` would be selected by the aggregate's `docs`
    // pass exactly as by `smithers-build docs`. CI never spawns an agent: the
    // unattended plan drops those roots before anything is walked or keyed.
    const selected = options.unattended === true
      ? eligible.filter((row) => !RulePolicy.of(Target.metadata(row.target).target).attended)
      : eligible
    // A named pattern — `//pkg:name` or `//pkg/...:name` — resolved to at least
    // one row, so an empty selection means those rows do not participate in the
    // verb. A bare subtree is the only pattern allowed to select nothing.
    const namedPattern = parsedPattern._tag === "Exact" || parsedPattern.target !== undefined
    if (verb !== "auto" && namedPattern && selected.length === 0) {
      throw new Planner.UnsupportedVerbError(pattern, verb)
    }
    if (verb === "auto" && selected.length === 0) {
      throw new Error(`no targets selected by ${pattern} for the ${verb} verb`)
    }
    for (const row of selected) {
      if (rootLabels !== undefined && !rootLabels.has(row.label)) continue
      if (!selectedByLabel.has(row.label)) selectedByLabel.set(row.label, row)
      if (omitExclusive) wildcardRoots.add(row.label)
    }
  }
  const selected = [...selectedByLabel.values()]
  // The mode each selected root is planned under. Computed before the walk so a
  // target reached first as a dependency still adopts its root mode. A label
  // appears at most once in `selected`, so this maps each root to one mode.
  const rootModes = new Map<string, Mode>()
  for (const row of selected) {
    rootModes.set(row.label, rootMode(Target.metadata(row.target).target, options))
  }
  const workspace = index.workspace
  const workspaceToolchain = await WorkspaceToolchain.resolve(workspace, { root: index.root, signal: options.signal })
  const lockfilePath = (workspace.packageManager as
    | { readonly lockfile?: { readonly path?: unknown } }
    | undefined)?.lockfile?.path
  const lockfileDigest = typeof lockfilePath === "string"
    ? await Input.digestFile(NodePath.join(index.root, Input.resolvePath("", lockfilePath)), {
      workspaceRoot: index.root,
      signal: options.signal
    })
    : undefined
  // A declared environment resolves once per plan and fails closed: the
  // host's PATH is never consulted for a tool the workspace said comes from
  // the closure.
  const hostEnvironment = Workspace.withheldEnvironment(
    options.environment ?? process.env,
    options.remoteCache?.credentials
  )
  const nixDeclaration = WorkspaceDeclaration.nixEnvironment(workspace)
  const nixEnvironment = nixDeclaration === undefined
    ? undefined
    : await NixExec.resolveEnvironment({
      root: index.root,
      declaration: nixDeclaration,
      cacheDirectory: options.cacheDirectory,
      environment: hostEnvironment,
      signal: options.signal,
      log
    })
  const context: PlanContext = {
    root: index.root,
    cacheDirectory: options.cacheDirectory,
    index,
    signal: options.signal,
    log,
    flags: workspace.flags?.flags ?? {},
    managerBinary: managerBinaryOf(workspace),
    workspaceToolchain,
    tools: new Map(),
    toolBytes: new Map(),
    probes: new Map(),
    hostProbes: HostProbes.make(),
    nodes: new Map(),
    privateLabels: new WeakMap(),
    privateCounter: 0,
    visiting: new Set(),
    rootModes,
    inputs: options.inputs ?? {},
    environment: nixEnvironment === undefined
      ? hostEnvironment
      : NixExec.hostEnvironmentWith(nixEnvironment, hostEnvironment),
    nixEnvironment,
    ambient: {
      node: process.version,
      platform,
      arch: process.arch,
      lockfile: lockfileDigest ?? null,
      ...(workspaceToolchain.manifestDigests.length === 0
        ? {}
        : { toolchainManifests: workspaceToolchain.manifestDigests }),
      implementation: await Planner.implementationFingerprint(options.signal)
    },
    store: undefined,
    storeWarned: false,
    remoteCache: options.remoteCache,
    crateSets: new Map(),
    closureDigests: new Map(),
    closureResults: new Map(),
    graphDigests: new Map(),
    repoResolutions,
    childPlan: options.plan === true,
    reporter,
    write: options.write === true,
    kind: verb === "auto" ? undefined : verb,
    approvals: options.approvals
  }
  const roots: Array<string> = []
  try {
    for (const row of selected) {
      const rule = Target.metadata(row.target).target
      const node = await visit(context, row.target, { mode: rootMode(rule, options) })
      roots.push(node.label)
    }
  } finally {
    // The plan-time store is scoped to planning; execution opens its own.
    if (context.store !== undefined) await context.store.close().catch(() => undefined)
  }
  // The work list is the closure of the roots over execution edges only;
  // key-only dependencies (a Clean's targets, a refused rule's attrs) stay
  // planned but unscheduled.
  const closureOf = (starts: Iterable<string>): Set<string> => {
    const labels = new Set<string>()
    const queue = [...starts]
    while (queue.length > 0) {
      const label = queue.pop()!
      if (labels.has(label)) continue
      labels.add(label)
      const node = context.nodes.get(label)
      if (node === undefined) throw new Error(`planned execution edge names an unplanned node: ${label}`)
      for (const dependency of node.dependencies) queue.push(dependency)
      // A refused consumer never acts, so its gates are not scheduled: running
      // them would be work in the name of a check nothing will consume.
      if (node.refusal === undefined) { for (const gate of node.gateDeps) queue.push(gate) }
    }
    return labels
  }
  const workLabels = closureOf(roots)
  for (const label of workLabels) {
    const hosts = Target.metadata(context.nodes.get(label)!.declaration).hosts
    if (hosts !== undefined && !hosts.includes(platform)) {
      throw new Error(`${label} runs only on ${hosts.join(", ")}; this host is ${platform}`)
    }
  }
  for (const label of closureOf(wildcardRoots)) {
    if (!selectedByLabel.has(label) && Target.isExclusive(context.nodes.get(label)!.attrs)) {
      throw new Error(`wildcard selection reaches exclusive dependency ${label}; use --include-exclusive to run it`)
    }
  }
  const workList = [...workLabels].map((label) => context.nodes.get(label)!)
  return { roots, workList, nodes: context.nodes, closures: context.closureResults }
}
