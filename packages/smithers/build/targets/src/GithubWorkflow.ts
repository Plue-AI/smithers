/**
 * Reading and rendering GitHub Actions workflow files.
 *
 * A generated CI pipeline is only worth anything if it still runs the gates
 * the repository requires. `GithubCiGen` used to render five hard-coded steps
 * whose whole pipeline was one `pnpm dlx @smthrs/build-cli ci //...` invocation, and it
 * declared `.github/workflows/ci.yml` as its output — so building the root
 * target replaced a multi-job pipeline (typecheck, lint, circular-dependency
 * guard, browser bundle gate, release pack smoke test, Rust fmt/clippy/test,
 * WASM reproducibility, Bun, macOS, Windows) with a single job that ran none
 * of them.
 *
 * This module supplies the two halves of the fix: a renderer that can express a
 * real multi-job pipeline rather than a fixed five-step one, and a workflow
 * reader, so the rendered pipeline can be checked against the gates the
 * repository declared before a single byte is written.
 *
 * The reader is two layers. YAML lexing and structure come from `yaml`, the
 * parser this package already depends on and already reads workspace data
 * with; a hand-written scanner used to do that job and carried its own
 * quoting, indentation, and block-scalar rules, which is where its bugs lived.
 * On top of it sits the part that is this module's own: a workflow validator
 * that refuses anything the gate contract cannot verify — a YAML alias or
 * merge key, an inherited `defaults:` shell, a duplicate top-level key, job
 * id, job field, or step field, a job with no runner or no steps, a step that
 * declares neither or both of `uses` and `run`. Failing closed is the point: a
 * gate this module could not see is reported missing, never assumed present.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import { Buffer } from "node:buffer"
import * as Yaml from "yaml"

/**
 * Maximum encoded workflow size accepted by the structural parser.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumWorkflowBytes = 1024 * 1024

/**
 * One step of a workflow job.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowStep {
  readonly name: string | undefined
  /** The step's `id:`, which a later step's `steps.<id>` expression reads. */
  readonly id: string | undefined
  readonly uses: string | undefined
  readonly run: string | undefined
  /** The declared run shell, or `undefined` for the GitHub runner default. */
  readonly shell: string | undefined
  /** The raw `if:` expression, or `undefined` when the step declares none. */
  readonly condition: string | undefined
  /** The raw `continue-on-error:` value, or `undefined` when unset. */
  readonly continueOnError: string | undefined
}

/**
 * One job of a workflow.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowJob {
  readonly id: string
  readonly name: string | undefined
  readonly runsOn: string | undefined
  /** A reusable workflow reference, for a job that delegates with `uses:`. */
  readonly uses: string | undefined
  /** The raw `if:` expression, or `undefined` when the job declares none. */
  readonly condition: string | undefined
  /** The raw `continue-on-error:` value, or `undefined` when unset. */
  readonly continueOnError: string | undefined
  readonly steps: ReadonlyArray<WorkflowStep>
}

/**
 * A parsed workflow file.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workflow {
  readonly name: string | undefined
  readonly jobs: ReadonlyArray<WorkflowJob>
}

/**
 * Why a workflow file was refused.
 *
 * `too_large` is a source over {@link maximumWorkflowBytes}; `invalid_yaml`
 * is a structural YAML error; `unsupported` is a construct the gate scanner
 * will not follow (an alias, a merge, an inherited `defaults:`); `duplicate`
 * is a repeated key, job id, or event; `missing` is an absent trigger, job,
 * runner, or step; `invalid_shape` is any other value of the wrong shape.
 *
 * @category models
 * @since 0.1.0
 */
export const WorkflowParseReason = Schema.Literals([
  "too_large",
  "invalid_yaml",
  "unsupported",
  "duplicate",
  "missing",
  "invalid_shape"
])

/**
 * Why a workflow file was refused.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkflowParseReason = typeof WorkflowParseReason.Type

/**
 * A workflow file could not be read as a GitHub Actions workflow.
 *
 * The message is `line {line}: {detail}`.
 *
 * @category errors
 * @since 0.1.0
 */
export class WorkflowParseError extends Schema.TaggedError<WorkflowParseError>()(
  "smithers-build/WorkflowParseError",
  {
    line: Schema.Number,
    reason: WorkflowParseReason,
    detail: Schema.String
  }
) {
  override readonly name = "WorkflowParseError"
  override get message(): string {
    return `line ${this.line}: ${this.detail}`
  }
}

const refusal = (line: number, reason: WorkflowParseReason, detail: string): WorkflowParseError =>
  new WorkflowParseError({ line, reason, detail })

/** One mapping entry, with the source line of its key. */
interface Entry {
  readonly key: string
  readonly value: unknown
  readonly line: number
}

/** The 1-based source line a node starts on, or line 1 when it has no range. */
const nodeLine = (counter: Yaml.LineCounter, node: unknown): number => {
  const range = (node as { readonly range?: readonly [number, number, number] } | null | undefined)?.range
  return range === undefined ? 1 : counter.linePos(range[0]).line
}

/** Whether a mapping entry was written with no value at all (`steps:`). */
const isEmptyNode = (node: unknown): boolean =>
  node === null || node === undefined || (Yaml.isScalar(node) && node.value === null)

