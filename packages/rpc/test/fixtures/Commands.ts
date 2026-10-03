import type { CommandsCard } from "../../src/CommandsCard.ts"
import { type Story, story } from "./_story.ts"

const todos: CommandsCard["groups"][number] = {
  label: "TODOs",
  advanced: false,
  commands: [
    { tag: "todo.new", synopsis: "/todo.new text", description: "Put a new TODO on the stack", agent: "run" },
    { tag: "todo.answer", synopsis: "/todo.answer Tn", description: "Answer the agent's question", agent: "run" },
    { tag: "merge", synopsis: "/merge Tn", description: "Merge the first TODO in order", agent: "confirm" }
  ]
}
const people: CommandsCard["groups"][number] = {
  label: "People",
  advanced: false,
  commands: [{ tag: "members", synopsis: "/members", description: "Manage people and roles", agent: "never" }]
}
const advanced: CommandsCard["groups"][number] = {
  label: "Advanced",
  advanced: true,
  commands: [
    { tag: "monitor", synopsis: "/monitor", description: "Open the run monitor", agent: "run" },
    { tag: "debug-api", synopsis: "/debug-api", description: "Try any call in the open API", agent: "never" }
  ]
}

export const fixtures = {
  member: story("Commands a member may run", { groups: [todos, advanced] }, {
    expect: ["/todo.answer Tn", "Answer the agent's question", "/monitor"]
  }),
  maintainer: story("Commands a maintainer may run", { groups: [todos, people, advanced] }, {
    expect: ["/members", "Manage people and roles", "/merge Tn"]
  }),
  basic_only: story("Only the basic groups", { groups: [todos] }, { expect: ["TODOs", "/todo.new text"] })
} satisfies Record<string, Story<CommandsCard>>
