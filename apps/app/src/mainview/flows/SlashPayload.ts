/*
 * The composer boundary: slash argument text in, a flow's typed payload out.
 *
 * Under the old `Command` interface every handler re-parsed its own `args?:
 * string` — the same trailing-`owner/repo` split written out dozens of times,
 * each free to drift. Flows take DECODED payloads, so the text-shaped step
 * happens exactly once: here, at the edge where a human's `/name <text>` (or
 * an agent's single argument string) becomes the record the flow's input
 * schema validates.
 *
 * A parse either produces the payload or an honest error naming what is
 * missing. The error never reaches the flow: an invocation that cannot be
 * parsed is refused before the handler runs, which is why no handler below the
 * boundary contains an argument check.
 */
import { isTraceFilter,TRACE_FILTER_IDS } from "../cards/RunTrace"
import { isGraphDrawerTab, unknownTabRefusal } from "../state/controller/graph"
import type { KnownRepositories } from "../state/RepoContext"
import { REPO_TOKEN,splitTrailingRepo } from "../state/RepoContext"
import { isAgentProvider } from "../state/seams/AgentSessionSeam"
import { parseFileArgs } from "./FileArgs"
import { splitRunSource,takesRunSource } from "@smthrs/ui/run-command"

/** A parsed invocation, or the honest refusal that names what is missing. */
export type Parsed =
  | { readonly payload: Record<string, unknown> }
  | { readonly error: string }

/**
 * One flow's grammar: its slash text, and the repositories a trailing
 * `owner/repo` token beside other text may name (RepoContext.ts
 * splitTrailingRepo). Absent `known`, the token's shape alone decides.
 */
export type Grammar = ((args: string | undefined, known?: KnownRepositories) => Parsed) & { readonly buttonOnly?: boolean }

/** A JSON payload carried by a button; positional text must instead be collected by the form. */
export const carriedPayload = (name: string): Grammar => Object.assign((args: string | undefined): Parsed => {
  try {
    const value: unknown = JSON.parse((args ?? "").trim())
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return ok(value as Record<string, unknown>)
  } catch { /* The form reads positional text; a button must carry a JSON object. */ }
  return no(`${name} takes the values its button carries`)
}, { buttonOnly: true as const })

const ok = (payload: Record<string, unknown>): Parsed => ({ payload })
const no = (error: string): Parsed => ({ error })

/** Structured setup edits preserve prompt whitespace and typed setting values. */
const setupObject = (args: string | undefined): Parsed => {
  if (!(args ?? "").trim()) return ok({})
  try {
    const value: unknown = JSON.parse(args!)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? ok(value as Record<string, unknown>) : no("Setup input must be a JSON object")
  } catch { return no("Setup input must be a JSON object") }
}

/** Structured graph doors preserve engine IDs verbatim, including whitespace. */
const graphObject = (args: string | undefined, target: "runId" | "cardId", value: "nodeId" | "tab"): Parsed | undefined => {
  if (!args?.trim().startsWith("{")) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(args) } catch { return no("Graph input must be a JSON object") }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return no("Graph input must be a JSON object")
  const fields = parsed as Record<string, unknown>
  if (Object.keys(fields).some(key => key !== target && key !== value) || typeof fields[target] !== "string" || fields[target] === "") return no(`Graph input needs ${target}`)
  if (fields[value] !== undefined && (typeof fields[value] !== "string" || fields[value] === "")) return no(`Graph input needs ${value}`)
  if (value === "tab" && (typeof fields.tab !== "string" || !isGraphDrawerTab(fields.tab))) return no("Choose a graph tab")
  return ok(fields)
}

/** The empty payload every no-argument flow takes. */
const NONE: Parsed = { payload: {} }
/** A name under refs/smithers/users/<id>/ (packages/backend repohost.UserIDFromRef). */
const PUSHED_REF_NAME = /^(?!.*\.\.)(?!.*(?:^|\/)\.)(?!.*\.(?:\/|$))(?!.*\.lock(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

const trimmed = (args: string | undefined): string => (args ?? "").trim()

/** A required single-value payload, refused by name when the text is blank. */
const required = (field: string, args: string | undefined, reason: string): Parsed => {
  const value = trimmed(args)
  return value === "" ? no(reason) : ok({ [field]: value })
}

/** Preserve the existing card-ID door and decode the structured form used by
 * the conversation agent without treating JSON text as a different card ID. */
const setupGuideTarget = (args: string | undefined): Parsed => {
  const value = trimmed(args)
  if (!value.startsWith("{") && !value.startsWith("[")) return required("cardId", args, "Choose the setup to configure")
  const parsed = setupObject(value)
  if ("error" in parsed) return parsed
  const { cardId } = parsed.payload
  return Object.keys(parsed.payload).length === 1 && typeof cardId === "string" && cardId.trim() !== ""
    ? ok({ cardId: cardId.trim() }) : no("Choose the setup to configure")
}

/** An optional single-value payload: blank text means the field is absent. */
const optional = (field: string, args: string | undefined): Parsed => {
  const value = trimmed(args)
  return ok(value === "" ? {} : { [field]: value })
}

/** The trailing `--space public|private` a wiki door may carry (#1922); the rest of the line is positional. */
const wikiSpaceFlag = (args: string | undefined): { readonly line: string; readonly space?: "public" | "private" | { readonly error: string } } => {
  const match = /\s*--space(?:\s+(\S+))?\s*$/.exec(trimmed(args))
  if (match === null) return { line: trimmed(args) }
  const value = match[1]
  return { line: trimmed(args).slice(0, match.index).trim(),
    space: value === "public" || value === "private" ? value : { error: "A Wiki space is public or private." } }
}

/** A repo-scoped flow that takes nothing but its optional `owner/repo` target. */
const repoOnly = (name: string, args: string | undefined): Parsed => {
  // This grammar only accepts a repository, including one not yet imported.
  const { rest, repo } = splitTrailingRepo(args)
  if (rest !== "") return no(`${name} takes just an owner/repo name`)
  return ok(repo === undefined ? {} : { repo })
}

/** A positive issue or pull-request number beside its optional repo. */
const numbered = (args: string | undefined, reason: string, _known?: KnownRepositories): Parsed => {
  // A numeric target has no free-text or file-path tail: an explicit owner/repo
  // is unambiguous even before the repository catalog has loaded.
  const { rest, repo } = splitTrailingRepo(args)
  const number = Number(rest)
  if (!Number.isInteger(number) || number <= 0) return no(reason)
  return ok(repo === undefined ? { number } : { number, repo })
}

/** Keep source and repository when a missing issue number opens the shared form. */
export const issueViewParts = (args: string | undefined): Record<string, unknown> => {
  const match = /^(.*?)\s*--source\s+(\S+)$/.exec(trimmed(args))
  const { rest, repo } = splitTrailingRepo(match ? match[1] : args)
  const number = Number(rest)
  return {
    ...(Number.isInteger(number) && number > 0 ? { number } : {}),
    ...(repo ? { repo } : {}),
    ...(match ? { source: match[2] } : {})
  }
}

/** Preserve JSON string whitespace when extracting the optional flow input. */
export const flowRunParts = (args: string | undefined): { name?: string; repo?: string; input?: string; sourceCard?: string } => {
  const source = splitRunSource(args)
  const parts = flowRunBody(source.args)
  return source.sourceCard === undefined ? parts : { ...parts, sourceCard: source.sourceCard }
}
/**
 * `against=<runId>`, the plan door's one extra token.
 *
 * It leads, because a flow's input is free-form JSON and a trailing token
 * beside it is not unambiguous. `payloadFor` has already taken `sourceCard=`
 * off the front, so this reads the next token and hands the rest to the
 * launch's own grammar.
 */
const AGAINST_TOKEN = /^\s*against=(\S+)(?:\s+([\s\S]*))?$/

export const splitPlanAgainst = (
  args: string | undefined
): { readonly args: string | undefined; readonly against?: string } => {
  const match = AGAINST_TOKEN.exec(args ?? "")
  return match === null ? { args } : { args: match[2], against: match[1]! }
}

/** `[sourceCard=id] [against=runId] <name> [owner/repo] [JSON object]`, as a half-typed form keeps it. */
export const flowPlanParts = (
  args: string | undefined
): { name?: string; repo?: string; input?: string; sourceCard?: string; against?: string } => {
  const source = splitRunSource(args)
  const preview = splitPlanAgainst(source.args)
  return {
    ...flowRunParts(preview.args),
    ...(source.sourceCard === undefined ? {} : { sourceCard: source.sourceCard }),
    ...(preview.against === undefined ? {} : { against: preview.against })
  }
}

/**
 * `<name> [owner/repo] [JSON object]`: what a launch and its plan both take.
 *
 * One parser for both, because the plan door is the launch's address stopped
 * at the plan: a grammar that drifted between them would make the graph a
 * card drew a different flow from the one its Run button starts.
 */
const flowTarget = (flow: string, args: string | undefined): Parsed => {
  const { name, repo, input } = flowRunParts(args)
  if (name === undefined) return no(`${flow} needs a flow name`)
  const target = { name, ...(repo === undefined ? {} : { repo }) }
  if (input === undefined) return ok(target)
  try {
    const value: unknown = JSON.parse(input)
    if (value === null || typeof value !== "object" || Array.isArray(value)) return no("Flow input must be a JSON object.")
    return ok({ ...target, input: value })
  } catch { return no("Flow input is not valid JSON. Fix the JSON object before running it.") }
}

const flowRunBody = (args: string | undefined): { name?: string; repo?: string; input?: string } => {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed(args))
  if (match === null) return {}
  const name = match[1]!
  const rest = match[2]?.trim() ?? ""
  if (rest === "") return { name }
  if (rest.startsWith("{") || rest.startsWith("[")) return { name, input: rest }
  const target = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)!
  return { name, repo: target[1]!, ...(target[2] === undefined ? {} : { input: target[2] }) }
}

