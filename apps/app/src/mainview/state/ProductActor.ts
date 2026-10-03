import { ActorSchema, MemberColorIndexSchema, PlaceholderAvatarUrl, ViaSchema, type Actor, type AgentKind, type PersonRef } from "@smthrs/rpc/CardPrimitives"

/** Historical stored notation (§2); RPC decoding remains owned by T-APP-19b. */
export type ProductActor =
  | { person: string; via?: string; session?: string }
  | { agent: string; run: string; todo?: number }
  | { system: string; requester?: string }
  | { github: string }
  | { outside: true }
export interface ActorMember extends PersonRef { id: string; color_index: number; removed?: boolean }
export interface ActorRun { id: string; owner?: string; agent?: AgentKind; avatar_url?: string }
export interface ActorSession { id: string; agent: AgentKind; name?: string; avatar_url?: string }
export interface ActorContext {
  roster?: readonly ActorMember[]
  runs?: readonly ActorRun[]
  sessions?: readonly ActorSession[]
}
const names: Record<AgentKind, string> = {
  smithers: "Smithers", coding: "Coding agent", reviewer: "Reviewer", "claude-code": "Claude Code", codex: "Codex", external: "Agent"
}
/** Labels for every consumer, with no comma before the acting-for member. */
export const actorName = (actor: Actor): string => {
  switch (actor.kind) {
    case "person": return actor.via === "terminal" ? `${actor.name}'s terminal`
      : actor.via ? `${actor.name} via ${actor.via.toUpperCase()}` : actor.name
    case "agent": return `${actor.name ?? names[actor.agent]}${actor.for_member ? ` for ${actor.for_member.name}` : ""}`
    case "system": return "Smithers"
    case "github": return `@${actor.login}`
    case "outside": return "changed outside Smithers"
  }
}
/** Recorded attribution only; request headers and credential authority never enter this adapter. */
export const toActor = (wire: ProductActor | Actor, roster: readonly ActorMember[] = [], runs: readonly ActorRun[] = [], sessions: readonly ActorSession[] = []): Actor => {
  if ("kind" in wire) return ActorSchema.parse(wire)
  const member = (id: string): ActorMember => {
    const found = roster.find(row => row.id === id || row.login === id)
    if (!found) throw new Error(`Actor member ${id} is missing from the roster`)
    return { ...found, name: found.removed ? found.login : found.name, color_index: MemberColorIndexSchema.parse(found.color_index) }
  }
  const personRef = (row: ActorMember): PersonRef => ({ login: row.login, name: row.name, avatar_url: row.avatar_url })
  if ("person" in wire) {
    const person = member(wire.person)
    const channel = ViaSchema.safeParse(wire.via)
    if (!wire.via || channel.success) return ActorSchema.parse({ kind: "person", ...personRef(person), color_index: person.color_index, via: channel.success ? channel.data : undefined })
    const session = sessions.find(row => row.id === wire.session)
    const agent: AgentKind = session?.agent ?? (Object.hasOwn(names, wire.via) ? wire.via as AgentKind : "external")
    return ActorSchema.parse({ kind: "agent", id: wire.session ? `agent-session-${wire.session}` : `agent-${wire.via}-${wire.person}`,
      agent, session_id: wire.session, name: session?.name ?? (agent === "external" ? wire.via : undefined),
      avatar_url: session?.avatar_url ?? PlaceholderAvatarUrl, for_member: personRef(person), color_index: person.color_index })
  }
  if ("agent" in wire) {
    const run = runs.find(row => row.id === wire.run)
    const owner = run?.owner ? member(run.owner) : undefined
    const agent: AgentKind = run?.agent ?? (Object.hasOwn(names, wire.agent) ? wire.agent as AgentKind : "external")
    return ActorSchema.parse({ kind: "agent", id: `agent-run-${wire.run}`, agent, run_id: wire.run, todo: wire.todo,
      name: agent === "external" ? wire.agent : undefined, avatar_url: run?.avatar_url ?? PlaceholderAvatarUrl,
      for_member: owner && personRef(owner), color_index: owner?.color_index ?? 6 })
  }
  if ("system" in wire) return { kind: "system", color_index: 7 }
  if ("github" in wire) return { kind: "github", login: wire.github, color_index: 7 }
  return { kind: "outside", color_index: 7 }
}
