/**
 * A Smithers Cloud workspace whose signed-in `claude` is this TUI's Claude
 * Code seat.
 *
 * The seat runs the `claude` it finds on `PATH` and asks `claude auth status`
 * whether it may. `--harness owner/repo/id` puts a `claude` first on `PATH`
 * that runs the workspace's `claude` over the workspace's SSH endpoint, with
 * its home and `CLAUDE_CONFIG_DIR` on the workspace's persistent disk. The
 * agent loop stays here; the subscription login never leaves the box.
 */
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { constants } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Failures from "./failures.ts"

/** Where the workspace keeps its home, its `claude`, and its login. */
export const home = "/home/developer"

const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`

/**
 * The settings the Agent SDK gives `claude` through its environment. SSH
 * carries no environment, so these travel in the command. Named one by one:
 * a credential such as `CLAUDE_CODE_OAUTH_TOKEN` must never leave this machine
 * or override the workspace's own login.
 */
const forwarded: ReadonlyArray<string> = [
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
  "CLAUDE_AGENT_SDK_VERSION",
  "ENABLE_CLAUDEAI_MCP_SERVERS"
]

/** The command the workspace runs for one `claude` invocation with `args`. */
export const remoteCommand = (
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = {},
  workspaceHome = home
): string => {
  const settings = Object.entries(environment).flatMap(([name, value]) =>
    forwarded.includes(name) && value !== undefined ? [`${name}=${quote(value)}`] : []
  )
  return `export ${
    [...settings, `HOME=${workspaceHome}`, `CLAUDE_CONFIG_DIR=${workspaceHome}/.claude`].join(" ")
  } PATH=${workspaceHome}/bin:${workspaceHome}/.local/bin:$PATH; cd ${workspaceHome} && exec claude ${
    args.map(quote).join(" ")
  }`
}

/**
 * Writes the `claude` that reaches `reference` into `stateDirectory` and
 * answers `environment` with its directory first on `PATH`.
 */
export const install = (
  environment: Readonly<Record<string, string | undefined>>,
  reference: string,
  stateDirectory: string
): Record<string, string | undefined> => {
  const bin = join(stateDirectory, "harness", reference.replaceAll("/", "_"), "bin")
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const entry = fileURLToPath(new URL("./harness-claude.ts", import.meta.url))
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nexec bun ${quote(entry)} ${quote(reference)} "$@"\n`,
    { mode: 0o755 }
  )
  chmodSync(join(bin, "claude"), 0o755)
  return { ...environment, PATH: [bin, environment.PATH].filter(Boolean).join(delimiter) }
}

/**
 * Runs `claude args` on the workspace `prefix` reaches, with this process's
 * stdio, and answers its exit code: 255 when the workspace cannot be reached,
 * `128 + n` when signal `n` ends it. A SIGINT or SIGTERM sent here goes to the
 * transport, so an aborted turn stops on the workspace too.
 */
export const run = async (
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>,
  prefix: () => Promise<ReadonlyArray<string>>,
  name: string,
  workspaceHome = home
): Promise<number> => {
  let argv: ReadonlyArray<string>
  try {
    argv = await prefix()
  } catch (error) {
    process.stderr.write(`${name} could not be reached. ${Failures.detailsIn(error)}\n`)
    return 255
  }
  const [program, ...rest] = argv
  const child = spawn(program!, [...rest, remoteCommand(args, environment, workspaceHome)], { stdio: "inherit" })
  const forward = (signal: NodeJS.Signals) => child.kill(signal)
  process.on("SIGINT", forward).on("SIGTERM", forward)
  return new Promise((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`${name} could not be reached. ${Failures.detailsIn(error)}\n`)
      resolve(255)
    })
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward).off("SIGTERM", forward)
      resolve(code ?? 128 + (signal === null ? 0 : constants.signals[signal]))
    })
  })
}