/**
 * `[owner/repo] --flow <id> --slug <name> --schedule <cron> [--input <json>]
 * [--tokens <n>] [--minutes <n>]`: the registration triggers.register takes.
 * The repository leads because a cron expression and a JSON input both hold
 * spaces, so nothing trailing is unambiguous; each flag runs to the next one,
 * which keeps those spaces.
 */
const TRIGGER_FIELDS: ReadonlyArray<string> = ["flow", "slug", "schedule", "input", "tokens", "minutes"]
const triggerRegistration = (args: string | undefined): Parsed => {
  // Buttons carry a structured draft so flag-like strings inside JSON input stay input.
  if (trimmed(args).startsWith("{")) {
    try {
      const value: unknown = JSON.parse(args!)
      if (value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.entries(value).every(([key, field]) => (key === "repo" || TRIGGER_FIELDS.includes(key)) && typeof field === "string")) return ok(value as Record<string, unknown>)
    } catch { /* The malformed carried draft gets the same honest refusal. */ }
    return no("Registration input must name text fields")
  }
  const reason = `triggers.register takes an owner/repo and ${TRIGGER_FIELDS.map((field) => `--${field}`).join(", ")}`
  const head = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed(args))
  const payload: Record<string, unknown> = {}
  let rest = trimmed(args)
  if (head !== null && !head[1]!.startsWith("--")) {
    if (!REPO_TOKEN.test(head[1]!)) return no(reason)
    payload["repo"] = head[1]!
    rest = (head[2] ?? "").trim()
  }
  if (rest === "") return ok(payload)
  // JSON input may contain whitespace followed by a flag name. Only top-level boundaries split flags.
  const parts: string[] = []
  let start = 0, depth = 0, quoted = false, escaped = false
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{" || char === "[") depth += 1
    else if (char === "}" || char === "]") depth = Math.max(0, depth - 1)
    else if (depth === 0 && /\s/.test(char) && rest.startsWith("--", index + 1)) {
      parts.push(rest.slice(start, index)); start = index + 1
    }
  }
  parts.push(rest.slice(start))
  for (const part of parts) {
    const flag = /^--([a-z]+)(?:\s+([\s\S]*))?$/.exec(part.trim())
    if (flag === null || !TRIGGER_FIELDS.includes(flag[1]!)) return no(reason)
    payload[flag[1]!] = (flag[2] ?? "").trim()
  }
  return ok(payload)
}

/**
 * `--name <name> --protocol <protocol> --model <model id> --credential <NAME>
 * [--url <base url>] [--path <path>]`: the record model.save takes, each flag
 * onto the record's own field name. No value holds whitespace, and a short
 * line decodes to what it gave: that is the prefill model.edit opens the form
 * with. There is no flag for a credential's value, because there is no field.
 */
const MODEL_FLAGS: Readonly<Record<string, string>> = {
  name: "name",
  protocol: "protocol",
  model: "modelId",
  credential: "credential",
  url: "baseUrl",
  path: "path"
}
const modelSave = (args: string | undefined): Parsed => {
  const reason = `model.save takes ${Object.keys(MODEL_FLAGS).map((name) => `--${name}`).join(", ")}`
  const payload: Record<string, unknown> = {}
  const rest = trimmed(args)
  if (rest === "") return ok(payload)
  if (!rest.startsWith("--")) return no(reason)
  for (const part of rest.split(/\s+(?=--)/)) {
    const flag = /^--([a-z]+)(?:\s+(\S+))?$/.exec(part.trim())
    const field = flag === null ? undefined : MODEL_FLAGS[flag[1]!]
    if (flag === null || field === undefined) return no(reason)
    if (flag[2] !== undefined) payload[field] = flag[2]
  }
  return ok(payload)
}

/** `<name>`: the one model a model flow acts on. A name holds no whitespace, and a bare line opens the form. */
const modelName = (name: string, args: string | undefined): Parsed => {
  const [id, ...extra] = tokensOf(args)
  if (extra.length > 0) return no(`${name} takes one model name`)
  return ok(id === undefined ? {} : { id })
}

/** A composer edit: one JSON object, so a prompt keeps its newlines and quotes. */
const jsonObject = (name: string) => (args: string | undefined): Parsed => {
  if (!(args ?? "").trim()) return ok({})
  try {
    const value: unknown = JSON.parse(args!)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? ok(value as Record<string, unknown>) : no(`${name} takes a JSON object`)
  } catch { return no(`${name} takes a JSON object`) }
}

/** Typed controls keep explicit fields out of ambiguous human argument text. */
const structuredFields = (name: string, args: string | undefined, fields: readonly string[]): Parsed | undefined => {
  if (!args?.trimStart().startsWith("{")) return undefined
  const parsed = jsonObject(name)(args)
  return "payload" in parsed && Object.keys(parsed.payload).some(key => !fields.includes(key))
    ? no(`${name} takes ${fields.join(", ")}`) : parsed
}

/** Two identifier positions are unambiguous; a lone slash-bearing id may be a path/ref. */
const identifierRepo = (args: string | undefined, known?: KnownRepositories) =>
  splitTrailingRepo(args, tokensOf(args).length > 1 ? undefined : known)

/**
 * `<name> [owner/repo]`: the schedule `triggers.run` fires now. A schedule's
 * name holds no whitespace (SLUG), so the repository trails it as it does
 * everywhere else, and a line with no name at all opens the form for it.
 */
const triggerRun = (args: string | undefined, known?: KnownRepositories): Parsed => {
  const { rest, repo } = identifierRepo(args, known)
  const slug = rest.trim()
  if (/\s/.test(slug)) return no("triggers.run takes a schedule name and optionally an owner/repo")
  return ok({ ...(slug === "" ? {} : { slug }), ...(repo === undefined ? {} : { repo }) })
}

/** `<NAME> [owner/repo]`: a secret name holds no whitespace, so the repository trails it. */
const secretName = (name: string, args: string | undefined, known: KnownRepositories | undefined, needed: boolean): Parsed => {
  const { rest, repo } = identifierRepo(args, known)
  const secret = rest.trim()
  if (/\s/.test(secret)) return no(`${name} takes a secret name and optionally an owner/repo`)
  if (needed && secret === "") return no("Choose a secret")
  return ok({ ...(secret === "" ? {} : { name: secret }), ...(repo === undefined ? {} : { repo }) })
}

/** The three sandbox kinds `box.open --kind` accepts (ADR 0002). */
const KINDS: ReadonlyArray<string> = ["container", "vm", "desktop"]

/**
 * `<number> <text> [owner/repo]` as typed, or the button's JSON object
 * (FlowArgs.ts). Either way the text is kept as written: a Markdown comment's
 * newlines, indentation and code fences are the comment.
 */
const issueComment = (args: string | undefined, known?: KnownRepositories): Parsed => {
  const line = trimmed(args)
  let fields: Record<string, unknown>
  if (line.startsWith("{")) {
    const parsed = jsonObject("issues.comment")(line)
    if ("error" in parsed) return parsed
    fields = parsed.payload
    if (Object.keys(fields).some(key => key !== "number" && key !== "text" && key !== "repo")) return no("issues.comment takes number, text and repo")
    if (fields.repo !== undefined && typeof fields.repo !== "string") return no("issues.comment's repository must be owner/repo")
  } else {
    const { rest, repo } = splitTrailingRepo(line, known)
    const [, head = "", text = ""] = /^(\S*)\s*([\s\S]*)$/.exec(rest) ?? []
    fields = { number: Number(head), text, ...(repo === undefined ? {} : { repo }) }
  }
  const { number, text, repo } = fields
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return no("issues.comment needs an issue number")
  if (typeof text !== "string" || text.trim() === "") return no("issues.comment needs the comment text")
  return ok({ number, text: text.trim(), ...(repo === undefined ? {} : { repo }) })
}

/** `[bookmark] [owner/repo]`: the one-command desktop open and its bare `desktop` door. */
const desktopOpen = (args: string | undefined, known?: KnownRepositories): Parsed => {
  const structured = structuredFields("box.desktop.open", args, ["bookmark", "repo"])
  if (structured !== undefined) return structured
  const { rest, repo } = identifierRepo(args, known)
  const bookmark = rest.trim()
  if (/\s/.test(bookmark)) return no("desktop takes a bookmark and optionally an owner/repo")
  return ok({ ...(bookmark === "" ? {} : { bookmark }), ...(repo === undefined ? {} : { repo }) })
}

/**
 * The rest of the trimmed line after its first `count` tokens, with the
 * spacing inside it intact — how a grammar takes a tail that may hold
 * whitespace (a path, a message, a name).
 */
const restAfter = (args: string | undefined, count: number): string => {
  let rest = trimmed(args)
  for (let index = 0; index < count; index += 1) {
    const match = /^\S+\s*/.exec(rest)
    if (match === null) return ""
    rest = rest.slice(match[0].length)
  }
  return rest.trim()
}

/** `<number> [owner/repo]`: a positive integer, then an optional repository. */
const numberedTarget = (name: string, args: string | undefined): Parsed => {
  const [first, repo, ...rest] = tokensOf(args)
  if (first === undefined) return NONE
  const number = Number(first)
  if (!Number.isInteger(number) || number <= 0) return no(`${name} needs an issue number`)
  if (rest.length > 0) return no(`${name} takes a number and one owner/repo`)
  return ok(repo === undefined ? { number } : { number, repo })
}
const tokensOf = (args: string | undefined): Array<string> =>
  trimmed(args)
    .split(/\s+/)
    .filter((token) => token !== "")

/**
 * `<path>:<line>:<col> [owner/repo]` (docs/code-intel/PLAN.md §4): a 1-based
 * position in a file, both numbers required. Only the TRAILING `:n:n` comes
 * off the token, so a path with a colon of its own keeps working, as
 * files.read's anchor does.
 */
