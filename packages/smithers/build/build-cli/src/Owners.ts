/**
 * Ownership resolution over the package index: which owners a changed path
 * resolves to, why, and under which agent policy; plus the two projections
 * of that answer, `.github/CODEOWNERS` and the per-directory `OWNERS` tree.
 *
 * The declarations are inert data on `S.Package` and `S.Workspace`
 * (`@smthrs/targets/Owners`). This module is the only place they meet the
 * package tree and the dependency graph, so the CLI's `owners` command, the
 * `owners()` and `rdeps()` queries, and the two generated-file rules all read
 * one resolution.
 *
 * ## Terms
 *
 * A path belongs to the deepest package whose directory contains it. Its
 * **direct** owners are that package's `owners` plus every `perFile` rule the
 * path matches. Unless the package sets `noparent`, the walk continues to
 * the parent package and adds its owners as **inherited**, up to the root; a
 * path whose chain declares nothing resolves to the **workspace** owners.
 *
 * A package's **upstream** is the set of packages its targets depend on,
 * transitively, through declared dependencies: what `deps()` reaches. A
 * package that declares `upstream: "review"` or `"approve"` claims changes to
 * those packages: the claiming package's own owners join the resolution as
 * suggested reviewers or required approvers, tagged `upstream-of //pkg`.
 * `packages` bounds the claim to named labels or subtree patterns.
 *
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import type * as Owners from "@smthrs/targets/Owners"
import * as Target from "@smthrs/targets/Target"
import { minimatch } from "minimatch"
import * as Ansi from "./Ansi.ts"
import { byCodeUnit } from "./internal/Text.ts"
import * as Label from "./Label.ts"
import type { PackageIndex } from "./PackageIndex.ts"
import * as PackageTree from "./PackageTree.ts"

/**
 * Why one owner is on a path.
 *
 * @category models
 * @since 0.1.0
 */
export type Reason =
  | { readonly kind: "direct" }
  | { readonly kind: "per-file"; readonly pattern: string }
  | { readonly kind: "inherited"; readonly from: string }
  | { readonly kind: "workspace" }
  | { readonly kind: "upstream-of"; readonly label: string }

/**
 * One resolved owner on a path: the reference as written, the role the
 * resolution gives it, and every reason it is there.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResolvedOwner {
  readonly owner: Owners.Owner
  readonly role: "approve" | "review"
  readonly reasons: ReadonlyArray<Reason>
}

/**
 * One touched path and everything ownership says about it.
 *
 * @category models
 * @since 0.1.0
 */
export interface TouchedPath {
  readonly path: string
  /** The owning package label, `//` for the root. */
  readonly package: string
  readonly owners: ReadonlyArray<ResolvedOwner>
  readonly agentPolicy: Owners.AgentPolicy
  /** Every package with a say: the owning package and each upstream claimant. */
  readonly packages: ReadonlyArray<string>
}

/**
 * The whole answer for one set of paths.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resolution {
  readonly touchedPaths: ReadonlyArray<TouchedPath>
  /** Owners with the `approve` role anywhere in the set, deduplicated and sorted. */
  readonly requiredApprovers: ReadonlyArray<Owners.Owner>
  /** Owners with only the `review` role, deduplicated and sorted, never also required. */
  readonly suggestedReviewers: ReadonlyArray<Owners.Owner>
}

const packageLabel = (packagePath: string): string => packagePath === "" ? "//" : `//${packagePath}`

const normalizePath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
  if (normalized === "" || normalized === "." || normalized.split("/").includes("..")) {
    throw new Error(`owners paths must be workspace-relative: ${JSON.stringify(path)}`)
  }
  return normalized
}

/**
 * The deepest package whose directory contains the path, `""` for the root.
 *
 * @category resolution
 * @since 0.1.0
 */
