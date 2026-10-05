/**
 * Public spelling aliases shared by target and durable command invocations.
 * @since 1.0.0
 */

import * as Argv from "./Argv.ts"

/** Commands that evaluate the shared target declarations.
 * @category parsing
 * @since 1.0.0
 */
export const targetCommands = new Set([
  "build",
  "test",
  "lint",
  "docs",
  "review",
  "ci",
  "run",
  "target",
  "targets",
  "query",
  "graph",
  "owners",
  "install",
  "git-hooks",
  "gitHooks",
  "show",
  "affected",
  "watch",
  "explain",
  "cache",
  "clean",
  "info"
])
const valued = new Set(["--workspace", "-w", "--ui", "--filter", "--fields"])
const switches = new Set([
  "--help",
  "-h",
  "--schema",
  "--llms",
  "--no-color"
])

/**
 * Accept --root for target commands while preserving the published --workspace schema.
 * Durable commands keep --root unchanged, and arguments after -- are never rewritten.
 * @category parsing
 * @since 1.0.0
 */
export const normalizeArguments = (args: ReadonlyArray<string>): Array<string> => {
  const parsed = Argv.parse(args)
  const rest = parsed.rest
  let offset = 0
  while (offset < rest.length && rest[offset]!.startsWith("-")) {
    const flag = rest[offset]!
    if (switches.has(flag) || [...valued].some((value) => flag.startsWith(`${value}=`))) offset++
    else if (valued.has(flag)) offset += 2
    else return [...args]
  }
  const index = parsed.restIndices[offset] ?? args.length
  const command = args[index]
  if (command === undefined) return [...args]
  // `smthrs .` opens the checkout in the app (commands/Open.ts).
  if (command === ".") return normalizeArguments([...args.slice(0, index), "open", ".", ...args.slice(index + 1)])
  const bare = command.startsWith("//") || command.startsWith(":")
  const generator = command === "generate" && ["ci", "package"].includes(args[index + 1] ?? "")
  if (!bare && !targetCommands.has(command) && !generator) {
    // Connection flags belong to the leaf command in Incur. Legacy callers
    // put them before the command; move that prefix after the command's
    // arguments, retaining the literal tail behind `--` untouched.
    const separator = args.indexOf("--", index)
    const end = separator < 0 ? args.length : separator
    return [...args.slice(index, end), ...args.slice(0, index), ...args.slice(end)]
  }
  const depth = generator || command === "show" || command === "cache" ? 2 : 1
  const commandPath = bare ? ["target", command] : args.slice(index, index + depth)
  const options = [...args.slice(0, index), ...args.slice(index + (bare ? 1 : depth))]
  let positional = false
  return [
    ...commandPath,
    ...options.map((argument) => {
      if (argument === "--") positional = true
      if (positional) return argument
      if (argument === "--root") return "--workspace"
      return argument.startsWith("--root=") ? `--workspace=${argument.slice(7)}` : argument
    })
  ]
}