const positioned = (name: string, args: string | undefined): Parsed => {
  const parsed = parseFileArgs(args)
  if ("error" in parsed) return parsed
  const tokens = parsed.tokens
  const [token, repo] = tokens
  const usage = `/${name} <path>:<line>:<col> [owner/repo]`
  if (token === undefined) return no(`${name} needs a position: ${usage}`)
  if (tokens.length > 2) return no(`${name} takes a position and optionally an owner/repo`)
  const match = /^(.+):(\d+):(\d+)$/.exec(token)
  if (match === null) return no(`${name} needs <path>:<line>:<col>: ${usage}`)
  const [, path = "", lineText = "", columnText = ""] = match
  const line = Number(lineText)
  const column = Number(columnText)
  if (line === 0 || column === 0) return no(`${name} lines and columns count from 1: ${usage}`)
  return ok({ path, line, column, ...(repo === undefined ? {} : { repo }) })
}

/*
 * The grammar, one entry per flow that accepts arguments. A flow absent from
 * this table takes the empty payload — which is also what a flow with no args
 * hint gets, since `parseSubmit` routes `/name <text>` for such a flow to the
 * agent as a prompt rather than to the flow.
 */
/** `<changeId> <n>`: a change id followed by one positive id (a thread, a finding). */
const numberedChangeRef = (name: string, field: string, what: string, args: string | undefined): Parsed => {
  const [changeId, raw, ...rest] = tokensOf(args)
  const id = Number(raw)
  if (changeId === undefined || raw === undefined || rest.length > 0 || !Number.isInteger(id) || id <= 0) {
    return no(`${name} takes a change id and ${what}`)
  }
  return ok({ changeId, [field]: id })
}