export const packageOf = (index: PackageIndex, path: string): string => {
  let best = ""
  for (const packagePath of index.packages()) {
    if (packagePath === "") continue
    if ((path === packagePath || path.startsWith(`${packagePath}/`)) && packagePath.length > best.length) {
      best = packagePath
    }
  }
  return best
}

/** The package and each existing ancestor package, nearest first, root last. */
const chainOf = (index: PackageIndex, packagePath: string): ReadonlyArray<string> => {
  const chain: Array<string> = []
  let current = packagePath
  for (;;) {
    if (index.hasPackage(current)) chain.push(current)
    if (current === "") break
    const cut = current.lastIndexOf("/")
    current = cut < 0 ? "" : current.slice(0, cut)
  }
  return chain
}

const relativeTo = (packagePath: string, path: string): string =>
  packagePath === "" ? path : path === packagePath ? "" : path.slice(packagePath.length + 1)

const matches = (pattern: string, relative: string): boolean =>
  relative !== "" && minimatch(relative, pattern, { dot: true, matchBase: !pattern.includes("/") })

/**
 * The transitive set of packages one package depends on, through every
 * labeled target's dependency closure, excluding the package itself.
 *
 * @category resolution
 * @since 0.1.0
 */
export const upstreamPackages = (index: PackageIndex, packagePath: string): ReadonlyArray<string> => {
  const found = new Set<string>()
  const seen = new Set<Target.AnyTarget>()
  const stack: Array<Target.AnyTarget> = index.targets().filter((row) => row.packagePath === packagePath).map((row) =>
    row.target
  )
  while (stack.length > 0) {
    const current = stack.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    const owner = index.ownerOf(current)
    if (owner !== undefined && owner !== packagePath) found.add(owner)
    for (const dependency of Target.metadata(current).dependencies) stack.push(dependency)
  }
  return [...found].sort(byCodeUnit)
}

/** Whether a bounded upstream claim covers one package. */
const claimCovers = (claim: Owners.Upstream, packagePath: string): boolean => {
  if (claim.packages === undefined) return true
  return claim.packages.some((entry) => {
    const pattern = Label.parse(entry, "")
    if (pattern._tag === "Subtree") {
      return pattern.packagePath === "" || packagePath === pattern.packagePath ||
        packagePath.startsWith(`${pattern.packagePath}/`)
    }
    return pattern.target === undefined && pattern.packagePath === packagePath
  })
}

/** Accumulates owners, merging reasons for one owner seen twice. */
class OwnerSet {
  private readonly byOwner = new Map<string, { role: "approve" | "review"; reasons: Array<Reason> }>()
  add(owner: Owners.Owner, role: "approve" | "review", reason: Reason): void {
    const known = this.byOwner.get(owner)
    if (known === undefined) {
      this.byOwner.set(owner, { role, reasons: [reason] })
      return
    }
    if (role === "approve") known.role = "approve"
    known.reasons.push(reason)
  }
  list(): ReadonlyArray<ResolvedOwner> {
    return [...this.byOwner].sort(([left], [right]) => byCodeUnit(left, right)).map(([owner, entry]) => ({
      owner,
      role: entry.role,
      reasons: entry.reasons
    }))
  }
}

/**
 * The owners of one package directory itself, with inheritance and the
 * workspace fallback, but without per-file rules: what an upstream claim
 * contributes and what a CODEOWNERS package line lists.
 *
 * @category resolution
 * @since 0.1.0
 */
export const packageOwners = (index: PackageIndex, packagePath: string): ReadonlyArray<ResolvedOwner> => {
  const set = new OwnerSet()
  let declared = false
  for (const ancestor of chainOf(index, packagePath)) {
    const declaration = index.ownersOf(ancestor)
    if (declaration === undefined) continue
    const reason: Reason = ancestor === packagePath
      ? { kind: "direct" }
      : { kind: "inherited", from: packageLabel(ancestor) }
    for (const owner of declaration.owners) {
      set.add(owner, "approve", reason)
      declared = true
    }
    if (declaration.noparent) break
  }
  if (!declared && index.workspace.owners !== undefined) {
    for (const owner of index.workspace.owners.owners) set.add(owner, "approve", { kind: "workspace" })
  }
  return set.list()
}

