/**
 * Shared pre-parser globals. The declaration coverage test pins this table to
 * Command's root flags and ControlBridge's connection options.
 * @since 1.0.0
 */

import { Cli, z } from "incur"

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

/** Parser output adds transport metadata without narrowing the existing Globals input contract. */
interface ParsedGlobals extends Globals {
  /** Equivalent options with opaque values protected from Incur built-in extraction. */
  readonly incurArgv: ReadonlyArray<string>
  /** Actual stdio transport selection, excluding opaque option values and literal tails. */
  readonly mcp: boolean
}

const isParsed = (args: Globals): args is ParsedGlobals =>
  "incurArgv" in args && Array.isArray(args.incurArgv) && "mcp" in args && typeof args.mcp === "boolean"

const valued = {
  "--root": "root",
  "--remote": "remote",
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
  "--verbose": "verbose",
  "--mcp": "mcp"
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
  "--scope",
  "--filter-output",
  "--token-limit",
  "--token-offset"
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
export const parse = (args: ReadonlyArray<string> | Globals, cli?: object): ParsedGlobals => {
  if ("rest" in args) {
    if (isParsed(args)) return args
    args = args.argv
  }
  const values: Record<(typeof valued)[keyof typeof valued], string | undefined> = {
    root: undefined,
    remote: undefined,
    mcpConfig: undefined,
    backend: undefined,
    audience: undefined,
    format: undefined
  }
  const flags: Record<(typeof switches)[keyof typeof switches], boolean | undefined> = {
    json: undefined,
    quiet: undefined,
    silent: undefined,
    verbose: undefined,
    mcp: undefined
  }
  const incurArgv: Array<string> = []
  let scope = cli === undefined ? undefined : Cli.toCommands.get(cli as never)
  const arities = new Map<string, boolean>([...localValues].map((flag) => [flag, true]))
  const names = new Map<string, string>([["-w", "--workspace"]])
  const declare = (
    schema: z.ZodObject<any> | undefined,
    aliases?: Partial<Record<string | number | symbol, string>>
  ) => {
    const shape: Record<string, z.ZodType> = schema?.shape ?? {}
    for (const [name, field] of Object.entries(shape)) {
      let base = field
      while ("innerType" in base.def && base.def.innerType !== undefined) base = base.def.innerType as z.ZodType
      const takesValue = !(base instanceof z.ZodBoolean) && field.meta()?.["count"] !== true
      arities.set(`--${name}`, takesValue)
      arities.set(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, takesValue)
      if (aliases?.[name] !== undefined) {
        arities.set(`-${aliases[name]}`, takesValue)
        names.set(`-${aliases[name]}`, `--${name}`)
      }
    }
  }
  if (cli !== undefined) declare(Cli.toRootOptions.get(cli as never))
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
      incurArgv.push(...args.slice(index))
      keep(index, argument)
      for (let tail = index + 1; tail < args.length; tail++) keep(tail, args[tail]!)
      break
    }
    if (!argument.startsWith("-")) {
      const found = scope?.get(argument)
      const entry = found !== undefined && "_alias" in found ? scope?.get(found.target) : found
      if (entry !== undefined) {
        if ("_group" in entry) {
          scope = entry.commands
          declare(entry.root?.options, entry.root?.alias)
        } else {
          scope = undefined
          if ("options" in entry) declare(entry.options, entry.alias)
        }
      }
      incurArgv.push(argument)
      keep(index, argument)
      continue
    }
    const separator = argument.indexOf("=")
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    const inline = separator === -1 ? undefined : argument.slice(separator + 1)
    if (flag in valued) {
      const name = valued[flag as keyof typeof valued]
      if (inline === undefined && index + 1 >= args.length) {
        incurArgv.push(argument)
        keep(index, argument)
        continue
      }
      const value = inline ?? args[++index]!
      values[name] ??= value
      // Incur's format extractor accepts only the spaced spelling and consumes
      // its value itself. All other values must be opaque to that extractor.
      incurArgv.push(...(flag === "--format" ? [flag, value] : [`${flag}=${value}`]))
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
      // Incur supports stacked boolean/count aliases with a valued alias last.
      // Use the same declared arities; its parser retains syntax validation.
      const aliases = !flag.startsWith("--") && inline === undefined ? [...flag.slice(1)].map((name) => `-${name}`) : []
      const stack = aliases.length > 1 && aliases.slice(0, -1).every((name) => arities.get(name) === false) &&
          arities.get(aliases.at(-1)!) === true ?
        aliases :
        undefined
      const normalized = stack?.at(-1) ?? flag
      const takesValue = arities.get(normalized) === true
      if (takesValue && inline === undefined && index + 1 < args.length) {
        value = args[++index]!
        keep(index, value)
      }
      if (!options.has(flag)) options.set(flag, value)
      if (typeof value === "string" && inline === undefined) {
        incurArgv.push(...(stack?.slice(0, -1).map((name) => names.get(name) ?? name) ?? []))
        incurArgv.push(
          ...(["--filter-output", "--token-limit", "--token-offset"].includes(flag)
            ? [flag, value]
            : [`${names.get(normalized) ?? normalized}=${value}`])
        )
      } else incurArgv.push(argument)
      continue
    }
    const name = switches[switchName as keyof typeof switches]
    const switchIndex = index
    let value: boolean | undefined
    if (inline !== undefined) {
      value = Object.hasOwn(literals, inline) ? literals[inline] : undefined
      if (value === undefined || negated !== undefined) {
        incurArgv.push(argument)
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
    if (name !== "mcp") incurArgv.push(...args.slice(switchIndex, index + 1))
  }
  return {
    argv: args,
    incurArgv: flags.mcp ? ["--mcp", ...incurArgv] : incurArgv,
    mcp: flags.mcp ?? false,
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
