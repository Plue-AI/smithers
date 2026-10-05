/** Shared flow command grammar and quoted proposals (spec §11.5.1). */
import { z } from "zod"
import type { AgentCommand } from "./AgentCommands.ts"
import type { Card } from "./Cards.ts"
import { packagedTodoSource } from "./PackagedTodoSource.ts"
export { packagedTodoSource }
export const FLOW_COMMAND = { name: "flow", summary: "Show a flow's steps and versions", args: "<name>", agent: "run" } as const satisfies AgentCommand
export const FLOW_EDIT_COMMAND = { name: "flow.edit", summary: "Propose a change to a flow", args: "<name> <request> [JSON: source]", agent: "confirm" } as const satisfies AgentCommand
export const flowEditPrompt = (name: string, request: string): string =>
  `Change flows/${name}/flow.ts: ${request}; start from the built-in composition when no override exists`
export const FlowInputSchema = z.strictObject({ name: z.string().regex(/^[a-z0-9_-]+(?:[./][a-z0-9_-]+)*$/) })
export const FlowEditInputSchema = FlowInputSchema.extend({ request: z.string().min(1).max(4096), source: z.string().max(16384).optional() })
export const parseFlowArgs = (args: string | undefined): { payload: Record<string, unknown> } | { error: string } => {
  const line = (args ?? "").trim()
  if (line.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(line)
      return value !== null && typeof value === "object" && !Array.isArray(value) ? { payload: value as Record<string, unknown> } : { error: "Invalid flow input" }
    } catch { return { error: "Invalid flow input" } }
  }
  const [name, ...request] = line.split(/\s+/)
  return { payload: { ...(name ? { name } : {}), ...(request.length ? { request: request.join(" ") } : {}) } }
}
/** One minimal contiguous hunk, computed from packaged bytes; no repository code runs here. */
export const flowProposalDiff = (name: string, source: string): string => {
  if (name !== "todo") throw new Error("The packaged source for this flow is unavailable")
  if (new TextEncoder().encode(source).length > 16384 || !source.endsWith("\n")) throw new Error("Proposed source must end with a newline and fit in 16 KiB")
  if (source === packagedTodoSource) throw new Error("The proposed source has no changes")
  const old = packagedTodoSource.slice(0, -1).split("\n"), next = source.slice(0, -1).split("\n")
  let start = 0, suffix = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start++
  while (suffix < old.length - start && suffix < next.length - start && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  const removed = old.slice(start, old.length - suffix), added = next.slice(start, next.length - suffix)
  return `--- a/flows/${name}/flow.ts\n+++ b/flows/${name}/flow.ts\n@@ -${removed.length ? start + 1 : start},${removed.length} +${added.length ? start + 1 : start},${added.length} @@\n` +
    removed.map(line => `-${line}\n`).join("") + added.map(line => `+${line}\n`).join("")
}
export const flowCard = (name: string, ordinal: number, createdAt: number): Extract<Card, { kind: "flow" }> => ({
  id: `flow:${name}`, kind: "flow", title: name === "todo" ? "TODO flow" : `${name} flow`, status: "active", ordinal, createdAt, payload: { name }
})
