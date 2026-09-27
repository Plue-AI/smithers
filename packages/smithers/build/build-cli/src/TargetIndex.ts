/**
 * The declaration-derived target index: one row per labeled target, built from
 * PACKAGE.ts metadata alone.
 *
 * `smithers-build index` emits it, and the root `//:targetIndex` target
 * (`@smthrs/targets/TargetIndex`) commits it as `.smithers/target-index.json`,
 * the file smithers.sh reads from the public mirror to show targets beside
 * files. A row carries only what a declaration states: the rule, the kinds,
 * the summary, the declared inputs and outputs, the labeled dependencies, the
 * declared hosts, and the declaring file. It carries no cache key, no
 * content digest, no line number, and no host fact, so the committed file
 * changes only when a declaration changes.
 *
 * @since 0.1.0
 */
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import type * as TargetIndexRule from "@smthrs/targets/TargetIndex"
import * as Ansi from "./Ansi.ts"
import { inputPackage } from "./internal/InputPackage.ts"
import * as Path from "./internal/Path.ts"
import { byCodeUnit, posix } from "./internal/Text.ts"
import type * as PackageIndex from "./PackageIndex.ts"
import * as RepoResolution from "./RepoResolution.ts"

/**
 * One labeled target as its declaration states it: the row shape the
 * `TargetIndex` rule checks in, so what `index` prints and what the file
 * carries are one type.
 *
 * @category models
 * @since 0.1.0
 */
export type Row = TargetIndexRule.Row

/**
 * The index for one pattern: rows sorted by label.
 *
 * @category models
 * @since 0.1.0
 */
export interface Listing {
  readonly pattern: string
  readonly targets: ReadonlyArray<Row>
}

const attrMember = (attrs: unknown, key: string): unknown =>
  typeof attrs === "object" && attrs !== null ? (attrs as Record<string, unknown>)[key] : undefined

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

/**
 * The workspace-relative paths a target writes.
 *
 * A rule that registers declared outputs (`TsBuild`, `FactoryProjection`)
 * answers from its metadata. The generator rules keep their write set in
 * attrs instead, exactly where the package planner reads it when it confines
 * the spawn: `changes` and `emit` on `Generate`, `output` on `Docs.Page` and
 * `GithubCiGen`, and `homeOutput` on `FactoryProjection` in check mode. Reading
 * the same attrs here keeps the index honest about which file a target owns
 * without changing what any executor verifies.
 */
const outputsOf = (packagePath: string, metadata: Target.Metadata): ReadonlyArray<string> => {
  const found = new Set<string>()
  const declared = metadata.outputs
  if (declared !== undefined) {
    for (const path of declared.paths) found.add(Input.resolvePath(declared.cwd === "." ? "" : declared.cwd, path))
  }
  const attrs = metadata.attrs
  for (const change of strings(attrMember(attrs, "changes"))) found.add(Input.resolvePath(packagePath, change))
  const emit = attrMember(attrs, "emit")
  if (typeof emit === "object" && emit !== null) {
    for (const path of Object.keys(emit)) found.add(Input.resolvePath(packagePath, path))
  }
  for (const key of ["stdout", "output", "homeOutput"]) {
    const value = attrMember(attrs, key)
    if (typeof value === "string" && value !== "") found.add(Input.resolvePath(packagePath, value))
  }
  return [...found].sort(byCodeUnit)
}

/**
 * One declared input as the row carries it: a `kind` record (never the
 * planner's tagged `Input.Declared`, which `Target.make` would lift into the
 * index target's own inputs) with its paths resolved from the declaring
 * package.
 */
const inputOf = (packagePath: string, declared: Input.Declared): TargetIndexRule.RowInput => {
  switch (declared._tag) {
    case "File":
      return { kind: "file", path: Input.resolvePath(packagePath, declared.path) }
    case "Glob":
      return {
        kind: "glob",
        pattern: Input.resolvePath(packagePath, declared.pattern),
        exclude: declared.exclude.map((entry) => Input.resolvePath(packagePath, entry))
      }
    case "PnpmWorkspace":
      return { kind: "pnpm-workspace", path: Input.resolvePath(packagePath, declared.path) }
    case "GitDiff":
      return {
        kind: "git-diff",
        base: declared.base,
        ...(declared.paths === undefined ? {} : { paths: declared.paths }),
        ...(declared.added === undefined ? {} : { added: declared.added }),
        ...(declared.addedLines === undefined ? {} : { addedLines: declared.addedLines })
      }
  }
}