/**
 * The agent policy one path lands under: the nearest declaring package's
 * first matching override, else its default, walking up unless `noparent`;
 * the workspace declaration last; `human-approve` when nothing declares.
 *
 * @category resolution
 * @since 0.1.0
 */
export const agentPolicyOf = (index: PackageIndex, path: string): Owners.AgentPolicy => {
  const owning = packageOf(index, path)
  for (const ancestor of chainOf(index, owning)) {
    const declaration = index.ownersOf(ancestor)
    if (declaration === undefined) continue
    if (declaration.agents !== undefined) {
      const relative = relativeTo(ancestor, path)
      for (const override of declaration.agents.overrides) {
        if (matches(override.pattern, relative)) return override.policy
      }
      return declaration.agents.default
    }
    if (declaration.noparent) break
  }
  const workspace = index.workspace.owners?.agents
  if (workspace !== undefined) {
    for (const override of workspace.overrides) if (matches(override.pattern, path)) return override.policy
    return workspace.default
  }
  return "human-approve"
}

/** Every package that claims upstream changes, with its claim. */
const claimants = (
  index: PackageIndex
): ReadonlyArray<{ readonly packagePath: string; readonly claim: Owners.Upstream }> => {
  const found: Array<{ readonly packagePath: string; readonly claim: Owners.Upstream }> = []
  for (const packagePath of index.packages()) {
    const claim = index.ownersOf(packagePath)?.upstream
    if (claim !== undefined) found.push({ packagePath, claim })
  }
  return found
}

/**
 * Resolves ownership for a set of workspace-relative paths.
 *
 * @category resolution
 * @since 0.1.0
 */
export const resolve = (index: PackageIndex, paths: ReadonlyArray<string>): Resolution => {
  const upstreamCache = new Map<string, ReadonlySet<string>>()
  const upstreamOf = (packagePath: string): ReadonlySet<string> => {
    const known = upstreamCache.get(packagePath)
    if (known !== undefined) return known
    const computed = new Set(upstreamPackages(index, packagePath))
    upstreamCache.set(packagePath, computed)
    return computed
  }
  const claims = claimants(index)
  const touched: Array<TouchedPath> = []
  for (const raw of [...new Set(paths.map(normalizePath))].sort(byCodeUnit)) {
    const owning = packageOf(index, raw)
    const set = new OwnerSet()
    const packages = new Set<string>([packageLabel(owning)])
    let declared = false
    for (const ancestor of chainOf(index, owning)) {
      const declaration = index.ownersOf(ancestor)
      if (declaration === undefined) continue
      const direct = ancestor === owning
      const reason: Reason = direct ? { kind: "direct" } : { kind: "inherited", from: packageLabel(ancestor) }
      for (const owner of declaration.owners) {
        set.add(owner, "approve", reason)
        declared = true
      }
      const relative = relativeTo(ancestor, raw)
      for (const rule of declaration.perFile) {
        if (!matches(rule.pattern, relative)) continue
        for (const owner of rule.owners) {
          set.add(owner, "approve", { kind: "per-file", pattern: rule.pattern })
          declared = true
        }
      }
      if (declaration.noparent) break
    }
    if (!declared && index.workspace.owners !== undefined) {
      for (const owner of index.workspace.owners.owners) set.add(owner, "approve", { kind: "workspace" })
    }
    for (const claimant of claims) {
      if (claimant.packagePath === owning) continue
      if (!upstreamOf(claimant.packagePath).has(owning)) continue
      if (!claimCovers(claimant.claim, owning)) continue
      const label = packageLabel(claimant.packagePath)
      for (const entry of packageOwners(index, claimant.packagePath)) {
        set.add(entry.owner, claimant.claim.mode, { kind: "upstream-of", label })
      }
      packages.add(label)
    }
    touched.push({
      path: raw,
      package: packageLabel(owning),
      owners: set.list(),
      agentPolicy: agentPolicyOf(index, raw),
      packages: [...packages].sort(byCodeUnit)
    })
  }
  const required = new Set<Owners.Owner>()
  const suggested = new Set<Owners.Owner>()
  for (const entry of touched) {
    for (const owner of entry.owners) (owner.role === "approve" ? required : suggested).add(owner.owner)
  }
  for (const owner of required) suggested.delete(owner)
  return {
    touchedPaths: touched,
    requiredApprovers: [...required].sort(byCodeUnit),
    suggestedReviewers: [...suggested].sort(byCodeUnit)
  }
}

