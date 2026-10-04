export const RETIRED_CARD_KINDS = ["explain", "repository-setup", "agent", "admin-health", "notifications", "registration", "connect", "plugin-library", "theme-picker", "models", "model-call", "retired", "service-log", "repo", "targets", "target-run", "graph", "run-timeline", "run-history", "affected", "ci-matrix", "balance", "billing-plans", "grant-confirm", "stack", "factory.home"] as const

/** Retired surfaces stay decodable, but cannot be reopened or sent to a model. */
export const cardAvailable = (kind: string): boolean =>
  !(RETIRED_CARD_KINDS as readonly string[]).includes(kind)
