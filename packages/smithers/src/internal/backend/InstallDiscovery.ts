import { Cli } from "incur"
import { Refused } from "../../CliError.ts"

// Keep the actual discovery tree, rather than reconstructing it from the
// descriptor allowlist. Help, MCP and skills all consume this same tree.
type Commands = NonNullable<ReturnType<typeof Cli.toCommands.get>>
const trees = new WeakMap<object, Commands>()

export const retainInstallDiscovery = (cli: object, commands: Commands): void => {
  trees.set(cli, commands)
}

export const installCommands = (cli: object): Commands | undefined => trees.get(cli)

export const installCommandPaths = (cli: object): string[] => {
  const tree = trees.get(cli)
  if (tree === undefined) throw new Refused({ fault: "bug", code: "install_discovery_unavailable", message: "CLI install discovery is unavailable" })
  const paths: string[] = []
  const walk = (commands: Commands, prefix: string[] = []): void => {
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