/**
 * A field's text.
 *
 * Every field this reader carries is compared as source text: a gate matches a
 * command string and `alwaysRuns` matches its few accepted conditions, so a value YAML
 * decoded to a boolean or a number is rendered back to the spelling GitHub
 * reads. A field that is not a scalar — a mapping under `if:`, a sequence
 * under `run:` — reads as the empty string, which matches no gate and no
 * accepted condition, so a value this reader cannot verify fails closed.
 */
const scalarText = (node: unknown): string => {
  if (!Yaml.isScalar(node)) return ""
  const value = node.value
  if (value === null || value === undefined) return ""
  const text = typeof value === "string" ? value : String(value)
  // A block scalar keeps the break that closed it. Nothing this module reads
  // is sensitive to a trailing blank line -- a gate matches commands, not
  // whitespace -- and dropping it keeps a one-line script exactly one line.
  return node.type === Yaml.Scalar.BLOCK_LITERAL || node.type === Yaml.Scalar.BLOCK_FOLDED
    ? text.replace(/\n+$/, "")
    : text
}

/**
 * The entries of a block mapping, in source order.
 *
 * A duplicate mapping key is invalid YAML and the LAST occurrence wins, so a
 * gate matched against the shadowed `jobs:` mapping, job, `steps:` block, or
 * `run:` script would be reported present while GitHub runs none of it. Each
 * caller supplies the refusal for its own level, because "duplicate key" alone
 * does not say which job or step lost its script.
 */
const entriesOf = (
  map: Yaml.YAMLMap,
  counter: Yaml.LineCounter,
  duplicate: (key: string, line: number) => WorkflowParseError
): ReadonlyArray<Entry> => {
  const seen = new Set<string>()
  const entries: Array<Entry> = []
  for (const item of map.items) {
    const line = nodeLine(counter, item.key)
    if (!Yaml.isScalar(item.key)) {
      throw refusal(line, "unsupported", "a mapping key that is not a scalar is not supported by the gate scanner")
    }
    // The key is its decoded text, because `"test":` and `test:` are the same
    // key. A gate or a required job pinned to `test` must see the job either
    // way, and the duplicate check must see the two spellings as one key.
    const key = scalarText(item.key)
    if (seen.has(key)) throw duplicate(key, line)
    seen.add(key)
    entries.push({ key, value: item.value, line })
  }
  return entries
}

/** Indexes a level's entries so a field can be read by name. */
const byKey = (entries: ReadonlyArray<Entry>): ReadonlyMap<string, Entry> =>
  new Map(entries.map((entry) => [entry.key, entry] as const))

/** Refuses the keys whose effect on a gate this module cannot verify. */
const refuseInherited = (fields: ReadonlyMap<string, Entry>, describe: (key: string) => string): void => {
  for (const key of ["defaults", "<<"]) {
    const field = fields.get(key)
    if (field !== undefined) throw refusal(field.line, "unsupported", describe(key))
  }
}

const eventNameShape = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Holds a workflow event to the identifier shape GitHub documents. */
const eventName = (text: string, line: number): string => {
  if (!eventNameShape.test(text)) {
    throw refusal(line, "invalid_shape", `${JSON.stringify(text)} is not a supported workflow event name shape`)
  }
  return text
}

/** Refuses a workflow that declares no trigger, so it can never run its gates. */
const checkTrigger = (trigger: Entry, counter: Yaml.LineCounter): void => {
  const node = trigger.value
  if (Yaml.isMap(node)) {
    const events = entriesOf(
      node,
      counter,
      (key, line) => refusal(line, "duplicate", `duplicate workflow event ${JSON.stringify(key)}`)
    )
    if (events.length === 0) throw refusal(trigger.line, "missing", "workflow declares no trigger")
    for (const event of events) eventName(event.key, event.line)
    return
  }
  if (Yaml.isSeq(node)) {
    const events = node.items.map((item) => eventName(scalarText(item), nodeLine(counter, item)))
    if (events.length === 0) throw refusal(trigger.line, "missing", "workflow declares no trigger")
    if (new Set(events).size !== events.length) {
      throw refusal(trigger.line, "duplicate", "workflow event sequence contains a duplicate event")
    }
    return
  }
  const value = scalarText(node)
  if (value === "") throw refusal(trigger.line, "missing", "workflow declares no trigger")
  eventName(value, trigger.line)
}

