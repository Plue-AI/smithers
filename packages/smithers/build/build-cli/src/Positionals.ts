/**
 * Refuses positional arguments that no command argument consumes.
 *
 * incur 0.5 assigns positionals to a command's argument keys in order and
 * silently drops the rest unless the last key is an array, so an unguarded
 * `clean //a/... //b/...` would clean only `//a/...`. {@link guard} makes every
 * command of a CLI refuse such an invocation with the typed
 * `UNEXPECTED_ARGUMENT` error before its handler runs.
 *
 * wevm/incur#231 ("reject unexpected positional arguments") proposed this in
 * incur itself and was never merged. Delete this module once incur rejects
 * surplus positionals on its own.
 *
 * @since 0.1.0
 */
import { Cli, Errors, Parser, z } from "incur"
import { AsyncLocalStorage } from "node:async_hooks"

/** The slice of an incur registry entry the guard reads. */
interface Entry {
  readonly _alias?: true
  readonly target?: string
  readonly _group?: true
  readonly commands?: ReadonlyMap<string, Entry>
  readonly root?: Entry
  readonly args?: z.ZodObject<any> | undefined
  readonly options?: z.ZodObject<any> | undefined
  readonly alias?: Record<string, string> | undefined
}

interface Invocation {
  readonly cli: Cli.Cli<any, any, any, any>
  readonly argv: ReadonlyArray<string>
  readonly globals: z.ZodObject<any> | undefined
}

const invocations = new AsyncLocalStorage<Invocation>()

/** incur's own switches, which it removes before resolving a command. */
const builtinSwitches = new Set([
  "--full-output",
  "--llms",
  "--llms-full",
  "--mcp",
  "--help",
  "-h",
  "--update",
  "--incur-update-check",
  "--schema",
  "--json",
  "--token-count"
])

/** incur's own flags that take the next token as their value. */
const builtinValues = new Set(["--format", "--filter-output", "--token-limit", "--token-offset"])

/** Mirrors incur's `extractBuiltinFlags`: the tokens left for globals and commands. */
const withoutBuiltins = (argv: ReadonlyArray<string>): Array<string> => {
  const rest: Array<string> = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    const next = argv[index + 1]
    if (builtinSwitches.has(token)) continue
    // A following value belongs to a command-local `--version` option.
    if (token === "--version" && (next === undefined || next.startsWith("-"))) continue
    if (builtinValues.has(token) && next) {
      index++
      continue
    }
    rest.push(token)
  }
  return rest
}

const lookup = (commands: ReadonlyMap<string, Entry>, path: ReadonlyArray<string>): Entry | undefined => {
  let scope: ReadonlyMap<string, Entry> | undefined = commands
  let entry: Entry | undefined
  for (const word of path) {
    const found: Entry | undefined = scope?.get(word)
    entry = found?._alias === true ? scope?.get(found.target!) : found
    scope = entry?.commands
  }
  return entry?._group === true ? entry.root : entry
}

/**
 * Keeps each option's flag shape but drops its validation, so an invalid or
 * missing option never hides a surplus positional; incur still reports it.
 */
const lenient = (options: z.ZodObject<any> | undefined): z.ZodObject<any> | undefined =>
  options === undefined ? undefined : z.object(
    Object.fromEntries(
      Object.entries(options.shape as Record<string, z.ZodType>).map(([name, field]) => [
        name,
        field.meta()?.["count"] === true ? field : field.optional().catch(undefined)
      ])
    )
  )

const unwrap = (schema: z.ZodType): z.ZodType => {
  let current = schema as { readonly def: { readonly innerType?: z.ZodType } }
  while (current.def.innerType !== undefined) current = current.def.innerType as never
  return current as never
}

/**
 * The positionals `tokens` pass to `command` beyond the ones its argument keys
 * consume; `undefined` when the tokens do not parse, which incur reports itself.
 *
 * @category parsing
 * @since 0.1.0
 */
export const unconsumed = (
  command: Pick<Entry, "args" | "options" | "alias">,
  tokens: ReadonlyArray<string>
): ReadonlyArray<string> | undefined => {
  const keys = Object.keys(command.args?.shape ?? {})
  const last = keys.length === 0 ? undefined : command.args!.shape[keys[keys.length - 1]!] as z.ZodType
  // A trailing array argument collects every remaining positional.
  if (last !== undefined && unwrap(last) instanceof z.ZodArray) return []
  try {
    const parsed = Parser.parse([...tokens], {
      args: z.object({ positionals: z.array(z.string()).optional() }),
      options: lenient(command.options),
      alias: command.alias
    })
    return (parsed.args.positionals ?? []).slice(keys.length)
  } catch {
    return undefined
  }
}

/**
 * The positionals an argv passes to the command at `path` beyond the ones it
 * consumes; `undefined` when the argv serves stdio MCP, names no command, or
 * does not parse.
 *
 * @category parsing
 * @since 0.1.0
 */
export const surplus = (
  cli: Cli.Cli<any, any, any, any>,
  argv: ReadonlyArray<string>,
  path: ReadonlyArray<string>,
  globals?: z.ZodObject<any>
): ReadonlyArray<string> | undefined => {
  // A stdio MCP server runs inside `serve`, and its tool calls carry named
  // parameters, never the server's own argv.
  if (argv.includes("--mcp")) return undefined
  const command = lookup(Cli.toCommands.get(cli as never) as ReadonlyMap<string, Entry>, path)
  if (command === undefined) return undefined
  const tokens = withoutBuiltins(argv)
  const rest = globals === undefined
    ? tokens
    : Parser.parseGlobals(tokens, globals, undefined, { validate: false }).rest
  return unconsumed(command, rest.slice(path.length))
}

const refuse = async (context: { readonly command: string }, next: () => Promise<void>): Promise<void> => {
  const invocation = invocations.getStore()
  // Only an HTTP request (`cli.fetch`) runs outside `serve`; it carries named
  // parameters, never loose positionals.
  if (invocation === undefined) return next()
  const extra = surplus(invocation.cli, invocation.argv, context.command.split(" "), invocation.globals)
  if (extra !== undefined && extra.length > 0) {
    throw new Errors.IncurError({ code: "UNEXPECTED_ARGUMENT", message: `Unexpected argument: ${extra.join(" ")}` })
  }
  return next()
}

/**
 * Makes every command `cli` serves refuse unconsumed positionals.
 *
 * Pass the CLI's `globals` schema so its global flags are not mistaken for
 * positionals. Commands mounted after this call are guarded too.
 *
 * @category constructors
 * @since 0.1.0
 */
export const guard = <A extends Cli.Cli<any, any, any, any>>(cli: A, globals?: z.ZodObject<any>): A => {
  cli.use(refuse)
  const serve = cli.serve.bind(cli)
  cli.serve = (argv = process.argv.slice(2), options) =>
    invocations.run(
      { cli, argv, globals },
      () => serve(argv, options)
    )
  return cli
}
