/**
 * Gitlink-keyed submodule planning for build-system execution.
 *
 * The git index is the version authority. `.gitmodules` selects paths, globs
 * are expanded before execution, and populated worktrees must already match
 * their pinned gitlink commit. Checkout is required only for missing/empty
 * paths and therefore implies a network-enabled sandbox.
 *
 * @since 0.1.0
 */

import type * as GitTarget from "@smthrs/targets/GitTarget"
import * as Input from "@smthrs/targets/Input"
import { minimatch } from "minimatch"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as PackageTree from "./PackageTree.ts"

/** One submodule selected and pinned by the repository index.
 *
 * @category models
 * @since 0.1.0
 */
export interface Gitlink {
  readonly path: string
  readonly sha: string
  readonly state: "missing" | "empty" | "matching" | "mismatch"
  readonly head?: string | undefined
  readonly dirty?: boolean | undefined
}

/** The complete plan for one Git.Submodule(s) target.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly paths: ReadonlyArray<string>
  readonly gitlinks: ReadonlyArray<Gitlink>
  /**
   * Absolute host directories the selected submodules clone from when their
   * `.gitmodules` url names a local repository (an absolute path or a
   * `file://` url). A confined `git submodule update` has to be able to read
   * them; a remote url needs the network the rule already asks for.
   */
  readonly sources: ReadonlyArray<string>
  readonly refusal?: string | undefined
}

/**
 * The host directory a submodule url names when it is local, else undefined.
 * Relative urls resolve against the superproject's remote, not the
 * filesystem, so they are left to git.
 */
const localSource = (url: string): string | undefined => {
  if (url.startsWith("file://")) return decodeURIComponent(url.slice("file://".length))
  return NodePath.isAbsolute(url) ? url : undefined
}

/** `.gitmodules` entries as workspace-relative path to url. */
const configEntries = async (
  root: string,
  config: string
): Promise<ReadonlyMap<string, string | undefined>> => {
  // A workspace whose selected paths came from the index rather than from a
  // config file (`Git.Submodule`) may have no `.gitmodules` at all; that is
  // no entries, not a failure. A file that exists but cannot be read is one.
  const present = await Fs.access(NodePath.join(root, ...config.split("/"))).then(() => true, () => false)
  if (!present) return new Map()
  const raw = await PackageTree.runGit(root, ["config", "-z", "--file", config, "--list"])
  const directory = NodePath.posix.dirname(config) === "." ? "" : NodePath.posix.dirname(config)
  const paths = new Map<string, string>()
  const urls = new Map<string, string>()
  for (const record of raw.split("\0")) {
    const newline = record.indexOf("\n")
    if (newline < 0) continue
    const key = record.slice(0, newline)
    const value = record.slice(newline + 1)
    const match = /^submodule\.(.*)\.(path|url)$/i.exec(key)
    if (match === null || value === "") continue
    if (match[2]!.toLowerCase() === "path") paths.set(match[1]!, Input.resolvePath(directory, value))
    else urls.set(match[1]!, value)
  }
  const entries = new Map<string, string | undefined>()
  for (const [name, path] of paths) entries.set(path, urls.get(name))
  return entries
}

const configPaths = async (root: string, config: string): Promise<ReadonlyArray<string>> => {
  // `-z` separates records with NUL and the key from its value with a newline,
  // so a submodule name or path carrying whitespace still parses exactly.
  const raw = await PackageTree.runGit(root, [
    "config",
    "-z",
    "--file",
    config,
    "--list"
  ])
  const directory = NodePath.posix.dirname(config) === "." ? "" : NodePath.posix.dirname(config)
  const paths: Array<string> = []
  for (const record of raw.split("\0")) {
    const newline = record.indexOf("\n")
    if (newline < 0) continue
    const key = record.slice(0, newline)
    if (!/^submodule\..*\.path$/i.test(key)) continue
    const declared = record.slice(newline + 1)
    if (declared === "") continue
    paths.push(Input.resolvePath(directory, declared))
  }
  return [...new Set(paths)].sort()
}

const pinnedSha = async (root: string, path: string): Promise<string | undefined> => {
  const raw = await PackageTree.runGit(root, ["ls-files", "--stage", "--", path])
  const match = /^160000 ([0-9a-f]{40,64}) 0\t/.exec(raw)
  return match?.[1]
}

