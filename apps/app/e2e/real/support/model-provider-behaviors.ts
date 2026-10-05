/** Model ids the loopback provider answers. Behaviour is keyed by id, so the provider needs no control channel. */
export const PROVIDER_MODEL = {
  answers: "e2e-answers",
  rateLimited: "e2e-rate-limited",
  slow: "e2e-slow",
  garbled: "e2e-garbled",
  echoes: "e2e-echoes",
  reads: "e2e-reads"
} as const
export type ProviderModelId = typeof PROVIDER_MODEL[keyof typeof PROVIDER_MODEL]

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
  journal: "/__journal"
} as const

export type ProviderProtocol = "openai-chat" | "anthropic-messages" | "evaluation"

/** One request as the provider saw it. Written when the answer is decided, before a slow answer waits. */
export interface ProviderJournalEntry {
  readonly at: string
  readonly protocol: ProviderProtocol
  readonly modelId: string
  readonly status: number
  readonly authorized: boolean
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
