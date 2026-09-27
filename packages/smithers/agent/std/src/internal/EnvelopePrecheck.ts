/**
 * The hermetic pre-check: a lexical scan of shell text for the paths it names,
 * and the refusal when one of them falls outside the declared envelope.
 *
 * The scan is fail-closed over explicit path tokens and nothing more. It
 * cannot prove confinement — a shell can name a path no lexer sees, through a
 * variable, a substitution, or a program that opens a file of its own — so a
 * kernel or host sandbox must eventually enforce and report the complete read
 * and write sets.
 *
 * It lives beside the flow rather than inside it because it is its own
 * concept, with its own vocabulary (Access, PathReference) and its own
 * security history: three independent bypasses, each sufficient on its own to
 * defeat it, are closed here.
 *
 * @since 1.0.0
 */

import type * as Path from "@smthrs/kernel/Path"
import * as StdError from "../StdError.ts"
import { withinEnvelope } from "./Paths.ts"

/**
 * The filesystem envelope one invocation declared.
 *
 * Structural rather than the hermetic `Bash.Input` itself: the scan needs the
 * three fields and none of the rest, and depending on the flow module would
 * make the flow and its pre-check import each other.
 *
 * @category models
 * @since 1.0.0
 */
export interface Envelope {
  readonly cwd?: string | undefined
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
}

/**
 * How a command touches a path it names.
 *
 * @category models
 * @since 1.0.0
 */
export type Access = "read" | "write"

/**
 * One path a command names, and how it touches it.
 *
 * @category models
 * @since 1.0.0
 */
export interface PathReference {
  readonly access: Access
  readonly value: string
}

const commandSeparators = new Set(["&&", "||", ";", "|", "&", "\n"])
const redirections = new Set([">", ">>", "<", "<<"])
const writeCommands = new Set(["chmod", "chown", "mkdir", "rm", "rmdir", "tee", "touch", "truncate", "unlink"])
const destinationCommands = new Set(["cp", "install", "mv"])
const prefixWrappers = new Set(["env", "nice", "time", "sudo", "nohup", "xargs", "command", "exec"])

