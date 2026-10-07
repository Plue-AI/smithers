import { payloadFor } from "./SlashPayload"
import type { CardCommandInput } from "@smthrs/rpc/CardAction"
/** Secret values belong to the one-shot gesture, never recorded command arguments. */
export const publicSecretInput = (input: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const { value: _value, key: _key, token: _token, ...payload } = input
  return { ...payload, ...(payload.operation === "scope" ? {
    scope: payload.scope === "main-only" ? "main_only" : payload.scope === "all" ? "all_branches" : payload.scope
  } : {}) }
}

export type SecretOperation = NonNullable<NonNullable<CardCommandInput["secrets"]>["operation"]>
/** Bind a control to the shared door without placing its write-only value in metadata. */
export const secretInput = (operation: SecretOperation, input: Readonly<Record<string, unknown>>): NonNullable<CardCommandInput["secrets"]> => ({
  ...input, operation, ...(operation === "scope" ? { scope: input.scope === "main-only" ? "main_only" : input.scope === "all" ? "all_branches" : input.scope } : {})
}) as NonNullable<CardCommandInput["secrets"]>

/** Decode the retired argument grammar only while migrating saved controls. */
export const secretArgs = (operation: SecretOperation, args = ""): string => {
  let input: Record<string, unknown> = {}
  if (args.trim().startsWith("{")) {
    try { const parsed: unknown = JSON.parse(args); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown> } catch { return "{}" }
  } else {
    const parsed = payloadFor(`secrets.${operation}`, args)
    if ("payload" in parsed) input = parsed.payload
  }
  return JSON.stringify(publicSecretInput({ ...input, operation }))
}
