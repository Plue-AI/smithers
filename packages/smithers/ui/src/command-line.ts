/** Renderer-neutral command tokens shared by client grammars.
 * @since 0.1.0
 */

/** The explicit owner/repository token accepted by repository commands.
 * @category parsing
 * @since 0.1.0
 */
export const REPO_TOKEN = /^[\w.-]+\/[\w.-]+$/

/** The registry spelling of a command name: trimmed, leading slashes gone. */
export const canonicalCommandName = (name: string): string => name.trim().replace(/^\/+/, "")

/** `/model gpt` → `{ name: "model", argument: "gpt" }`. */
export const parseCommand = (text: string): { readonly name: string; readonly argument: string } | undefined => {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match === null ? undefined : { name: match[1]!, argument: (match[2] ?? "").trim() }
}


/** How a composer submit resolves under the flows-are-the-app doctrine. */
export type Submit =
  | { readonly kind: "empty" }
  | { readonly kind: "command"; readonly name: string; readonly args?: string }
  /**
   * A leading token that IS flow syntax and names no registered flow.
   *
   * Handing it to the model as prose is the dishonest answer: typing `/reset`
   * on a non-admin session (where `reset` does not register) put the literal
   * string in front of the model, which reached for whatever flow it could
   * see and ran something else entirely (§23.5). A name the app does not have
   * is answered by the app, not improvised by the model.
   */
  | { readonly kind: "unknown-command"; readonly name: string }
  | { readonly kind: "prompt"; readonly text: string }

// Flow names are deliberately narrower than arbitrary prompt text. Keeping
// this grammar in one named place makes the flow/prompt boundary auditable: a
// typo or punctuation after a slash must go to the agent, never accidentally
// invoke a flow with side effects.
const COMMAND_NAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/

/** Split only the leading slash-flow token; arguments remain opaque text. */
const commandHead = (text: string): { readonly name: string; readonly args?: string } | undefined => {
  const parsed = parseCommand(text)
  if (parsed === undefined || !COMMAND_NAME.test(parsed.name)) return undefined
  return parsed.argument === "" ? { name: parsed.name } : { name: parsed.name, args: parsed.argument }
}

/**
 * Parses the composer draft:
 *  - blank (or a bare "/") submits nothing — bare "/" + Enter is handled by the
 *    menu selecting its first (recommended) item,
 *  - an input that is ONLY a registered slash flow executes it directly
 *    by its registered name,
 *  - `/name <text>` executes directly when the flow declares input,
 *  - a leading token that is flow SYNTAX but names no registered flow is
 *    refused by name — never handed to the model as prose,
 *  - anything else is a prompt for the agent.
 *
 * This is the syntactic half of the composer boundary: it decides flow-vs-
 * prompt and splits the name from the opaque argument text. Turning that text
 * into the flow's typed payload is `SlashPayload.payloadFor`, which the same
 * boundary calls next — so a handler never sees raw argument text.
 */
export const parseSubmit = <C extends { readonly name: string; readonly acceptsArgs?: boolean }>(
  input: string,
  commands: ReadonlyArray<C>
): Submit => {
  const text = input.trim()
  if (text === "" || text === "/") return { kind: "empty" }
  const invocation = commandHead(text)
  if (invocation === undefined) return { kind: "prompt", text }
  const command = commands.find((candidate) => candidate.name === invocation.name)
  if (command === undefined) return { kind: "unknown-command", name: invocation.name }
  if (invocation.args === undefined) return { kind: "command", name: invocation.name }
  if (command.acceptsArgs === true) {
    return { kind: "command", name: invocation.name, args: invocation.args }
  }
  return { kind: "prompt", text }
}
