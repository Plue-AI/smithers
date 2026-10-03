import { ActorChip, actorName, type Actor } from "./ActorChip"
import { StateWord } from "./StateWord"
import { toneTokens } from "./Tone"
import type { ViewStory } from "./stories"
import type { TodoState } from "@smthrs/rpc/CardPrimitives"

const ben = { login: "ben", name: "Ben Park", avatar_url: "", color_index: 1 }
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
    { kind: "agent", id: agent, agent, avatar_url: "", color_index: delegated ? 1 : 6, ...(delegated ? { for_member: ben } : {}) }
  ])
}
for (let color_index = 0; color_index < 6; color_index++) actors.push([`member-color-${color_index}`, { kind: "person", ...ben, color_index }])
// Self-contained avatar, so screenshots never depend on external image servers.
actors.push(["person-avatar", { kind: "person", ...ben, avatar_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%23376f91'/%3E%3Ctext x='24' y='32' text-anchor='middle' fill='white' font-size='24'%3EB%3C/text%3E%3C/svg%3E" }])
const states: TodoState[] = ["queued", "starting", "working", "needs_you", "paused", "failed", "in_review", "merged", "dropped"]
export const stories: ViewStory[] = [
  ...actors.map(([name, actor]) => ({
    name: `actor-${name}`, expect: [actorName(actor)],
    render: () => <div style={{ display: "flex", gap: 12, alignItems: "center" }}><ActorChip actor={actor} size="s" /><ActorChip actor={actor} size="m" live /><span>{actorName(actor)}</span></div>
  })),
  ...states.flatMap(state => [false, true].map(withStep => ({
    name: `state-${state}${withStep ? "-step" : ""}`,
    expect: [({ queued: "Queued", starting: "Starting", working: "Working", needs_you: "Needs you", paused: "Paused", failed: "Failed", in_review: "In review", merged: "Merged", dropped: "Dropped" })[state]],
    render: () => <StateWord state={state} step={withStep ? state === "queued" ? "#2" : "Implement" : undefined} />,
  }))),
  ...Object.keys(toneTokens).map(tone => ({ name: `tone-${tone}`, expect: [tone], render: () => <span data-tone={tone} style={{ color: "var(--tone)" }}>{tone}</span> })),
]
// Queue detail has a different literal from the bare queued word.
stories.find(story => story.name === "state-queued-step")!.expect = ["Waiting for a machine · #2"]
