/** Refusal diagnostics contain only explicitly selected native identities. */
export const sourceRefusal = (reason: string, values: Readonly<Record<string, unknown>> = {}): string => {
  const message = `source_refused: ${reason}`
  console.warn(message, JSON.stringify(values))
  return message
}
