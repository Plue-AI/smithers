/** Model ids the loopback provider answers. Behaviour is keyed by id; the one control is a `[HOLD key]` turn's release. */
export const PROVIDER_MODEL = {
  answers: "e2e-answers",
  rateLimited: "e2e-rate-limited",
  slow: "e2e-slow",
  garbled: "e2e-garbled",
  echoes: "e2e-echoes",
  reads: "e2e-reads"
} as const
export type ProviderModelId = typeof PROVIDER_MODEL[keyof typeof PROVIDER_MODEL]

/**
 * The install's own role models (packages/backend install_setup.go InstallFastModel and the Decisions role), which an
 * install pointed here by SMITHERS_MODEL_PROVIDER_ORIGIN asks for: the fast model behaves as `reads`, so the app agent
 * on Cerebras reads files, and Decisions as `answers`. The review seat is the AI Gateway's second-vendor review model
 * (flows/coding/host.ts routedReviewModels), which the stack's review of a TODO's PR runs on with only a Gateway key;
 * it behaves as `answers`.
 */
export const INSTALL_MODEL = { fast: "gpt-oss-120b", decisions: "typesafe-ai/jev", review: "anthropic/claude-sonnet-4.5" } as const

/** The assistant text every successful generation streams, in two deltas. */
export const PROVIDER_REPLY = ["loopback ", "pong"] as const
/** What a `reads` generation says before the tool result it was handed. */
export const PROVIDER_READ_LEAD = "From the source: "
/** What an `echoes` generation says before its nested credential fragments. */
export const PROVIDER_ECHO_LEAD = "your key is "
/** The per-question confidence the evaluation endpoint reports. */
export const PROVIDER_CONFIDENCE = 0.97
/** The `retry-after` seconds a rate-limited answer carries. */
export const PROVIDER_RETRY_AFTER_SECONDS = 1

export const PROVIDER_PATHS = {
  openaiChat: "/v1/chat/completions",
  anthropic: "/v1/messages",
  evaluation: "/v4/ai/evaluation-model",
  ready: "/__ready",
  journal: "/__journal",
  /** GET: the `[HOLD key]` coding turns waiting now, one key per turn. */
  held: "/__held",
  /** POST `/__release/<key>`: answers every turn held on key, and every later one at once. */
  release: "/__release/"
} as const

export type ProviderProtocol = "openai-chat" | "anthropic-messages" | "evaluation"

/** One request as the provider saw it. Written when the answer is decided, before a slow answer waits. */
export interface ProviderJournalEntry {
  readonly at: string
  readonly protocol: ProviderProtocol
  readonly modelId: string
  readonly status: number
  readonly authorized: boolean
  /** The TODO coding step a scripted answer served (`coding/draft-plan`, …), or `todo/judge` for the run's evaluation. */
  readonly step?: string
  /**
   * The bracketed marker words a coding turn carried (`HOLD`, `FIXED`, a spec's own `STEER-E2E`), each once: evidence
   * that a person's steer or answer reached that turn, never the turn's text.
   */
  readonly markers?: ReadonlyArray<string>
  /** sha256 hex of the presented credential, or null when none was sent. Never the value. */
  readonly credentialSha256: string | null
  /** Non-credential protocol headers only: anthropic-version, ai-gateway-*, ai-evaluation-*, ai-model-id. */
  readonly headers: Readonly<Record<string, string>>
  /** An evaluation's question ids, in body order, and the state it was asked about. */
  readonly questions?: ReadonlyArray<string>
  readonly state?: unknown
  /** A generation's parameters: whether a system prompt was sent, and the knobs the body named. */
  readonly system?: boolean
  readonly maxTokens?: number
  readonly temperature?: number
}
