import type { ActorChipCard } from "../../src/ActorChipCard.ts"
import {
  agent,
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

export const fixtures = {
  person: { actor: person, size: "s", live: false },
  person_medium: { actor: person, size: "m", live: true },
  ssh: { actor: ssh_person, size: "s", live: true },
  terminal: { actor: { ...person, via: "terminal" }, size: "s", live: true },
  cli: { actor: { ...person, via: "cli" }, size: "s", live: true },
  smithers_for_ben: { actor: smithers_for_ben, size: "m", live: true },
  claude_code_for_ben: { actor: claude_code, size: "m", live: true },
  codex_for_will: { actor: codex, size: "m", live: true },
  coding_agent_for_ben: { actor: agent, size: "m", live: true },
  reviewer_for_ben: { actor: reviewer, size: "s", live: true },
  undelegated_agent: { actor: undelegated_agent, size: "m", live: true },
  undelegated_smithers: { actor: smithers, size: "s", live: false },
  system: { actor: system, size: "s", live: false },
  github_user: { actor: github_user, size: "m", live: false },
  outside: { actor: outside, size: "s", live: false }
} satisfies Record<string, ActorChipCard>
