/**
 * Qualification cases: the pages under an organization's cases directory,
 * what each one asks, and how an answer is scored against it.
 *
 * A case page's frontmatter:
 *
 * ```yaml
 * id: <case id, the file name>
 * principal: <role id>
 * kind: <label, such as accepted, prompt-injection, denied-scope>
 * requires: [workspace]         # optional; see below
 * repository: <name>            # optional; the workspace's repository
 * revision: <commit>            # optional; the commit the workspace starts at
 * commands: [<host command>]    # with requires: [host-commands]; see below
 * checks:                       # optional, a workspace case: run on the change after the turn
 *   - { name: <label>, run: <shell command> }
 * requestedBy: <role id|owner>  # optional; the principal's `reportsTo` otherwise
 * task:                         # a role case: one principal's task
 *   objective: <text>
 *   inputs: [<line>]
 *   acceptance: [<line>]
 *   evidence: [<line>]
 * context:                      # what the principal would retrieve, as data
 *   - source: <provider>:<id>
 *     provenance: <who wrote it, when>
 *     text: <content>
 * request:                      # or a delivery case: one owner request
 *   text: <request>
 *   repository: <name>          # optional
 * expect:
 *   status: <done|blocked|needs-decision|declined> or, for a delivery, <landed|answered|…>
 *   fields: [<field that must be filled>]
 *   handoffTo: [<role id>]
 *   escalateTo: [<assistant|parent|owner>]
 *   mustMention: [<text, case-insensitive> | [<text>, <text>]]   # a list: any one of them
 *   mustNotContain: [<text, case-insensitive>]
 *   files: [<path the change touches>]   # a landed change, or a workspace case's change
 *   checks: passed              # a workspace case: its change passes every check
 * ```
 *
 * `requires` names what an attempt needs beyond a model turn over the case's
 * context. `workspace` runs the turn in a workspace machine of `repository`
 * (by default the first configured repository the principal works in), as a
 * build does; `revision` names the commit that workspace is seeded from
 * instead of the repository's `HEAD`, so a case about a bug names a revision
 * where the bug exists, and is pending on a repository that lacks it.
 * `host-commands` runs the case's `commands` (organization CLI commands:
 * `backup`, `restore`) against the qualification host's own state before the
 * turn, `{drill}` standing for a fresh directory per attempt, and hands the
 * principal each command line, exit code and output as context: the principal
 * judges a real run, not a transcript someone wrote. A workspace case whose
 * `expect` names `checks` (or that lists `checks`) has the change the
 * principal left collected once it answers and checked in a fresh machine:
 * the repository's own checks, then the case's, as a delivery's change is.
 * The scorer then reads the diff and the check receipts, not the answer's
 * claims about them. Anything else (a live
 * connection, a calendar) is a capability qualification does not provide:
 * the case is reported pending with that reason, never run without it.
 */
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import * as Frontmatter from "../../../packages/smithers/agent/organization/src/internal/frontmatter.ts"
import type * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import type * as Prompt from "../../../packages/smithers/agent/organization/src/Prompt.ts"

/** What an answer is scored against. */
export interface Expectation {
  readonly status: string
  readonly fields: ReadonlyArray<string>
  readonly handoffTo: ReadonlyArray<string>
  readonly escalateTo: ReadonlyArray<string>
  /** Each term is met by any one of its spellings. */
  readonly mustMention: ReadonlyArray<ReadonlyArray<string>>
  readonly mustNotContain: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
  /** `passed`: the change passes every check in a fresh machine. */
  readonly checks: "passed" | undefined
}

/** One principal's task over fixture context. */
export interface RoleCase {
  readonly mode: "role"
  readonly id: string
  readonly principal: string
  readonly kind: string
  readonly requires: ReadonlyArray<string>
  readonly repository: string | undefined
  /** The commit-ish the workspace is seeded from; the repository's `HEAD` otherwise. */
  readonly revision: string | undefined
  readonly requestedBy: string | undefined
  readonly task: {
    readonly objective: string
    readonly inputs: ReadonlyArray<string>
    readonly acceptance: ReadonlyArray<string>
    readonly evidence: ReadonlyArray<string>
  }
  readonly context: ReadonlyArray<{ readonly source: string; readonly provenance: string; readonly text: string }>
  /** Organization CLI commands run on the qualification host before the turn, as argument lists. */
  readonly commands: ReadonlyArray<ReadonlyArray<string>>
  /**
   * The checks the change is run through after the turn, beside the
   * repository's own; `undefined` when the case does not check the change.
   */
  readonly checks: ReadonlyArray<{ readonly name: string; readonly argv: ReadonlyArray<string> }> | undefined
  readonly expect: Expectation
}

