// Agent/session real-host journeys remain owed: https://github.com/smithersai/smithers/issues/1873.
export const agent = [
  "agent.session.list", "agent.session.new",
  "agent.session.say", "agent.session.stop", "agent.session.view",
  "subagents",
] as const