const GRAMMAR: Readonly<Record<string, Grammar>> = {
  "issues.fix": (args) => numberedTarget("issues.fix", args),
  "issues.verify": (args) => numberedTarget("issues.verify", args),
  "issues.comment.react": jsonObject("issues.comment.react"),
  "issues.sync.resolve": jsonObject("issues.sync.resolve"),
  "issues.comment.retry": jsonObject("issues.comment.retry"),
  "issues.set": jsonObject("issues.set"),
  /* `<connection_id> <scope_id> <conversation_id> [external_user_id] [owner/repo]`, or the form's `{ connection_id, scope_id, conversation_id, external_user_id, repo }`. */
  "integrations.admit": (args, known) => {
    const structured = structuredFields("integrations.admit", args, ["connection_id", "scope_id", "conversation_id", "external_user_id", "repo"])
    if (structured !== undefined) return structured
    const { rest, repo } = splitTrailingRepo(args, known)
    const [connection_id, scope_id, conversation_id, external_user_id, extra] = tokensOf(rest)
    if (extra !== undefined) return no("integrations.admit takes a connection id, workspace id, channel id, an optional user id and optionally an owner/repo")
    return ok({
      ...(connection_id === undefined ? {} : { connection_id }), ...(scope_id === undefined ? {} : { scope_id }),
      ...(conversation_id === undefined ? {} : { conversation_id }), ...(external_user_id === undefined ? {} : { external_user_id }),
      ...(repo === undefined ? {} : { repo })
    })
  },
  "integrations.list": args => repoOnly("integrations.list", args),
  "issues.setup": args => repoOnly("issues.setup", args),
  "review.setup": args => repoOnly("review.setup", args),
  "ci.setup": args => repoOnly("ci.setup", args),
  "feature.setup": args => repoOnly("feature.setup", args),
  "chores.setup": args => repoOnly("chores.setup", args),
  "setup.ask": args => setupObject(args),
  "setup.configure": args => setupObject(args),
  "setup.guide": setupGuideTarget,
  "setup.view": args => setupObject(args),
  "setup.work": args => setupObject(args),
  "setup.run": args => setupObject(args),
  "setup.retry": args => required("cardId", args, "Choose the setup to retry"),
  "setup.discard": args => required("cardId", args, "Choose the setup whose draft to discard"),
  "setup.discard.confirm": args => required("cardId", args, "Choose the setup whose draft to discard"),
  "appearance.theme": (args) => ok({ palette: args ?? "" }),
  "chat.queue": args => required("text", args, "Choose a prompt"),
  "chat.queue.edit": args => required("id", args, "Choose a queued prompt"),
  "chat.queue.remove": args => required("id", args, "Choose a queued prompt"),
  "chat.send": (args) => required("text", args, "send needs the text to submit"),
  "chat.filter.toggle": (args) => required("target", args, "Choose a filter target"),
  "chat.filter.grep": (args) => ok({ text: args ?? "" }),
  "chat.clear": (args) => trimmed(args) === "" ? NONE : trimmed(args) === "--summarize"
    ? ok({ summarize: true })
    : no("chat.clear accepts only --summarize; omit it to archive locally"),
  "browser.open": (args) => required("url", args, "browser needs a URL: /browser.open https://example.com"),
  /*
   * The description keeps the trailing `owner/repo` token: createWorkflow
   * applies its OWN split, which (unlike splitTrailingRepo) leaves a lone
   * repo-shaped word as the description. Splitting here would change which
   * inputs name a target.
   */
  "flow.create": (args) => structuredFields("flow.create", args, ["description", "repo"]) ?? ok({ description: trimmed(args) }),
  "flow.repo.choose": (args) => required("repo", args, "flow.repo.choose needs a repository name"),
  "flow.run.stop": (args) => {
    const [cardId, ...rest] = tokensOf(args)
    if (cardId === undefined) return no("flow.run.stop needs the card id")
    const reason = rest.join(" ").trim()
    return ok(reason === "" ? { cardId } : { cardId, reason })
  },
  "flow.run.retry": (args) => required("cardId", args, "flow.run.retry needs the card id"),
  /*
   * Lane runs — the run inbox and its acts. `runs.list` takes its filters in
   * any order: `by=`/`lineage=` name theirs, a trailing owner/repo names the
   * workspace, and the remaining positionals are [status] [flow].
   */
  "runs.attention": (args) => repoOnly("runs.attention", args),
  "runs.handoff": (args) => required("runId", args, "Choose a run to prepare its handoff"),
  "runs.list": (args, known) => {
    const structured = structuredFields("runs.list", args, ["status", "flow", "by", "lineage", "sourceCard", "repo"])
    if (structured !== undefined) return structured
    const { rest, repo } = splitTrailingRepo(args, known)
    const payload: Record<string, string> = {}
    const positional: Array<string> = []
    for (const token of tokensOf(rest)) {
      const keyed = /^(by|lineage|sourceCard)=(.+)$/.exec(token)
      if (keyed !== null) payload[keyed[1]!] = keyed[2]!
      else positional.push(token)
    }
    if (positional.length > 2) return no("runs.list takes [status] [flow] [by=…] [lineage=…] [sourceCard=…] [owner/repo]")
    const [status, flow] = positional
    if (status !== undefined) payload["status"] = status
    if (flow !== undefined) payload["flow"] = flow
    if (repo !== undefined) payload["repo"] = repo
    return ok(payload)
  },
  "runs.open": (args, known) => {
    const tokens = (args ?? "").trim().split(/\s+/)
    const requests = tokens.filter(token => token.startsWith("requestId="))
    if (requests.length > 1 || requests[0] === "requestId=") return no("The saved run request is invalid.")
    const requestId = requests[0]?.slice("requestId=".length)
    const { rest, repo } = identifierRepo(tokens.filter(token => !token.startsWith("requestId=")).join(" "), known)
    const runId = rest.trim()
    if (runId === "" || /\s/.test(runId)) return no("runs.open needs a run id: /runs.open <runId> [owner/repo]")
    return ok({ runId, ...(repo === undefined ? {} : { repo }), ...(requestId === undefined ? {} : { requestId }) })
  },
  "runs.resume": (args) => required("runId", args, "runs.resume needs a run id"),
  "runs.rerun": (args) => required("runId", args, "runs.rerun needs a run id"),
  "runs.continue": (args) => {
    const [runId, requestId, ...extra] = tokensOf(args)
    if (runId === undefined) return no("runs.continue needs a run id")
    if (requestId === undefined || extra.length > 0) return no("runs.continue takes a run id and the request id: /runs.continue <runId> <requestId>")
    return ok({ runId, requestId })
  },
  "runs.signal": (args) => {
    const [runId, name] = tokensOf(args)
    if (runId === undefined) return no("runs.signal needs a run id")
    if (name === undefined) return no("runs.signal needs the signal's name: /runs.signal <runId> <name> [json]")
    // The payload keeps its original spacing — JSON is whitespace-sensitive to a reader.
    const payload = trimmed(args).slice(runId.length).trim().slice(name.length).trim()
    return ok(payload === "" ? { runId, name } : { runId, name, payload })
  },
  "runs.steer": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.steer needs a run id")
    const body = rest.join(" ").trim()
    if (body === "") return no("runs.steer needs the message to deliver")
    return ok({ runId, body })
  },
  "runs.seat": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.seat needs a run id")
    const seat = rest.join(" ").trim()
    if (seat === "") return no("runs.seat needs the seat to move the run to")
    return ok({ runId, seat })
  },
  "runs.thinking": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.thinking needs a run id")
    const thinking = rest.join(" ").trim()
    if (thinking === "") return no("runs.thinking needs the thinking level")
    return ok({ runId, thinking })
  },
  "runs.tools": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.tools needs a run id")
    const toolNames = rest.join(" ").trim()
    if (toolNames === "") return no("runs.tools needs the tool names, comma-separated")
    return ok({ runId, toolNames })
  },
  "runs.logs": (args) => {
    const tokens = tokensOf(args)
    const follow = tokens.includes("--follow")
    const [runId, ...rest] = tokens.filter((token) => token !== "--follow")
    if (runId === undefined) return no("runs.logs needs a run id: /runs.logs <runId> [--follow]")
    if (rest.length > 0) return no("runs.logs takes a run id and optionally --follow")
    return ok(follow ? { runId, follow } : { runId })
  },
  /* The run trace's reader gestures (factory spec 06 §6): a filter word, or a node with an optional journal seq. */
  "runs.trace.filter": (args) => {
    const [runId, filter, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.trace.filter needs a run id")
    if (filter === undefined || !isTraceFilter(filter)) {
      return no(`runs.trace.filter needs one of ${TRACE_FILTER_IDS.join(", ")}`)
    }
    if (rest.length > 0) return no("runs.trace.filter takes a run id and one filter")
    return ok({ runId, filter })
  },
  "runs.trace.select": (args) => {
    const [runId, nodeId, seqText, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.trace.select needs a run id")
    if (nodeId === undefined) return no("runs.trace.select needs the trace node to select")
    if (rest.length > 0) return no("runs.trace.select takes a run id, a node and optionally a journal seq")
    if (seqText === undefined) return ok({ runId, nodeId })
    const seq = Number(seqText)
    if (!Number.isInteger(seq) || seq < 0) return no("runs.trace.select's seq is a journal sequence number")
    return ok({ runId, nodeId, seq })
  },
  "runs.events": (args) => required("runId", args, "runs.events needs a run id"),
  "runs.coding.select": (args) => {
    const [runId, changeId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.coding.select needs a run id")
    if (changeId === undefined) return no("runs.coding.select needs a predicted Change")
    if (rest.length > 0) return no("runs.coding.select takes a run id and one Change")
    return ok({ runId, changeId })
  },
  "runs.trace.live": (args) => required("runId", args, "runs.trace.live needs a run id"),
  "runs.trace.view": (args) => {
    const [runId, view, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.trace.view needs a run id")
    if (view !== "turns" && view !== "timeline" && view !== "graph" && view !== "steps" && view !== "devtools") return no("runs.trace.view needs turns, timeline, graph, steps or devtools")
    if (rest.length > 0) return no("runs.trace.view takes a run id and one view")
    return ok({ runId, view })
  },
  "runs.graph.follow": (args) => {
    const [runId, follow, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.graph.follow needs a run id")
    if (follow !== "on" && follow !== "off") return no("runs.graph.follow needs on or off")
    if (rest.length > 0) return no("runs.graph.follow takes a run id and on or off")
    return ok({ runId, follow })
  },
  "runs.takeover": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.takeover needs a run id")
    if (rest.length > 0) return no("runs.takeover takes one run id")
    return ok({ runId })
  },
  "runs.release": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.release needs a run id")
    if (rest.length > 0) return no("runs.release takes one run id")
    return ok({ runId })
  },
  "runs.graph.execution": (args) => {
    const [runId, executionId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.graph.execution needs a run id")
    if (rest.length > 0) return no("runs.graph.execution takes a run id and at most one execution")
    return ok(executionId === undefined ? { runId } : { runId, executionId })
  },
  /* The graph's drill-in (L5): a node to open, or nothing at all to close the one that is open. */
  "runs.graph.select": (args) => {
    const structured = graphObject(args, "runId", "nodeId")
    if (structured !== undefined) return structured
    const [runId, nodeId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.graph.select needs a run id")
    if (rest.length > 0) return no("runs.graph.select takes a run id and at most one node")
    return ok(nodeId === undefined ? { runId } : { runId, nodeId })
  },
  "runs.graph.tab": (args) => {
    const structured = graphObject(args, "runId", "tab")
    if (structured !== undefined) return structured
    const [runId, tab, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.graph.tab needs a run id")
    if (tab === undefined || !isGraphDrawerTab(tab)) return no(unknownTabRefusal("runs.graph.tab"))
    if (rest.length > 0) return no("runs.graph.tab takes a run id and one tab")
    return ok({ runId, tab })
  },
  "flow.plan.select": (args) => {
    const structured = graphObject(args, "cardId", "nodeId")
    if (structured !== undefined) return structured
    const [cardId, nodeId, ...rest] = tokensOf(args)
    if (cardId === undefined) return no("flow.plan.select needs the plan card it draws on")
    if (rest.length > 0) return no("flow.plan.select takes a plan card and at most one node")
    return ok(nodeId === undefined ? { cardId } : { cardId, nodeId })
  },
  "flow.plan.tab": (args) => {
    const structured = graphObject(args, "cardId", "tab")
    if (structured !== undefined) return structured
    const [cardId, tab, ...rest] = tokensOf(args)
    if (cardId === undefined) return no("flow.plan.tab needs the plan card it draws on")
    if (tab === undefined || !isGraphDrawerTab(tab)) return no(unknownTabRefusal("flow.plan.tab"))
    if (rest.length > 0) return no("flow.plan.tab takes a plan card and one tab")
    return ok({ cardId, tab })
  },
  "runs.steps": (args) => required("runId", args, "runs.steps needs a run id"),
  "approvals.list": (args) => repoOnly("approvals.list", args),
  "flow.run.stop-all": (args) => repoOnly("flow.run.stop-all", args),
  "approvals.open": (args) => required("runId", args, "approvals.open needs a run id"),
  "flow.list": (args) => repoOnly("flow.list", args),
  "triggers.list": (args) => repoOnly("triggers.list", args),
  "triggers.register": (args) => triggerRegistration(args),
  "triggers.resume": (args, known) => triggerRun(args, known),
  "triggers.run": (args, known) => triggerRun(args, known),
  "flow.run": (args) => flowTarget("flow.run", args),
  /*
   * The plan door takes the launch's own line, because it is the launch's own
   * address stopped at the plan. Without this entry the grammar answered
   * nothing and every plan door — the row's button and the slash alike —
   * raised an empty form instead of planning the flow it was handed.
   */
  "flow.plan": (args) => {
    /* `against=<runId>` asks for the re-key preview: the same plan, compared
     * with the plan that run was approved on (L7, D-030). */
    const preview = splitPlanAgainst(args)
    const parsed = flowTarget("flow.plan", preview.args)
    return preview.against === undefined || "error" in parsed ? parsed : ok({ ...parsed.payload, against: preview.against })
  },
  "card.history.back": (args) => required("cardId", args, "Choose a frame to go back"),
  "card.history.forward": (args) => required("cardId", args, "Choose a frame to go forward"),
  "notifications.read-update": (args) => required("cardId", args, "Choose an update to mark read"),
  "notifications.tag": (args) => {
    const [id, ...rest] = tokensOf(args)
    return ok({ ...(id ? { id } : {}), ...(rest.length ? { tag: rest.join(" ") } : {}) })
  },
  "repo.overview": (args) => repoOnly("repo.overview", args),
  "repo.update": (args) => repoOnly("repo.update", args),
  "card.maximize": (args) => required("cardId", args, "card.maximize needs the card id"),
  "card.dismiss": (args) => required("cardId", args, "card.dismiss needs the card id"),
  // The clipboard text is taken verbatim: trimming would silently rewrite what
  // the human asked to copy.
  "chat.copy-message": (args) => (args ?? "") === "" ? no("copy-message needs the text to copy") : ok({ text: args ?? "" }),
  "approval.approve": (args) => required("cardId", args, "approval.approve needs the card id"),
  "approval.deny": (args) => required("cardId", args, "approval.deny needs the card id"),
  "wiki.select": (args) => required("documentId", args, "wiki.select needs the document id"),
  "wiki.cloud": (args) => {
    const { line: positional, space } = wikiSpaceFlag(args)
    if (typeof space === "object") return no(space.error)
    const [repo, page] = tokensOf(positional)
    if (repo === undefined) return no("Choose a repository for its Wiki.")
    if (page !== undefined && !/^\d+$/.test(page)) return no("A Wiki page is a whole number.")
    return ok({ repo, ...(page === undefined ? {} : { page: Number(page) }), ...(space === undefined ? {} : { space }) })
  },
  "wiki.cloud.open": (args) => {
    const { line: positional, space } = wikiSpaceFlag(args)
    if (typeof space === "object") return no(space.error)
    // Both positions are explicit identifiers; inventory cannot disambiguate them.
    const { rest, repo } = splitTrailingRepo(positional)
    return rest === "" || repo === undefined ? no("Choose a Wiki page slug and repository.") : ok({ slug: rest, repo, ...(space === undefined ? {} : { space }) })
  },
  "wiki.view": (args) => trimmed(args) === "read" || trimmed(args) === "edit" ? ok({ view: trimmed(args) }) : no("A Wiki page view is read or edit."),
  "wiki.space": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    if (rest !== "public" && rest !== "private") return no("A Wiki space is public or private.")
    return ok({ space: rest, ...(repo === undefined ? {} : { repo }) })
  },
  "wiki.cloud.new": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    return rest === "" ? no("A page needs a title.") : ok({ title: rest, ...(repo === undefined ? {} : { repo }) })
  },
  "wiki.cloud.rename": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const [slug, ...path] = tokensOf(rest)
    if (slug === undefined) return no("wiki.cloud.rename takes a page slug and its new path.")
    // The page's button carries only the slug; the form then asks for the path.
    return ok({ slug, ...(path.length === 0 ? {} : { path: path.join(" ") }), ...(repo === undefined ? {} : { repo }) })
  },
  "wiki.cloud.delete": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    return rest === "" || /\s/.test(rest) ? no("wiki.cloud.delete takes a page slug.") : ok({ slug: rest, ...(repo === undefined ? {} : { repo }) })
  },
  "wiki.history": (args) => {
    const { line: positional, space } = wikiSpaceFlag(args)
    if (typeof space === "object") return no(space.error)
    const { rest, repo } = splitTrailingRepo(positional)
    const [slug, page, ...more] = tokensOf(rest)
    if (slug === undefined || more.length > 0) return no("wiki.history takes a page slug.")
    if (page !== undefined && !/^\d+$/.test(page)) return no("A history page is a whole number.")
    return ok({ slug, ...(page === undefined ? {} : { page: Number(page) }), ...(repo === undefined ? {} : { repo }), ...(space === undefined ? {} : { space }) })
  },
  "wiki.attach": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const path = tokensOf(rest)
    return ok({ ...(path.length === 0 ? {} : { path: path.join(" ") }), ...(repo === undefined ? {} : { repo }) })
  },
  "wiki.sync": (args) => required("documentId", args, "wiki.sync needs the document id"),
  "wiki.card.select": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const [cardId, documentId] = parsed.tokens
    return cardId === undefined || documentId === undefined ? no("Choose a Wiki card and page.") : ok({ cardId, documentId })
  },
  "wiki.card.view": (args) => {
    const [cardId, view] = tokensOf(args)
    return cardId === undefined || view === undefined ? no("Choose a Wiki card and view.") : ok({ cardId, view })
  },
  "wiki.edit": (args) => {
    const [documentId] = tokensOf(args)
    if (documentId === undefined) return no("Choose a Wiki page and its Markdown.")
    const body = trimmed(args).slice(documentId.length).trim()
    if (body === "") return no("Supply the Wiki page's Markdown.")
    try { return ok({ documentId, body: JSON.parse(body) }) }
    catch { return no("Supply Markdown as a JSON string, or open the Wiki edit form without a body.") }
  },
  "wiki.delete": (args) => required("documentId", args, "wiki.delete needs the document id"),
  // Librarian L5: a note by path, file stem or title; wiki.graph without one is the whole Wiki.
  "wiki.open": (args) => required("path", args, "wiki.open needs a note path or title"),
  "wiki.backlinks": (args) => required("path", args, "wiki.backlinks needs a note path or title"),
  "wiki.graph": (args) => optional("path", args),
  "wiki.heading": (args) => {
    const [line, cardId] = (args ?? "").trim().split(/\s+/)
    return line ? ok({ line, ...(cardId ? { cardId } : {}) }) : no("wiki.heading needs the heading's source line")
  },
  /* Hidden aliases of the two above (entries/world.ts). */
  "world.select": (args) => required("documentId", args, "world.select needs the document id"),
  "world.delete": (args) => required("documentId", args, "world.delete needs the document id"),
  "toast.dismiss": (args) => required("toastId", args, "toast.dismiss needs the toast id"),
  /* The Library's two acts: one plugin id, the one the shelf lists. */
  "plugins.install": (args) => required("plugin", args, "plugins.install needs a plugin id — /plugins lists them"),
  "plugins.remove": (args) => required("plugin", args, "plugins.remove needs a plugin id — /plugins lists what is installed"),
  /* The flow the card names as absent; blank renders the generic "That is not in the web app". */
  "app.download.prompt": (args) => optional("flow", args),
  "repos.import": (args) => repoOnly("repos.import", args),
  /* One freeform repository link; without it the form asks for one. */
  "repository.register": (args) => ok((args ?? "").trim() === "" ? {} : { link: (args ?? "").trim() }),
  /* Tutorial stage 3's bare doors: the same read as their .list flows. */
  "issues": (args, known) => GRAMMAR["issues.list"]!(args, known),
  "prs": (args, known) => GRAMMAR["prs.list"]!(args, known),
  "issues.list": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    // `--kind conversation|issue` narrows the list (DESIGN §3.1, §3.2).
    const kindMatch = /(?:^|\s)--kind(?:\s+|=)(\S+)/.exec(rest)
    const kind = kindMatch?.[1]
    if (kind !== undefined && kind !== "conversation" && kind !== "issue" && kind !== "all") return no("issues.list --kind takes conversation, issue or all")
    // `--view <id>` lists through a saved view the repository's factory declares (#2269).
    const viewMatch = /(?:^|\s)--view(?:\s+|=)(\S+)/.exec(rest)
    const view = viewMatch?.[1]
    if (view !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(view)) return no("issues.list --view takes a saved view id")
    const bare = rest.replace(/(?:^|\s)--kind(?:\s+|=)\S+/, "").replace(/(?:^|\s)--view(?:\s+|=)\S+/, "").trim()
    const filter = bare === "" ? "open" : bare
    if (filter !== "open" && filter !== "closed" && filter !== "all") {
      return no("issues.list takes open, closed, or all")
    }
    return ok({ filter, ...(repo === undefined ? {} : { repo }), ...(kind === undefined || kind === "all" ? {} : { kind }), ...(view === undefined ? {} : { view }) })
  },
  "issue.flows": (args, known) => numbered(args, "An issue number is required", known),
  "issue.repro": (args, known) => numbered(args, "An issue number is required", known),
  "issue.poc": (args, known) => numbered(args, "An issue number is required", known),
  "issue.implement": (args, known) => numbered(args, "An issue number is required", known),
  "prs.triage": (args, known) => numbered(args, "A pull request number is required", known),
  "wiki.ask": (args) => required("question", args, "wiki.ask needs the question"),
  "issue.add-flow": (args) => {
    try {
      const value: unknown = JSON.parse(trimmed(args))
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? ok(value as Record<string, unknown>) : no("Describe the flow to add")
    } catch { return no("Describe the flow to add") }
  },
  "issues.view": args => {
    const parts = issueViewParts(args)
    if (parts.number === undefined) return no("issues.view needs an issue number")
    if (parts.source !== undefined && parts.source !== "github" && parts.source !== "smithers-cloud") return no("Choose GitHub or Smithers Cloud as the issue source")
    return ok(parts)
  },
  "issues.create": (args, known) => {
    // `--kind conversation` starts an owner-private conversation (smithers-ui-DESIGN.md §3.1); the title is everything else.
    const kindMatch = /(?:^|\s)--kind(?:\s+|=)(\S+)\s*$/.exec(args ?? "")
    const kind = kindMatch?.[1]
    if (kind !== undefined && kind !== "conversation" && kind !== "issue") return no("issues.create --kind takes conversation or issue")
    const { rest, repo } = splitTrailingRepo(kindMatch === null ? args : (args ?? "").slice(0, kindMatch.index).trim(), known)
    if (rest === "") return no("issues.create needs a title")
    return ok({ title: rest, ...(repo === undefined ? {} : { repo }), ...(kind === undefined ? {} : { kind }) })
  },
  /*
   * The repository welcome and its three answers (controller/onboarding.ts):
   * each takes only its optional target. `feature.prototype` reads like
   * issues.create: the request is the line, a trailing owner/repo the target.
   */
  "change.request": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    // Only a trailing `from:<name>` names the pushed ref; "from:" inside the
    // request is prose.
    const from = /(?:^|\s)from:(\S*)$/.exec(rest)
    const prompt = from === null ? rest : rest.slice(0, from.index).trim()
    if (from !== null && !PUSHED_REF_NAME.test(from[1]!)) return no("change.request's from: names a ref pushed with `smithers repo push --name <name>`")
    const payload: Record<string, unknown> = {}
    if (prompt !== "") payload["prompt"] = prompt
    if (from !== null) payload["from"] = from[1]
    if (repo !== undefined) payload["repo"] = repo
    return ok(payload)
  },
  "feature.prototype": (args, known) => {
    const structured = structuredFields("feature.prototype", args, ["request", "repo"])
    if (structured !== undefined) return structured
    const { rest, repo } = splitTrailingRepo(args, known)
    if (rest === "") return no("feature.prototype needs what the feature should do")
    return ok(repo === undefined ? { request: rest } : { request: rest, repo })
  },
  "issues.close": (args, known) => numbered(args, "issues.close needs an issue number", known),
  "issues.reopen": (args, known) => numbered(args, "issues.reopen needs an issue number", known),
  "issues.comment": (args, known) => issueComment(args, known),
  "prs.list": (args) => repoOnly("prs.list", args),
  "prs.view": (args, known) => numbered(args, "prs.view needs a pull request number", known),
  "prs.tab": args => {
    const [cardId, tab, ...rest] = tokensOf(args)
    return cardId && tab && rest.length === 0 && ["conversation", "commits", "checks", "files"].includes(tab)
      ? ok({ cardId, tab }) : no("Choose a pull request card and tab")
  },
  "prs.create": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    // The source bookmark rides as a `from:<name>` token anywhere in the text;
    // /branches.list shows the choices.
    const tokens = rest.split(/\s+/).filter((token) => token !== "")
    const fromToken = tokens.find((token) => token.startsWith("from:"))
    const from = fromToken?.slice("from:".length)
    const title = tokens.filter((token) => !token.startsWith("from:")).join(" ")
    if (title === "") return no("prs.create needs a title")
    if (fromToken !== undefined && (from === undefined || from === "")) {
      return no("prs.create's from: token needs a bookmark name — see /branches.list")
    }
    return ok({
      title,
      ...(from === undefined || from === "" ? {} : { from }),
      ...(repo === undefined ? {} : { repo })
    })
  },
  "prs.land": (args, known) => numbered(args, "prs.land needs a pull request number", known),
  "prs.review": (args, known) => {
    const structured = structuredFields("prs.review", args, ["number", "verdict", "text", "repo"])
    if (structured !== undefined) {
      if ("error" in structured) return structured
      const payload = structured.payload
      return ok({ ...payload, verdict: payload.verdict === "request-changes" ? "request_changes" : payload.verdict,
        text: payload.text === undefined ? "" : payload.text })
    }
    const { rest, repo } = splitTrailingRepo(args, known)
    const [head, verdict, ...tail] = rest.split(/\s+/)
    const number = Number(head)
    if (!Number.isInteger(number) || number <= 0) return no("prs.review needs a pull request number")
    const type = verdict === "approve"
      ? "approve"
      : verdict === "request-changes"
      ? "request_changes"
      : verdict === "comment"
      ? "comment"
      : undefined
    if (type === undefined) {
      return no("prs.review needs a verdict: approve, request-changes, or comment")
    }
    const text = tail.join(" ").trim()
    return ok(repo === undefined ? { number, verdict: type, text } : { number, verdict: type, text, repo })
  },
  "billing.upgrade": (args) => optional("plan", args),
  "env.view": (args) => repoOnly("env.view", args),
  "env.remove-token": (args) => repoOnly("env.remove-token", args),
  "env.set": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    if (rest === "") return no("env.set needs a NAME=value pair")
    return ok(repo === undefined ? { assignment: rest } : { assignment: rest, repo })
  },
  "secrets.revoke": (args) => required("id", args, "Choose a coding connection"),
  "secrets.move": (args) => {
    const [id, direction, ...rest] = tokensOf(args)
    if (id === undefined || (direction !== "up" && direction !== "down") || rest.length > 0) {
      return no("secrets.move takes a connection id and up or down")
    }
    return ok({ id, direction })
  },
  "secrets.scope": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    const [name, scope, ...extra] = tokensOf(rest)
    if (name === undefined || (scope !== "main-only" && scope !== "all") || extra.length > 0) {
      return no("secrets.scope takes a secret name and main-only or all")
    }
    return ok(repo === undefined ? { name, scope } : { name, scope, repo })
  },
  "secrets.list": (args) => repoOnly("secrets.list", args),
  "secrets.bind": (args, known) => structuredFields("secrets.bind", args, ["name", "hosts", "headers", "repo"]) ?? secretName("secrets.bind", args, known, false),
  /* The value is never on a line: it arrives only through the form's write-only field. */
  "secrets.set": (args, known) => structuredFields("secrets.set", args, ["name", "hosts", "headers", "repo"]) ?? secretName("secrets.set", args, known, false),
  "secrets.delete": (args, known) => secretName("secrets.delete", args, known, true),
  "model.show": (args) => modelName("model.show", args),
  "model.edit": (args) => modelName("model.edit", args),
  "model.remove": (args) => modelName("model.remove", args),
  "model.test": (args) => modelName("model.test", args),
  "model.compose": (args) => modelName("model.compose", args),
  "model.ask": (args) => modelName("model.ask", args),
  "model.recall": (args) => modelName("model.recall", args),
  "model.fixture": (args) => modelName("model.fixture", args),
  "model.prompt": jsonObject("model.prompt"),
  "model.state": jsonObject("model.state"),
  "model.question": jsonObject("model.question"),
  "model.option": jsonObject("model.option"),
  "model.save": (args) => modelSave(args),
  /* `<seat> <name|default>`: the seat alone is the card's Assign button, and the form asks for the model. */
  "model.assign": (args) => {
    const [seat, recordId, ...extra] = tokensOf(args)
    if (extra.length > 0) return no("model.assign takes a seat and a model name")
    return ok({ ...(seat === undefined ? {} : { seat }), ...(recordId === undefined ? {} : { recordId }) })
  },
  /*
   * The palette flows (Search and Command Palette Spec 2026-09-07 §6): the
   * whole line is the query, qualifiers included (`deploy status:failed`);
   * the seam reads them in the mode's own grammar. Only search.open takes
   * a flag, `--kinds a,b`, and only it may run with no query at all.
   */
  "search.open": (args) => {
    const tokens = tokensOf(args)
    const at = tokens.indexOf("--kinds")
    const kinds = at === -1 ? undefined : tokens[at + 1]
    const query = tokens.filter((_, index) => at === -1 || (index !== at && index !== at + 1)).join(" ")
    return ok({ ...(query === "" ? {} : { query }), ...(kinds === undefined ? {} : { kinds }) })
  },
  "search.files": (args) => required("query", args, "search.files needs a query"),
  "search.flows": (args) => required("query", args, "search.flows needs a query"),
  "search.targets": (args) => required("query", args, "search.targets needs a query"),
  "search.wiki": (args) => required("query", args, "search.wiki needs a query"),
  "search.history": (args) => required("query", args, "search.history needs a query"),
  "search.runs": (args) => required("query", args, "search.runs needs a query"),
  "search.changes": (args) => required("query", args, "search.changes needs a query"),
  "search.issues": (args) => required("query", args, "search.issues needs a query"),
  "search.boxes": (args) => required("query", args, "search.boxes needs a query"),
  "search.secrets": (args) => required("query", args, "search.secrets needs a query"),
  "tutorial.live.inspect": (args) => { const [cardId, eventId] = tokensOf(args); return ok({ ...(cardId ? { cardId } : {}), ...(eventId ? { eventId } : {}) }) },
  "tutorial.live.retry": (args) => required("cardId", args, "Choose a live tutorial run"),
  "app.first-run.dismiss": () => NONE,
  "app.hint.dismiss": args => required("id", args, "Choose a hint"),
  "input.mode": (args) => required("mode", args, "Choose an input mode."),
  "palette.open": (args) => optional("prefix", args),
  "palette.actions": (args) => required("ref", args, "palette.actions needs an item ref"),
  "history.show": (args) => repoOnly("history.show", args),
  "history.backfill": (args) => repoOnly("history.backfill", args),
  "history.parallel": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const value = Number(rest)
    if (!/^[1-8]$/.test(rest) || !Number.isInteger(value)) return no("history.parallel takes a lane count from 1 to 8")
    return ok(repo === undefined ? { value } : { value, repo })
  },
  "history.retry": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    if (!/^[\w-]{1,64}$/.test(rest)) return no("history.retry takes an item id")
    return ok(repo === undefined ? { id: rest } : { id: rest, repo })
  },
  "history.land": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const [id = "", head = "", ...extra] = rest.split(/\s+/)
    if (!/^[\w-]{1,64}$/.test(id) || !/^[\w-]{1,64}$/.test(head) || extra.length > 0) return no("history.land takes an item id and its pull request head")
    return ok(repo === undefined ? { id, head } : { id, head, repo })
  },
  /* `<title> [owner/repo]`, or the form's `{ title, body, repo }`. */
  "history.todo": (args, known) => {
    const structured = structuredFields("history.todo", args, ["title", "body", "repo"])
    if (structured !== undefined) return structured
    const { rest, repo } = splitTrailingRepo(args, known)
    return ok({ ...(rest === "" ? {} : { title: rest }), ...(repo === undefined ? {} : { repo }) })
  },
  "history.view": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    if (rest !== "issues" && rest !== "metrics") return no("history.view takes issues or metrics")
    return ok(repo === undefined ? { view: rest } : { view: rest, repo })
  },
  /*
   * Both generators need a repository. Commands.ts renders a form only for a
   * grammar failure, so a blank line must fail here rather than reach schema
   * rejection with a missing key.
   */
  "wiki.create": (args) => trimmed(args) === "" ? no("Choose a repository.") : repoOnly("wiki.create", args),
  "history.bootstrap": (args) => trimmed(args) === "" ? no("Choose a repository.") : repoOnly("history.bootstrap", args),
  "branches.list": (args) => repoOnly("branches.list", args),
  /* A lone token with a slash is the repository; name both to list a branch whose name has one. */
  "commits.list": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const tokens = rest === "" ? [] : rest.split(/\s+/)
    if (tokens.length > 1) return no("commits.list takes a branch and optionally an owner/repo")
    return ok({ ...(tokens[0] === undefined ? {} : { branch: tokens[0] }), ...(repo === undefined ? {} : { repo }) })
  },
  "commits.read": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    if (rest === "") return no("commits.read needs a change id or commit id")
    if (/\s/.test(rest)) return no("commits.read takes one change id and optionally an owner/repo")
    return ok(repo === undefined ? { ref: rest } : { ref: rest, repo })
  },
  /*
   * Lane citc: the workspace flows. An id is always one token; fork's and
   * snapshot's optional name is the rest of the line; template's name is one
   * token (a slug), with the workspace id trailing it.
   */
  "box.list": (args) => repoOnly("box.list", args),
  "box.open": (args, known) => {
    const structured = structuredFields("box.open", args, ["bookmark", "repo", "kind"])
    if (structured !== undefined) return structured
    /*
     * ADR 0002: the kind IS the choice, so it rides the line as `--kind
     * <container|vm|desktop>` wherever the caller put it — the card's three
     * buttons append it, a human may type it anywhere. Everything left after
     * it is the bookmark and the optional trailing owner/repo.
     */
    const flagged = /(?:^|\s)--kind(?:\s+(\S+))?/.exec(args ?? "")
    if (flagged !== null && (flagged[1] === undefined || !KINDS.includes(flagged[1]))) {
      return no("box.open's kind must be container, vm, or desktop")
    }
    const kind = flagged?.[1]
    const line = flagged === null ? args : (args ?? "").replace(flagged[0], " ")
    const { rest, repo } = identifierRepo(line, known)
    const bookmark = rest.trim()
    if (/\s/.test(bookmark)) return no("box.open takes a bookmark and optionally an owner/repo")
    return ok({
      ...(bookmark === "" ? {} : { bookmark }),
      ...(repo === undefined ? {} : { repo }),
      ...(kind === undefined ? {} : { kind })
    })
  },
  "box.view": (args) => required("workspaceId", args, "box.view needs a workspace id"),
  "box.select": (args) => structuredFields("box.select", args, ["workspaceId", "repo", "flow", "args"]) ?? required("workspaceId", args, "box.select needs a workspace id"),
  "box.terminal": (args) => optional("workspaceId", args),
  "box.suspend": (args) => optional("workspaceId", args),
  "box.resume": (args) => optional("workspaceId", args),
  "box.sessions": (args) => optional("workspaceId", args),
  "box.session.destroy": (args) => {
    const [sessionId, workspaceId, ...rest] = tokensOf(args)
    if (sessionId === undefined) return no("box.session.destroy needs a session id")
    if (rest.length > 0) return no("box.session.destroy takes a session id and optionally a workspace id")
    return ok(workspaceId === undefined ? { sessionId } : { sessionId, workspaceId })
  },
  "box.delete": (args) => {
    /* `<workspaceId> <name>`: the name typed back is required; the card sends the draft the user typed. */
    const [workspaceId, ...rest] = tokensOf(args)
    if (workspaceId === undefined) return no("box.delete needs a workspace id and its name typed back: /box.delete <workspaceId> <name>")
    const confirmName = rest.join(" ").trim()
    if (confirmName === "") return no(`box.delete needs the workspace's name typed back: /box.delete ${workspaceId} <name>`)
    return ok({ workspaceId, confirmName })
  },
  "box.facet": (args) => {
    const [workspaceId, facet, ...rest] = tokensOf(args)
    if (workspaceId === undefined || facet === undefined || rest.length > 0) {
      return no("box.facet takes a workspace id and a facet")
    }
    return ok({ workspaceId, facet })
  },
  /*
   * Lane L3: the facet reads. A path is one token (plue's own listing refuses
   * a name with a separator in it), so the workspace id, when given, trails
   * it; the egress cursor is plue's opaque base64 keyset position and trails
   * the workspace id.
   */
  "box.files": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const [path, workspaceId, ...rest] = parsed.tokens
    if (rest.length > 0) return no("box.files takes a path and optionally a workspace id")
    return ok({
      ...(path === undefined ? {} : { path }),
      ...(workspaceId === undefined ? {} : { workspaceId })
    })
  },
  "box.file": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const [path, workspaceId, ...rest] = parsed.tokens
    if (path === undefined) return no("box.file needs a path: /box.file <path> [workspaceId]")
    if (rest.length > 0) return no("box.file takes a path and optionally a workspace id")
    return ok(workspaceId === undefined ? { path } : { path, workspaceId })
  },
  "box.services": (args) => optional("workspaceId", args),
  /*
   * Lane L3b: a mint is always addressed by id, because it hands out a
   * credential for one named box. The one-command open is the exception that
   * proves it — it takes no id because it is what CREATES the box:
   * `/desktop [bookmark] [owner/repo]`, the same shape as `box.open`
   * without the kind. A bookmark is one token; the trailing `owner/repo` is
   * the target.
   */
  "box.desktop.open": (args, known) => desktopOpen(args, known),
  "desktop": (args, known) => desktopOpen(args, known),
  "box.desktop": (args) => required("workspaceId", args, "box.desktop needs a workspace id"),
  "box.desktop.stop": (args) =>
    required("workspaceId", args, "box.desktop.stop needs a workspace id"),
  "box.desktop.rotate": (args) =>
    required("workspaceId", args, "box.desktop.rotate needs a workspace id"),
  "box.images": (args) => repoOnly("box.images", args),
  "box.egress": (args) => {
    const [workspaceId, cursor, ...rest] = tokensOf(args)
    if (rest.length > 0) return no("box.egress takes a workspace id and optionally a page cursor")
    return ok({
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(cursor === undefined ? {} : { cursor })
    })
  },
  "egress.session": (args) => {
    const [sessionId, repo, cursor, ...rest] = tokensOf(args)
    if (sessionId === undefined) return no("egress.session needs an agent session id")
    if (rest.length > 0) return no("egress.session takes a session id, optionally an owner/repo, then a page cursor")
    return ok({
      sessionId,
      ...(repo === undefined ? {} : { repo }),
      ...(cursor === undefined ? {} : { cursor })
    })
  },
  /* Lane change: a change id is one token; the pins and the path trail it. */
  "change.view": (args) => {
    const [changeId, rev, ...rest] = tokensOf(args)
    if (changeId === undefined) return no("change.view needs a change id")
    if (rest.length > 0) return no("change.view takes a change id and optionally a revision number")
    if (rev === undefined) return ok({ changeId })
    const seq = Number(rev)
    if (!Number.isInteger(seq) || seq <= 0) return no("change.view's revision is a positive number")
    return ok({ changeId, rev: seq })
  },
  "change.diff": (args) => {
    const [changeId, from, to] = tokensOf(args)
    if (changeId === undefined) return no("change.diff needs a change id")
    /* The path is the REST of the line: a file's path may hold a space, and neither pin ever does. */
    const path = restAfter(args, 3)
    return ok({
      changeId,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(path === "" ? {} : { path })
    })
  },
  "change.land": (args) => required("changeId", args, "change.land needs a change id"),
  /* plue#489 splits by PATH, and refuses an empty list — so at least one path is the grammar. */
  "change.split": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const [changeId, ...paths] = parsed.tokens
    if (changeId === undefined || paths.length === 0) {
      return no("change.split takes a change id and at least one path to move")
    }
    return ok({ changeId, paths })
  },
  "change.resolve": (args) => {
    const [changeId] = tokensOf(args)
    /* The conflicted file's path is the rest of the line, so a path with a space resolves too. */
    const path = restAfter(args, 1)
    if (changeId === undefined || path === "") {
      return no("change.resolve takes a change id and the conflicted file's path")
    }
    return ok({ changeId, path })
  },
  "change.revert": (args) => required("changeId", args, "change.revert needs a change id"),
  "change.facet": (args) => {
    const [changeId, facet, ...rest] = tokensOf(args)
    if (changeId === undefined || facet === undefined || rest.length > 0) {
      return no("change.facet takes a change id and a facet")
    }
    return ok({ changeId, facet })
  },
  /* Lane L1: the pins and pickers are tokens; a thread or finding id is a positive number after the change id. */
  "change.pins": (args) => {
    const [changeId, from, to, ...rest] = tokensOf(args)
    if (changeId === undefined || from === undefined || to === undefined || rest.length > 0) {
      return no("change.pins takes a change id and two pins: parent|<rev> and <rev>|current")
    }
    return ok({ changeId, from, to })
  },
  "change.checks": (args) => {
    const [changeId, seq, ...rest] = tokensOf(args)
    const number = Number(seq)
    if (changeId === undefined || seq === undefined || rest.length > 0 || !Number.isInteger(number) || number <= 0) {
      return no("change.checks takes a change id and a revision number")
    }
    return ok({ changeId, seq: number })
  },
  "review.since-mine": (args) => required("changeId", args, "review.since-mine needs a change id"),
  "review.done": (args) => numberedChangeRef("review.done", "threadId", "a comment id", args),
  "review.ack": (args) => numberedChangeRef("review.ack", "threadId", "a comment id", args),
  "review.reopen": (args) => numberedChangeRef("review.reopen", "threadId", "a comment id", args),
  /* plue#488: a login, or `agent:<name>` for a named agent — the seam sends whichever the wire expects. */
  "review.request": (args) => {
    const [changeId, reviewer, ...rest] = tokensOf(args)
    if (changeId === undefined || reviewer === undefined || rest.length > 0) {
      return no("review.request takes a change id and a login (or agent:<name>)")
    }
    return ok({ changeId, reviewer })
  },
  "review.unrequest": (args) => numberedChangeRef("review.unrequest", "requestId", "a review-request id", args),
  "findings.please-fix": (args) => numberedChangeRef("findings.please-fix", "findingId", "a finding id", args),
  "findings.not-useful": (args) => numberedChangeRef("findings.not-useful", "findingId", "a finding id", args),
  "files.list": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const tokens = parsed.tokens
    if (tokens.length > 2) return no("files.list takes a path and optionally an owner/repo")
    const [path, repo] = tokens
    return ok(repo === undefined ? { path: path ?? "" } : { path: path ?? "", repo })
  },
  /*
   * The line anchor (docs/code-intel/PLAN.md §1): `<path>[:<line>[:<col>]]`.
   * Only a TRAILING numeric suffix comes off the token, so a repository path
   * with a colon of its own keeps working; the parser stays first-token-is-path.
   */
  "files.implementation-diff": (args) => optional("changeId", args),
  "files.open-diff": (args) => {
    try {
      const value: unknown = JSON.parse(args ?? "")
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? ok(value as Record<string, unknown>) : no("Select a diff and file")
    } catch {
      const [cardId, ...path] = (args ?? "").trim().split(/\s+/)
      return cardId && path.length ? ok({ cardId, path: path.join(" ") }) : no("Select a diff and file")
    }
  },
  "files.read": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const tokens = [...parsed.tokens]
    const refAt = tokens.indexOf("--ref")
    const ref = refAt === -1 ? undefined : tokens[refAt + 1]
    if (refAt !== -1) {
      if (refAt !== tokens.length - 2 || !ref) return no("files.read --ref needs a revision")
      tokens.splice(refAt, 2)
    }
    const [token, repo] = tokens
    if (token === undefined) return no("files.read needs a file path")
    if (tokens.length > 2) return no("files.read takes a path and optionally an owner/repo")
    const anchor = /^(.*?):(\d+)(?::(\d+))?$/.exec(token)
    const path = anchor === null ? token : anchor[1] ?? ""
    if (path === "") return no("files.read needs a file path")
    const line = anchor === null ? undefined : Number(anchor[2])
    const column = anchor?.[3] === undefined ? undefined : Number(anchor[3])
    if (line === 0 || column === 0) return no("files.read lines and columns count from 1: /files.read <path>[:<line>[:<col>]]")
    return ok({
      path,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      ...(ref === undefined ? {} : { ref }),
      ...(repo === undefined ? {} : { repo })
    })
  },
  /* Code intelligence (docs/code-intel/PLAN.md §4): a position for hover and definition, a path for diagnostics. */
  "code.hover": (args) => positioned("code.hover", args),
  "code.definition": (args) => positioned("code.definition", args),
  "code.diagnostics": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const tokens = parsed.tokens
    const [path, repo] = tokens
    if (path === undefined) return no("code.diagnostics needs a file path: /code.diagnostics <path> [owner/repo]")
    if (tokens.length > 2) return no("code.diagnostics takes a path and optionally an owner/repo")
    return ok({ path, ...(repo === undefined ? {} : { repo }) })
  },
  "repos.app": (args) => repoOnly("repos.app", args),
  
  "github.app": (args) => repoOnly("github.app", args),
  "github.app.choose": (args) => required("installationId", args, "Choose a GitHub App installation."),
  "github.app.open": (args) => repoOnly("github.app.open", args),
  "github.reconcile": (args) => repoOnly("github.reconcile", args),
  "github.mirror-sync": (args) => repoOnly("github.mirror-sync", args),
  /* plue#491: the ref name is one token (it carries slashes) with the usual optional trailing repo. */
  "github.mirror.retry-ref": (args, known) => {
    const structured = structuredFields("github.mirror.retry-ref", args, ["ref", "repo"])
    if (structured !== undefined) return structured
    const { rest, repo } = identifierRepo(args, known)
    if (rest === "" || /\s/.test(rest)) return no("github.mirror.retry-ref needs one ref name")
    return ok(repo === undefined ? { ref: rest } : { ref: rest, repo })
  },
  "repos.import.retry": (args) => required("jobId", args, "repos.import.retry needs the job id"),
  "sync.ops.show-more": (args) => required("cardId", args, "sync.ops.show-more needs the card id"),
  "debug.backend": (args) => ok({ backend: args ?? "" }),
  "debug.errors": (args) => optional("query", args),
  "admin.grant": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("admin.grant takes an amount in dollars and a login")
    const [amountRaw, login] = tokens
    const amountUsd = Number(amountRaw)
    if (
      amountRaw === undefined ||
      !Number.isFinite(amountUsd) ||
      amountUsd <= 0 ||
      login === undefined ||
      login === ""
    ) {
      return no("admin.grant needs an amount in dollars and a login: /admin.grant 25 octocat")
    }
    return ok({ amountUsd, login })
  },
  "admin.grant.confirm": (args) => required("cardId", args, "admin.grant.confirm needs the card id"),
  "admin.grant.cancel": (args) => required("cardId", args, "admin.grant.cancel needs the card id"),
  /* `[cwd]`: an OPEN working copy by path, id, name, or key; blank means the active one (the server never takes a bare path). */
  "agent.explain": (args) => required("what", args, "agent.explain needs something to explain: /agent.explain <what>"),
  /* THE FORM LAW: the generic form card's acts. `form.set`'s value is the rest of the line (blank clears). */
  "form.set": (args) => {
    const [cardId, field, ...rest] = tokensOf(args)
    if (cardId === undefined) return no("form.set needs the card id")
    if (field === undefined) return no("form.set needs the field name")
    const value = trimmed(args).slice(cardId.length).trim().slice(field.length).trim()
    return ok({ cardId, field, value: rest.length === 0 ? "" : value })
  },
  "form.submit": (args) => required("cardId", args, "form.submit needs the card id"),
  /* The signup onboarding (entries/signup.ts): `set`'s value is the rest of the line (blank clears). */
  "signup.set": (args) => {
    const match = /^\s*(\S+)(?:[ \t]([\s\S]*))?$/.exec(args ?? "")
    if (match === null) return no("signup.set needs the field name")
    return ok({ field: match[1]!, value: match[2] ?? "" })
  },
  "signup.answer": (args) => required("value", args, "Choose an answer"),
  "signup.repo": (args) => required("repo", args, "Choose a repository, or new"),
  /*
   * The cloud agent sessions (entries/agentSession.ts). `new` reads its line
   * as [owner/repo] [provider] [task…], each position OPTIONAL: a token that
   * is not repo-shaped stays in the task's text, a second token that names no
   * provider is not consumed as one — what the line could not give, the form
   * asks for (THE FORM LAW). The task keeps its spacing (it is the session's
   * first message).
   */
  "agent.session.new": (args) => {
    let rest = trimmed(args)
    const payload: Record<string, unknown> = {}
    const head = /^\S+/.exec(rest)?.[0]
    if (head === undefined) return ok({})
    if (REPO_TOKEN.test(head)) {
      payload["repo"] = head
      rest = rest.slice(head.length).trim()
    }
    const next = /^\S+/.exec(rest)?.[0]
    if (next !== undefined && isAgentProvider(next)) {
      payload["provider"] = next
      rest = rest.slice(next.length).trim()
    }
    if (rest !== "") payload["task"] = rest
    return ok(payload)
  },
  "agent.session.list": (args) => repoOnly("agent.session.list", args),
  // Session ids have no trailing free text: the explicit repo is unambiguous
  // even when repository inventory is unavailable or has not refreshed yet.
  "agent.session.view": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const sessionId = rest.trim()
    if (sessionId === "" || /\s/.test(sessionId)) return no("agent.session.view needs a session id: /agent.session.view <id> [owner/repo]")
    return ok(repo === undefined ? { sessionId } : { sessionId, repo })
  },
  /* `<id> <text…>`: the text is the rest of the line, spacing intact — no trailing repo is split off a message. */
  "agent.session.say": (args) => {
    const [sessionId] = tokensOf(args)
    if (sessionId === undefined) return no("agent.session.say needs a session id")
    const text = restAfter(args, 1)
    if (text === "") return no("agent.session.say needs the message text")
    return ok({ sessionId, text })
  },
  "agent.session.stop": (args) => {
    const { rest, repo } = splitTrailingRepo(args)
    const sessionId = rest.trim()
    if (sessionId === "" || /\s/.test(sessionId)) return no("agent.session.stop needs a session id: /agent.session.stop <id> [owner/repo]")
    return ok(repo === undefined ? { sessionId } : { sessionId, repo })
  },
  "tab.card": (args) => required("cardId", args, "tab.card needs the card id"),
  "tab.select": (args) => required("tab", args, "tab.select needs a tab id or a position 1-9"),
  "tab.close": (args) => optional("tabId", args),
  "repo.select": (args) => required("repo", args, "repo.select needs a pinned repository key"),
  /* `<copyId>[#path]`: the tree row's own id, split at the first `#` (a copy id never carries one; a path may have spaces). */
  "repo.tree": (args) => {
    const text = trimmed(args)
    if (text === "") return no("repo.tree needs a working copy id: /repo.tree <copyId>[#path]")
    const hash = text.indexOf("#")
    if (hash === -1) return ok({ copy: text })
    const copy = text.slice(0, hash).trim()
    const path = text.slice(hash + 1).trim()
    if (copy === "") return no("repo.tree needs a working copy id: /repo.tree <copyId>[#path]")
    return ok(path === "" ? { copy } : { copy, path })
  },
  "workspace.rename": (args) => required("name", args, "workspace.rename needs a name: /workspace.rename <name>"),
  /* `[path]`: a typed path opens directly (where the host allows one); blank is the folder dialog, the human's door alone. */
  /* Tutorial stage 2: blank choose opens the ranked card; blank create asks for the name. */
  "repo.choose": (args) => optional("repo", args),
  "repo.create": (args) => optional("name", args),
  /* `<repoId> [workspace] <verb> <pattern>`: the last two tokens are the run; anything between is the workspace path. */
  /* `<repoId> key=value…`: every facet is optional; a bare value with no `=` is the query. */
  /*
   * The target-graph commands (docs/LOCAL-APP.md "Cards: target graph"). The
   * repo id may go unnamed — the controller resolves the one open repository
   * — so a lone `//…` token is the LABEL, anything else the repo id.
   */
  /* Same shape as target.graph: a lone `//…` token is the label to pin, none clears the focus. */
  /* `<repoId> [query=…] [private=on|off]`: a bare token with no `=` is the query. */
}