/** Reads one item of a job's `steps:` sequence. */
const readStep = (node: unknown, job: string, counter: Yaml.LineCounter): WorkflowStep => {
  const line = nodeLine(counter, node)
  if (!Yaml.isMap(node)) {
    throw refusal(line, "invalid_shape", `expected a mapping in a step of job ${JSON.stringify(job)}`)
  }
  const fields = byKey(entriesOf(
    node,
    counter,
    (key, keyLine) =>
      refusal(keyLine, "duplicate", `duplicate key ${JSON.stringify(key)} in a step of job ${JSON.stringify(job)}`)
  ))
  if (fields.has("<<")) {
    throw refusal(
      line,
      "unsupported",
      `a YAML merge in a step of job ${JSON.stringify(job)} is not supported by the gate scanner`
    )
  }
  const field = (key: string): string | undefined => {
    const entry = fields.get(key)
    return entry === undefined ? undefined : scalarText(entry.value)
  }
  const uses = field("uses")
  const run = field("run")
  if ((uses === undefined) === (run === undefined)) {
    throw refusal(
      line,
      "invalid_shape",
      `a step of job ${JSON.stringify(job)} must declare exactly one of \`uses\` or \`run\``
    )
  }
  if ((uses ?? run)!.trim() === "") {
    throw refusal(
      line,
      "invalid_shape",
      `a step of job ${JSON.stringify(job)} has an empty ${uses === undefined ? "run" : "uses"} value`
    )
  }
  const shell = field("shell")
  if (shell !== undefined && shell.trim() === "") {
    throw refusal(line, "invalid_shape", `a step of job ${JSON.stringify(job)} has an empty shell`)
  }
  return {
    name: field("name"),
    id: field("id"),
    uses,
    run,
    shell,
    // A conditional step is not proof that a gate still runs, so the condition
    // is carried out of the scan rather than dropped. An `if:` this reader
    // cannot read as a scalar is the empty string, which is not the always-true
    // literal and therefore fails closed.
    condition: field("if"),
    continueOnError: field("continue-on-error")
  }
}

const jobIdShape = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** Reads one entry of the top-level `jobs:` mapping. */
const readJob = (job: Entry, counter: Yaml.LineCounter): WorkflowJob => {
  const node = job.value
  if (Yaml.isSeq(node)) {
    throw refusal(
      nodeLine(counter, node.items[0] ?? node),
      "invalid_shape",
      `expected a mapping entry in job ${JSON.stringify(job.key)}, not a sequence item`
    )
  }
  if (!Yaml.isMap(node)) {
    throw refusal(job.line, "invalid_shape", `job ${JSON.stringify(job.key)} must be a block mapping`)
  }
  if (!jobIdShape.test(job.key)) {
    throw refusal(job.line, "invalid_shape", `${JSON.stringify(job.key)} is not a valid GitHub Actions job id`)
  }
  const fields = byKey(entriesOf(
    node,
    counter,
    (key, line) => refusal(line, "duplicate", `duplicate key ${JSON.stringify(key)} in job ${JSON.stringify(job.key)}`)
  ))
  refuseInherited(
    fields,
    (key) => `${JSON.stringify(key)} in job ${JSON.stringify(job.key)} is not supported by the gate scanner`
  )
  const field = (key: string): string | undefined => {
    const entry = fields.get(key)
    return entry === undefined ? undefined : scalarText(entry.value)
  }
  const steps: Array<WorkflowStep> = []
  const declared = fields.get("steps")
  if (declared !== undefined && !isEmptyNode(declared.value)) {
    if (!Yaml.isSeq(declared.value)) {
      throw refusal(declared.line, "invalid_shape", "`steps` must be a block sequence")
    }
    for (const item of declared.value.items) steps.push(readStep(item, job.key, counter))
  }
  const runsOn = field("runs-on")
  const uses = field("uses")
  if (uses !== undefined) {
    if (uses.trim() === "") {
      throw refusal(job.line, "invalid_shape", `reusable job ${JSON.stringify(job.key)} has an empty uses value`)
    }
    if (runsOn !== undefined || declared !== undefined) {
      throw refusal(
        job.line,
        "invalid_shape",
        `reusable job ${JSON.stringify(job.key)} cannot also declare runs-on or steps`
      )
    }
  } else {
    if (runsOn === undefined || runsOn.trim() === "") {
      throw refusal(job.line, "missing", `job ${JSON.stringify(job.key)} declares no runner`)
    }
    if (declared === undefined || steps.length === 0) {
      throw refusal(job.line, "missing", `job ${JSON.stringify(job.key)} declares no steps`)
    }
  }
  return {
    id: job.key,
    name: field("name"),
    runsOn,
    uses,
    condition: field("if"),
    continueOnError: field("continue-on-error"),
    steps
  }
}

/** Reports the first structural YAML error against the line it sits on. */
const refuseYamlErrors = (document: Yaml.Document.Parsed, counter: Yaml.LineCounter): void => {
  const failure = document.errors[0]
  if (failure === undefined) return
  const summary = failure.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")
  const line = failure.linePos?.[0].line ?? counter.linePos(failure.pos[0]).line
  throw refusal(line, "invalid_yaml", `invalid YAML: ${summary}`)
}

/**
 * An alias resolves to a node declared elsewhere, which would let a gate match
 * a `run:` body that no step in that job spells out. The gate contract reports
 * what it can read, so an alias is refused rather than followed.
 */
const refuseAliases = (document: Yaml.Document.Parsed, counter: Yaml.LineCounter): void => {
  Yaml.visit(document, {
    Alias: (_key, node) => {
      throw refusal(nodeLine(counter, node), "unsupported", "a YAML alias is not supported by the gate scanner")
    }
  })
}