/**
 * The workspace-relative paths changed since a git base, the same set an
 * `S.gitDiff(base)` input declares.
 *
 * @category resolution
 * @since 0.1.0
 */
export const changedPaths = async (root: string, base: string): Promise<ReadonlyArray<string>> => {
  const validated = Input.validateGitBase(base)
  const raw = await PackageTree.runGit(root, ["diff", "--name-only", "-z", "--end-of-options", validated, "--"])
  return raw.split("\0").filter((path) => path !== "").sort(byCodeUnit)
}

/**
 * Every labeled target whose dependency closure reaches the target one
 * label names: the reverse of `deps()`.
 *
 * @category querying
 * @since 0.1.0
 */
export const rdeps = (index: PackageIndex, label: string): ReadonlyArray<string> => {
  const rows = index.resolve(label)
  if (rows.length !== 1) throw new Error("rdeps() requires one exact or default target")
  const root = rows[0]!
  const found: Array<string> = []
  for (const row of index.targets()) {
    if (row.label === root.label) continue
    const stack: Array<Target.AnyTarget> = [row.target]
    const seen = new Set<Target.AnyTarget>()
    let reaches = false
    while (stack.length > 0 && !reaches) {
      const current = stack.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      for (const dependency of Target.metadata(current).dependencies) {
        if (dependency === root.target) {
          reaches = true
          break
        }
        stack.push(dependency)
      }
    }
    if (reaches) found.push(row.label)
  }
  return found.sort(byCodeUnit)
}

/**
 * The JSON shape the `--json` output and the Smithers landing gate share:
 * `touched_paths[]` with `{ login }` or `{ team }` owner objects, `role`,
 * `reasons` as strings, and `agent_policy`.
 *
 * @category formatting
 * @since 0.1.0
 */
export const toJson = (resolution: Resolution): {
  readonly touched_paths: ReadonlyArray<{
    readonly path: string
    readonly package: string
    readonly owners: ReadonlyArray<
      {
        readonly login?: string
        readonly team?: string
        readonly role: string
        readonly reasons: ReadonlyArray<string>
      }
    >
    readonly agent_policy: Owners.AgentPolicy
    readonly packages: ReadonlyArray<string>
  }>
  readonly required_approvers: ReadonlyArray<string>
  readonly suggested_reviewers: ReadonlyArray<string>
} => ({
  touched_paths: resolution.touchedPaths.map((entry) => ({
    path: entry.path,
    package: entry.package,
    owners: entry.owners.map((owner) => ({
      ...(owner.owner.startsWith("team:") ? { team: owner.owner.slice(5) } : { login: owner.owner }),
      role: owner.role,
      reasons: owner.reasons.map(reasonText)
    })),
    agent_policy: entry.agentPolicy,
    packages: entry.packages
  })),
  required_approvers: resolution.requiredApprovers,
  suggested_reviewers: resolution.suggestedReviewers
})

/**
 * One reason rendered the way the JSON and the table both show it.
 *
 * @category rendering
 * @since 0.1.0
 */
