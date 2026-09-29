/** Command-line validation before a model, session, or terminal is opened. */
import { statSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

export const usage = `Usage: smithers-tui [directory] [options]

  -m, --model <provider:id>  Chat model
  -c, --continue             Continue the latest session
  -r, --resume               Choose a session
  -p, --print <prompt>       Print one answer and exit
      --approve <mode>       all (default), ask, or deny
      --budget-tokens <n>    Token cap per turn and worker (default 200M; 0 or none disables)
      --budget-daily-tokens <n>  Token cap per UTC day on this machine (default 2B; 0 or none disables)
      --box <owner/repo/id>  Run worker tools in this Smithers Cloud workspace (or SMITHERS_BOX)
      --harness <owner/repo/id>  Run the Claude Code seat on this workspace's signed-in claude (or SMITHERS_HARNESS)
  -h, --help                 Show help`

/** Whether `reference` names a Smithers Cloud workspace: `OWNER/REPO/WORKSPACE_ID`. */
export const validBox = (reference: string): boolean => /^[\w.-]+\/[\w.-]+\/[\w-]+$/.test(reference)

/**
 * Whether two valid references reach the same workspace. The id alone names it,
 * and the backend reads it as a UUID, so case and hyphens do not distinguish two.
 */
export const sameWorkspace = (left: string, right: string): boolean => {
  const id = (reference: string) => reference.split("/")[2]!.toLowerCase().replaceAll("-", "")
  return id(left) === id(right)
}

const options = {
  model: { type: "string", short: "m" },
  continue: { type: "boolean", short: "c" },
  resume: { type: "boolean", short: "r" },
  print: { type: "string", short: "p" },
  approve: { type: "string" },
  "budget-tokens": { type: "string" },
  "budget-daily-tokens": { type: "string" },
  box: { type: "string" },
  harness: { type: "string" },
  help: { type: "boolean", short: "h" }
} as const

const optionOf = (arg: string) => {
  const name = arg.split("=")[0]!
  return Object.entries(options).find(([long, option]) =>
    name === `--${long}` || ("short" in option && name === `-${option.short}`)
  )?.[1]
}
const known = (arg: string): boolean => optionOf(arg) !== undefined

/** A `parseArgs` refusal as one sentence naming the argument, by its error code. */
const refusal = (args: ReadonlyArray<string>, error: unknown): string => {
  const code = (error as { readonly code?: unknown } | null)?.code
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const option = args.find((arg) => arg.startsWith("-") && arg !== "--" && !known(arg))
    return option === undefined ? "Unknown option" : `Unknown option ${option.split("=")[0]}`
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const flag = args.find((arg) => arg.includes("=") && optionOf(arg)?.type === "boolean")
    if (flag !== undefined) return `${flag.split("=")[0]} takes no value`
    const last = args.at(-1)
    return last !== undefined && known(last) ? `${last} needs a value` : "An option is missing its value"
  }
  if (code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") return "Expected one directory"
  return "Could not read the arguments"
}

export const parse = (args: ReadonlyArray<string>, cwd: string) => {
  try {
    const { values, positionals } = parseArgs({ args: [...args], options, allowPositionals: true })
    if (values.help === true) return { help: true } as const
    if (positionals.length > 1) return { error: "Expected one directory" } as const
    if (values.continue && values.resume) return { error: "Choose --continue or --resume" } as const
    if (values.print !== undefined && (values.continue || values.resume)) {
      return { error: "--print cannot resume an interactive conversation" } as const
    }
    if (values.model !== undefined && values.model.trim() === "") return { error: "--model needs a model" } as const
    if (values.print !== undefined && values.print.trim() === "") return { error: "--print needs a prompt" } as const
    if (values.box !== undefined && !validBox(values.box)) {
      return { error: "--box needs owner/repo/workspace-id" } as const
    }
    if (values.harness !== undefined && !validBox(values.harness)) {
      return { error: "--harness needs owner/repo/workspace-id" } as const
    }
    const directory = resolve(cwd, positionals[0] ?? ".")
    try {
      if (!statSync(directory).isDirectory()) return { error: `Not a directory: ${directory}` } as const
    } catch {
      return { error: `Cannot open directory: ${directory}` } as const
    }
    return { values, cwd: directory } as const
  } catch (error) {
    return { error: refusal(args, error) } as const
  }
}
