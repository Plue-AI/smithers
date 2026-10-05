/**
 * The app agent's one tool ("commands are the app"): list the commands callable right now, or execute one by
 * name. Every host that runs an app-agent turn offers this tool and reads its calls with this decoder; hosts
 * differ only in which commands they can run.
 * @since 1.0.0
 */

import type { AgentToolSpec } from "./NativeAgent.ts"

/**
 * The one tool the chat model gets.
 * @since 1.0.0
 * @category constants
 */
export const commandsToolSpec: AgentToolSpec = {
  type: "function",
  name: "commands",
  description: "action \"list\" returns {state, commands}: the live app state (surface, whether work is " +
    "connected, whether a turn is streaming) and every command callable right now; an optional " +
    "\"namespace\" narrows it to one namespace with every command's args, and an optional \"query\" " +
    "(the act you need, in words) returns the few commands that do it with their args. " +
    "action \"execute\" runs one command by name through the same code path the UI buttons " +
    "and slash commands use.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "execute"], description: "list commands or execute one." },
      query: {
        type: "string",
        description:
          "For list: the act you need, in words (\"switch to dark mode\"); answers the matching commands not already in your prompt."
      },
      namespace: {
        type: "string",
        description:
          "For list: only the commands in this namespace, the part of the name before the first dot (repo, search, target)."
      },
      name: {
        type: "string",
        description:
          "The command name (required for execute), e.g. \"browser.open\" — the catalog's leading slash is accepted too."
      },
      args: { type: "string", description: "Optional argument text for commands that accept it." }
    },
    required: ["action"],
    additionalProperties: false
  }
}

/**
 * One decoded call of the commands tool. `namespace` and `name` are bare: the model writes command names in their
 * user-facing spelling, with a leading slash, and the agent boundary strips it as the composer strips the human's.
 * An empty `namespace` or `query` asks for none.
 * @since 1.0.0
 * @category models
 */
export type CommandsCall =
  | { readonly action: "list"; readonly namespace: string; readonly query: string }
  | { readonly action: "execute"; readonly name: string; readonly args: string | undefined }

const bare = (name: string): string => name.trim().replace(/^\/+/u, "")

/**
 * Decodes the commands tool's arguments, or answers the honest failure the model reads instead.
 * @since 1.0.0
 * @category parsers
 */
export const decodeCommandsCall = (raw: string): CommandsCall | { readonly failure: string } => {
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return { failure: "failed: the commands tool arguments were not valid JSON" }
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { failure: "failed: the commands tool arguments must be an object" }
  }
  const fields = input as Readonly<Record<string, unknown>>
  const text = (key: string): string | undefined => typeof fields[key] === "string" ? fields[key] : undefined
  if (fields.action === "list") {
    return {
      action: "list",
      namespace: bare(text("namespace") ?? "").replace(/\.$/u, ""),
      query: (text("query") ?? "").trim()
    }
  }
  if (fields.action !== "execute") {
    return { failure: "failed: the commands tool action must be \"list\" or \"execute\"" }
  }
  const name = bare(text("name") ?? "")
  if (name === "") return { failure: "failed: the execute action requires a command name" }
  return { action: "execute", name, args: text("args") }
}

/**
 * The result for a tool the model called that is not the commands tool.
 * @since 1.0.0
 * @category utilities
 */
export const unknownToolResult = (name: string): string => `unknown-tool: ${name}`

/**
 * The result for a command no host here runs. The recovery is in the error: it points the model back at the list
 * action, so the retry happens in the same turn instead of the model telling the person to run it.
 * @since 1.0.0
 * @category utilities
 */
export const unknownCommandResult = (name: string): string =>
  `unknown-command: ${name} — no command has that name; use the list action for every command callable right now`