export const reasonText = (reason: Reason): string => {
  switch (reason.kind) {
    case "direct":
      return "direct"
    case "per-file":
      return `per-file ${reason.pattern}`
    case "inherited":
      return `inherited from ${reason.from}`
    case "workspace":
      return "workspace"
    case "upstream-of":
      return `upstream-of ${reason.label}`
  }
}

/**
 * Renders a resolution for a person: one block per path, owners with role
 * and reasons, then the required and suggested sets.
 *
 * @category formatting
 * @since 0.1.0
 */
export const text = (resolution: Resolution, style: Ansi.Palette = Ansi.none): string => {
  if (resolution.touchedPaths.length === 0) return style.dim("no paths")
  const lines: Array<string> = []
  for (const entry of resolution.touchedPaths) {
    lines.push(`${style.bold(entry.path)}  ${style.dim(entry.package)}  ${style.dim(`agents: ${entry.agentPolicy}`)}`)
    if (entry.owners.length === 0) lines.push(`  ${style.dim("no owners")}`)
    for (const owner of entry.owners) {
      const role = owner.role === "approve" ? style.green("approve") : style.yellow("review")
      lines.push(`  ${owner.owner.padEnd(24)}  ${role}  ${style.dim(owner.reasons.map(reasonText).join(", "))}`)
    }
  }
  lines.push("")
  lines.push(`${style.bold("required approvers")}  ${resolution.requiredApprovers.join(" ") || style.dim("none")}`)
  lines.push(`${style.bold("suggested reviewers")} ${resolution.suggestedReviewers.join(" ") || style.dim("none")}`)
  return lines.join("\n")
}

const codeownersHandle = (org: string, owner: Owners.Owner): string =>
  owner.startsWith("team:") ? `@${org}/${owner.slice(5)}` : `@${owner}`

/** A glob rendered for CODEOWNERS: anchored under its package directory. */
const codeownersPattern = (packagePath: string, glob: string | undefined): string => {
  const base = packagePath === "" ? "" : `/${packagePath}/`
  if (glob === undefined) return packagePath === "" ? "*" : base
  if (glob.includes("/")) return `${base === "" ? "/" : base}${glob}`
  // A bare file glob applies at every depth inside the package; the explicit
  // prefix scopes it independently of preceding CODEOWNERS lines.
  return `${base === "" ? "" : base}**/${glob}`
}

/** Intersect wildcard sequences, retaining every possible alignment of stars. */
const intersectSequences = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
  star: string,
  separator: string,
  intersect: (left: string, right: string) => ReadonlyArray<string>
): ReadonlyArray<string> => {
  const cache = new Map<string, ReadonlyArray<string>>()
  const visit = (i: number, j: number): ReadonlyArray<string> => {
    const key = `${i}:${j}`
    const known = cache.get(key)
    if (known !== undefined) return known
    const a = left[i]
    const b = right[j]
    const found = new Set<string>()
    const append = (head: string, tails: ReadonlyArray<string>) => {
      for (const tail of tails) {
        // Adjacent stars have the same language as one star.
        found.add(
          head === star && (tail === star || tail.startsWith(`${star}${separator}`))
            ? tail
            : tail === ""
            ? head
            : `${head}${separator}${tail}`
        )
      }
    }
    if (a === undefined && b === undefined) found.add("")
    else if (a === star && b === star) {
      append(star, visit(i + 1, j))
      append(star, visit(i, j + 1))
    } else if (a === star) {
      for (const suffix of visit(i + 1, j)) found.add(suffix)
      if (b !== undefined) append(b, visit(i, j + 1))
    } else if (b === star) {
      for (const suffix of visit(i, j + 1)) found.add(suffix)
      if (a !== undefined) append(a, visit(i + 1, j))
    } else if (a !== undefined && b !== undefined) {
      for (const head of intersect(a, b)) append(head, visit(i + 1, j + 1))
    }
    const result = [...found]
    cache.set(key, result)
    return result
  }
  return visit(0, 0)
}

