import type { StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"

/** The refusal a signed-out hybrid fixture host gives a chat turn. */
export const CLOUD_CHAT_SIGN_IN = "Sign in to Smithers Cloud to chat — /cloud.sign-in."

/** Injected test agent. Production turns use the shared backend transport. */
export interface CloudAgent {
  readonly start: (request: StartAgentTurnRequest) => StartAgentTurnResult
  readonly cancel: (runId: string) => { readonly status: "cancelled" | "not-found" }
}