/**
 * Parses a GitHub Actions workflow.
 *
 * Structure comes from `yaml`; everything this function adds is the part a
 * general YAML decoder cannot supply. It refuses a workflow whose gates it
 * could not verify: an alias or a `<<` merge, an inherited `defaults:` shell,
 * a duplicate top-level key, job id, job field, or step field, a job with no
 * runner or no steps, a step declaring neither or both of `uses` and `run`,
 * and a workflow with no trigger. Every refusal names the source line.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseWorkflow = (source: string): Workflow => {
  if (Buffer.byteLength(source, "utf8") > maximumWorkflowBytes) {
    throw refusal(1, "too_large", `workflow source is larger than ${maximumWorkflowBytes} bytes`)
  }
  const counter = new Yaml.LineCounter()
  const document = Yaml.parseDocument(source, {
    lineCounter: counter,
    // `<<` stays an ordinary key, so a merge is refused by name below instead
    // of being folded into the mapping it would shadow.
    merge: false,
    // Duplicates are refused per level below, because "duplicate key" alone
    // does not name the job or step whose script GitHub will not run.
    uniqueKeys: false
  })
  refuseYamlErrors(document, counter)
  refuseAliases(document, counter)

  const contents = document.contents
  if (Yaml.isSeq(contents)) {
    throw refusal(
      nodeLine(counter, contents.items[0] ?? contents),
      "invalid_shape",
      "expected a mapping entry at the top level, not a sequence item"
    )
  }
  if (contents !== null && !Yaml.isMap(contents)) {
    throw refusal(nodeLine(counter, contents), "invalid_shape", "expected a mapping at the top level")
  }
  const top = byKey(
    contents === null
      ? []
      : entriesOf(
        contents,
        counter,
        (key, line) => refusal(line, "duplicate", `duplicate top-level key ${JSON.stringify(key)}`)
      )
  )
  refuseInherited(top, (key) => `top-level ${JSON.stringify(key)} is not supported by the gate scanner`)
  const trigger = top.get("on")
  if (trigger === undefined) {
    throw refusal(1, "missing", "workflow is missing the required top-level `on` trigger")
  }
  const declared = top.get("jobs")
  if (declared === undefined) {
    throw refusal(1, "missing", "workflow is missing the required top-level `jobs` mapping")
  }
  checkTrigger(trigger, counter)

  if (Yaml.isSeq(declared.value)) {
    throw refusal(
      nodeLine(counter, declared.value.items[0] ?? declared.value),
      "invalid_shape",
      "expected a job mapping entry, not a sequence item"
    )
  }
  if (isEmptyNode(declared.value)) throw refusal(1, "missing", "workflow declares no jobs")
  if (!Yaml.isMap(declared.value)) {
    throw refusal(declared.line, "unsupported", "inline `jobs` mappings are not supported")
  }
  const jobs = entriesOf(
    declared.value,
    counter,
    (key, line) => refusal(line, "duplicate", `duplicate job id ${JSON.stringify(key)}`)
  ).map((job) => readJob(job, counter))
  if (jobs.length === 0) throw refusal(1, "missing", "workflow declares no jobs")

  const name = top.get("name")
  return { name: name === undefined ? undefined : scalarText(name.value) || undefined, jobs }
}

/**
 * A command a workflow must still run.
 *
 * `command` is matched as a WHOLE COMMAND at a shell command boundary of some
 * step's `run` body — never as a substring. It must start where the shell would
 * start reading a command (the beginning of the script, or after `\n`, `;`,
 * `&`, `&&`, `|`, `||`, a subshell or command-substitution `(`, or one of the
 * `if`/`then`/`else`/`elif`/`while`/`until`/`do`/`{`/`}`/`!`/`time`/`sudo`/
 * `exec` words that introduce one, across a `\`-newline line continuation), it
 * must sit outside every quoted string, and the character after it must end a
 * shell word. So `echo pnpm run check` and `"pnpm run check"` do not satisfy a
 * `pnpm run check` gate, while `if ! cmp a b; then`, `(cd x && bun …)`,
 * `corepack enable && \` + `pnpm run check`, and
 * `pnpm install --frozen-lockfile --ignore-scripts` still do. Arguments and
 * flags after the declared command are allowed; a longer command name
 * (`pnpm run checkall`) is not.
 *
 * A gate whose command names an action instead matches a step's `uses` value
 * exactly, or the same action at any version (`actions/checkout` matches
 * `actions/checkout@v4`). It never matches a `uses` that merely contains it.
 *
 * `job`, when given, also requires the command to appear in that job, which is
 * how a gate that must run on a specific platform (macOS, Windows, Bun) is
 * pinned to it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Gate {
  readonly name: string
  readonly command: string
  readonly job?: string | undefined
}

/** Removes a shell comment from one script line, respecting quoting. */
const stripShellComment = (line: string): string => {
  let quote: string | undefined
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!
    if (quote !== undefined) {
      if (character === "\\" && quote === "\"") {
        index += 1
        continue
      }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      continue
    }
    // A `#` opens a shell comment at the start of a word only, which keeps
    // `${{ ... }}`, `$#`, and `a#b` intact.
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index)
  }
  return line
}

/**
 * Strips shell comments from a `run` script, line by line.
 *
 * A gate proves a command still RUNS. Commented-out text is not a command, and
 * a workflow whose only remaining occurrence of `pnpm run check` sits behind a
 * `#` runs no typecheck — so the comment is removed before matching and the
 * gate is reported missing. Quoting state is not carried across lines, which
 * fails closed: a `#` inside a multi-line quoted string is treated as a
 * comment, costing a gate a match rather than inventing one.
 *
 * @category verification
 * @since 0.1.0
 */
