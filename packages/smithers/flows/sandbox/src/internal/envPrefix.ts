/**
 * Renders a caller's environment as `env(1)` operands.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"

/**
 * The caller's environment as shell-quoted `env(1)` operands: every removal,
 * then every assignment.
 *
 * GNU coreutils, busybox, and BSD `env` all support `-u`, so an undefined
 * value deletes a variable the machine was created with instead of silently
 * keeping it: `undefined` means the same "remove this one" for a remote
 * command that it means for a local one. Every `-u` precedes every
 * assignment, because `env` stops reading options at the first operand and
 * `env A=1 -u B prog` hands `-u` to `env` as the program to run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const envPrefix = (env: Readonly<Record<string, string | undefined>> | undefined): ReadonlyArray<string> => {
  const entries = Object.entries(env ?? {})
  return [
    ...entries.flatMap(([key, value]) => value === undefined ? ["-u", CommandLine.quote(key)] : []),
    ...entries.flatMap(([key, value]) => value === undefined ? [] : [CommandLine.quote(`${key}=${value}`)])
  ]
}
