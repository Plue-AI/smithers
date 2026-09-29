/**
 * `smthrs init`: the smallest project a flow can be run from.
 *
 * rc.0 scaffolds one thing, a markdown flow at `flows/<name>/flow.mdx`, and
 * makes one edit, adding `.flows/` to the repository's ignore file. The 0.x
 * ceremony, interactive agent selection, a workflow pack, a global
 * `~/.smithers` install, and skill installation as a side effect, is gone: seats
 * resolve from environment keys, and every side effect a command performs
 * without being asked is a side effect an operator has to undo.
 *
 * The one thing the scaffold reads from the host is its seat. `smthrs up`
 * cannot run a prompt flow that declares none, so a scaffold without a
 * `model:` line is a scaffold that is not launchable, which is what rc.0 first
 * shipped (release rehearsal). {@link defaultSeat} chooses it from
 * the same environment keys `smthrs doctor` reports.
 *
 * The ignore edit is idempotent and repository-scoped, carried over from the
 * 0.x `ensureRootGitignore` requirement: append once, never inside a
 * non-repository directory, and never a second time when a rule already
 * covers the path.
 *
 * @since 1.0.0
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import * as CliError from "./CliError.ts"
import * as Environment from "./Environment.ts"
import * as Project from "./Project.ts"
import { starterSeats } from "./Providers.ts"

/**
 * The ignore rule rc.0 state needs.
 *
 * @category constants
 * @since 1.0.0
 */
export const ignoreRule = ".flows/"

/**
 * What one ignore-file edit did.
 *
 * @category models
 * @since 1.0.0
 */
export type IgnoreStatus = "created" | "updated" | "unchanged" | "skipped"

/**
 * Explains why a proposed flow name cannot be used by `init`.
 *
 * Reach for this before presenting a usage error. It accepts one portable path
 * segment from the documented character set and otherwise returns a sentence
 * safe to show to the operator without creating any project state.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const nameProblem = (name: string): string | undefined => {
  const reason = (): string =>
    `a flow name is one path segment of letters, digits, '-' and '_'; got ${JSON.stringify(name)}`
  if (
    name === "" ||
    isAbsolute(name) ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /\p{Cc}/u.test(name) ||
    !/^[A-Za-z0-9_-]+$/.test(name)
  ) return reason()
  return undefined
}

/**
 * Whether a scaffold name passes {@link nameProblem}.
 *
 * Use this predicate when only a boolean is needed. Invalid input returns
 * `false`; callers that need the refusal sentence should use `nameProblem`.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const isValidName = (name: string): boolean => nameProblem(name) === undefined

/**
 * Whether a directory is the root of a repository whose ignore file is worth
 * editing.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isRepository = (root: string, exists: (path: string) => boolean = existsSync): boolean =>
  exists(join(root, ".git")) || exists(join(root, ".jj"))

/** Whether an existing ignore file already covers `.flows/`. */
const alreadyIgnored = (contents: string): boolean =>
  contents.split("\n").map((line) => line.trim()).some((line) =>
    line === ".flows" || line === ".flows/" || line === "/.flows" || line === "/.flows/"
  )

/**
 * Adds `.flows/` to the repository ignore file, once.
 *
 * Outside a git or jj repository this reports `skipped` and writes nothing: a
 * `.gitignore` in a directory that is not a repository is litter.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ensureIgnored = (root: string): IgnoreStatus => {
  if (!isRepository(root)) return "skipped"
  const file = join(root, ".gitignore")
  const block = `# Smithers run state\n${ignoreRule}\n`
  if (!existsSync(file)) {
    writeFileSync(file, block, "utf8")
    return "created"
  }
  const contents = readFileSync(file, "utf8")
  if (alreadyIgnored(contents)) return "unchanged"
  const separator = contents === "" || contents.endsWith("\n") ? "" : "\n"
  writeFileSync(file, `${contents}${separator}${block}`, "utf8")
  return "updated"
}

/**
 * The seat a scaffold declares, and the credential that chose it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Seat {
  /** The `model:` line's value. */
  readonly seat: string
  /** The environment variable that resolves it. */
  readonly variable: string
  /** Whether that variable is set in the environment `init` read. */
  readonly resolved: boolean
}

/**
 * The seat `smthrs init` writes into the scaffold.
 *
 * rc.0 resolves seats from environment keys, so the scaffold's seat is chosen
 * from the same keys `smthrs doctor` reports, in doctor's order. An `openai`
 * seat is credentialed by `OPENAI_API_KEY` or by the ChatGPT session
 * `SMITHERS_OPENAI_AUTH=chatgpt` selects, exactly as `NodeControl.seatResolver`
 * reads them.
 *
 * A directory with no provider key still gets a `model:` line. A scaffold
 * without one is not launchable at all: `smthrs up` on it answered `Run
 * run-1 was accepted but the executor did not take it` and left a run nothing
 * would ever drive (release rehearsal). With the line, the same
 * launch refuses by naming the key to set.
 *
 * @category constructors
 * @since 1.0.0
 */