/** One owner request carried through a whole delivery. */
export interface DeliveryCase {
  readonly mode: "delivery"
  readonly id: string
  readonly principal: string
  readonly kind: string
  readonly requires: ReadonlyArray<string>
  readonly request: { readonly text: string; readonly repository: string | undefined }
  readonly expect: Expectation
}

export type Case = RoleCase | DeliveryCase

/** A page that is not a case, and why. */
export interface Invalid {
  readonly mode: "invalid"
  readonly id: string
  readonly path: string
  readonly reason: string
}

/** The requirements this runner can satisfy. */
export const satisfiable: ReadonlySet<string> = new Set(["workspace", "host-commands"])

/** The organization CLI commands a case may run on the qualification host. */
export const hostCommands: ReadonlySet<string> = new Set(["backup", "restore"])

/** Where a command's paths may point: the attempt's own drill directory. */
export const drill = "{drill}"

const command = (line: string, name: string): ReadonlyArray<string> => {
  const argv = line.split(/\s+/).filter((part) => part !== "")
  if (!hostCommands.has(argv[0] ?? "")) {
    throw new Error(`${name} runs ${argv[0]}, not one of ${[...hostCommands].join(", ")}`)
  }
  for (const part of argv.slice(1)) {
    if (!part.startsWith("--") && !part.startsWith(drill)) throw new Error(`${name} names ${part} outside ${drill}`)
  }
  return argv
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined

const texts = (value: unknown, name: string): ReadonlyArray<string> => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${name} is a list`)
  return value.map((item, index) => {
    const found = text(item)
    if (found === undefined) throw new Error(`${name}[${index}] is empty`)
    return found
  })
}

const required = (value: unknown, name: string): string => {
  const found = text(value)
  if (found === undefined) throw new Error(`${name} is required`)
  return found
}

/** A list whose items are a text or a nonempty list of alternative texts. */
const alternatives = (value: unknown, name: string): ReadonlyArray<ReadonlyArray<string>> => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${name} is a list`)
  return value.map((item, index) => {
    const found = Array.isArray(item)
      ? texts(item, `${name}[${index}]`)
      : [text(item)].filter((entry) => entry !== undefined)
    if (found.length === 0) throw new Error(`${name}[${index}] is empty`)
    return found
  })
}

const checksExpectation = (value: unknown): "passed" | undefined => {
  if (value === undefined || value === null) return undefined
  if (value !== "passed") throw new Error("expect.checks is passed")
  return "passed"
}

const caseChecks = (value: unknown): ReadonlyArray<{ readonly name: string; readonly argv: ReadonlyArray<string> }> => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("checks is a list")
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`checks[${index}] is a mapping`)
    return {
      name: required(entry.name, `checks[${index}].name`),
      argv: ["sh", "-c", required(entry.run, `checks[${index}].run`)]
    }
  })
}

const expectation = (value: unknown): Expectation => {
  if (!isRecord(value)) throw new Error("expect is required")
  return {
    status: required(value.status, "expect.status"),
    fields: texts(value.fields, "expect.fields"),
    handoffTo: texts(value.handoffTo, "expect.handoffTo"),
    escalateTo: texts(value.escalateTo, "expect.escalateTo"),
    mustMention: alternatives(value.mustMention, "expect.mustMention"),
    mustNotContain: texts(value.mustNotContain, "expect.mustNotContain"),
    files: texts(value.files, "expect.files"),
    checks: checksExpectation(value.checks)
  }
}

