/** Reviewed literal policy. Never infer permissions from a shipped implementation. */
import appendixB from "../apps/app/src/mainview/flows/fixtures/AppendixBPolicy.json"
import appendixC from "../apps/app/src/mainview/flows/fixtures/AppendixC.json"
import cli from "../packages/smithers/test/CatalogCli.fixture.json"

export type Violation = { readonly id: string; readonly reason: "unlisted" | "cut" | "renamed" | "replaced" | "runtime" }
const match = (id: string, pattern: string): boolean => {
  // The only Appendix B wildcard is a terminal prefix expansion.
  return pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern
}

export const auditAppIds = (ids: ReadonlyArray<string>): Violation[] => ids.flatMap<Violation>(id => {
  // Appendix A owns the replacement names, including reused old pane names.
  if (appendixB.publicIds.includes(id)) return []
  const rows = appendixB.rows.filter(row => row.ids.some(pattern => match(id, pattern)))
  if (rows.some(row => row.status === "cut")) return [{ id, reason: "cut" as const }]
  if (rows.some(row => row.status === "rename")) return [{ id, reason: "renamed" as const }]
  return rows.length === 0 ? [{ id, reason: "unlisted" as const }] : []
})

export const auditCliPaths = (paths: ReadonlyArray<string>): Violation[] => {
  const allowed = new Set([...cli.commands.map(row => row.path), ...cli.b6])
  return paths.filter(path => !allowed.has(path)).map(id => ({ id, reason: "unlisted" }))
}

export type RuntimeTag = { readonly id: string; readonly runtime: "install" | "machine"; readonly kind?: string; readonly source?: string }
/**
 * Tags are obtained from the built registry by its caller, never by importing
 * repository code here. Parameterized actions are matched by their literal
 * Appendix C templates; they cannot introduce a new fixed tag.
 */
const tagMatch = (id: string, template: string): boolean => {
  const pieces = template.split(/(<[^>]+>)/)
  const pattern = pieces.map(piece => piece.startsWith("<") ? "[^/]+" : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")
  return new RegExp(`^${pattern}$`).test(id)
}
export const auditRuntimeTags = (tags: ReadonlyArray<RuntimeTag>): Violation[] => tags.flatMap<Violation>(({ id, runtime, kind = "flow", source }) => {
  const rows = appendixC.rows.filter(row => row.kind === kind && (row.id.includes("<") ? source === row.source.split(":")[0] && tagMatch(id, row.id) : id === row.id))
  if (rows.length === 0) return [{ id, reason: "unlisted" as const }]
  if (rows.some(row => row.status === "cut")) return [{ id, reason: "cut" as const }]
  if (rows.some(row => row.status === "replaced") && !(id in appendixC.engineeringOverrides)) return [{ id, reason: "replaced" as const }]
  return rows.some(row => row.runtime === runtime) ? [] : [{ id, reason: "runtime" as const }]
})

export const assertCatalogPolicy = (violations: ReadonlyArray<Violation>): void => {
  if (violations.length > 0) throw new Error(violations.map(row => `${row.reason}: ${row.id}`).join("\n"))
}