/**
 * Whether a decoder for this flow exists in the table above.
 *
 * The gate in SlashPayload.test.ts reads it: a declaration that takes
 * arguments and names no decoder here (and carries none as
 * `metadata.grammar`) would silently decode to the EMPTY payload, discarding
 * what the human typed — the drift `triggers.register` shipped with.
 *
 * @category conversions
 */
export const hasGrammar = (name: string): boolean => GRAMMAR[name] !== undefined

/**
 * Turns one flow's slash argument text into its typed payload.
 *
 * @category conversions
 */
export const payloadFor = (
  name: string,
  args: string | undefined,
  grammar?: Grammar,
  known?: KnownRepositories
): Parsed => {
  const parse = GRAMMAR[name] ?? grammar
  if (parse === undefined) return NONE
  if (takesRunSource(name)) {
    const source = splitRunSource(args)
    const parsed = parse(source.args, known)
    return "payload" in parsed && source.sourceCard !== undefined ? ok({ ...parsed.payload, sourceCard: source.sourceCard }) : parsed
  }
  return parse(args, known)
}

/**
 * The grammar of a flow declared at runtime that takes only its optional
 * `owner/repo` target (a repository's flow leaf, entries/flow.ts): the table
 * above cannot name it, so the flow carries this as `metadata.grammar`.
 */
