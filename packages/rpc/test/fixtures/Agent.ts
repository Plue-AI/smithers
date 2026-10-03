import type { AgentCard } from "../../src/AgentCard.ts"
import { at, person } from "./_shared.ts"

const base: AgentCard = {
  name: "implementer",
  instructions_path: "flows/todo/instructions/implementer.md",
  role: "coding",
  model: "gpt-6.1-sol",
  available: [{ model: "gpt-6.1-sol", price_in: 1, price_out: 2 }, { model: "gpt-6-astra", price_in: 2, price_out: 4 }],
  runs: [{ id: "run-12-1", title: "T12 · Card model contracts", state: "done", at }]
}
export const fixtures = {
  coding: base,
  fast: {
    ...base,
    name: "app agent",
    instructions_path: ".smithers/instructions/app.md",
    role: "fast",
    model: "gpt-6-luna",
    available: [{ model: "gpt-6-luna", price_in: 0.1, price_out: 0.2 }]
  },
  jev: { ...base, name: "reviewer", instructions_path: "flows/todo/instructions/reviewer.md", role: "jev" },
  no_choices: { ...base, available: [] },
  idle: { ...base, runs: [] },
  changed: { ...base, changed: { from: "gpt-6-astra", by: person, at } },
  queued: { ...base, runs: [{ ...base.runs[0]!, state: "queued" }] },
  running: { ...base, runs: [{ ...base.runs[0]!, state: "running" }] },
  waiting: { ...base, runs: [{ ...base.runs[0]!, state: "waiting" }] },
  held: { ...base, runs: [{ ...base.runs[0]!, state: "held" }] },
  failed: { ...base, runs: [{ ...base.runs[0]!, state: "failed" }] },
  cancelled: { ...base, runs: [{ ...base.runs[0]!, state: "cancelled" }] }
} satisfies Record<string, AgentCard>
