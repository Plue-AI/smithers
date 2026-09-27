/**
 * Target query result models and rendering.
 *
 * @since 0.1.0
 */

import type * as Target from "@smthrs/targets/Target"
import * as Ansi from "./Ansi.ts"
import type * as Planner from "./Planner.ts"

/**
 * Result of a bare label or pattern query.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Listing {
  readonly query: string
  readonly targets: ReadonlyArray<{
    readonly label: string
    readonly target: string
    readonly kinds: ReadonlyArray<Target.Kind>
    /** The declaration's one-line summary ({@link Target.Presentation}), when it carries one. */
    readonly summary?: string | undefined
    /** Present and true when the declaration marks the target featured. */
    readonly featured?: boolean | undefined
    /**
     * Why a `Repo.Target` row resolved to nothing, when it did.
     */
    readonly refusal?: string | undefined
  }>
}

/**
 * Result of a `deps(label)` query.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Dependencies {
  readonly query: string
  readonly root: string
  readonly dependencies: ReadonlyArray<string>
  readonly edges: ReadonlyArray<Planner.Edge>
}

/**
 * Result of an `rdeps(label)` query: every labeled target that depends on
 * the root, transitively.
 *
 * @category models
 * @since 0.1.0
 */
export interface Dependents {
  readonly query: string
  readonly root: string
  readonly dependents: ReadonlyArray<string>
}

/**
 * Result of an `owners(label)` query: the owners of the package holding the
 * label, with reasons, plus the packages it depends on.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageOwners {
  readonly query: string
  readonly package: string
  readonly owners: ReadonlyArray<
    { readonly owner: string; readonly role: string; readonly reasons: ReadonlyArray<string> }
  >
  readonly agentPolicy: string
  readonly upstream: ReadonlyArray<string>
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
 * Renders a query result for a person: a listing as aligned `LABEL TARGET
 * KINDS` columns, and `deps(label)` as the root followed by what it depends
 * on. With the default palette the text carries no escape sequences.
 *
 * @category formatting
 * @since 0.1.0
 */
export const text = (
  result: Listing | Dependencies | Dependents | PackageOwners,
  style: Ansi.Palette = Ansi.none
): string => {
  if ("dependents" in result) {
    const count = result.dependents.length
    const head = `${style.bold(result.root)} ${
      style.dim(`is depended on by ${count} ${count === 1 ? "target" : "targets"}`)
    }`
    return [head, ...result.dependents.map((label) => `  ${label}`)].join("\n")
  }
  if ("owners" in result) {
    const head = `${style.bold(result.package)} ${style.dim(`agents: ${result.agentPolicy}`)}`
    const owners = result.owners.length === 0
      ? [`  ${style.dim("no owners")}`]
      : result.owners.map((entry) =>
        `  ${entry.owner.padEnd(24)}  ${entry.role}  ${style.dim(entry.reasons.join(", "))}`
      )
    const upstream = result.upstream.length === 0
      ? []
      : [style.dim(`depends on ${result.upstream.join(" ")}`)]
    return [head, ...owners, ...upstream].join("\n")
  }
  if ("root" in result) {
    const count = result.dependencies.length
    const head = `${style.bold(result.root)} ${style.dim(`depends on ${count} ${count === 1 ? "target" : "targets"}`)}`
    return [head, ...result.dependencies.map((label) => `  ${label}`)].join("\n")
  }
  if (result.targets.length === 0) return style.dim(`no targets match ${result.query}`)
  const labelWidth = Math.max("LABEL".length, ...result.targets.map((row) => row.label.length))
  const targetWidth = Math.max("TARGET".length, ...result.targets.map((row) => row.target.length))
  const header = style.dim(`${"LABEL".padEnd(labelWidth)}  ${"TARGET".padEnd(targetWidth)}  KINDS`)
  const rows = result.targets.map((row) => {
    const kinds = row.kinds.map((name) => kind(name, style)).join(" ")
    const line = `${row.label.padEnd(labelWidth)}  ${style.dim(row.target.padEnd(targetWidth))}  ${kinds}`
    return row.refusal === undefined ? line : `${line}  ${style.dim(`(refused: ${row.refusal})`)}`
  })
  return [header, ...rows].join("\n")
}
