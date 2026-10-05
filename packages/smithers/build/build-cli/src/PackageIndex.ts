/**
 * The immutable label / target / owner index over one loaded package graph.
 *
 * Labels are a pure function of admitted PACKAGE.ts path plus explicit map
 * key — nothing else creates identity. One target value answers to one
 * label (`Alias` is the sanctioned second name because it is a distinct
 * target). Omission from a map is privacy: an unlisted target has no label
 * and is unreachable from query, completion, and patterns, while the owner
 * binding still records which package's public closure reaches it.
 *
 * @since 0.1.0
 */

import * as Owners from "@smthrs/targets/Owners"
import * as PackageValue from "@smthrs/targets/Package"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import type { LoadedFactory } from "./FactoryLoader.ts"
import { collectTargets } from "./internal/Attrs.ts"
import * as Path from "./internal/Path.ts"
import { byCodeUnit, posix } from "./internal/Text.ts"
import * as Label from "./Label.ts"
import { PackageError } from "./PackageError.ts"
import type { LoadedGraph } from "./PackageLoader.ts"

/**
 * One labeled target row.
 *
 * @category models
 * @since 0.1.0
 */
export interface IndexedTarget {
  readonly label: string
  readonly packagePath: string
  readonly key: string
  readonly target: Target.AnyTarget
}

/**
 * One classified dependency edge between labeled targets.
 *
 * There are exactly three edge kinds. Targets reached outside explicit
 * `gates` and `services` attrs are ordinary data dependencies.
 *
 * @category models
 * @since 0.1.0
 */
export interface Edge {
  readonly from: string
  readonly to: string
  readonly kind: "data" | "gates" | "services"
}

/** Collects every tagged reference record inside one attr value. */
const collectReferences = (
  value: unknown,
  into: Array<{ readonly tag: string; readonly name: string }>,
  seen: Set<object>
): void => {
  if (typeof value !== "object" || value === null || seen.has(value) || Target.isTarget(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, into, seen)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  const tag = (value as { readonly _tag?: unknown })._tag
  const name = (value as { readonly name?: unknown }).name
  if ((tag === "AgentRef" || tag === "FlagRef" || tag === "HostBin") && typeof name === "string") {
    into.push({ tag, name })
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && "value" in descriptor) collectReferences(descriptor.value, into, seen)
  }
}

/** Rules that may never be reachable through a `data` edge. */
const illegalDataRules: ReadonlySet<string> = new Set([
  "Shell.Run",
  "Shell.Serve",
  "Anvil.Fork",
  "Docker.Serve",
  "Docker.Service",
  "Docker.Push",
  "CloudRun.Preview"
])

/**
 * Enforces the data-edge law: `data` means materialize producer files, so a
 * Run or Serve target reachable through a `data` attr — directly or through
 * any dependency chain entered there — is a graph-load error, never a target
 * that quietly executes as a side effect of materialization.
 */
const assertLegalDataClosure = (row: IndexedTarget): void => {
  const attrs = Target.metadata(row.target).attrs
  if (typeof attrs !== "object" || attrs === null) return
  const descriptor = Object.getOwnPropertyDescriptor(attrs, "data")
  if (descriptor === undefined || !("value" in descriptor)) return
  const entries = new Set<Target.AnyTarget>(collectTargets(descriptor.value))
  const seen = new Set<Target.AnyTarget>()
  const stack = [...entries]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    const metadata = Target.metadata(current)
    if (illegalDataRules.has(metadata.target)) {
      throw new PackageError(
        "illegal_data_target",
        `${row.label} reaches a ${metadata.target} target through its data attr; ` +
          "data means materialize producer files and may not execute Run or Serve targets",
        { label: row.label }
      )
    }
    for (const dependency of metadata.dependencies) stack.push(dependency)
  }
}

/**
 * The validated, immutable index of one loaded package graph.
 *
 * @category models
 * @since 0.1.0
 */
