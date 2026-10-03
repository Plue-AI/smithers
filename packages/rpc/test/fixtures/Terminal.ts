import type { TerminalCard } from "../../src/TerminalCard.ts"
import { agent, claude_code, person, ssh_person, will_person } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const willActor = will_person
const base: TerminalCard = {
  id: "terminal-1",
  title: "Checks",
  branch: "todo/12",
  owner: person,
  agents: [],
  watchers: [],
  viewer_is_owner: true,
  frozen: false
}
export const fixtures = {
  idle: story("Owner's idle terminal", base, { expect: ["Checks"] }),
  running: story("Running a command with a watcher", { ...base, command: "pnpm check", watchers: [willActor] }, {
    expect: ["pnpm check"]
  }),
  agent_working: story(
    "Claude Code working in Ben's terminal",
    { ...base, agents: [claude_code], command: "claude" },
    { expect: ["Checks", "claude"] }
  ),
  watching: story(
    "Someone else's terminal",
    { ...base, command: "go test ./...", watchers: [willActor], viewer_is_owner: false },
    {
      expect: ["go test ./..."]
    }
  ),
  agent_owner: story(
    "The coding agent's terminal",
    { ...base, id: "terminal-2", title: "Implement", owner: agent, watchers: [person], viewer_is_owner: false },
    { expect: ["Implement"] }
  ),
  ssh: story("Ben via SSH", { ...base, owner: ssh_person, command: "jj status" }, { expect: ["jj status"] }),
  frozen_watching: story("Watching while rebasing", { ...base, frozen: true, viewer_is_owner: false }, { expect: ["Checks"] }),
  frozen: story("Frozen while rebasing", { ...base, command: "pnpm check", frozen: true }, { expect: ["Checks"] })
} satisfies Record<string, Story<TerminalCard>>
