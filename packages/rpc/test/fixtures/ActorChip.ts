import type { ActorChipCard } from "../../src/ActorChipCard.ts"
import {
  agent,
  ben,
  ben_color,
  claude_code,
  codex,
  github_user,
  outside,
  person,
  reviewer,
  smithers,
  smithers_for_ben,
  ssh_person,
  system,
  undelegated_agent
} from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const chip = (name: string, model: ActorChipCard, expect: string[]): Story<ActorChipCard> =>
  story(name, model, { expect })

export const fixtures = {
  person: chip("Ben", { actor: person, size: "s" }, ["Ben"]),
  person_medium: chip("Ben, medium and live", { actor: person, size: "m", live: true }, ["Ben"]),
  ssh: chip("Ben via SSH", { actor: ssh_person, size: "s", live: true }, ["Ben"]),
  terminal: chip("Ben's terminal", { actor: { ...person, via: "terminal" }, size: "s", live: true }, ["Ben"]),
  cli: chip("Ben via CLI", { actor: { ...person, via: "cli" }, size: "s", live: true }, ["Ben"]),
  smithers_for_ben: chip("Smithers, for Ben", { actor: smithers_for_ben, size: "m", live: true }, ["Ben"]),
  claude_code_for_ben: chip("Claude Code, for Ben", { actor: claude_code, size: "m", live: true }, ["Ben"]),
  codex_for_ben: chip(
    "Codex for Ben",
    {
      actor: { ...codex, id: "agent-session-codex-9", session_id: "codex-9", for_member: ben, color_index: ben_color },
      size: "m",
      live: true
    },
    ["Ben"]
  ),
  codex_for_will: chip("Codex for Will, in Will's colour", { actor: codex, size: "m", live: true }, ["Will"]),
  external_for_ben: chip(
    "An external agent for Ben",
    {
      actor: {
        kind: "agent",
        id: "agent-session-aider-2",
        agent: "external",
        avatar_url: ben.avatar_url,
        session_id: "aider-2",
        name: "Aider",
        for_member: ben,
        color_index: ben_color
      },
      size: "s",
      live: true
    },
    ["Aider", "Ben"]
  ),
  coding_agent_for_ben: chip("Coding agent, for Ben", { actor: agent, size: "m", live: true }, ["Ben"]),
  reviewer_for_ben: chip("Reviewer, for Ben", { actor: reviewer, size: "s", live: true }, ["Ben"]),
  undelegated_agent: chip("An agent acting for nobody", { actor: undelegated_agent, size: "m", live: true }, [
    "wiki refresh"
  ]),
  undelegated_smithers: chip("Smithers acting for nobody", { actor: smithers, size: "s", live: false }, ["Smithers"]),
  system: chip("An install event", { actor: system, size: "s", live: false }, ["Smithers"]),
  github_user: chip("A GitHub user", { actor: github_user, size: "m", live: false }, ["octocat"]),
  outside: chip("Changed outside Smithers", { actor: outside, size: "s", live: false }, ["outside"])
} satisfies Record<string, Story<ActorChipCard>>