export const stripShellComments = (script: string): string => script.split("\n").map(stripShellComment).join("\n")

/** Characters that end one shell command and open the next. */
const commandSeparators = new Set(["\n", ";", "&", "|", "(", ")"])

/**
 * Words that introduce a command rather than being one. `sudo`, `exec`, and
 * `time` run the command that follows them; the rest are shell keywords whose
 * next word is a command. `for`, `case`, and `select` are deliberately absent:
 * the word after them is a variable or a value, not a command.
 */
const commandIntroducers = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "time",
  "sudo",
  "exec"
])

/** A `NAME=value` prefix, which the shell applies before running the command. */
const assignmentPrefix = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Skips a quoted string, returning the index just past its closing quote. */
const skipQuoted = (script: string, open: number): number => {
  const quote = script[open]!
  let index = open + 1
  while (index < script.length) {
    const character = script[index]!
    // A backslash escapes inside `"…"` only; inside `'…'` it is literal.
    if (quote === "\"" && character === "\\") {
      index += 2
      continue
    }
    if (character === quote) return index + 1
    index += 1
  }
  // An unterminated quote swallows the rest of the script, which fails closed:
  // it can only cost a gate a match, never invent one.
  return script.length
}

/**
 * Skips a here-document, returning the index at the end of its terminator line.
 *
 * A here-document body is DATA the shell feeds to a command's stdin, never
 * commands it runs, so `cat <<'EOF' … pnpm run check … EOF` runs no typecheck.
 * The remainder of the opening line is skipped with the body, and an
 * unterminated here-document swallows the rest of the script: both can only
 * cost a gate a match, never invent one.
 */
const skipHereDocument = (script: string, open: number): number => {
  let index = open + 2
  const stripTabs = script[index] === "-"
  if (stripTabs) index += 1
  while (script[index] === " " || script[index] === "\t") index += 1
  let delimiter = ""
  while (index < script.length) {
    const character = script[index]!
    if (character === "'" || character === "\"") {
      const close = skipQuoted(script, index)
      delimiter += script.slice(index + 1, Math.max(index + 1, close - 1))
      index = close
      continue
    }
    if (/[\s;&|()<>]/.test(character)) break
    delimiter += character
    index += 1
  }
  const newline = script.indexOf("\n", index)
  if (delimiter === "" || newline === -1) return script.length
  let offset = newline + 1
  for (const line of script.slice(offset).split("\n")) {
    if (line === delimiter || (stripTabs && line.replace(/^\t+/, "") === delimiter)) {
      return Math.min(script.length, offset + line.length)
    }
    offset += line.length + 1
  }
  return script.length
}

/**
 * Returns the end of a shell function definition beginning at `start`.
 *
 * A function body is deferred code: merely declaring
 * `check() { pnpm run check; }` does not run the command. The gate scanner
 * therefore skips the complete balanced body. If the body is malformed, the
 * rest of the script is swallowed, which fails closed. Calling the function
 * later is also not expanded by this deliberately small scanner; callers that
 * require a gate should spell the required command directly.
 */
const functionDefinitionEnd = (script: string, start: number): number | undefined => {
  const header = script.slice(start).match(
    /^(?:(?:function[ \t\n]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t\n]*\([ \t\n]*\))?)|(?:[A-Za-z_][A-Za-z0-9_]*[ \t\n]*\([ \t\n]*\)))[ \t\n]*\{/
  )
  if (header === null) return undefined
  let index = start + header[0].length
  let depth = 1
  while (index < script.length) {
    const character = script[index]!
    if (character === "'" || character === "\"") {
      index = skipQuoted(script, index)
      continue
    }
    if (character === "\\") {
      index += 2
      continue
    }
    if (character === "<" && script[index + 1] === "<" && script[index + 2] !== "<") {
      index = skipHereDocument(script, index)
      continue
    }
    if (character === "{") depth += 1
    if (character === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return script.length
}

/**
 * One command the shell would run, as a half-open range of the script.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandSpan {
  /** The offset of the command's first word. */
  readonly start: number
  /** The offset just past the command's last word, before its separator. */
  readonly end: number
}

/**
 * The commands the shell would run, each as the range its words occupy.
 *
 * This is the whole of the fail-closed gate contract: a command is only proof
 * that something RUNS when the shell would run it, so `echo pnpm run check`,
 * `"…; pnpm run check"`, and `xpnpm run check` yield no command span at the
 * gate's text. Constructs this scanner does not model (backticks, `eval`)
 * simply produce no span there, which reports the gate missing rather than
 * accepting text that may not run.
 *
 * A span ends where the shell stops reading the command: at a separator, at a
 * here-document, or at the end of the script. That is what lets a caller hold
 * the WHOLE command to a policy — {@link performsInstall} checks the install's
 * own flags — rather than only its first words.
 *
 * Shell-level control flow is the one thing it deliberately looks THROUGH: a
 * command inside an `if`, a loop body, or a `case` arm is reported as run,
 * because the flows pipeline's own byte-comparison gate lives inside
 * `if ! cmp …; then`. A workflow-level `if:` is the opposite — see
 * {@link alwaysRuns} — because GitHub may skip the whole job or step.
 *
 * @category verification
 * @since 0.1.0
 */
