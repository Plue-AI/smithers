// Synthetic values, reference-derived field names and enums: prototype README
// "Existing data contracts". No private prototype source or live records.
// Expected values are literal, independent of the production schema/body.
export const input = {
  brief: {
    headline: "Will brief",
    updated: "2026-10-03T15:00:00Z",
    updated_epoch: 1791039600,
    questions: [{ id: "q1", q: "Ready?", why: "Review", options: ["Yes", "No"] }],
    resolved: [{
      id: "q0",
      q: "Run checks?",
      why: "Verify",
      options: ["Yes"],
      resolved: "2026-10-03T14:00:00Z",
      outcome: "Yes"
    }],
    agents: [{ name: "agent-1", role: "lead", doing: "Review", state: "idle" as const }],
    bar: { checks: { value: 0, level: "warn" as const } },
    found: [{
      what: "Observation unavailable",
      why: "Source failed",
      done: "Retained previous observation",
      level: "warn" as const
    }],
    log: ["Review requested"]
  }
}
export const expected = {
  headline: "Will brief",
  updated: "2026-10-03T15:00:00Z",
  updated_epoch: 1791039600,
  questions: [{ id: "q1", q: "Ready?", why: "Review", options: ["Yes", "No"] }],
  resolved: [{
    id: "q0",
    q: "Run checks?",
    why: "Verify",
    options: ["Yes"],
    resolved: "2026-10-03T14:00:00Z",
    outcome: "Yes"
  }],
  agents: [{ name: "agent-1", role: "lead", doing: "Review", state: "idle" }],
  bar: { checks: { value: 0, level: "warn" } },
  found: [{
    what: "Observation unavailable",
    why: "Source failed",
    done: "Retained previous observation",
    level: "warn"
  }],
  log: ["Review requested"]
}