export class PackageIndex {
  readonly root: string
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
  /** The factory declared in FACTORY.ts beside the workspace, when one exists. */
  readonly factory: LoadedFactory | undefined
  /** The cwd's package path, or undefined when cwd is outside the workspace. */
  readonly currentPackage: string | undefined
  private readonly rows: ReadonlyArray<IndexedTarget>
  private readonly byLabel: ReadonlyMap<string, IndexedTarget>
  private readonly labelsByTarget: ReadonlyMap<Target.AnyTarget, string>
  private readonly owners: WeakMap<Target.AnyTarget, string>
  private readonly packagePaths: ReadonlySet<string>
  private readonly packageOwners: ReadonlyMap<string, Owners.Declaration>

  private constructor(
    root: string,
    workspace: WorkspaceDeclaration.WorkspaceDeclaration,
    factory: LoadedFactory | undefined,
    currentPackage: string | undefined,
    rows: ReadonlyArray<IndexedTarget>,
    byLabel: ReadonlyMap<string, IndexedTarget>,
    labelsByTarget: ReadonlyMap<Target.AnyTarget, string>,
    owners: WeakMap<Target.AnyTarget, string>,
    packagePaths: ReadonlySet<string>,
    packageOwners: ReadonlyMap<string, Owners.Declaration>
  ) {
    this.root = root
    this.workspace = workspace
    this.factory = factory
    this.currentPackage = currentPackage
    // The class documents itself as immutable and used to store, and hand
    // back, the caller's live array. `ReadonlyArray` is erased at runtime, so
    // that promise held for TypeScript consumers and for nothing else: a
    // mutated row would have left subtree resolution and edge computation
    // reading one set of rows while exact resolution still consulted the
    // separately built `byLabel` map.
    for (const row of rows) Object.freeze(row)
    this.rows = Object.freeze(rows)
    this.byLabel = byLabel
    this.labelsByTarget = labelsByTarget
    this.owners = owners
    this.packagePaths = packagePaths
    this.packageOwners = packageOwners
  }

