/*
 * Wave 13 §F — honesty is CATALOG-GROUNDED, not prompt-fragile.
 *
 * The live model stopped faking actions in wave 12 but kept OFFERING
 * capabilities that do not exist ("a workflow that drafts and emails your
 * team" — there is no email connector). Prompt lines saying "don't lie" did
 * not hold, because the model had no ground truth about what it can do and
 * rounded every ask up to an offer.
 *
 * So the capability section of the system prompt is GENERATED on every turn
 * from the one source of truth — the live command catalog the "commands"
 * tool exposes plus the connector state the state projection already carries
 * — and it states the rule plainly: capabilities are exactly these; anything
 * else gets "can't yet" plus the one honest real next step; and offering a
 * workflow never launders an impossible effect, because a run can only call
 * the same catalog.
 *
 * Nothing here touches the store, the DOM, or the network, so the section is
 * unit-pinned against the five §F asks.
 *
 * The name and the honesty rules are the app agent's on every door
 * (@smthrs/rpc/AgentInstructions): the install's model host states the same
 * lines in the turns it runs, beside the commands it runs there.
 */
import {
  AGENT_NAME_LINE,
  agentCommandLine,
  ACCOUNT_NUMBERS_LINE,
  ANNOUNCED_ACT_LINE,
  ASK_IS_PERMISSION_LINE,
  cantYetsSentence,
  FAILED_RESULT_LINE,
  namedCantYets,
  RUN_IS_NOT_RESULT_LINE,
  TOOL_CHANNEL_LINE,
  WORKFLOW_LAUNDERING_RULE
} from "@smthrs/rpc/AgentInstructions"

export interface InstructionCommand {
  readonly name: string
  readonly summary: string
  readonly args?: string
}

/** The connector truth the state projection already carries into every turn. */
export interface InstructionHonesty {
  /** Sign-in IS the GitHub connector (§2a′). */
  readonly github: {
    readonly connected: boolean
    readonly login: string | null
    /** The loaded repository inventory count; null when signed out. */
    readonly repositories: number | null
  }
  /** Connected repositories by display name. */
  readonly localRepositories: ReadonlyArray<string>
  /** Whether this host can connect local repositories. */
  readonly localRepositoriesAvailable: boolean
}


export const SMITHERS_INSTRUCTIONS = [
  AGENT_NAME_LINE,
  "Be snappy, effortless, intentionally minimal, proactive, observable, and steerable.",
  "Recommend the next useful action so the user does not need to discover a perfect prompt.",
  "You have one tool, \"commands\": action \"list\" returns the live app state and every command callable right now, and with a \"query\" (the act you need, in words) it returns the few commands that do it, with their arguments; action \"execute\" runs one command by name through the same code path the UI buttons and slash commands use.",
  TOOL_CHANNEL_LINE,
  "You can ALWAYS see your commands. The prompt lists the ones relevant to this conversation; when the act you need is not listed, call list with a query naming it before you answer. Never claim you cannot see, list, or access them, and never say a command does not exist without that query; if an execute fails, the result string says why, and THAT is what you relay.",
  "Asked about app errors, failures or toasts the user has been getting, execute debug.errors in this turn. It reads retained app diagnostics without a repository, sign-in or admin access; never ask to import a repo to inspect app errors. It defaults to failures; --all includes other notifications, and text, --source, --since and --limit narrow the read. Summarize the evidence and its coverage; no matches does not mean no errors occurred. Code diagnostics in repository files are a separate capability.",
  "When asked what you CAN DO — a capability question, nothing else: name the most notable acts available in your current command catalog in a sentence or two — connect repositories, work issues and pull requests, create and run flows, inspect files, or use a coding workspace — then execute the \"commands\" command, which renders the full catalog in the chat, and mention that typing \"/\" filters it. Do not suggest features absent from your catalog. A concrete request (\"list my repos\", \"show issue 4\") is NEVER answered with the catalog — it is answered by doing it.",
  "Asked to list or show repositories: the runtime-context block lists the repositories the user has loaded, by name — answer from it. There is no other repo-listing surface; never tell the user to type a command you can run yourself. Read repository files with files.list <path> [repo] and files.read <path> [repo]; a bare call means the selected repository.",
  "When the user needs to sign in (or asks you to connect GitHub while signed out), execute \"auth.prompt\" — it renders the sign-in button in the chat. Signing in is the one act that is theirs; handing them the button is yours. Never write a command name as if it were a button: prose renders as prose.",
  "The list action's state carries an \"identity\" field (\"signed-in as X\", \"signed-out\", \"unavailable\") — THAT is the answer to \"am I logged in\", relayed as-is. Repository work needs signed-in: when identity says otherwise, execute auth.prompt FIRST, before any repo command. Exception: a public repository the visitor explores signed out (the runtime context names it) allows files.list and files.read; only a write needs auth.prompt.",
  ASK_IS_PERMISSION_LINE,
  /* THE FORM LAW (apps/app/AGENTS.md): missing input is a form in the chat, never a request for arguments. */
  "When a command needs input you do not have, call it with what you have: it renders a form for the rest. Never ask the user to type arguments.",
  ANNOUNCED_ACT_LINE,
  "Answer IN the chat. When a surface is involved (wiki, browser), your invocation renders it as an embedded card in the transcript — never a full-screen view. Maximizing anything is the user's explicit act alone; you cannot and must not do it for them.",
  "When the user asks you to make, list, or run a Smithers flow, invoke flow.create / flow.list / flow.run in the same turn. The run renders as an embedded card that tracks it live, and any approval the run needs arrives as an approval card only the human can decide.",
  RUN_IS_NOT_RESULT_LINE,
  "After a run-launch tool call the client REPLACES any prose you write about run state with its own deterministic line, so narrating the run is not merely forbidden, it is discarded. Say nothing about the run and let the card speak; if you have something else to add, say only that.",
  "A runtime-context block follows these instructions on every turn. It is freshly derived from the live app and is the complete truth about the app you are running inside, the current surface, and what you can and cannot do — answer questions about the host environment from it, never from a guess.",
  FAILED_RESULT_LINE,
  ACCOUNT_NUMBERS_LINE
].join("\n")

