import { PlaceholderAvatarUrl } from "../../src/CardPrimitives.ts"

export const placeholder_avatar = PlaceholderAvatarUrl
export const at = "2026-10-02T17:42:00.000Z"
export const sha = "4bc79aef91d66ea28c90b706d584d3b9b48e14ea"
export const ben = {
  login: "ben",
  name: "Ben Carter",
  avatar_url: placeholder_avatar
}
export const will = {
  login: "williamcory",
  name: "Will Cory",
  avatar_url: placeholder_avatar
}
// Members' own colours (0–5). A participant acting for a member takes that member's colour; 6 is an agent or
// Smithers acting for nobody; 7 is neutral (GitHub users, outside writes and install events). M-34, spec §14.6a.1.
export const ben_color = 0
export const will_color = 1
export const person = { kind: "person" as const, ...ben, color_index: ben_color }
export const ssh_person = { ...person, via: "ssh" as const }
export const will_person = { kind: "person" as const, ...will, color_index: will_color }
export const agent = {
  kind: "agent" as const,
  id: "agent-run-41-implementer",
  agent: "coding" as const,
  avatar_url: placeholder_avatar,
  run_id: "run-41",
  for_member: ben,
  name: "implementer",
  todo: 12,
  color_index: ben_color
}
export const reviewer = {
  kind: "agent" as const,
  id: "agent-run-41-reviewer",
  agent: "reviewer" as const,
  avatar_url: placeholder_avatar,
  run_id: "run-41",
  for_member: ben,
  todo: 12,
  color_index: ben_color
}
export const claude_code = {
  kind: "agent" as const,
  id: "agent-session-cc-7",
  agent: "claude-code" as const,
  avatar_url: placeholder_avatar,
  session_id: "cc-7",
  for_member: ben,
  color_index: ben_color
}
export const codex = {
  kind: "agent" as const,
  id: "agent-session-codex-3",
  agent: "codex" as const,
  avatar_url: placeholder_avatar,
  session_id: "codex-3",
  for_member: will,
  color_index: will_color
}
// An agent acting for nobody (color_index 6). It is a named external agent, so the label it renders, its name, is a
// string the model carries; the undelegated coding agent's derived label "Coding agent" is covered by ActorChip.test.tsx.
export const undelegated_agent = {
  kind: "agent" as const,
  id: "agent-session-aider-77",
  agent: "external" as const,
  avatar_url: placeholder_avatar,
  session_id: "session-77",
  name: "Aider",
  color_index: 6
}
export const smithers_for_ben = {
  kind: "agent" as const,
  id: "smithers-session-ben-3",
  agent: "smithers" as const,
  avatar_url: placeholder_avatar,
  session_id: "ben-3",
  for_member: ben,
  color_index: ben_color
}
export const smithers = {
  kind: "agent" as const,
  id: "smithers-install",
  agent: "smithers" as const,
  avatar_url: placeholder_avatar,
  color_index: 6
}
export const system = { kind: "system" as const, color_index: 7 as const }
export const github_user = { kind: "github" as const, login: "octocat", color_index: 7 as const }
export const outside = { kind: "outside" as const, color_index: 7 as const }
export const issue = {
  number: 3474,
  title: "Card model contracts",
  url: "https://github.com/smithersai/smithers/issues/3474"
}