/** CODEOWNERS globs use * and ? within a component and ** across directories. */
const intersectPatterns = (left: string, right: string): ReadonlyArray<string> => {
  if (left === right) return [left]
  return intersectSequences(left.split("/"), right.split("/"), "**", "/", (a, b) => {
    if (a === b) return [a]
    if (a === "*") return [b]
    if (b === "*") return [a]
    return intersectSequences([...a], [...b], "*", "", (x, y) => x === y || y === "?" ? [x] : x === "?" ? [y] : [])
      .filter((segment) => segment !== "")
  })
}

/** Per-file patterns scoped to this package, including every overlap's union. */
const codeownersRules = (index: PackageIndex, packagePath: string) => {
  const rules = new Map<string, Set<Owners.Owner>>()
  const scope = packagePath === "" ? "**" : `${packagePath}/**`
  for (const ancestor of chainOf(index, packagePath)) {
    const declaration = index.ownersOf(ancestor)
    if (declaration === undefined) continue
    for (const rule of declaration.perFile) {
      const pattern = codeownersPattern(ancestor, rule.pattern).replace(/^\//, "")
      for (const projected of intersectPatterns(scope, pattern)) {
        const additions: Array<readonly [string, ReadonlyArray<Owners.Owner>]> = [[projected, rule.owners]]
        for (const [existing, owners] of rules) {
          for (const overlap of intersectPatterns(existing, projected)) {
            additions.push([overlap, [...owners, ...rule.owners]])
          }
        }
        for (const [pattern, owners] of additions) {
          const merged = rules.get(pattern) ?? new Set<Owners.Owner>()
          for (const owner of owners) merged.add(owner)
          rules.set(pattern, merged)
        }
      }
    }
    if (declaration.noparent) break
  }
  // An intersection contains every owner of its contributing rules, so it
  // must follow them under last-match semantics. Ties are deterministic.
  return [...rules].sort(([a, ownersA], [b, ownersB]) => ownersA.size - ownersB.size || byCodeUnit(a, b))
}

/**
 * Renders `.github/CODEOWNERS`: least specific first, so GitHub's last-match
 * rule lands on the deepest package or per-file rule. Only required approvers
 * appear; a `review` upstream claim has no CODEOWNERS form.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderCodeowners = (index: PackageIndex, org: string): string => {
  const lines: Array<string> = [
    "# Generated by smithers-build from the PACKAGE.ts owners declarations. Do not edit.",
    "# PACKAGE.ts is authoritative; regenerate with: smithers-build build <label> --write",
    ""
  ]
  const claims = claimants(index).filter((claimant) => claimant.claim.mode === "approve").map((claimant) => ({
    ...claimant,
    upstream: new Set(upstreamPackages(index, claimant.packagePath)),
    owners: packageOwners(index, claimant.packagePath)
  }))
  const packages = [...index.packages()].sort((left, right) =>
    left.split("/").length - right.split("/").length || byCodeUnit(left, right)
  )
  for (const packagePath of packages) {
    const set = new OwnerSet()
    const perFileBase = new OwnerSet()
    for (const entry of packageOwners(index, packagePath)) {
      set.add(entry.owner, "approve", { kind: "direct" })
      // A matching per-file declaration suppresses the workspace fallback,
      // just as it does in resolve; upstream claims still contribute below.
      if (!entry.reasons.some((reason) => reason.kind === "workspace")) {
        perFileBase.add(entry.owner, "approve", { kind: "direct" })
      }
    }
    for (const claimant of claims) {
      if (claimant.packagePath === packagePath || !claimant.upstream.has(packagePath)) continue
      if (!claimCovers(claimant.claim, packagePath)) continue
      for (const entry of claimant.owners) {
        const reason: Reason = { kind: "upstream-of", label: packageLabel(claimant.packagePath) }
        set.add(entry.owner, "approve", reason)
        perFileBase.add(entry.owner, "approve", reason)
      }
    }
    const owners = set.list()
    // Even an empty directory rule must clear owners from ancestor patterns.
    lines.push(
      [codeownersPattern(packagePath, undefined), ...owners.map((entry) => codeownersHandle(org, entry.owner))].join(
        " "
      )
    )
    const perFileOwners = perFileBase.list()
    for (const [pattern, ruleOwners] of codeownersRules(index, packagePath)) {
      const merged = new OwnerSet()
      for (const entry of perFileOwners) merged.add(entry.owner, "approve", { kind: "direct" })
      for (const owner of ruleOwners) merged.add(owner, "approve", { kind: "per-file", pattern })
      const anchored = packagePath === "" && pattern.startsWith("**/") ? pattern : `/${pattern}`
      lines.push(`${anchored} ${merged.list().map((entry) => codeownersHandle(org, entry.owner)).join(" ")}`)
    }
  }
  return `${lines.join("\n")}\n`
}

