/*
 * The one-tool agent contract ("commands are the app"), ported from flows/ui
 * src/ui/runtime/agentTools.ts: the agent reaches the app through ONE tool —
 * list the registered commands with the live app state, or execute one by
 * name through the identical code path the buttons and slash menu use.
 *
 * Wave 3b: the chat tool-call loop binds to this contract. The turn carries
 * `agentToolSpecs`; a `tool_call` frame executes through
 * `CommandRegistry.executeForAgent` (actor smithers), and the honest result
 * string below is what the continuation turn posts back to the model.
 */
import type { AgentToolSpec } from "@smthrs/rpc/NativeAgent"
import { agentFaultNote } from "@smthrs/rpc/RefusalCopy"
import { MAX_TOOL_RESULT_BYTES, utf8Bytes } from "../state/AgentTurnPolicy"
import { canonicalCommandName } from "@smthrs/ui/command-line"
import type { CommandRegistry } from "./Commands"
import type { CatalogItem, CommandState, FlowEntry } from "./registry"
import { disclosedToAgent, itemOf } from "./registry"

export type { AgentToolSpec }

export interface AgentToolCall {
  readonly name: string
  readonly arguments: string
  readonly httpCall?: { readonly turnId: string; readonly callId: string; readonly attemptId?: string; readonly legId?: string }
}

/**
 * The flows the agent may see and call.
 *
 * This is the registry itself narrowed to model-invocable entries and then to
 * the declared model disclosure — not a second catalog. The trigger axis is the
 * descriptor's own `modelInvocable` flag, so user-only browser mechanics are
 * absent structurally rather than by a filter that could be forgotten.
 */
const agentVisible = (entries: ReadonlyArray<FlowEntry>): Array<CatalogItem> => entries.map(itemOf).filter(disclosedToAgent)

/**
 * The agent's live catalog as instruction material (Wave 13 §F): the same set
 * the "list" action returns, so the generated capability section of the system
 * prompt and the tool can never disagree about what the agent can do.
 */
export const agentVisibleCatalog = (
  callable: ReadonlyArray<FlowEntry>
): ReadonlyArray<{ readonly name: string; readonly summary: string; readonly args?: string }> =>
  agentVisible(callable).map((command) => ({
    name: command.name,
    summary: command.summary,
    ...(command.args === undefined ? {} : { args: command.args })
  }))

/*
 * The agent's own door beside a user-only act (§2a): the registry's
 * `userOnlyReason` says WHY the act is the human's; this table says what the
 * model does INSTEAD, where an instead exists — a prompt flow that renders the
 * human's button in the chat, or the text answer that replaces the gesture.
 * A flow that stops being user-only leaves this table (agent-parity.md).
 */
const USER_ONLY_ALTERNATIVES: Readonly<Record<string, string>> = {
  "auth.sign-in": "invoke auth.prompt, which renders that button in the chat",
  "cloud.sign-in": "invoke cloud.prompt, which renders that button in the chat",
  "app.download": "invoke app.download.prompt, which renders that button in the chat",
  "admin.reset": "suggest /chat.clear if they want a fresh chat",
  "chat.send": "answer with text instead",
  "card.maximize": "your invocation of a surface flow renders the embedded card",
  "palette.open": "invoke a search.* flow (search.open, search.files, search.flows, …), which answers the same rows as data"
}

/**
 * The honest tool-result error when the model reaches for a user-only flow:
 * the registry's reason, then the agent's own door when one exists, so the
 * model tells the user where the act lives instead of promising it.
 */
export const userOnlyError = (name: string, reason?: string): string => {
  const alternative = USER_ONLY_ALTERNATIVES[name]
  return `failed: /${name} is user-only — ${reason ?? "it is a control the human clicks, already visible on their screen"}${
    alternative === undefined ? "" : ` — ${alternative}`
  }`
}

/*
 * The seams' instruction shape: "Sign in to Smithers Cloud first — /cloud.sign-in."
 * and "sign in with /cloud.sign-in, or …". Only the slash INSIDE a sign-in
 * instruction is rewritten; a refusal whose subject is the flow itself
 * ("/cloud.sign-in is not in the web app — …", the W0 door sentence) keeps
 * its name, because that sentence is about the flow, not an act to take.
 */
const CLOUD_SIGN_IN_INSTRUCTION = /(\bsign in\b[^.]*?)\/cloud\.sign-in\b/giu

/**
 * A handler's refusal, worded for the agent. The seams answer a missing
 * Smithers Cloud session with the human's slash (`/cloud.sign-in`), which the
 * model cannot invoke; its next act is the prompt flow that renders that
 * button, so the failure text names it (agent-parity.md: the model ran
 * `/auth.prompt`, the wrong prompt, because nothing named the right one).
 */
export const agentFailureText = (error: string): string => {
  const worded = error.replace(
    CLOUD_SIGN_IN_INSTRUCTION,
    "$1cloud.prompt (it renders the Smithers Cloud sign-in button in the chat)"
  )
  /*
   * …and the fault class, when the app itself coded this refusal. Without it
   * the model reads "service unavailable" and picks a story: it has apologised
   * for a full fleet as though the user had asked for too much, and told a
   * user at their own quota that Smithers was broken. `agentFaultNote` only
   * fires on a code the app wrote at the front of the string, looked up in
   * plue's closed registry — never on the English.
   */
  const note = agentFaultNote(worded)
  return note === null ? worded : `${worded} ${note}`
}

