
/** The run reference is separate from backend IDs and from freeform message/JSON arguments. */
export const splitRunSource = (args: string | undefined): { readonly args: string | undefined; readonly sourceCard?: string } => {
  const match = /^\s*sourceCard=(\S+)(?:\s+([\s\S]*))?$/.exec(args ?? "")
  return match === null ? { args } : { args: match[2], sourceCard: match[1]! }
}

export const takesRunSource = (name: string): boolean =>
  (name.startsWith("runs.") && name !== "runs.list") || name === "approvals.open" || name === "flow.run.stop-all" || name === "flow.run" || name === "flow.plan" ||
  name === "flow.list"

/** Search references are opaque; retain the recorded card alongside the unchanged backend ID. */
export const runSearchRef = (runId: string, sourceCard: string): string => `run:${JSON.stringify([runId, sourceCard])}`

export const runSearchPayload = (ref: string): { readonly runId: string; readonly sourceCard?: string } => {
  if (ref.startsWith("run:[")) {
    try {
      const value: unknown = JSON.parse(ref.slice(4))
      if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string")) {
        return { runId: value[0]!, sourceCard: value[1]! }
      }
    } catch { /* Older bare references still name the backend ID exactly. */ }
  }
  return { runId: ref }
}

export const runSourceCommand = <Name extends string>(
  cardId: string,
  send: (name: Name, args?: string) => void
): typeof send => (name, args) => {
  send(name, takesRunSource(name) && splitRunSource(args).sourceCard === undefined ? `sourceCard=${cardId}${args === undefined ? "" : ` ${args}`}` : args)
}
