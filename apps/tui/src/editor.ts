/**
 * Composer logic that owes nothing to the renderer: prompt history, slash
 * commands, and the double-press window for Ctrl+C.
 */

/** pi keeps this many prompts and skips a repeat of the latest one. */
export const historyLimit = 100

/** A second Ctrl+C within this window exits (pi's `lastSigintTime`). */
export const exitWindowMs = 500

/**
 * Prompt history, browsed with Up and Down. `index` is how far back the
 * composer currently shows; -1 is the draft being typed.
 */
export class History {
  private entries: Array<string> = []
  private index = -1
  private draft = ""

  constructor(initial: ReadonlyArray<string> = []) {
    for (const entry of initial) this.add(entry)
  }

  add(entry: string): void {
    const text = entry.trim()
    this.index = -1
    if (text === "" || this.entries.at(-1) === text) return
    this.entries.push(text)
    if (this.entries.length > historyLimit) this.entries.shift()
  }

  get browsing(): boolean {
    return this.index >= 0
  }

  /** The older entry to show, or undefined at the oldest. */
  up(current: string): string | undefined {
    if (this.index + 1 >= this.entries.length) return undefined
    if (this.index === -1) this.draft = current
    this.index++
    return this.entries[this.entries.length - 1 - this.index]
  }

  /** The newer entry to show, the draft past the newest, or undefined when not browsing. */
  down(): string | undefined {
    if (this.index < 0) return undefined
    this.index--
    return this.index === -1 ? this.draft : this.entries[this.entries.length - 1 - this.index]
  }
}

export interface Command {
  readonly name: string
  readonly args?: string
  readonly description: string
}

export const commands: ReadonlyArray<Command> = [
  { name: "model", args: "[query]", description: "Pick a model" },
  { name: "new", description: "Start a new conversation" },
  { name: "resume", description: "Resume a conversation" },
  { name: "conversation", description: "Show the conversation file and tokens" },
  { name: "compact", description: "Drop the oldest context" },
  { name: "name", args: "<name>", description: "Name this conversation" },
  { name: "copy", description: "Copy the last answer" },
  { name: "summary", description: "Review this conversation" },
  { name: "chat", description: "Return to chat" },
  { name: "filter", description: "Show or hide kinds of rows" },
  { name: "grep", args: "[text]", description: "Show only rows containing text" },
  { name: "smithers", description: "The factory's issues" },
  { name: "todo", args: "<title>", description: "File a TODO for the factory" },
  { name: "retry", args: "#<issue>", description: "Retry a factory issue" },
  { name: "devtools", args: "[id] [node]", description: "Inspect a run's nodes" },
  { name: "flows", description: "Flows and agents" },
  { name: "flow", args: "<name> [json|key=value|prompt]", description: "Run a flow or agent" },
  { name: "quit", description: "Quit" }
]

/**
 * Commands that run when typed but are not listed: the wrapped workers, whose
 * prompt line Ctrl+K starts, and `/quit`'s alias.
 */
export const unlisted: ReadonlyArray<string> = ["claude", "codex", "exit"]

/** A name the command switch handles: listed or unlisted. */
export const known = (name: string): boolean =>
  commands.some((command) => command.name === name) || unlisted.includes(name)

/** Edits from `a` to `b`, a swap of two neighbors counting as one (optimal string alignment). */
const distance = (a: string, b: string): number => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i + j))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1)
      }
    }
  }
  return rows[a.length]![b.length]!
}

/**
 * The listed command a mistyped `/name` most likely meant: at most two edits
 * away and fewer edits than half its letters; the earlier command wins a tie.
 */
export const nearest = (name: string): Command | undefined => {
  const typed = name.toLowerCase()
  let best: { readonly command: Command; readonly edits: number } | undefined
  for (const command of commands) {
    const edits = distance(typed, command.name)
    if (edits <= 2 && edits * 2 < typed.length && (best === undefined || edits < best.edits)) best = { command, edits }
  }
  return best?.command
}

/** What an unknown `/name` says: the nearest listed command, when one is close. */
export const unknown = (name: string): string => {
  const near = nearest(name)
  return near === undefined ? `Unknown command /${name}` : `Unknown command /${name}. Try /${near.name}.`
}

/** Tab and Enter insert `/name ` for these, so the argument can be typed or completed. */
export const takesArgument = (command: Command): boolean => command.args?.startsWith("<") === true

export { parseCommand } from "@smthrs/ui/command-line"

/** Formats a token count the way pi's footer does: 950, 1.2k, 45k, 1.2M. */
export const tokens = (count: number): string => {
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
