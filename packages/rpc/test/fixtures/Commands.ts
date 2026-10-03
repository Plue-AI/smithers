import type { CommandsCard } from "../../src/CommandsCard.ts"

export const fixtures = {
  empty: { groups: [] },
  available: {
    groups: [
      {
        label: "TODOs",
        advanced: false,
        commands: [{ tag: "todo", title: "Open TODO" }, { tag: "todo.drop", title: "Drop TODO" }]
      },
      { label: "Install", advanced: true, commands: [{ tag: "sign-in", title: "Sign in" }] }
    ]
  }
} satisfies Record<string, CommandsCard>
