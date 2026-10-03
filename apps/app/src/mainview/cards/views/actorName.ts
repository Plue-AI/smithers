import type { Actor } from "@smthrs/rpc/CardPrimitives"
const first = (name: string) => name.trim().split(/\s+/)[0]
const agentNames = { smithers: "Smithers", coding: "Coding agent", reviewer: "Reviewer", "claude-code": "Claude Code", codex: "Codex", external: "External agent" }
export function actorName(actor: Actor): string {
  switch (actor.kind) {
    case "person": return actor.via === "terminal" ? `${first(actor.name)}'s terminal`
      : `${first(actor.name)}${actor.via ? ` via ${actor.via.toUpperCase()}` : ""}`
    case "agent": return `${actor.name || agentNames[actor.agent]}${actor.for_member ? ` for ${first(actor.for_member.name)}` : ""}`
    case "github": return `@${actor.login}`
    case "outside": return "Changed outside Smithers"
    case "system": return "Install event"
  }
}
