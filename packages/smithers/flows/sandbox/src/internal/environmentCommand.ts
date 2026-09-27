/**
 * Applies environment deletions beyond SDKs that accept only string values.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"

/**
 * Keeps ordinary overrides in the SDK field. When removing inherited values,
 * launches an absolute guest shell through env, with removals before assignments.
 * Neither a removed nor an overridden PATH participates in locating that shell.
 *
 * @category constructors
 * @since 0.1.0
 */
export const environmentCommand = (
  command: string,
  values: Readonly<Record<string, string | undefined>> | undefined,
  shell: string = "/bin/sh"
): { readonly command: string; readonly env: Record<string, string> } => {
  const removed: Array<string> = []
  const assigned: Array<[string, string]> = []
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value === undefined) removed.push("-u", name)
    else assigned.push([name, value])
  }
  if (removed.length === 0) return { command, env: Object.fromEntries(assigned) }
  return {
    command: [
      "/usr/bin/env",
      ...removed,
      ...assigned.map(([name, value]) => `${name}=${value}`),
      shell,
      "-c",
      command
    ].map(CommandLine.quote).join(" "),
    env: {}
  }
}
