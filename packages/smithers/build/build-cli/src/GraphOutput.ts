/**
 * Human-readable target graph renderers.
 *
 * Every renderer takes an optional palette. With the default, {@link Ansi.none},
 * the text is exactly what the structured `graph` field carries, so a
 * terminal and a pipe see the same tree and only the terminal sees colour.
 *
 * @since 0.1.0
 */

import * as Ansi from "./Ansi.ts"

/**
 * One build-system node as {@link packageText} lists it.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageRow {
  readonly label: string
  readonly target: string
  /** Why a `Repo.Target` row resolved to nothing, when it did. */
  readonly refusal?: string | undefined
}

/**
 * One build-system edge as {@link packageText} lists it.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageEdge {
  readonly from: string
  readonly to: string
  readonly kind: string
}

/**
 * Renders the build-system graph: every selected label, each followed by its
 * outgoing edges as `-kind-> label` lines.
 *
 * @category formatting
 * @since 0.1.0
 */
export const packageText = (
  rows: ReadonlyArray<PackageRow>,
  edges: ReadonlyArray<PackageEdge>,
  style: Ansi.Palette = Ansi.none
): string =>
  rows.map((row) => {
    const own = edges.filter((edge) => edge.from === row.label)
    const plain = row.target === "Filegroup" ? style.dim(row.label) : style.bold(row.label)
    // A refused repository row resolved to nothing. It used to survive only in
    // the JSON envelope, so the person reading the terminal saw a row that
    // looked as ordinary as every other one.
    const name = row.refusal === undefined ? plain : `${plain} ${style.dim(`(refused: ${row.refusal})`)}`
    return own.length === 0
      ? name
      : `${name}\n${own.map((edge) => `  ${style.dim(`-${edge.kind}->`)} ${edge.to}`).join("\n")}`
  }).join("\n")
const mermaidLabel = (label: string): string =>
  label.replaceAll("\"", "&quot;").replaceAll("\r", " ").replaceAll("\n", " ")

/**
 * Renders the build-system graph as Mermaid: one node per selected label and
 * one arrow per edge, labeled with the edge kind.
 *
 * The `graph --mermaid` flag used to be accepted and dropped in the build system,
 * which printed the text tree under a `format: "text"` envelope. Node ids are
 * hex-encoded labels, so no label text can reach the flowchart's grammar.
 *
 * @category formatting
 * @since 0.1.0
 */
export const packageMermaid = (
  rows: ReadonlyArray<PackageRow>,
  edges: ReadonlyArray<PackageEdge>
): string => {
  const lines = ["flowchart LR"]
  for (const row of rows) {
    const caption = row.refusal === undefined
      ? `${row.label}\\n${row.target}`
      : `${row.label}\\n${row.target}\\nrefused: ${row.refusal}`
    lines.push(`  ${mermaidId(row.label)}["${mermaidLabel(caption)}"]`)
  }
  for (const edge of edges) {
    lines.push(`  ${mermaidId(edge.from)} -->|${mermaidLabel(edge.kind)}| ${mermaidId(edge.to)}`)
  }
  return lines.join("\n")
}

const mermaidId = (label: string): string => `n_${Buffer.from(label).toString("hex")}`
