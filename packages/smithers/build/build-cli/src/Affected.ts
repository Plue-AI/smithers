/** Conservative changed-file selection, including reverse target dependencies.
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import { Minimatch } from "minimatch"
import * as Path from "node:path"
import * as ContainedProcess from "./internal/ContainedProcess.ts"
import { inputPackage } from "./internal/InputPackage.ts"
import type { PackageIndex } from "./PackageIndex.ts"
import { productionSourceRoots } from "./Planner.ts"

/** Affected discovery refused a git result or could not finish within its bound.
 * @category errors
 * @since 1.0.0-rc.0
 */
export class AffectedGitError extends Error {
  readonly _tag = "AffectedGitError"
  readonly code: ContainedProcess.ProcessError["code"] | "nonzero_exit" | "invalid_timeout"
  readonly args: ReadonlyArray<string>

  constructor(code: AffectedGitError["code"], args: ReadonlyArray<string>, message: string, cause?: unknown) {
    super(message, { cause })
    this.code = code
    this.args = [...args]
  }
}

/** Collects changed paths from explicit inputs or a verified Git comparison.
 * @category querying
 * @since 0.1.0
 */
export const changedPaths = async (root: string, options: {
  readonly base: string
  readonly head?: string | undefined
  readonly files?: ReadonlyArray<string> | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
}): Promise<ReadonlyArray<string>> => {
  if (options.signal?.aborted) {
    throw new AffectedGitError("cancelled", [], "affected discovery cancelled", options.signal.reason)
  }
  if (options.files !== undefined) return [...new Set(options.files)].sort()
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new AffectedGitError("invalid_timeout", [], "git timeout must be an integer from 1 to 86400000ms")
  }
  const git = async (args: ReadonlyArray<string>): Promise<string> => {
    let stdout = ""
    let stderr = ""
    let code: number
    try {
      code = await ContainedProcess.run({
        command: "git",
        args,
        cwd: root,
        signal: options.signal,
        environment: options.environment,
        timeoutMs,
        maxOutputBytes: 16 * 1024 * 1024,
        fatalUtf8: true,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        }
      })
    } catch (cause) {
      throw new AffectedGitError(
        cause instanceof ContainedProcess.ProcessError ? cause.code : "process_failed",
        args,
        `git ${args[0]} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause
      )
    }
    if (code !== 0) {
      throw new AffectedGitError("nonzero_exit", args, `git ${args[0]} exited ${code}: ${stderr.trim()}`, {
        exitCode: code,
        stderr
      })
    }
    return stdout
  }
  const gitPaths = async (args: ReadonlyArray<string>) => (await git(args)).split("\0").filter(Boolean)
  // Resolve user revisions before passing them to diff; a leading dash cannot become an option.
  const revision = async (ref: string) =>
    (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim()
  const base = await revision(options.base)
  const paths = options.head === undefined
    ? [
      ...await gitPaths(["diff", "--name-only", "--no-renames", "-z", base, "--"]),
      ...await gitPaths(["ls-files", "--others", "--exclude-standard", "-z"])
    ]
    : await gitPaths(["diff", "--name-only", "--no-renames", "-z", base, await revision(options.head), "--"])
  return [...new Set(paths)].sort()
}

const globalPath = (path: string): boolean =>
  !path.includes("/") || path.startsWith(".smithers/") || Path.posix.basename(path) === "PACKAGE.ts" ||
  /(^|\/)(?:[^/]*lock[^/]*|package\.json|tsconfig[^/]*\.json|\.npmrc|\.yarnrc[^/]*|\.gitignore)$/.test(path)

const compileInput = (
  input: Input.Declared,
  packagePath: string,
  glob: (pattern: string) => Minimatch
): (path: string) => boolean => {
  switch (input._tag) {
    case "File": {
      const resolved = Input.resolvePath(packagePath, input.path)
      return (path) => resolved === path
    }
    case "Glob": {
      const pattern = glob(Input.resolvePath(packagePath, input.pattern))
      const excludes = input.exclude.map((exclude) => glob(Input.resolvePath(packagePath, exclude)))
      return (path) => pattern.match(path) && !excludes.some((exclude) => exclude.match(path))
    }
    // These input forms include ambient repository state and workspace membership.
    case "GitDiff":
    case "PnpmWorkspace":
      return () => true
  }
}

/** Selects roots, among the union of the patterns, whose declarations, package inputs or dependencies may have changed.
 * @category querying
 * @since 0.1.0
 */
export const select = (index: PackageIndex, patterns: ReadonlyArray<string>, paths: ReadonlyArray<string>) => {
  const normalized = [
    ...new Set(paths.map((path) => {
      const value = path.replaceAll("\\", "/").replace(/^\.\//, "")
      if (value === "" || Path.posix.isAbsolute(value) || value.split("/").includes("..")) {
        throw new Error(`invalid workspace-relative changed path: ${path}`)
      }
      return value
    }))
  ].sort()
  const rows = index.targets()
  const selected = [
    ...new Map(patterns.flatMap((pattern) => index.resolve(pattern)).map((row) => [row.label, row])).values()
  ]
  const reasons = new Map<string, Set<string>>()
  const globs = new Map<string, Minimatch>()
  const glob = (pattern: string): Minimatch => {
    let compiled = globs.get(pattern)
    if (compiled === undefined) {
      compiled = new Minimatch(pattern, { dot: true })
      globs.set(pattern, compiled)
    }
    return compiled
  }
  const entries = new Map<Target.AnyTarget, {
    readonly metadata: Target.Metadata
    readonly packagePath: string
    readonly matchesBase: (path: string) => boolean
  }>()
  const entry = (target: Target.AnyTarget) => {
    let value = entries.get(target)
    if (value !== undefined) return value
    const metadata = Target.metadata(target)
    const packagePath = index.ownerOf(target) ?? ""
    const packagePrefix = packagePath === "" ? undefined : `${packagePath}/`
    const inputs = metadata.inputs.map((input) => compileInput(input, inputPackage(metadata, packagePath), glob))
    const matches = new Map<string, boolean>()
    value = {
      metadata,
      packagePath,
      matchesBase: (path) => {
        let result = matches.get(path)
        if (result === undefined) {
          // Membership catches new files, implicit compiler inputs and config lookups.
          result = packagePrefix !== undefined && path.startsWith(packagePrefix) ||
            inputs.some((input) => input(path))
          matches.set(path, result)
        }
        return result
      }
    }
    entries.set(target, value)
    return value
  }
  const implementationRoots = productionSourceRoots().map((source) =>
    Path.relative(index.root, source.directory).replaceAll("\\", "/")
  )
    .filter((path) => path !== ".." && !path.startsWith("../") && !Path.isAbsolute(path))
  const global = normalized.filter((path) =>
    globalPath(path) || implementationRoots.some((directory) => path === directory || path.startsWith(`${directory}/`))
  )
  // An unowned file may be an ambient input; conservatively invalidate the graph.
  const ownership = normalized.length === 0 ? [] : rows.map((row) => entry(row.target))
  const unknown = normalized.filter((path) => !ownership.some((value) => value.matchesBase(path)))
  const conservative = global.length + unknown.length > 0
  if (conservative) {
    for (const row of selected) reasons.set(row.label, new Set([...global, ...unknown]))
  } else if (normalized.length > 0) {
    const direct = new Map<Target.AnyTarget, (path: string) => boolean>()
    const reverse = new Map<Target.AnyTarget, Set<Target.AnyTarget>>()
    const selectors = new Map<string, ReadonlyArray<Target.AnyTarget>>()
    const pending = selected.map((row) => row.target)
    // Index the selected closure once, including private and verb-specific edges.
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const target = pending[cursor]!
      if (direct.has(target)) continue
      const value = entry(target)
      const metadata = value.metadata
      const views = metadata.kinds.map((kind) => metadata.forKind(kind))
      const inputs = views.flatMap((view) => view.inputs)
        .map((input) => compileInput(input, inputPackage(metadata, value.packagePath), glob))
      direct.set(target, (path) =>
        value.matchesBase(path) || inputs.some((input) => input(path)) ||
        metadata.inputs.length === 0 && metadata.dependencies.length === 0)
      const dependencies = new Set([
        ...metadata.dependencies,
        ...views.flatMap((view) => view.dependencies)
      ])
      for (const selector of [...metadata.dependencySelectors, ...views.flatMap((view) => view.dependencySelectors)]) {
        const label = `${selector.pattern}:${selector.target}`
        let resolved = selectors.get(label)
        if (resolved === undefined) {
          resolved = index.resolve(label).map((row) => row.target)
          selectors.set(label, resolved)
        }
        for (const dependency of resolved) dependencies.add(dependency)
      }
      for (const dependency of dependencies) {
        let dependents = reverse.get(dependency)
        if (dependents === undefined) reverse.set(dependency, dependents = new Set())
        dependents.add(target)
        pending.push(dependency)
      }
    }
    for (const path of normalized) {
      const affected = new Set<Target.AnyTarget>()
      for (const [target, matches] of direct) if (matches(path)) affected.add(target)
      // Set iteration includes newly added dependents and visits each target/path once,
      // even when several selected roots share dependencies or the graph has a cycle.
      for (const target of affected) {
        for (const dependent of reverse.get(target) ?? []) affected.add(dependent)
      }
      for (const row of selected) {
        if (!affected.has(row.target)) continue
        let causes = reasons.get(row.label)
        if (causes === undefined) reasons.set(row.label, causes = new Set())
        causes.add(path)
      }
    }
  }
  return {
    pattern: patterns.join(" "),
    files: normalized,
    conservative,
    globalInputs: [...new Set([...global, ...unknown])].sort(),
    targets: selected.filter((row) => reasons.has(row.label)).map((row) => ({
      label: row.label,
      reasons: [...reasons.get(row.label)!].sort()
    }))
  }
}
