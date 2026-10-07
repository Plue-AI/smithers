/** Keep credential values in the write-only gesture, outside command metadata and recorded actions. */
export const publicSettingsInput = (input: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  if (input.operation === "model-key") return Object.fromEntries(["operation", "role", "provider", "model", "action"]
    .filter(key => input[key] !== undefined).map(key => [key, input[key]]))
  const { value: _secret, ...payload } = input
  return payload
}
