// Resume reuses the reviewed registration; authenticated host acceptance remains #1939.
export const triggers = [
  "triggers.approve", "triggers.pause", "triggers.resume", "triggers.run",
] as const