  /**
   * Builds and validates the index from one loaded graph.
   *
   * @category constructors
   * @since 0.1.0
   */
  static make(graph: LoadedGraph, cwd: string = graph.root): PackageIndex {
    const rows: Array<IndexedTarget> = []
    const byLabel = new Map<string, IndexedTarget>()
    const folded = new Map<string, string>()
    const labelsByTarget = new Map<Target.AnyTarget, string>()
    const packagePaths = new Set<string>()
    const packageOwners = new Map<string, Owners.Declaration>()
    const sortedPackages = [...graph.packages].sort((left, right) => byCodeUnit(left.file, right.file))
    for (const loaded of sortedPackages) {
      if (packagePaths.has(loaded.packagePath)) {
        throw new PackageError("duplicate_package_path", "two Package modules resolve to one package directory", {
          path: loaded.file
        })
      }
      packagePaths.add(loaded.packagePath)
      const metadata = PackageValue.metadata(loaded.value)
      if (metadata.owners !== undefined) packageOwners.set(loaded.packagePath, metadata.owners)
      for (const key of metadata.keys) {
        if (!PackageValue.targetKeyPattern.test(key)) {
          throw new PackageError("invalid_target_key", `Package key fails the target grammar: ${JSON.stringify(key)}`, {
            path: loaded.file
          })
        }
        const target = (loaded.value as Record<string, unknown>)[key]
        if (!Target.isTarget(target)) {
          throw new PackageError("invalid_target_value", `Package key ${JSON.stringify(key)} does not hold a target`, {
            path: loaded.file
          })
        }
        const label = Label.format(loaded.packagePath, key)
        const existingLabel = labelsByTarget.get(target)
        if (existingLabel !== undefined) {
          throw new PackageError(
            "target_multiple_labels",
            `one target value is listed under both ${existingLabel} and ${label}; use S.Alias for a second name`,
            { path: loaded.file, label }
          )
        }
        const foldedKey = label.toLowerCase()
        const collision = folded.get(foldedKey)
        if (collision !== undefined) {
          throw new PackageError("case_collision", `two labels collide case-insensitively: ${collision} and ${label}`, {
            path: loaded.file,
            label
          })
        }
        if (byLabel.has(label)) {
          throw new PackageError("duplicate_label", `two targets carry one label: ${label}`, {
            path: loaded.file,
            label
          })
        }
        const row: IndexedTarget = { label, packagePath: loaded.packagePath, key, target }
        rows.push(row)
        byLabel.set(label, row)
        folded.set(foldedKey, label)
        labelsByTarget.set(target, label)
      }
    }
    // Phantom-instance guard: a target whose declaring file is a case
    // variant of a discovered PACKAGE.ts was constructed by a second module
    // instance of the same physical file — a case-mismatched import that
    // slipped past the static scan (for example through a computed
    // specifier). One physical declaration must yield one set of target
    // identities, so this is fatal.
    const declarationFiles = new Map<string, string>()
    for (const loaded of sortedPackages) declarationFiles.set(loaded.file.toLowerCase(), loaded.file)
    const instanceChecked = new Set<Target.AnyTarget>()
    const checkInstance = (target: Target.AnyTarget): void => {
      if (instanceChecked.has(target)) return
      instanceChecked.add(target)
      const source = Target.metadata(target).sourceFile
      if (source === undefined) return
      const relative = Path.containedRelative(graph.root, source)
      if (relative === undefined || relative === "") return
      const posixRelative = posix(relative)
      const exact = declarationFiles.get(posixRelative.toLowerCase())
      if (exact !== undefined && exact !== posixRelative) {
        throw new PackageError(
          "case_collision",
          `a target was declared by ${posixRelative}, a case variant of the discovered ${exact}; ` +
            "a case-mismatched import evaluated a second instance of the module",
          { path: exact }
        )
      }
    }
    // Owner binding: every listed target's dependency closure binds unowned
    // locals to the listing package; a target reached through an imported
    // Package keeps the owner its own listing assigned. An unlisted local
    // reachable from two packages has two working-directory meanings and is
    // fatal.
    const owners = new WeakMap<Target.AnyTarget, string>()
    for (const row of rows) owners.set(row.target, row.packagePath)
    for (const row of rows) {
      checkInstance(row.target)
      const stack: Array<Target.AnyTarget> = [row.target]
      const seen = new Set<Target.AnyTarget>()
      while (stack.length > 0) {
        const current = stack.pop()!
        if (seen.has(current)) continue
        seen.add(current)
        for (const dependency of Target.metadata(current).dependencies) {
          checkInstance(dependency)
          if (labelsByTarget.has(dependency)) continue
          const owner = owners.get(dependency)
          if (owner === undefined) {
            owners.set(dependency, row.packagePath)
          } else if (owner !== row.packagePath) {
            throw new PackageError(
              "private_owner_conflict",
              `an unlisted target of rule ${
                Target.metadata(dependency).target
              } is reachable from //${owner} and //${row.packagePath}; list it in one Package map`,
              { label: row.label }
            )
          }
          stack.push(dependency)
        }
      }
    }
    // Reference resolution: every S.Agents.<name> / S.Flags.<name> reference
    // reachable from an indexed target must name a declared workspace agent
    // or flag; an unknown name is a graph-load error.
    const agents = WorkspaceDeclaration.agentNames(graph.workspace)
    const flags = WorkspaceDeclaration.flagNames(graph.workspace)
    const hostBins = new Set(graph.workspace.host === undefined ? [] : graph.workspace.host.bins)
    const visited = new Set<Target.AnyTarget>()
    const validateReferences = (target: Target.AnyTarget, label: string): void => {
      if (visited.has(target)) return
      visited.add(target)
      const references: Array<{ readonly tag: string; readonly name: string }> = []
      collectReferences(Target.metadata(target).attrs, references, new Set())
      for (const reference of references) {
        if (reference.tag === "AgentRef" && !agents.has(reference.name)) {
          throw new PackageError("unknown_agent", `S.Agents.${reference.name} names no declared workspace agent`, {
            label
          })
        }
        if (reference.tag === "FlagRef" && !flags.has(reference.name)) {
          throw new PackageError("unknown_flag", `S.Flags.${reference.name} names no declared workspace flag`, {
            label
          })
        }
        if (reference.tag === "HostBin" && !hostBins.has(reference.name)) {
          throw new PackageError(
            "undeclared_host_bin",
            `S.Host.bin(${
              JSON.stringify(reference.name)
            }) names no binary in the workspace S.Host({ bins }) declaration`,
            { label }
          )
        }
      }
      for (const dependency of Target.metadata(target).dependencies) validateReferences(dependency, label)
    }
    for (const row of rows) {
      validateReferences(row.target, row.label)
      assertLegalDataClosure(row)
    }
    // Owner reference resolution: every team:<name> an owners declaration
    // names must be on the workspace roster; an unknown team is a graph-load
    // error, the same way an unknown agent or flag is.
    const teams = WorkspaceDeclaration.teamNames(graph.workspace)
    const checkTeams = (declaration: Owners.Declaration, where: string): void => {
      for (const team of Owners.teamReferences(declaration)) {
        if (!teams.has(team)) {
          throw new PackageError(
            "unknown_team",
            `owners of ${where} name team:${team}, which the workspace S.Teams roster does not declare`,
            {
              path: where
            }
          )
        }
      }
    }
    if (graph.workspace.owners !== undefined) checkTeams(graph.workspace.owners, "the workspace")
    for (const [packagePath, declaration] of packageOwners) checkTeams(declaration, `//${packagePath}`)
    rows.sort((left, right) => byCodeUnit(left.label, right.label))
    return new PackageIndex(
      graph.root,
      graph.workspace,
      graph.factory,
      Label.currentPackageOrUndefined(graph.root, cwd),
      rows,
      byLabel,
      labelsByTarget,
      owners,
      packagePaths,
      packageOwners
    )
  }