export const commandSpans = (script: string): ReadonlyArray<CommandSpan> => {
  const spans: Array<{ readonly start: number; end: number }> = []
  let open: { readonly start: number; end: number } | undefined
  let index = 0
  let expectCommand = true
  while (index < script.length) {
    const character = script[index]!
    if (character === " " || character === "\t") {
      index += 1
      continue
    }
    if (expectCommand) {
      const functionEnd = functionDefinitionEnd(script, index)
      if (functionEnd !== undefined) {
        index = functionEnd
        open = undefined
        // A following command still needs its own shell separator. Without
        // one, `f() { :; }pnpm run check` is a syntax error, not proof that
        // the shell starts another command at `pnpm`.
        expectCommand = false
        continue
      }
    }
    if (commandSeparators.has(character)) {
      open = undefined
      expectCommand = true
      index += 1
      continue
    }
    if (character === "'" || character === "\"") {
      // A quoted first word is not a command name this scanner will vouch for.
      index = skipQuoted(script, index)
      if (open !== undefined) open.end = index
      expectCommand = false
      continue
    }
    if (character === "\\") {
      // A backslash-newline is a line continuation: the shell joins the two
      // lines, so it neither ends the current command nor cancels a pending
      // one. `pnpm install --frozen-lockfile && \` still starts a command on
      // the next line, and reading the continuation as an ordinary escape
      // would report that command missing.
      if (script[index + 1] !== "\n") {
        if (open !== undefined) open.end = index + 2
        // Any other unquoted backslash escapes the next character, so
        // `echo \; pnpm run check` passes the `;` to `echo` and starts no
        // second command. Reading it as a separator would invent a command
        // boundary the shell does not have.
        expectCommand = false
      }
      index += 2
      continue
    }
    // `<<<` is a here-string, whose word is on this line; `<<` opens a body.
    if (character === "<" && script[index + 1] === "<" && script[index + 2] !== "<") {
      index = skipHereDocument(script, index)
      open = undefined
      expectCommand = true
      continue
    }
    const start = index
    while (index < script.length) {
      const next = script[index]!
      if (next === " " || next === "\t" || commandSeparators.has(next)) break
      if (next === "'" || next === "\"") {
        index = skipQuoted(script, index)
        continue
      }
      // The same escape target inside a word: `a\;b` is one argument, not two
      // commands.
      index += next === "\\" ? 2 : 1
    }
    if (expectCommand) {
      open = { start, end: index }
      spans.push(open)
      const word = script.slice(start, index)
      if (!commandIntroducers.has(word) && !assignmentPrefix.test(word)) expectCommand = false
    } else if (open !== undefined) {
      open.end = index
    }
  }
  return spans
}

/**
 * The offsets at which the shell would start reading a command.
 *
 * @category verification
 * @since 0.1.0
 */
export const commandStarts = (script: string): ReadonlyArray<number> => commandSpans(script).map((span) => span.start)

/** Whether a character ends the shell word a command name occupies. */
const endsWord = (character: string | undefined): boolean =>
  character === undefined || character === " " || character === "\t" ||
  character === "<" || character === ">" || commandSeparators.has(character)

/**
 * Whether a `run` script runs the given command.
 *
 * The command must begin at a shell command boundary and end at a word
 * boundary, so arguments and flags may follow it but a longer command name may
 * not. Shell comments come off first: commented-out text is not a command.
 *
 * @category verification
 * @since 0.1.0
 */
export const runsCommand = (script: string, command: string): boolean => {
  const wanted = command.trim()
  if (wanted === "") return false
  const text = stripShellComments(script)
  return commandStarts(text).some((start) => text.startsWith(wanted, start) && endsWord(text[start + wanted.length]))
}

/**
 * Whether a step's `uses` value is the action a gate names.
 *
 * The value must BE the action, either at the pinned reference the gate
 * declares or at any version of an unversioned one. A `uses` that merely
 * contains the gate's text — `my-org/actions/checkout@v4` against
 * `actions/checkout@v4` — is a different action and does not satisfy it.
 *
 * @category verification
 * @since 0.1.0
 */
export const usesAction = (uses: string, command: string): boolean => {
  const value = uses.trim()
  const wanted = command.trim()
  return wanted !== "" && (value === wanted || (!wanted.includes("@") && value.startsWith(`${wanted}@`)))
}

/**
 * The one step condition that proves a gate as well as no `if:` does, given an
 * earlier unconditional step with `id: setup`: it runs whenever the implicit
 * `success()` would, and also after an earlier gate went red. Generated CI
 * puts it on every gate step.
 *
 * @category verification
 * @since 0.1.0
 */
export const independentGateCondition = "!cancelled() && steps.setup.conclusion == 'success'" as const

const expressionBody = (condition: string): string => {
  const normalized = condition.trim()
  return normalized.match(/^\$\{\{\s*(.*?)\s*\}\}$/)?.[1] ?? normalized
}