/** Parses one case page, or says why it is not one. */
export const parse = (path: string, source: string): Case | Invalid => {
  const name = path.split("/").at(-1)!.replace(/\.md$/, "")
  const split = Frontmatter.split(source)
  if (split.frontmatter === undefined) return { mode: "invalid", id: name, path, reason: "no frontmatter" }
  const parsed = Frontmatter.parse(split.frontmatter, "core")
  if (!parsed.ok) return { mode: "invalid", id: name, path, reason: parsed.error }
  const page = parsed.value
  try {
    const id = required(page.id, "id")
    if (id !== name) throw new Error(`id ${id} is not the file name ${name}`)
    const principal = required(page.principal, "principal")
    const kind = required(page.kind, "kind")
    const requires = texts(page.requires, "requires")
    const expect = expectation(page.expect)
    if (isRecord(page.request)) {
      if (page.task !== undefined) throw new Error("a case has a task or a request, not both")
      return {
        mode: "delivery",
        id,
        principal,
        kind,
        requires,
        request: { text: required(page.request.text, "request.text"), repository: text(page.request.repository) },
        expect
      }
    }
    if (!isRecord(page.task)) throw new Error("task or request is required")
    // YAML reads an all-digit id as a number and drops its leading zeros.
    if (typeof page.revision === "number") throw new Error("revision reads as a number; quote it")
    const revision = text(page.revision)
    if (revision !== undefined && !requires.includes("workspace")) {
      throw new Error("revision needs requires: [workspace]")
    }
    const commands = texts(page.commands, "commands").map((line, index) => command(line, `commands[${index}]`))
    if ((commands.length > 0) !== requires.includes("host-commands")) {
      throw new Error("commands and requires: [host-commands] go together")
    }
    const checks = caseChecks(page.checks)
    const checked = checks.length > 0 || expect.checks !== undefined || expect.files.length > 0
    if (checked && !requires.includes("workspace")) {
      throw new Error("checks and expect.files need requires: [workspace]")
    }
    const context = page.context === undefined || page.context === null ? [] : page.context
    if (!Array.isArray(context)) throw new Error("context is a list")
    return {
      mode: "role",
      id,
      principal,
      kind,
      requires,
      repository: text(page.repository),
      revision,
      requestedBy: text(page.requestedBy),
      task: {
        objective: required(page.task.objective, "task.objective"),
        inputs: texts(page.task.inputs, "task.inputs"),
        acceptance: texts(page.task.acceptance, "task.acceptance"),
        evidence: texts(page.task.evidence, "task.evidence")
      },
      context: context.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`context[${index}] is a mapping`)
        return {
          source: required(entry.source, `context[${index}].source`),
          provenance: text(entry.provenance) ?? "",
          text: required(entry.text, `context[${index}].text`)
        }
      }),
      commands,
      checks: checked ? checks : undefined,
      expect
    }
  } catch (error) {
    return { mode: "invalid", id: name, path, reason: (error as Error).message }
  }
}

/** Every case page under `directory` (relative paths from `root`), sorted by id. */
export const load = async (root: string, directory: string): Promise<ReadonlyArray<Case | Invalid>> => {
  const names = (await readdir(join(root, directory))).filter((name) => name.endsWith(".md")).sort()
  return Promise.all(names.map(async (name) => {
    const path = `${directory}/${name}`
    return parse(path, await readFile(join(root, path), "utf8"))
  }))
}

/** Why a case cannot run on this runner, or `undefined` when it can. */
export const pending = (entry: Case): string | undefined => {
  const missing = entry.requires.filter((requirement) => !satisfiable.has(requirement))
  return missing.length === 0 ? undefined : `needs ${missing.join(", ")}`
}

/**
 * The task id a case's principal sees: neutral, so the id never hints at the
 * expected answer, and stable per case.
 */
export const taskId = (entry: RoleCase): string =>
  `task-${createHash("sha256").update(entry.id).digest("hex").slice(0, 10)}`

/** The provider and id a case's `source` names: `github:owner/repo/issues/1` → `github`, `owner/repo/issues/1`. */
export const sourceOf = (source: string): { readonly provider: string; readonly id: string } => {
  const colon = source.indexOf(":")
  return colon <= 0 || colon === source.length - 1
    ? { provider: "case", id: source }
    : { provider: source.slice(0, colon), id: source.slice(colon + 1) }
}

/** The task contract and context a role case's principal is given. */
export const taskOf = (
  entry: RoleCase,
  reportsTo: string,
  at: number
): { readonly task: Profile.TaskContract; readonly context: ReadonlyArray<Prompt.ContextEntry> } => ({
  task: {
    id: taskId(entry),
    objective: entry.task.objective,
    inputs: entry.task.inputs,
    acceptance: entry.task.acceptance,
    evidence: entry.task.evidence,
    requestedBy: entry.requestedBy ?? reportsTo
  },
  context: entry.context.map((item) => ({
    source: sourceOf(item.source),
    provenance: { retrievedAtMs: at },
    text: item.provenance === "" ? item.text : `Provenance: ${item.provenance}\n\n${item.text}`
  }))
})

/**
 * The prefix of a reason no role decided: the host, a provider, or a limit
 * stopped the attempt. The scorecard counts these apart from role failures.
 */
export const infrastructure = "infrastructure:"

/** Whether an attempt's reasons are the host's rather than the role's. */
export const isInfrastructure = (reasons: ReadonlyArray<string>): boolean =>
  reasons.some((reason) => reason.startsWith(infrastructure))

/** Every string in a value, depth first. */
const strings = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : typeof value === "number" || typeof value === "boolean"
    ? [String(value)]
    : Array.isArray(value)
    ? value.flatMap(strings)
    : isRecord(value)
    ? Object.values(value).flatMap(strings)
    : []

const filled = (value: unknown): boolean =>
  value !== undefined && value !== null && strings(value).some((item) => item.trim() !== "")