  /**
   * Every labeled row, sorted by label.
   *
   * @category querying
   * @since 0.1.0
   */
  targets(): ReadonlyArray<IndexedTarget> {
    return this.rows
  }

  /**
   * The label of one indexed target, or undefined for a private local.
   *
   * @category querying
   * @since 0.1.0
   */
  labelOf(target: Target.AnyTarget): string | undefined {
    return this.labelsByTarget.get(target)
  }

  /**
   * The package that owns one target: its listing package, or — for a
   * private local — the package whose public closure reaches it.
   *
   * @category querying
   * @since 0.1.0
   */
  ownerOf(target: Target.AnyTarget): string | undefined {
    return this.owners.get(target)
  }

  /**
   * Every discovered package path, sorted, `""` for the root.
   *
   * @category querying
   * @since 0.1.0
   */
  packages(): ReadonlyArray<string> {
    return [...this.packagePaths].sort(byCodeUnit)
  }

  /**
   * Whether a package exists at exactly this path.
   *
   * @category querying
   * @since 0.1.0
   */
  hasPackage(packagePath: string): boolean {
    return this.packagePaths.has(packagePath)
  }

  /**
   * The ownership declaration one package carries, or undefined when it
   * declares none and inherits.
   *
   * @category querying
   * @since 0.1.0
   */
  ownersOf(packagePath: string): Owners.Declaration | undefined {
    return this.packageOwners.get(packagePath)
  }