const sourceOf = (root: string, metadata: Target.Metadata): { readonly file: string } | undefined => {
  if (metadata.sourceFile === undefined) return undefined
  const relative = Path.containedRelative(root, metadata.sourceFile)
  return relative === undefined || relative === "" ? undefined : { file: posix(relative) }
}

/**
 * Builds the index for every target a pattern selects.
 *
 * Nothing here plans or keys a target: the rows come from the loaded
 * declarations and the index's labeled edges, plus the repository resolution
 * a `Repo.Target` row needs to state its effective kinds or its refusal.
 * `environment` is the caller's host environment; a child repository query
 * sees it only after the workspace's cache credentials are withheld.
 *
 * @category querying
 * @since 0.1.0
 */
export const build = async (
  index: PackageIndex.PackageIndex,
  pattern: string,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal | undefined
): Promise<Listing> => {
  const rows = index.resolve(pattern)
  const dependencies = new Map<string, Set<string>>()
  for (const edge of index.edges(rows)) {
    const found = dependencies.get(edge.from) ?? new Set<string>()
    found.add(edge.to)
    dependencies.set(edge.from, found)
  }
  const resolver = RepoResolution.resolver(index, environment)
  const targets = await Promise.all(rows.map(async (row): Promise<Row> => {
    const metadata = Target.metadata(row.target)
    const resolution = metadata.target === "Repo.Target"
      ? await RepoResolution.resolve(resolver, row.target, signal)
      : undefined
    const mode = attrMember(metadata.attrs, "mode")
    const source = sourceOf(index.root, metadata)
    return {
      label: row.label,
      package: row.packagePath,
      name: row.label.slice(row.label.lastIndexOf(":") + 1),
      rule: metadata.target,
      kinds: await RepoResolution.effectiveKinds(resolver, row.target, signal),
      ...(metadata.summary === undefined ? {} : { summary: metadata.summary }),
      ...(metadata.featured ? { featured: true as const } : {}),
      ...(typeof mode === "string" ? { mode } : {}),
      cacheable: metadata.cacheable,
      inputs: metadata.inputs.map((declared) => inputOf(inputPackage(metadata, row.packagePath), declared)),
      outputs: outputsOf(row.packagePath, metadata),
      dependencies: [...(dependencies.get(row.label) ?? [])].sort(byCodeUnit),
      ...(metadata.hosts === undefined ? {} : { hosts: [...metadata.hosts] }),
      ...(source === undefined ? {} : { source }),
      ...(resolution?.refusal === undefined ? {} : { refusal: resolution.refusal })
    }
  }))
  return { pattern, targets: targets.sort((left, right) => byCodeUnit(left.label, right.label)) }
}

const kindColor: Record<string, keyof Ansi.Palette> = {
  build: "blue",
  test: "green",
  lint: "yellow",
  run: "magenta",
  docs: "cyan",
  review: "red"
}

const kind = (name: string, style: Ansi.Palette): string => {
  const color = kindColor[name]
  return color === undefined ? name : (style[color] as (text: string) => string)(name)
}

/**
 * Renders the index for a person: aligned `LABEL RULE KINDS` columns, the
 * outputs a row owns after an arrow, and a featured row marked with a star.
 * With the default palette the text carries no escape sequences.
 *
 * @category formatting
 * @since 0.1.0
 */
export const text = (listing: Listing, style: Ansi.Palette = Ansi.none): string => {
  if (listing.targets.length === 0) return style.dim(`no targets match ${listing.pattern}`)
  const labelWidth = Math.max("LABEL".length, ...listing.targets.map((row) => row.label.length))
  const ruleWidth = Math.max("RULE".length, ...listing.targets.map((row) => row.rule.length))
  const header = style.dim(`${"LABEL".padEnd(labelWidth)}  ${"RULE".padEnd(ruleWidth)}  KINDS`)
  const lines = listing.targets.map((row) => {
    const kinds = row.kinds.map((name) => kind(name, style)).join(" ")
    const star = row.featured ? ` ${style.bold("*")}` : ""
    const outputs = row.outputs.length === 0 ? "" : `  ${style.dim(`-> ${row.outputs.join(" ")}`)}`
    const refusal = row.refusal === undefined ? "" : `  ${style.dim(`(refused: ${row.refusal})`)}`
    return `${row.label.padEnd(labelWidth)}  ${
      style.dim(row.rule.padEnd(ruleWidth))
    }  ${kinds}${star}${outputs}${refusal}`
  })
  return [header, ...lines].join("\n")
}
