import { refusalOf } from "@smthrs/rpc/Refusal"
import type { CommandResult } from "../../flows/entries/Declare"
import type { SeamContext } from "./SeamContext"

export type BranchControl = "sleep" | "wake" | "rebase" | "add-to-stack" | "return-to-item" | "keep-moved"
export interface BranchControlOptions {
  /** Each owning provider supplies its production activation receipt independently. */
  readonly ready: (operation: BranchControl) => boolean
}
export interface BranchControls {
  readonly available: (operation: BranchControl) => boolean
  readonly request: (operation: BranchControl, branch: string, input?: { text?: string }) => Promise<CommandResult>
}

/** Spec §6.3 branch commands, with no cloud or host execution fallback. */
export function createBranchControlsSeam(ctx: SeamContext, options: BranchControlOptions): BranchControls {
  const available = (operation: BranchControl) => !ctx.isDisposed?.() && options.ready(operation)
  return { available, request: async (operation, branch, input = {}) => {
    if (!available(operation)) return "Branch unavailable"
    if (!branch.trim() || /[\u0000\\]/.test(branch)) return "Choose a branch"
    try {
      // Moved-off controls carry a TODO number; resolve its current branch before writing.
      if (/^T[1-9][0-9]*$/.test(branch)) {
        const response = await ctx.http(`${ctx.baseUrl}/api/todos/${branch.slice(1)}`, { credentials: "same-origin" })
        const body = await response.json() as { branch?: { name?: unknown }; message?: string }
        if (!response.ok || typeof body.branch?.name !== "string") return body.message ?? "Branch unavailable"
        branch = body.branch.name
      }
      if (!available(operation)) return "Branch unavailable"
      const response = await ctx.http(`${ctx.baseUrl}/api/branches/${encodeURIComponent(branch)}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ op: operation, ...input })
      })
      const body = await response.json() as { message?: string; state?: string }
      if (!response.ok) return { refusal: refusalOf({ body, status: response.status, message: body.message ?? "Branch unavailable" }) }
      // Transport acknowledgment is not execution completion; activation waits for the owning provider.
      return response.status === 202 ? { value: "Requested" } : undefined
    } catch { return "Branch unavailable" }
  } }
}