const stateOf = async (root: string, path: string, sha: string): Promise<Gitlink> => {
  const absolute = NodePath.join(root, ...path.split("/"))
  const stats = await Fs.lstat(absolute).catch(() => undefined)
  if (stats === undefined) return { path, sha, state: "missing" }
  if (!stats.isDirectory()) return { path, sha, state: "mismatch" }
  if ((await Fs.readdir(absolute)).length === 0) return { path, sha, state: "empty" }
  const head = (await PackageTree.runGit(absolute, ["rev-parse", "HEAD"])).trim()
  const dirty = (await PackageTree.runGit(absolute, ["status", "--porcelain", "--untracked-files=all"])).trim() !== ""
  return head === sha && !dirty
    ? { path, sha, state: "matching", head, dirty }
    : { path, sha, state: "mismatch", head, dirty }
}

/** Resolves paths, gitlink SHAs, and current worktree state.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = async (
  options:
    | {
      readonly root: string
      readonly packagePath: string
      readonly rule: "Git.Submodules"
      readonly attrs: (typeof GitTarget.SubmodulesAttrs)["Type"]
    }
    | {
      readonly root: string
      readonly packagePath: string
      readonly rule: "Git.Submodule"
      readonly attrs: (typeof GitTarget.SubmoduleAttrs)["Type"]
    }
): Promise<Plan> => {
  let paths: ReadonlyArray<string>
  if (options.rule === "Git.Submodule") {
    paths = [Input.resolvePath(options.packagePath, options.attrs.path)]
  } else {
    const config = Input.resolvePath(options.packagePath, options.attrs.config.path)
    const available = await configPaths(options.root, config)
    const directory = NodePath.posix.dirname(config) === "." ? "" : NodePath.posix.dirname(config)
    const patterns = options.attrs.paths.map((path) => Input.resolvePath(directory, path))
    paths = available.filter((path) => patterns.some((pattern) => minimatch(path, pattern, { dot: true })))
    if (paths.length === 0) {
      return {
        paths,
        gitlinks: [],
        sources: [],
        refusal: `Git.Submodules paths ${JSON.stringify(options.attrs.paths)} match no entries in ${config}`
      }
    }
  }

  const gitlinks: Array<Gitlink> = []
  for (const path of [...new Set(paths)].sort()) {
    const sha = await pinnedSha(options.root, path)
    if (sha === undefined) {
      return {
        paths,
        gitlinks,
        sources: [],
        refusal: `Git submodule ${path} has no stage-0 gitlink in the repository index`
      }
    }
    const link = await stateOf(options.root, path, sha)
    gitlinks.push(link)
    if (link.state === "mismatch") {
      return {
        paths,
        gitlinks,
        sources: [],
        refusal: link.head === sha && link.dirty === true
          ? `Git submodule ${path} worktree has changes relative to pinned gitlink ${sha}`
          : `Git submodule ${path} worktree HEAD ${
            link.head === "" || link.head === undefined ? "is not readable" : link.head
          } does not match pinned gitlink ${sha}`
      }
    }
  }
  const entries = await configEntries(
    options.root,
    options.rule === "Git.Submodules"
      ? Input.resolvePath(options.packagePath, options.attrs.config.path)
      : ".gitmodules"
  )
  const sources: Array<string> = []
  for (const path of paths) {
    const url = entries.get(path)
    const source = url === undefined ? undefined : localSource(url)
    if (source !== undefined && !sources.includes(source)) sources.push(source)
  }
  return { paths: [...new Set(paths)].sort(), gitlinks, sources: sources.sort() }
}

/** Whether every selected checkout is populated at its pinned SHA.
 *
 * @category execution
 * @since 0.1.0
 */
export const isMaterialized = (plan: Plan): boolean => plan.gitlinks.every((link) => link.state === "matching")

/** Revalidates the selected worktrees after cache restore or checkout.
 *
 * @category execution
 * @since 0.1.0
 */
export const verify = async (root: string, plan: Plan): Promise<string | undefined> => {
  for (const link of plan.gitlinks) {
    const current = await stateOf(root, link.path, link.sha)
    if (current.state !== "matching") {
      return `Git submodule ${link.path} did not materialize pinned gitlink ${link.sha}`
    }
  }
  return undefined
}
