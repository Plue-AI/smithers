import type { TerminalCard } from "../../src/TerminalCard.ts"
import { ben, person, ssh_person, will } from "./_shared.ts"

const base: TerminalCard = {
  id: "terminal-1",
  title: "Checks",
  branch: "todo/12",
  owner: person,
  watchers: [],
  viewer_is_owner: true
}
export const fixtures = {
  idle: base,
  running: { ...base, command: "pnpm check", watchers: [will] },
  watching: { ...base, command: "go test ./...", watchers: [ben, will], viewer_is_owner: false },
  ssh: { ...base, owner: ssh_person, command: "jj status" },
  offer: { ...base, offer: "Add ripgrep to machine image" }
} satisfies Record<string, TerminalCard>
