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

export const parse = (args: ReadonlyArray<string>, cwd: string) => {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: {
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
      },
      allowPositionals: true
    })
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
    return { error: error instanceof Error ? error.message : String(error) } as const
  }
}
