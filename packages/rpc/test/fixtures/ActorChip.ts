import type { ActorChipCard } from "../../src/ActorChipCard.ts"
import { agent, ben, outside, person, system } from "./_shared.ts"

export const fixtures = {
  person: { actor: person, size: "s", live: false },
  person_medium: { actor: person, size: "m", live: true },
  claude_code: { actor: { ...person, via: "claude-code" }, size: "m", live: true },
  codex: { actor: { ...person, via: "codex" }, size: "m", live: true },
  ssh: { actor: { ...person, via: "ssh" }, size: "s", live: true },
  terminal: { actor: { ...person, via: "terminal" }, size: "s", live: true },
  cli: { actor: { ...person, via: "cli" }, size: "s", live: true },
  agent: { actor: agent, size: "m", live: true },
  system: { actor: system, size: "s", live: true },
  system_for: { actor: { ...system, for: ben }, size: "m", live: true },
  github: { actor: { kind: "github", login: "ben", color_index: 3 }, size: "m", live: false },
  outside: { actor: outside, size: "s", live: false }
} satisfies Record<string, ActorChipCard>
