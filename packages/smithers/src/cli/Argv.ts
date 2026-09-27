/**
 * Shared pre-parser globals. The declaration coverage test pins this table to
 * Command's root flags and ControlBridge's connection options.
 * @since 1.0.0
 */

/**
 * The shared flags with their values, and every word they did not claim.
 *
 * @category models
 * @since 1.0.0
 */
export interface Globals {
  readonly argv: ReadonlyArray<string>
  /** Original positions of the words retained in rest. */
  readonly restIndices: ReadonlyArray<number>
  /** Other options, kept in rest but with their values treated as opaque. */
  readonly options: ReadonlyMap<string, string | boolean>
  readonly root: string | undefined
  readonly remote: string | undefined
  readonly credential: string | undefined
  readonly mcpConfig: string | undefined
  readonly backend: string | undefined
  readonly audience: string | undefined
  readonly format: string | undefined
  readonly json: boolean
  readonly quiet: boolean
  readonly silent: boolean
  readonly verbose: boolean
  /**
   * Argv with every recognized global removed, in order. A global with a
   * malformed value (`--json=maybe`, a trailing `--root` with nothing after
   * it) stays here, so a reader that must not guess sees it. `--` and every
   * word after it are kept verbatim.
   */
  readonly rest: ReadonlyArray<string>
  /** The index in argv of the first word the globals did not claim; `argv.length` when they claimed all of it. */
  readonly first: number
}

const valued = {
  "--root": "root",
  "--remote": "remote",
  "--credential": "credential",
  "--mcp-config": "mcpConfig",
  "--backend": "backend",
  "--audience": "audience",
  // The one flag that is not a root global: `logs --format` is read before a
  // tree is chosen, so the alias router has to skip it the way it skips `--root`.
  "--format": "format"
} as const

const switches = {
  "--json": "json",
  "--quiet": "quiet",
  "--silent": "silent",
  "--verbose": "verbose"
} as const

// Options used by the pre-parser consumers. These stay in rest; recognizing
// their arity keeps a message or tool name spelled like a global opaque.
const localValues = new Set([
  "--workspace",
  "-w",
  "--ui",
  "--filter",
  "--fields",
  "--allowed-tools",
  "--message",
  "--scope"
])

// The literals `effect/unstable/cli` accepts after a boolean flag.
const literals: Record<string, boolean | undefined> = {
  true: true,
  "1": true,
  yes: true,
  y: true,
  on: true,
  false: false,
  "0": false,
  no: false,
  n: false,
  off: false
}

/**
 * Parses the shared globals out of raw argv.
 *
 * Valued globals retain the configuration reader's inline `=value` or next
 * word semantics; the command parser owns syntax validation. A switch takes an
 * inline boolean literal, a following boolean literal, or nothing, and
 * `--no-<switch>` clears it. The first occurrence of a flag wins, as
 * `NodeControl.makeConfig` always promised.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parse = (args: ReadonlyArray<string> | Globals): Globals => {
  if ("rest" in args) return args
  const values: Record<(typeof valued)[keyof typeof valued], string | undefined> = {
    root: undefined,
    remote: undefined,
    credential: undefined,
    mcpConfig: undefined,
    backend: undefined,
    audience: undefined,
    format: undefined
  }
  const flags: Record<(typeof switches)[keyof typeof switches], boolean | undefined> = {
    json: undefined,
    quiet: undefined,
    silent: undefined,
    verbose: undefined
  }
  const rest: Array<string> = []
  const restIndices: Array<number> = []
  const options = new Map<string, string | boolean>()
  let first: number | undefined
  const keep = (index: number, word: string) => {
    first ??= index
    rest.push(word)
    restIndices.push(index)
  }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === "--") {
      keep(index, argument)
      for (let tail = index + 1; tail < args.length; tail++) keep(tail, args[tail]!)
      break
    }
    if (!argument.startsWith("-")) {
      keep(index, argument)
      continue
    }
    const separator = argument.indexOf("=")
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    const inline = separator === -1 ? undefined : argument.slice(separator + 1)
    if (flag in valued) {
      const name = valued[flag as keyof typeof valued]
      if (inline === undefined && index + 1 >= args.length) {
        keep(index, argument)
        continue
      }
      const value = inline ?? args[++index]!
      values[name] ??= value
      continue
    }
    const negated = flag.startsWith("--no-") ? `--${flag.slice(5)}` : undefined
    const switchName = flag in switches
      ? flag
      : negated !== undefined && negated in switches
      ? negated
      : undefined
    if (switchName === undefined) {
      keep(index, argument)
      let value: string | boolean = inline ?? true
      if (localValues.has(flag) && inline === undefined && index + 1 < args.length) {
        value = args[++index]!
        keep(index, value)
      }
      if (!options.has(flag)) options.set(flag, value)
      continue
    }
    const name = switches[switchName as keyof typeof switches]
    let value: boolean | undefined
    if (inline !== undefined) {
      value = Object.hasOwn(literals, inline) ? literals[inline] : undefined
      if (value === undefined || negated !== undefined) {
        keep(index, argument)
        continue
      }
    } else if (negated !== undefined) {
      value = false
    } else {
      const following = args[index + 1]
      const literal = following === undefined || !Object.hasOwn(literals, following) ? undefined : literals[following]
      if (literal !== undefined) index++
      value = literal ?? true
    }
    flags[name] ??= value
  }
  return {
    argv: args,
    restIndices,
    options,
    ...values,
    json: flags.json ?? false,
    quiet: flags.quiet ?? false,
    silent: flags.silent ?? false,
    verbose: flags.verbose ?? false,
    rest,
    first: first ?? args.length
  }
}

/**
 * The words one command line offers a verb lookup, in order.
 *
 * `rest` still holds every option the globals did not claim, so a reader that
 * wants the verb has to step over them. A valued option this pre-parser
 * recognizes takes its value with it; an unknown one is a switch, because
 * guessing an arity would swallow the verb standing behind it. Everything
 * after `--` is an argument, never a verb.
 *
 * @category parsing
 * @since 1.0.0
 */
export const words = (args: ReadonlyArray<string> | Globals): ReadonlyArray<string> => {
  const parsed = parse(args)
  const found: Array<string> = []
  for (let index = 0; index < parsed.rest.length; index++) {
    const word = parsed.rest[index]!
    if (word === "--") break
    if (!word.startsWith("-")) {
      found.push(word)
      continue
    }
    if (word.includes("=")) continue
    if (typeof parsed.options.get(word) === "string") index++
  }
  return found
}