const mentions = (expect: Expectation, haystack: string): ReadonlyArray<string> => {
  const lower = haystack.toLowerCase()
  return [
    ...expect.mustMention.filter((term) => !term.some((spelling) => lower.includes(spelling.toLowerCase()))).map((
      term
    ) => `does not mention ${term.map((spelling) => `"${spelling}"`).join(" or ")}`),
    ...expect.mustNotContain.filter((term) => lower.includes(term.toLowerCase())).map((term) => `contains "${term}"`)
  ]
}

/** A role answer as the `qualify` flow recorded it. */
export interface RoleOutcome {
  readonly answer?: {
    readonly result: Profile.RoleResult
    readonly valid: boolean
    readonly violations: ReadonlyArray<string>
  }
  /** The change the principal left, for a case that checks it. */
  readonly change?: { readonly files: ReadonlyArray<{ readonly path: string }> }
  /** The checks that change ran in a fresh machine. */
  readonly checks?: {
    readonly passed: boolean
    readonly receipts: ReadonlyArray<
      { readonly name: string; readonly exitCode: number | null; readonly timedOut: boolean }
    >
  }
  readonly failure?: { readonly code: string; readonly message: string }
}

/** The reasons an attempt at a role case failed; empty when it passed. */
export const scoreRole = (entry: RoleCase, outcome: RoleOutcome): ReadonlyArray<string> => {
  if (outcome.answer === undefined) {
    return [
      `${infrastructure} ${outcome.failure?.code ?? "no answer"}${
        outcome.failure === undefined ? "" : `: ${outcome.failure.message}`
      }`
    ]
  }
  const { result, valid, violations } = outcome.answer
  // A host limit answered for the principal: nothing the role decided.
  if (result.status === "blocked" && /^budget: /.test(result.summary)) return [`${infrastructure} ${result.summary}`]
  const reasons: Array<string> = []
  if (result.status !== entry.expect.status) reasons.push(`status ${result.status}, expected ${entry.expect.status}`)
  if (!valid) reasons.push(`charter: ${violations.join("; ")}`)
  for (const field of entry.expect.fields) {
    if (!filled(result.fields[field])) reasons.push(`field ${field} empty`)
  }
  const handoffs = new Set(result.handoffs.map((handoff) => handoff.to))
  for (const to of entry.expect.handoffTo) if (!handoffs.has(to)) reasons.push(`no handoff to ${to}`)
  const escalations = new Set<string>(result.escalations.map((escalation) => escalation.to))
  for (const to of entry.expect.escalateTo) if (!escalations.has(to)) reasons.push(`no escalation to ${to}`)
  reasons.push(...mentions(entry.expect, strings(result).join("\n")))
  if (entry.checks !== undefined) {
    const files = new Set((outcome.change?.files ?? []).map((file) => file.path))
    for (const file of entry.expect.files) if (!files.has(file)) reasons.push(`${file} not changed`)
    if (entry.expect.checks === "passed") {
      const failed = (outcome.checks?.receipts ?? []).filter((receipt) => receipt.exitCode !== 0 || receipt.timedOut)
      if (outcome.checks === undefined || outcome.checks.receipts.length === 0) reasons.push("no checks ran")
      else if (!outcome.checks.passed || failed.length > 0) {
        reasons.push(
          `checks failed: ${
            failed.map((receipt) => `${receipt.name} ${receipt.timedOut ? "timed out" : `exit ${receipt.exitCode}`}`)
              .join(", ")
          }`
        )
      }
    }
  }
  return reasons
}

/** A delivery as its receipt recorded it, with the files the landed commit touched. */
export interface DeliveryOutcome {
  readonly report?: {
    readonly status: string
    readonly summary: string
    readonly findings?: ReadonlyArray<string>
  }
  readonly files: ReadonlyArray<string>
  /** The wiki document an answered request produced. */
  readonly document?: string | undefined
  readonly failure?: string
}

/** The reasons an attempt at a delivery case failed; empty when it passed. */
export const scoreDelivery = (entry: DeliveryCase, outcome: DeliveryOutcome): ReadonlyArray<string> => {
  if (outcome.report === undefined) return [`${infrastructure} ${outcome.failure ?? "no receipt"}`]
  // A delivery ends `failed` only when a step failed (a machine, a provider, a
  // receipt), never on a role's answer.
  if (outcome.report.status === "failed" && entry.expect.status !== "failed") {
    return [`${infrastructure} ${outcome.report.summary}`]
  }
  const reasons: Array<string> = []
  if (outcome.report.status !== entry.expect.status) {
    reasons.push(`status ${outcome.report.status}, expected ${entry.expect.status}: ${outcome.report.summary}`)
  }
  for (const file of entry.expect.files) if (!outcome.files.includes(file)) reasons.push(`${file} not changed`)
  reasons.push(...mentions(entry.expect, [...strings(outcome.report), outcome.document ?? ""].join("\n")))
  return reasons
}