  /**
   * Resolves one label or subtree pattern to indexed rows.
   *
   * A bare package label resolves only an explicit `default` key.
   *
   * @category querying
   * @since 0.1.0
   */
  resolve(patternText: string): ReadonlyArray<IndexedTarget> {
    if (patternText.startsWith(":") && this.currentPackage === undefined) {
      throw new PackageError(
        "unknown_label",
        "a relative label resolves against the current package, and the current directory is outside the workspace; use an absolute //package:name label",
        { label: patternText }
      )
    }
    const pattern = Label.parse(patternText, this.currentPackage ?? "")
    if (pattern._tag === "Subtree") {
      const prefix = pattern.packagePath === "" ? "" : `${pattern.packagePath}/`
      const inSubtree = this.rows.filter((row) =>
        row.packagePath === pattern.packagePath || row.packagePath.startsWith(prefix)
      )
      if (pattern.target === undefined) return inSubtree
      // A named recursive pattern selects the packages that opted in by
      // declaring the key. An empty result is a typo rather than an empty
      // matrix: a bare subtree can legitimately select nothing, but a caller
      // who named a target meant to run something.
      const named = inSubtree.filter((row) => row.key === pattern.target)
      if (named.length === 0) {
        throw new PackageError(
          "unknown_label",
          `no target named ${pattern.target} under //${pattern.packagePath}/...`,
          { label: patternText }
        )
      }
      return named
    }
    if (pattern.target === undefined) {
      if (!this.packagePaths.has(pattern.packagePath)) {
        throw new PackageError("unknown_label", `no package at //${pattern.packagePath}`, { label: patternText })
      }
      const row = this.byLabel.get(Label.format(pattern.packagePath, "default"))
      if (row === undefined) {
        throw new PackageError(
          "no_default_target",
          `package //${pattern.packagePath} declares no default key; name a target explicitly`,
          { label: patternText }
        )
      }
      return [row]
    }
    const row = this.byLabel.get(Label.format(pattern.packagePath, pattern.target))
    if (row === undefined) {
      throw new PackageError(
        "unknown_label",
        `target not found: ${Label.format(pattern.packagePath, pattern.target)}`,
        {
          label: patternText
        }
      )
    }
    return [row]
  }

  /**
   * The classified edges among labeled targets selected by a pattern,
   * including edges reached through private locals.
   *
   * @category querying
   * @since 0.1.0
   */
  edges(selected: ReadonlyArray<IndexedTarget>): ReadonlyArray<Edge> {
    const found: Array<Edge> = []
    const emitted = new Set<string>()
    for (const row of selected) {
      const attrs = Target.metadata(row.target).attrs
      const buckets: Record<"data" | "gates" | "services", Set<Target.AnyTarget>> = {
        data: new Set(),
        gates: new Set(),
        services: new Set()
      }
      if (typeof attrs === "object" && attrs !== null) {
        for (const kind of ["data", "gates", "services"] as const) {
          const descriptor = Object.getOwnPropertyDescriptor(attrs, kind)
          if (descriptor !== undefined && "value" in descriptor) {
            for (const found of collectTargets(descriptor.value)) buckets[kind].add(found)
          }
        }
      }
      // The buckets hold only the targets that appear directly inside the
      // row's own attr values, so a labeled dependency reached through
      // nested private locals inherits the classification of the private
      // chain's entry point: whatever attr the chain entered through is the
      // declared kind of everything it reaches. The visited map bounds the
      // traversal over shared private DAGs, keyed per resolved kind because
      // one private target can be entered through two attr positions.
      const visited = new Map<Target.AnyTarget, Set<Edge["kind"]>>()
      const emit = (dependency: Target.AnyTarget, inherited: Edge["kind"]): void => {
        const kind = buckets.services.has(dependency)
          ? "services"
          : buckets.gates.has(dependency)
          ? "gates"
          : buckets.data.has(dependency)
          ? "data"
          : inherited
        const kinds = visited.get(dependency)
        if (kinds !== undefined && kinds.has(kind)) return
        if (kinds === undefined) visited.set(dependency, new Set([kind]))
        else kinds.add(kind)
        const to = this.labelsByTarget.get(dependency)
        if (to === undefined) {
          // A private local: surface its own labeled dependencies so the
          // graph stays connected across omitted helpers.
          for (const next of Target.metadata(dependency).dependencies) emit(next, kind)
          return
        }
        const line = `${row.label}\0${to}\0${kind}`
        if (emitted.has(line)) return
        emitted.add(line)
        found.push({ from: row.label, to, kind })
      }
      for (const dependency of Target.metadata(row.target).dependencies) emit(dependency, "data")
    }
    return found.sort((left, right) =>
      byCodeUnit(`${left.from}\0${left.to}\0${left.kind}`, `${right.from}\0${right.to}\0${right.kind}`)
    )
  }
}