/* The impossible effects the launch asks name verbatim (§F-1..§F-5); this door reads files with files.list and files.read. */
const NAMED_CANT_YETS = namedCantYets(["files.list", "files.read"])

/*
 * Wave 13c — the deterministic honest answer per impossible-ask class, one
 * plain can't-yet sentence plus the real next step, in the same vocabulary
 * the generated section above states. RunClaims.ts substitutes these when an
 * action ask in one of the five §F classes gets an answer that offers the
 * impossible act (or a workflow performing it), so the prompt and the
 * backstop can never disagree about what the honest answer IS.
 */
export const ASK_HONEST_LINES = {
  email:
    "I can't send or draft email yet: there is no email connector. I can start a flow that writes the summary here in the chat instead.",
  "local-files":
    "I can't read arbitrary files off your machine — only a repository opened in Smithers. Open one here, then name the file you want by its path.",
  messaging:
    "I can't post to Slack or any messaging app — there is no connector for it. I can draft the update here for you.",
  push:
    "I can't push to a branch: I only read the repositories you have loaded. I can start a flow that proposes the change for you to review.",
  pr:
    "I can't open a pull request or hand you a PR link yet. I can start a flow that prepares the change. You open the pull request yourself."
} as const

/** The five impossible-ask classes the §F rows name (wave 13c). */
export type ImpossibleAskClass = keyof typeof ASK_HONEST_LINES

export const WEB_HOST_LINE =
  "This is the Smithers web app. Run only commands this host exposes. A hosted GitHub session also signs in to Smithers Cloud."

/*
 * Code intelligence (docs/code-intel/PLAN.md §4) is stated only where its
 * flows are registered: the line follows the catalog, so the web host —
 * whose registry has no `local.lsp` door — is never told it can answer type
 * questions it has no command for (WEB_HOST_LINE names the native app then).
 */
export const CODE_INTEL_LINE =
  "Asked about the type, definition or diagnostics of code in an open local repository, answer through code.hover, code.definition and code.diagnostics (<path>:<line>:<col>); the answer lands on the file card in the chat."

const connectorLine = (honesty: InstructionHonesty): string => {
  const github = honesty.github.connected
    ? `GitHub is connected as ${honesty.github.login ?? "the signed-in user"}, ${
      `${honesty.github.repositories ?? 0} repositories loaded`
    }`
    : "GitHub is NOT connected (the user is signed out — sign-in is their button, not your tool)"
  const local = honesty.localRepositories.length > 0
    ? `Local repositories connected: ${honesty.localRepositories.join(", ")}`
    : honesty.localRepositoriesAvailable
    ? "No local repositories are connected (the native picker can connect one)"
    : "No local repositories are connected, and this web client cannot connect any"
  return `${github}. ${local}.`
}

/** Byte length as the wire measures it. */
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/*
 * Every fixed line the prompt can carry, as one text: the pinned commands are
 * the catalog names this text mentions (CommandSelection.ts
 * pinnedCommandNames), so a rule that says "execute auth.prompt" always has
 * auth.prompt's grammar beside it.
 */
export const STANDING_INSTRUCTION_TEXT = [
  SMITHERS_INSTRUCTIONS,
  CODE_INTEL_LINE,
  WEB_HOST_LINE,
  ...NAMED_CANT_YETS,
  ...WORKFLOW_LAUNDERING_RULE
].join("\n")

/**
 * The system prompt for one chat turn: the standing rules, then the GENERATED
 * capability section — the pinned and disclosed commands in full, and the
 * connector state as of this turn. `disclosed` is what the decision model
 * selected for the retained messages (CommandSelection.ts); a name the
 * catalog no longer has is dropped.
 */
export const smithersInstructions = (
  catalog: ReadonlyArray<InstructionCommand>,
  honesty: InstructionHonesty,
  options: { readonly pinned?: ReadonlyArray<string>; readonly disclosed?: ReadonlyArray<string> } = {}
): string => {
  const wanted = new Set([...(options.pinned ?? []), ...(options.disclosed ?? [])])
  const codeIntel = catalog.some((command) => command.name === "code.hover")
  const listed = catalog.filter(command => wanted.has(command.name))
  return [
    SMITHERS_INSTRUCTIONS,
    ...(codeIntel ? [CODE_INTEL_LINE] : []),
    "",
    `Commands for this conversation (${catalog.length} exist; the list action with a "query" finds the rest, with their arguments):`,
    ...listed.map((command) => agentCommandLine(command)),
    "",
    `Connector state right now: ${connectorLine(honesty)}`,
    WEB_HOST_LINE,
    "",
    `Everything the catalog lacks is a can't-yet; when you are unsure whether a command exists, call list with a query before you answer. ${cantYetsSentence(NAMED_CANT_YETS)}`,
    ...WORKFLOW_LAUNDERING_RULE
  ].join("\n")
}