export const repoTargetGrammar = (name: string): Grammar => (args) => repoOnly(name, args)

/** Every `--flag` a flow's declared `args` spells, wherever it sits: `[--source github|smithers-cloud]`. */
const DECLARED_FLAG = /--([a-z][\w-]*)/g
/** A flag in a typed line, which is a token of its own rather than part of a word. */
const TYPED_FLAG = /(?:^|\s)--([a-z][\w-]*)/g

/**
 * The first flag the line names that the flow does not, or nothing.
 *
 * `payloadFor` answers the empty payload for a name with no grammar, and a
 * grammar reads the flags it knows and drops the rest: `/chat.clear
 * --summarize` on a build where summarising is off archived the conversation
 * with the flag discarded, so the person watched a consequential act happen
 * under a flag that did nothing. A door whose declared `args` takes free text
 * takes it as typed; a door that takes FLAGS, or takes nothing at all, has no
 * reading for one it never named.
 */
export const unknownFlag = (args: string | undefined, spec?: string): string | undefined => {
  if (spec !== undefined && !spec.includes("--")) return undefined
  const declared = new Set([...(spec ?? "").matchAll(DECLARED_FLAG)].map((match) => match[1]!))
  for (const match of trimmed(args).matchAll(TYPED_FLAG)) {
    if (!declared.has(match[1]!)) return match[1]!
  }
  return undefined
}