/** The one tool the chat model gets. */
export const commandsToolSpec: AgentToolSpec = {
  type: "function",
  name: "commands",
  description: "action \"list\" returns {state, commands}: the live app state (surface, whether work is " +
    "connected, whether a turn is streaming) and every command callable right now; an optional " +
    "\"namespace\" narrows it to one namespace with every command's args. " +
    "action \"execute\" runs one command by name through the same code path the UI buttons " +
    "and slash commands use.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "execute"], description: "list commands or execute one." },
      namespace: {
        type: "string",
        description: "For list: only the commands in this namespace, the part of the name before the first dot (repo, search, target)."
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

export const agentToolSpecs: ReadonlyArray<AgentToolSpec> = [commandsToolSpec]

const ARGS_OMITTED_NOTE = "args omitted to fit the tool-result limit; list one namespace ({\"action\":\"list\",\"namespace\":\"repo\"}) to see them"
const SUMMARIES_OMITTED_NOTE = "summaries and args omitted to fit the tool-result limit; list one namespace to see them"

/*
 * The list must reach the model whole. Both tool loops cut every result at
 * MAX_TOOL_RESULT_BYTES; the full registry rendered with args measured 20 to
 * 23 KiB, so the model got a 16 KiB prefix that did not parse and lost the
 * tail namespaces (search.*, repo.*, target.*) — its only discovery channel
 * once the prompt is in stage 3. Render the fullest shape that fits, and when
 * fields go, the note says how to get them back.
 */
const listResult = (state: CommandState, catalog: ReturnType<typeof agentVisibleCatalog>): string => {
  const full = JSON.stringify({ state, commands: catalog })
  if (utf8Bytes(full) <= MAX_TOOL_RESULT_BYTES) return full
  const withoutArgs = JSON.stringify({
    state,
    note: ARGS_OMITTED_NOTE,
    commands: catalog.map(({ name, summary }) => ({ name, summary }))
  })
  if (utf8Bytes(withoutArgs) <= MAX_TOOL_RESULT_BYTES) return withoutArgs
  return JSON.stringify({ state, note: SUMMARIES_OMITTED_NOTE, commands: catalog.map(({ name }) => ({ name })) })
}

/**
 * Execute one model tool call through the app's command dispatch. Results are
 * honest strings — "executed /name", "unknown-command: name", "failed: <error>"
 * — so they round-trip into the transcript unchanged. An unknown TOOL name is
 * an honest error string too, never a crash.
 */
export const executeAgentToolCall = async (
  registry: CommandRegistry,
  call: AgentToolCall
): Promise<string> => {
  if (call.name !== commandsToolSpec.name) return `unknown-tool: ${call.name}`
  let input: { readonly action?: unknown; readonly name?: unknown; readonly args?: unknown; readonly namespace?: unknown }
  try {
    input = JSON.parse(call.arguments) as typeof input
  } catch {
    return "failed: the commands tool arguments were not valid JSON"
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "failed: the commands tool arguments must be an object"
  }
  if (input.action === "list") {
    const namespace = typeof input.namespace === "string" ? canonicalCommandName(input.namespace).replace(/\.$/u, "") : ""
    const catalog = agentVisibleCatalog(registry.callable()).filter(
      (command) => namespace === "" || command.name === namespace || command.name.startsWith(`${namespace}.`)
    )
    return listResult(registry.state(), catalog)
  }
  if (input.action !== "execute") {
    return "failed: the commands tool action must be \"list\" or \"execute\""
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    return "failed: the execute action requires a command name"
  }
  /*
   * The model reads command names in their user-facing spelling — the
   * generated catalog and every result string here write "/browser" — so a
   * leading slash in the tool call is the model speaking the app's own
   * dialect, not a typo. The agent boundary strips it exactly as the
   * composer's parseSubmit strips the human's; the registry's names stay
   * bare. (Live on canary, execute {"name":"/browser"} died as
   * unknown-command and the turn degraded into asking permission.)
   */
  const name = canonicalCommandName(input.name)
  if (name === "") {
    return "failed: the execute action requires a command name"
  }
  /*
   * The trigger axis, enforced structurally: a user-only command is neither
   * listed nor executable by the agent — the model gets the honest error
   * naming the visible alternative, never a silent refusal.
   */
  const target = registry.find(name)
  if (target !== undefined && !registry.callable().includes(target)) {
    return userOnlyError(name, target.metadata.userOnlyReason)
  }
  /*
   * The agent-mode run (requirement axis): an unmet requirement comes back
   * as an honest failure naming the missing step — the model can tell the
   * user, but can never park work that fires after its turn ends.
   */
  const outcome = await registry.runAsAgent(
    name,
    typeof input.args === "string" ? input.args : undefined,
    call.httpCall
  )
  switch (outcome.status) {
    case "executed":
      return outcome.value ?? `executed /${name}`
    case "unknown-command":
      /*
       * The recovery is in the error: a dead-end "unknown-command" left
       * the live model telling the USER to run the command. Point it back
       * at the list action so the retry happens in the same turn.
       */
      return `unknown-command: ${name} — no command has that name; use the list action for every command callable right now`
    case "unavailable":
      /*
       * A flow this host lacks the door for: nothing ran ("failed:" is the
       * prefix the instructions bind to that). When the native app is the
       * answer the registry has already rendered the refusal card — the same
       * one a human's slash or button gets — so the model points at it
       * instead of retrying; for the other doors the sentence is the answer.
       */
      return outcome.action === null
        ? `failed: ${outcome.reason}`
        : `failed: ${outcome.reason} The refusal is already rendered in the chat as a card; point the user at it`
    case "failed":
      return `failed: ${outcome.error}`
    case "form":
      /*
       * THE FORM LAW: the call lacked required input, so the app rendered the
       * flow's form in the chat. The model tells the human to fill it in —
       * never to type arguments.
       */
      return `rendered a form for ${outcome.fields.join(", ")}: ask the user to fill it in`
  }
}