/**
 * Renders the `OWNERS` tree: one file per package that declares ownership,
 * plus the root when the workspace declares defaults. Format, per line:
 * `set noparent`, one owner per line (`team:<name>` kept as written),
 * `per-file <glob> = <owner>, <owner>`, `agents: <policy>` for the default
 * and `agents: <policy> <glob>` per override, and `reviewers: <owners>
 * # upstream-of //pkg` for upstream review claims; approve claims add the
 * claimant's owners as plain owner lines with the same trailing comment.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderOwnersTree = (
  index: PackageIndex,
  file: string = "OWNERS"
): ReadonlyArray<{ readonly path: string; readonly content: string }> => {
  const files: Array<{ readonly path: string; readonly content: string }> = []
  const claims = claimants(index).map((claimant) => ({
    ...claimant,
    upstream: new Set(upstreamPackages(index, claimant.packagePath)),
    owners: packageOwners(index, claimant.packagePath).map((entry) => entry.owner)
  }))
  for (const packagePath of index.packages()) {
    const declaration = index.ownersOf(packagePath)
    const workspaceDefaults = packagePath === "" && declaration === undefined ? index.workspace.owners : undefined
    const effective = declaration ?? workspaceDefaults
    const upstream: Array<
      { readonly label: string; readonly mode: "review" | "approve"; readonly owners: ReadonlyArray<Owners.Owner> }
    > = []
    for (const claimant of claims) {
      if (claimant.packagePath === packagePath) continue
      if (!claimant.upstream.has(packagePath)) continue
      if (!claimCovers(claimant.claim, packagePath)) continue
      const owners = claimant.owners
      if (owners.length > 0) {
        upstream.push({ label: packageLabel(claimant.packagePath), mode: claimant.claim.mode, owners })
      }
    }
    if (effective === undefined && upstream.length === 0) continue
    const lines: Array<string> = [
      `# Generated by smithers-build from ${packagePath === "" ? "" : `${packagePath}/`}PACKAGE.ts owners. Do not edit.`
    ]
    if (effective !== undefined) {
      if (effective.noparent) lines.push("set noparent")
      for (const owner of effective.owners) lines.push(owner)
      for (const rule of effective.perFile) lines.push(`per-file ${rule.pattern} = ${rule.owners.join(", ")}`)
      if (effective.agents !== undefined) {
        lines.push(`agents: ${effective.agents.default}`)
        for (const override of effective.agents.overrides) lines.push(`agents: ${override.policy} ${override.pattern}`)
      }
    }
    for (const claim of upstream) {
      if (claim.mode === "approve") {
        for (const owner of claim.owners) lines.push(`${owner}  # upstream-of ${claim.label}`)
      } else {
        lines.push(`reviewers: ${claim.owners.join(", ")}  # upstream-of ${claim.label}`)
      }
    }
    files.push({ path: packagePath === "" ? file : `${packagePath}/${file}`, content: `${lines.join("\n")}\n` })
  }
  return files
}