/**
 * Whether a parsed `if:` is provably always true.
 *
 * Only the `true` literal is accepted. Anything else — `false`, a context
 * expression, a value the scanner could not read — leaves the job or step
 * conditional, and a conditional job or step is not proof that a required
 * gate runs. {@link missingGates} additionally accepts
 * {@link independentGateCondition} on a step, where it can check the setup step.
 *
 * @category verification
 * @since 0.1.0
 */
export const alwaysRuns = (condition: string | undefined): boolean =>
  condition === undefined || expressionBody(condition) === "true"

/** Whether a step runs whenever its job does, reading the steps before it. */
const stepAlwaysRuns = (steps: ReadonlyArray<WorkflowStep>, index: number): boolean => {
  const condition = steps[index]!.condition
  if (alwaysRuns(condition)) return true
  return expressionBody(condition!) === independentGateCondition &&
    steps.slice(0, index).some((step) => step.id === "setup" && step.condition === undefined)
}

/** Shell declarations for which the scanner can prove a `run` body executes. */
const executableShells = new Set(["bash", "sh", "pwsh", "powershell", "cmd"])

/**
 * Whether GitHub will execute a run body through a shell the scanner models.
 *
 * @category verification
 * @since 0.1.0
 */
export const executesRunScript = (shell: string | undefined): boolean =>
  shell === undefined || executableShells.has(shell.trim().toLowerCase())

/**
 * The declared required jobs a workflow does not unconditionally run.
 *
 * A required job is required to RUN, on the same terms as a gate: a job
 * carrying an `if:` is one GitHub may skip, so `if: false` on a required job is
 * a job the pipeline does not have. A job that exists but is conditional is
 * reported as `id (conditional)`, because "missing" would send an operator
 * looking for a job that is right there in the file.
 *
 * `continue-on-error` stays out of it, exactly as it does for a gate: a
 * required job asserts that the job runs, not that its failure blocks a merge,
 * and the advisory platform lanes are jobs that do run.
 *
 * @category verification
 * @since 0.1.0
 */
export const missingRequiredJobs = (
  workflow: Workflow,
  requiredJobs: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const declared = new Set(workflow.jobs.map((job) => job.id))
  const unconditional = new Set(
    workflow.jobs.filter((job) => alwaysRuns(job.condition)).map((job) => job.id)
  )
  return requiredJobs
    .filter((id) => !unconditional.has(id))
    .map((id) => declared.has(id) ? `${id} (conditional)` : id)
}

/**
 * Reports the declared gates a workflow no longer runs.
 *
 * A gate is satisfied only by an UNCONDITIONAL job and step: `if: false`, and
 * every other condition that is not the always-true literal, is a job or step
 * GitHub may skip, so it cannot prove an unconditional gate. `continue-on-error`
 * is deliberately not treated the same way — a gate asserts that a command is
 * still run, not that its failure blocks a merge, and the advisory macOS and
 * Windows lanes of a real pipeline are exactly the jobs a platform-pinned gate
 * exists to pin.
 *
 * @category verification
 * @since 0.1.0
 */
export const missingGates = (
  workflow: Workflow,
  gates: ReadonlyArray<Gate>
): ReadonlyArray<Gate> =>
  gates.filter((gate) => {
    const jobs = (gate.job === undefined
      ? workflow.jobs
      : workflow.jobs.filter((job) => job.id === gate.job)).filter((job) => alwaysRuns(job.condition))
    return !jobs.some((job) =>
      job.steps.filter((_, index) => stepAlwaysRuns(job.steps, index)).some((step) =>
        (step.run !== undefined && executesRunScript(step.shell) && runsCommand(step.run, gate.command)) ||
        (step.uses !== undefined && usesAction(step.uses, gate.command))
      )
    )
  })

/**
 * One supported lockfile install, with the only flags it may carry.
 *
 * @category models
 * @since 0.1.0
 */
export interface SupportedInstall {
  /** The exact install command. */
  readonly command: string
  /** The workspace-binary runner that install pins. */
  readonly exec: string
  /** Valueless flags that cannot omit a dependency the lockfile pins. */
  readonly flags: ReadonlyArray<string>
  /** `--flag=value` flags that cannot omit a dependency the lockfile pins. */
  readonly valueFlags: ReadonlyArray<string>
}

/**
 * The lockfile installs a generated pipeline may run, and the flags each one
 * may carry.
 *
 * A generated pipeline that installs with anything else — `pnpm dlx`, a bare
 * `npm install`, a fetch-from-the-network one-liner — is not reproducible and
 * is not a supported way to set a workspace up, so the renderer refuses it.
 *
 * The flag lists are ALLOWLISTS, and they are the second half of the same
 * guarantee. `pnpm install --frozen-lockfile --lockfile-only` writes a lockfile
 * and installs nothing; `--prod`, `--production`, and `--omit=dev` drop the dev
 * dependencies the workspace CLI lives in; `--filter=…` installs a slice of the
 * workspace. Each one leaves the install gate satisfied and the pinned binary
 * missing, which is a guaranteed-red or silently incomplete pipeline. Only
 * flags that cannot omit a pinned dependency are listed, and an unrecognized
 * flag is refused rather than guessed at.
 *
 * @category constants
 * @since 0.1.0
 */