export const defaultSeat = (
  environment: Environment.Source
): Seat => {
  const chatgpt = Environment.read(environment, "SMITHERS_OPENAI_AUTH") === "chatgpt"
  for (const [variable, seat] of starterSeats) {
    if ((environment[variable] ?? "") !== "") return { seat, variable, resolved: true }
    if (variable === "OPENAI_API_KEY" && chatgpt) {
      return { seat, variable: "SMITHERS_OPENAI_AUTH", resolved: true }
    }
  }
  const [variable, seat] = starterSeats[0]!
  return { seat, variable, resolved: false }
}

/** The YAML comment that says where the seat came from and how to replace it. */
const seatNote = (seat: Seat): string =>
  seat.resolved
    ? `# The model seat this flow runs on. \`smthrs init\` chose it from
# ${seat.variable}, the first provider credential this environment sets. Change
# the line to run somewhere else; \`smthrs doctor\` lists the keys it reads.`
    : `# The model seat this flow runs on. No provider credential was set when
# \`smthrs init\` ran, so this is the default: set ${seat.variable}, or change
# the line to a seat you have a key for. \`smthrs doctor\` lists them.`

/**
 * The scaffolded flow body.
 *
 * Markdown, not TypeScript: `flow.mdx` needs no build step, no import
 * resolution, and no dependency on the package layout of the project it lands
 * in, so `smthrs flow start <name>` works in the directory `init` just created.
 *
 * The seat is a frontmatter comment rather than prose, because every line of
 * the markdown body below the frontmatter is an instruction the agent is
 * handed.
 *
 * @category constructors
 * @since 1.0.0
 */
export const template = (name: string, seat: Seat): string =>
  `---
description: A starter Smithers flow.
# The starter reads and edits files and runs the project's tests. Narrow these
# capabilities to the task before running it; proc:spawn permits shell commands.
capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*"]
${seatNote(seat)}
model: ${seat.seat}
---

# ${name}

Describe the work in prose. Headings organize the instructions given to the
agent; they do not create separate durable steps or enforce execution order.

## Read the request

Summarise what was asked for, and list the files that answer it.

## Do the work

Make the change. Keep it small enough to review in one sitting.

## Check the work

Run the project's tests and report what passed.
`

/**
 * What `smthrs init` created.
 *
 * @category models
 * @since 1.0.0
 */
export interface Scaffolded {
  readonly name: string
  readonly flowFile: string
  readonly created: boolean
  readonly gitignore: IgnoreStatus
  /** The state directory this project's runs will use. */
  readonly stateDirectory: string
  /** The model seat the scaffolded flow declares. */
  readonly seat: string
}

/**
 * Scaffolds `flows/<name>/flow.mdx` and ignores `.flows/`.
 *
 * An existing flow file is left exactly as it is: `init` is a starting point,
 * not an overwrite, and a second `init` in a project that already has flows
 * must not destroy one.
 *
 * @category constructors
 * @since 1.0.0
 */
export const scaffold = (
  root: string,
  name: string,
  environment: Environment.Source
): Scaffolded => {
  const problem = nameProblem(name)
  if (problem !== undefined) throw new CliError.UsageError({ message: problem })
  const directory = join(root, "flows", name)
  const flowFile = join(directory, "flow.mdx")
  const seat = defaultSeat(environment)
  const exists = existsSync(flowFile)
  if (!exists) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(flowFile, template(name, seat), "utf8")
  }
  // The empty state directory is the project's anchor. `Project.root` treats
  // `.flows/` as proof on its own and a bare `flows/` only beside a project
  // marker, so a scaffold in a plain directory that is neither a package nor a
  // repository would otherwise resolve a different root from every
  // subdirectory, which is the one failure `init` exists to prevent.
  const stateDirectory = Project.stateDirectory(root)
  mkdirSync(stateDirectory, { recursive: true })
  return { name, flowFile, created: !exists, gitignore: ensureIgnored(root), stateDirectory, seat: seat.seat }
}

/**
 * The default flow name, taken from the project directory.
 *
 * @category constructors
 * @since 1.0.0
 */
export const defaultName = (root: string): string => {
  const base = root.split(/[/\\]/).filter((part) => part !== "").at(-1) ?? "flow"
  const slug = base.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").replaceAll(/^-+|-+$/g, "")
  return slug === "" ? "flow" : slug
}