// Shell spaces may disappear, but a physical line ends one command. Retaining
// LF prevents a command on line one from classifying every later line's paths.
//
// A word is one or more runs of bare characters and quoted sections, not a
// bare run alone: `FOO="a b" rm /work/target` used to tokenize as `FOO="a`,
// `b"`, `rm`, `/work/target`, and since only the first token carried an `=`
// the command was read as `b"` rather than `rm` — so the delete was
// classified as a read and a hermetic call with `writes: []` spawned. The
// quoted alternatives come first inside the group so a quoted span is taken
// whole; the bare class excludes quotes so the branches cannot overlap.
const tokenize = (command: string): ReadonlyArray<string> =>
  command.match(/\n|>>|<<|&&|\|\||[<>;|&]|(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s<>;|&"']+)+/g) ?? []

const unquote = (token: string): string => {
  const first = token[0]
  const last = token[token.length - 1]
  return token.length >= 2 && (first === "'" || first === "\"") && last === first
    ? token.slice(1, -1)
    : token
}

const pathValue = (token: string): string =>
  unquote(token)
    .replace(/^\$\(+/, "")
    .replace(/[),]+$/, "")

const isPathToken = (path: Path.Path, token: string): boolean =>
  token === "." ||
  token === ".." ||
  token.startsWith("./") ||
  token.startsWith("../") ||
  path.isAbsolute(token) ||
  /^[A-Za-z]:[\\/]/.test(token) ||
  token.includes("/")

const segmentReferences = (path: Path.Path, tokens: ReadonlyArray<string>): ReadonlyArray<PathReference> => {
  const commentIndex = tokens.findIndex((token) => token.startsWith("#"))
  const active = commentIndex === -1 ? tokens : tokens.slice(0, commentIndex)
  const hasWrapper = active.some((token) => prefixWrappers.has(path.basename(pathValue(token))))
  let commandIndex = active.findIndex((token) =>
    !redirections.has(token) &&
    !token.includes("=") &&
    !prefixWrappers.has(path.basename(pathValue(token))) &&
    !token.startsWith("-") &&
    token !== ""
  )
  if (hasWrapper) {
    // Wrapper options can carry their own values. Prefer a later known
    // mutating command so an option value cannot lend it a read classification.
    const mutatingIndex = active.findIndex((token) => {
      const command = path.basename(pathValue(token))
      return writeCommands.has(command) || destinationCommands.has(command)
    })
    if (mutatingIndex !== -1) commandIndex = mutatingIndex
  }
  if (commandIndex === -1) return []

  const command = path.basename(pathValue(active[commandIndex]!))
  const candidates: Array<{ readonly index: number; readonly value: string }> = []
  for (let index = 0; index < active.length; index++) {
    const token = active[index]!
    if (index === commandIndex || redirections.has(token) || token.startsWith("-")) continue
    const value = pathValue(token)
    if (value !== "" && isPathToken(path, value)) candidates.push({ index, value })
  }

  const destinationIndex = destinationCommands.has(command)
    ? candidates[candidates.length - 1]?.index
    : undefined

  return candidates.map(({ index, value }) => {
    const previous = active[index - 1]
    const access: Access = previous === ">" || previous === ">>" ||
        writeCommands.has(command) || destinationIndex === index
      ? "write"
      : "read"
    return { access, value }
  })
}

/**
 * Every path token the shell text names, one segment at a time.
 *
 * @category pre-check
 * @since 1.0.0
 */
export const commandReferences = (path: Path.Path, command: string): ReadonlyArray<PathReference> => {
  const references: Array<PathReference> = []
  let segment: Array<string> = []
  for (const token of tokenize(command)) {
    if (commandSeparators.has(token)) {
      references.push(...segmentReferences(path, segment))
      segment = []
    } else {
      segment.push(token)
    }
  }
  references.push(...segmentReferences(path, segment))
  return references
}

const resolvePath = (
  path: Path.Path,
  cwd: string,
  value: string
): string => path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value)

const isDeclared = (
  path: Path.Path,
  cwd: string,
  declared: ReadonlyArray<string>,
  source: string
): boolean =>
  withinEnvelope(
    declared.map((entry) => resolvePath(path, cwd, entry)),
    resolvePath(path, cwd, source)
  )

/**
 * The refusal shell text earns by naming a path outside its declared
 * envelope, or `undefined` when every path it names is declared.
 *
 * @category pre-check
 * @since 1.0.0
 */
export const outsideEnvelope = (
  input: Envelope,
  text: string,
  path: Path.Path
): StdError.StdError | undefined => {
  const base = path.resolve(".")
  const cwd = path.resolve(input.cwd ?? ".")
  // Passing the default explicitly is not a declaration the caller owes. A
  // working directory is where the command runs, not a file it reads, and
  // `cwd: "."` names exactly what omitting `cwd` names — so refusing it asked
  // the caller to list the workspace root among its reads to say nothing at
  // all. Agents hit this constantly: one SWE-bench run spent ten of its
  // forty-eight tool calls re-issuing the same command after
  // "Working directory is outside declared reads: <the workspace root>". A
  // cwd that points somewhere else is still declared or refused.
  if (input.cwd !== undefined && cwd !== base && !isDeclared(path, cwd, input.reads, cwd)) {
    return new StdError.StdError({
      code: "outside_declared_reads",
      message: `Working directory is outside declared reads: ${cwd}`,
      path: cwd
    })
  }

  // The Shell contract currently has no sandbox or access-reporting surface.
  // This lexical scan is intentionally only a fail-closed pre-check for
  // explicit path tokens. It cannot prove confinement; a kernel/host sandbox
  // must eventually enforce and report the complete read and write sets.
  for (const reference of commandReferences(path, text)) {
    const resolved = resolvePath(path, cwd, reference.value)
    // /dev/* is the process plumbing every shell one-liner leans on:
    // `2>/dev/null`, `cat /dev/stdin`. Normalize first so a dot-dot segment
    // cannot disguise an ordinary filesystem path as process plumbing.
    if (resolved.startsWith("/dev/")) continue
    const declared = reference.access === "write" ? input.writes : input.reads
    if (!isDeclared(path, cwd, declared, resolved)) {
      const code = reference.access === "write" ? "outside_declared_writes" : "outside_declared_reads"
      return new StdError.StdError({
        code,
        message: `Command path is outside declared ${reference.access}s: ${resolved}`,
        path: resolved
      })
    }
  }
  return undefined
}
