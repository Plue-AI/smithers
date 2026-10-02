// Agent/session real-host journeys remain owed: https://github.com/smithersai/smithers/issues/1873.
export const agent = [
  // Its real scenario was models.spec.ts, which left with the model lab in the MVP cut (#3385).
  "agent.session.list", "agent.session.new",
  "agent.session.say", "agent.session.stop", "agent.session.view",
  "subagents",
] as const
