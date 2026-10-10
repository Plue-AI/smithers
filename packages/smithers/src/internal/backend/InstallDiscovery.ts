/**
 * Install command discovery: keeps the actual mounted command tree that help, MCP
 * and skills all consume, rather than rebuilding it from the descriptor allowlist.
 *
 * @since 1.0.0
 */

import type { Cli } from "incur"
import { Refused } from "../../CliError.ts"

// Keep the actual discovery tree, rather than reconstructing it from the
// descriptor allowlist. Help, MCP and skills all consume this same tree.
type Commands = NonNullable<ReturnType<typeof Cli.toCommands.get>>
const trees = new WeakMap<object, Commands>()

/**
 * Retains the command tree mounted on `cli` for help, MCP and skills discovery.
 *
 * @since 1.0.0
 * @private
 */
export const retainInstallDiscovery = (cli: object, commands: Commands): void => {
  trees.set(cli, commands)
}

/**
 * The command tree retained for `cli`, if any.
 *
 * @since 1.0.0
 * @private
 */
export const installCommands = (cli: object): Commands | undefined => trees.get(cli)

/**
 * Every command path in the tree retained for `cli`; refuses with
 * `install_discovery_unavailable` when none was retained.
 *
 * @since 1.0.0
 * @private
 */
export const installCommandPaths = (cli: object): Array<string> => {
  const tree = trees.get(cli)
  if (tree === undefined) {
    throw new Refused({
      fault: "bug",
      code: "install_discovery_unavailable",
      message: "CLI install discovery is unavailable"
    })
  }
  const paths: Array<string> = []
  const walk = (commands: Commands, prefix: Array<string> = []): void => {
    for (const [name, entry] of commands) {
      const path = [...prefix, name]
      if ("_group" in entry) {
        if (entry.root !== undefined) paths.push(path.join(" "))
        walk(entry.commands, path)
      } else paths.push(path.join(" "))
    }
  }
  walk(tree)
  return paths.sort()
}
