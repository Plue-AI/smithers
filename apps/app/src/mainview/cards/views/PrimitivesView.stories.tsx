import { fixtures as actorFixtures } from "@smthrs/rpc/fixtures/ActorChip"
import { ActorChip, type Actor } from "./ActorChip"
import { StateWord } from "./StateWord"
import type { ViewStory } from "./stories"
import type { TodoState } from "@smthrs/rpc/CardPrimitives"

const person = actorFixtures.person.model.actor as Extract<Actor, { kind: "person" }>
const ben = { login: person.login, name: person.name, avatar_url: person.avatar_url, color_index: 1 }
const actors: [string, Actor][] = [
  ["person", { kind: "person", ...ben }],
  ...(["ssh", "terminal", "cli"] as const).map(via => [`person-${via}`, { kind: "person", ...ben, name: "Maya Chen", via }] as [string, Actor]),
  ["system", { kind: "system", color_index: 7 }],
  ["github", { kind: "github", login: "octocat", color_index: 7 }],
  ["outside", { kind: "outside", color_index: 7 }],
]
for (const agent of ["smithers", "coding", "reviewer", "claude-code", "codex", "external"] as const) {
  for (const delegated of [false, true]) actors.push([
    `${agent}${delegated ? "-for-ben" : ""}`,
    { kind: "agent", id: agent, agent, avatar_url: ben.avatar_url, color_index: delegated ? 1 : 6, ...(delegated ? { for_member: ben } : {}) }
  ])
}
for (let color_index = 0; color_index < 6; color_index++) actors.push([`member-color-${color_index}`, { kind: "person", ...ben, color_index }])
actors.push(["person-avatar", { kind: "person", ...ben }])
const actorLabels: Record<string, string> = {
  person: "Ben", "person-ssh": "Maya via SSH", "person-terminal": "Maya's terminal", "person-cli": "Maya via CLI",
  system: "Smithers", github: "@octocat", outside: "Changed outside Smithers", smithers: "Smithers", "smithers-for-ben": "Smithers for Ben",
  coding: "Coding agent", "coding-for-ben": "Coding agent for Ben", reviewer: "Reviewer", "reviewer-for-ben": "Reviewer for Ben",
  "claude-code": "Claude Code", "claude-code-for-ben": "Claude Code for Ben", codex: "Codex", "codex-for-ben": "Codex for Ben",
  external: "External agent", "external-for-ben": "External agent for Ben", "person-avatar": "Ben",
  "member-color-0": "Ben", "member-color-1": "Ben", "member-color-2": "Ben", "member-color-3": "Ben", "member-color-4": "Ben", "member-color-5": "Ben",
}
const states: TodoState[] = ["queued", "starting", "working", "needs_you", "paused", "failed", "in_review", "merged", "dropped"]
export const stories: ViewStory[] = [
  ...Object.entries(actorFixtures).map(([key, fixture]) => ({
    name: `actor-fixture-${key}`, expect: fixture.expect,
    render: () => <div style={{ display: "flex", gap: 12, alignItems: "center" }}><ActorChip {...fixture.model} /></div>,
  })),
  ...actors.map(([name, actor]) => ({
    name: `actor-${name}`, expect: [actorLabels[name]!],
    render: () => <div style={{ display: "flex", gap: 12, alignItems: "center" }}><ActorChip actor={actor} size="s" /><ActorChip actor={actor} size="m" live /></div>
  })),
  ...states.flatMap(state => [false, true].map(withStep => ({
    name: `state-${state}${withStep ? "-step" : ""}`,
    expect: [state === "queued" && withStep ? "Waiting for a machine" : ({ queued: "Queued", starting: "Starting", working: "Working", needs_you: "Needs you", paused: "Paused", failed: "Failed", in_review: "In review", merged: "Merged", dropped: "Dropped" })[state]],
    render: () => <StateWord state={state} step={withStep ? "Implement" : undefined} />,
  }))),
  ...["live", "attention", "failed", "done", "quiet"].map(tone => ({ name: `tone-${tone}`, expect: [tone], render: () => <span data-tone={tone} style={{ color: "var(--tone)" }}>{tone}</span> })),
]