export const supportedInstalls: ReadonlyArray<SupportedInstall> = [
  {
    command: "pnpm install --frozen-lockfile",
    exec: "pnpm exec",
    flags: [
      "--ignore-scripts",
      "--prefer-offline",
      "--prefer-frozen-lockfile",
      "--strict-peer-dependencies",
      "--no-strict-peer-dependencies",
      "--no-color",
      "--silent"
    ],
    valueFlags: ["--reporter", "--loglevel", "--child-concurrency", "--network-concurrency"]
  },
  {
    command: "npm ci",
    exec: "npm exec --no-install --",
    flags: [
      "--ignore-scripts",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      "--no-color",
      "--foreground-scripts",
      "--silent"
    ],
    valueFlags: ["--loglevel"]
  },
  {
    command: "yarn install --immutable",
    exec: "yarn run",
    flags: ["--immutable-cache", "--check-cache", "--inline-builds", "--no-immutable-cache"],
    valueFlags: []
  },
  {
    command: "bun install --frozen-lockfile",
    exec: "bun run",
    flags: ["--ignore-scripts", "--no-progress", "--no-summary", "--no-verify", "--silent"],
    valueFlags: ["--concurrent-scripts"]
  }
]

/**
 * Install commands that respect a lockfile.
 *
 * @category constants
 * @since 0.1.0
 */
export const supportedInstallCommands: ReadonlyArray<string> = supportedInstalls.map((install) => install.command)

/** The value half of a `--flag=value` an install may carry. */
const flagValue = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The supported install a command line is, or `undefined` when it is none of
 * them.
 *
 * Extra flags are allowed only when {@link supportedInstalls} lists them for
 * that package manager. An unknown flag, a flag that can omit a pinned
 * dependency, and anything that could reach the shell or the network are all
 * refused, because each of them satisfies an install gate while leaving the
 * workspace incomplete.
 *
 * @category verification
 * @since 0.1.0
 */
export const supportedInstallOf = (command: string): string | undefined => {
  // A backslash-newline is a line continuation the shell removes before it
  // reads the words, so `pnpm install --frozen-lockfile \` + `--ignore-scripts`
  // is the one command it spells. `commandSpans` follows the continuation, and
  // the flag policy has to read the same words it does.
  const normalized = command.replace(/\\\n[ \t]*/g, " ").trim()
  for (const install of supportedInstalls) {
    if (normalized === install.command) return install.command
    if (!normalized.startsWith(`${install.command} `)) continue
    const suffix = normalized.slice(install.command.length).trim()
    const allowed = suffix.split(/\s+/).every((flag) => {
      const separator = flag.indexOf("=")
      if (separator === -1) return install.flags.includes(flag)
      return install.valueFlags.includes(flag.slice(0, separator)) && flagValue.test(flag.slice(separator + 1))
    })
    if (allowed) return install.command
  }
  return undefined
}

/**
 * Whether a command line is a supported lockfile install.
 *
 * @category verification
 * @since 0.1.0
 */
export const isSupportedInstall = (command: string): boolean => supportedInstallOf(command) !== undefined

/**
 * The command prefix that runs a workspace binary the matching lockfile
 * install already put in the tree.
 *
 * Each one resolves the binary from `node_modules`, so the version that runs is
 * the version the lockfile pinned. `npm exec --no-install` fails rather than
 * fetching. None of them may reach a registry: a generated pipeline that
 * fetched its own CLI would run a package the lockfile never approved, and the
 * install step would be decorative.
 *
 * @category constants
 * @since 0.1.0
 */
export const workspaceExecCommands: Readonly<Record<string, string>> = Object.fromEntries(
  supportedInstalls.map((install) => [install.command, install.exec])
)

/**
 * The workspace-binary runner for a supported lockfile install, or `undefined`
 * when the install is not supported.
 *
 * @category verification
 * @since 0.1.0
 */
export const workspaceExec = (install: string): string | undefined => {
  const supported = supportedInstallOf(install)
  return supported === undefined ? undefined : workspaceExecCommands[supported]
}

/**
 * Whether a `run` script actually performs the given lockfile install.
 *
 * The install has to be a command the SHELL RUNS, which is the same boundary
 * target a gate uses: it must occupy a whole {@link commandSpans} span, after
 * shell comments come off. A mention inside a comment, an `echo` argument, a
 * quoted string, or a here-document body installs nothing and does not count,
 * even though every one of them is a line of the script that reads like the
 * install.
 *
 * The WHOLE command is held to the same policy as the declared install, not
 * merely its prefix. `pnpm install --frozen-lockfile --prod` starts with the
 * declared base and installs none of the dev dependencies the pinned workspace
 * CLI lives in, so it does not perform the declared install; the allowlisted
 * `pnpm install --frozen-lockfile --ignore-scripts` does.
 *
 * @category verification
 * @since 0.1.0
 */
export const performsInstall = (script: string, install: string): boolean => {
  const declared = supportedInstallOf(install)
  if (declared === undefined) return false
  const text = stripShellComments(script)
  return commandSpans(text).some((span) => supportedInstallOf(text.slice(span.start, span.end)) === declared)
}
