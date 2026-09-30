/**
 * Generic persistent execution environments.
 * @since 1.0.0
 */

import { Cli, z } from "incur"
import * as CliError from "../CliError.ts"
import * as Environment from "../ExecutionEnvironment.ts"
import type { Runtime } from "./ControlBridge.ts"
import * as Presentation from "./Presentation.ts"

/**
 * Create the location management and command execution projection.
 *
 * @category constructors
 * @since 1.0.0
 */
export const createEnvironmentCli = (runtime: Runtime) => {
  const source = () => runtime.environment ?? process.env
  const args = z.object({ name: z.string().describe("Saved execution environment") })
  const execute = async (
    name: string,
    argv: ReadonlyArray<string>,
    terminal: boolean,
    forward?: { localPort: number; remotePort: number }
  ) => {
    const profile = await Environment.get(name, source())
    const code = await Environment.run(profile, argv, source(), { terminal, signal: runtime.signal, forward })
    runtime.exit?.(code)
  }
  return Cli.create("environment", { description: "Run commands in saved local, SSH, or Cloud environments" })
    .command("add", {
      description: "Save an execution location",
      mcp: false,
      args,
      options: z.object({
        local: z.boolean().default(false).describe("Run on this machine"),
        ssh: z.string().optional().describe("SSH alias or user@host; uses your SSH configuration and known_hosts"),
        workspace: z.string().optional().describe("Cloud workspace OWNER/REPO/ID"),
        directory: z.string().describe("Absolute working directory on the execution machine"),
        home: z.string().optional().describe("Persistent home on the execution machine")
      }),
      run: (c) =>
        Presentation.guard(c, () => {
          const { local, ssh, workspace, directory, home } = c.options
          if (Number(local) + Number(ssh !== undefined) + Number(workspace !== undefined) !== 1) {
            throw new CliError.UsageError({ message: "Choose exactly one of --local, --ssh, or --workspace" })
          }
          return Environment.add({
            name: c.args.name,
            transport: local ? "local" : ssh !== undefined ? "ssh" : "workspace",
            ...(local ? {} : { destination: ssh ?? workspace }),
            directory,
            ...(home === undefined ? {} : { home })
          }, source())
        })
    })
    .command("list", {
      description: "List saved execution locations",
      mcp: false,
      run: (c) => Presentation.guard(c, () => Environment.list(source()))
    })
    .command("view", {
      description: "Show an execution location",
      mcp: false,
      args,
      run: (c) => Presentation.guard(c, () => Environment.get(c.args.name, source()))
    })
    .command("remove", {
      description: "Forget an execution location",
      mcp: false,
      args,
      run: (c) =>
        Presentation.guard(c, async () => {
          await Environment.remove(c.args.name, source())
          return { removed: c.args.name }
        })
    })
    .command("exec", {
      description: "Run a command: environment exec NAME -- COMMAND [ARGS...]",
      mcp: false,
      args,
      options: z.object({
        arg: z.array(z.string()).default([]).describe("Command arguments; use -- followed by the command"),
        terminal: z.boolean().default(false).describe("Allocate a remote terminal for an interactive command")
      }),
      run: (c) => Presentation.guard(c, () => execute(c.args.name, c.options.arg, c.options.terminal))
    })
    .command("shell", {
      description: "Open a terminal in the execution environment",
      mcp: false,
      args,
      run: (c) =>
        Presentation.guard(c, () => execute(c.args.name, ["/bin/sh", "-c", "exec \"${SHELL:-/bin/sh}\""], true))
    })
    .command("forward", {
      description: "Forward a loopback port over SSH",
      mcp: false,
      args,
      options: z.object({
        localPort: z.number().int().min(1).max(65535).describe("Local port on 127.0.0.1"),
        remotePort: z.number().int().min(1).max(65535).describe("Remote port on 127.0.0.1")
      }),
      run: (c) => Presentation.guard(c, () => execute(c.args.name, [], false, c.options))
    })
}
