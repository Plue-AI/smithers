/**
 * Invocation-scoped presentation: handlers return data, this adapter owns UX.
 * Async-local context keeps concurrent MCP requests from sharing UI state.
 * @since 1.0.0
 */

import * as clack from "@clack/prompts"
import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { asRecord, asString } from "@smthrs/gateway/Diagnosis"
import * as Redaction from "@smthrs/journal/Redaction"
import { AsyncLocalStorage } from "node:async_hooks"
import { Writable } from "node:stream"
import { stripVTControlCharacters } from "node:util"
import * as Forensics from "../Forensics.ts"
import * as Failure from "../internal/Failure.ts"

interface Session {
  readonly transport: "mcp" | "cli"
  readonly policy: Audience.Policy
  readonly command: string
  readonly stdout: Writable
  readonly stderr: Writable
}
const sessions = new AsyncLocalStorage<Session>()
const stream = (terminal: RuntimeConfig["stdout"], fallback: Writable): Writable =>
  terminal === undefined ?
    fallback :
    new Writable({
      write(chunk, _encoding, done) {
        terminal.write(String(chunk))
        done()
      }
    })

/**
 * Presentation inputs supplied by Incur without exposing its implementation internals.
 * @category models
 * @since 1.0.0
 */
export interface Context {
  readonly command?: string | undefined
  readonly agent?: boolean | undefined
  readonly formatExplicit?: boolean | undefined
  readonly request?: unknown
  readonly globals?: { readonly audience?: Audience.Mode; readonly silent?: boolean } | undefined
  readonly args?: Readonly<Record<string, unknown>> | undefined
  readonly options?: Readonly<Record<string, unknown>> | undefined
  readonly ok?:
    | ((data: unknown, meta?: { cta?: { commands: Array<{ command: string; description: string }> } }) => never)
    | undefined
}

/**
 * Resolve once per invocation. No streams or environment values are mutated.
 * @category selection
 * @since 1.0.0
 */
export const policy = (context: Context, runtime: RuntimeConfig = {}): Audience.Policy => {
  const base = runtime.presentation
  const protocol = isMcp(context, runtime)
  return Audience.resolve({
    env: runtime.environment,
    stdout: runtime.stdout?.isTTY,
    stderr: runtime.stderr?.isTTY,
    audience: context.globals?.audience !== undefined && context.globals.audience !== "auto"
      ? context.globals.audience :
      base?.audience,
    mcp: protocol,
    formatExplicit: base?.structured === true || context.formatExplicit,
    silent: context.globals?.silent === true || base?.progress === "silent",
    verbose: base?.audience === "agent" && base.progress === "plain"
  })
}

/**
 * Keep one command's rendering preferences out of every handler's business logic.
 * @category constructors
 * @since 1.0.0
 */
export const scope = (context: Context, runtime: RuntimeConfig, next: () => Promise<void>): Promise<void> => {
  const resolved = policy(context, runtime)
  return sessions.run({
    transport: isMcp(context, runtime) ? "mcp" : "cli",
    policy: resolved,
    command: resolved.source === "mcp" ? (context.command ?? "").replaceAll("_", " ") : context.command ?? "",
    stdout: stream(runtime.stdout, process.stdout),
    stderr: stream(runtime.stderr, process.stderr)
  }, next)
}

/**
 * Current invocation, absent for direct library calls.
 * @category getters
 * @since 1.0.0
 */
export const current = (): Session | undefined => sessions.getStore()

// Host/protocol inputs, not the user-selectable audience. Incur's stdio MCP
// context has agent + explicit format + no CLI globals; HTTP has a request.
const isMcp = (context: Context, runtime: RuntimeConfig): boolean =>
  runtime.presentation?.source === "mcp" || context.request !== undefined ||
  (context.agent === true && context.formatExplicit === true && Object.keys(context.globals ?? {}).length === 0)

/**
 * One follow-up command, written without the `smthrs` prefix. The connection
 * options of the invocation are appended when it is shown.
 * @category models
 * @since 1.0.0
 */
export interface Next {
  readonly command: string
  readonly description: string
}

/**
 * The follow-ups a command declares: a fixed list, or one derived from its
 * result and arguments.
 * @category models
 * @since 1.0.0
 */
export type FollowUps =
  | ReadonlyArray<Next>
  | ((data: Readonly<Record<string, unknown>>, args: Readonly<Record<string, unknown>>) => ReadonlyArray<Next>)

/**
 * Quote one argument for a copyable follow-up command.
 * @category formatting
 * @since 1.0.0
 */
export const quote = Forensics.shellQuote
const text = (value: unknown): string | undefined => asString(value) || undefined

/**
 * Follow-ups for a result that names a durable run, falling back to
 * `otherwise` when it names none. Every command gets `runs()` unless it
 * declares its own `next`.
 * @category constructors
 * @since 1.0.0
 */
export const runs = (
  options: { readonly show?: boolean; readonly otherwise?: ReadonlyArray<Next> } = {}
): FollowUps =>
(data, args) => {
  const runId = text(data["runId"]) ?? text(args["run"])
  if (runId === undefined) return options.otherwise ?? []
  const actions: Array<Next> = []
  if (options.show !== false) {
    actions.push({
      command: `runs show ${quote(runId)}`,
      description: "Inspect status and the reason execution stopped"
    })
  }
  actions.push({
    command: `runs logs ${quote(runId)} --format jsonl`,
    description: "Read detailed events only when needed"
  })
  if (data["status"] === "waiting-approval" || data["_tag"] === "Parked") {
    actions.push({ command: "approvals list", description: "Inspect pending approval payloads" })
  }
  return actions
}

/**
 * Resolve declared follow-ups against one result: at most three, each with
 * the invocation's root and credential-free remote. Never echo credentials or
 * approval payloads.
 * @category constructors
 * @since 1.0.0
 */
export const nextActions = (value: unknown, context: Context = {}, next: FollowUps = runs()): Array<Next> => {
  const options = context.options ?? {}
  const root = text(options["root"])
  const remote = text(options["remote"])
  let connection = root === undefined ? "" : ` --root ${quote(root)}`
  if (remote !== undefined) {
    try {
      const url = new URL(remote)
      if (!url.username && !url.password && !url.search && !url.hash) connection += ` --remote ${quote(remote)}`
    } catch { /* Malformed connection arguments are handled before execution. */ }
  }
  const declared = typeof next === "function" ? next(asRecord(value), context.args ?? {}) : next
  return declared.slice(0, 3).map((action) => ({
    command: action.command + connection,
    description: action.description
  }))
}

/**
 * Sanitizes and bounds one terminal field. A run of control characters is one
 * space, including a BEL after an SGR sequence, regardless of Node version.
 * @category formatting
 * @since 1.0.0
 */
export const clean = (value: unknown): string =>
  stripVTControlCharacters(String(Redaction.redact(value))).replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(
    0,
    500
  )
const linesOf = (value: unknown, indent = "", depth = 0): Array<string> => {
  if (value === undefined) return []
  if (value === null || typeof value !== "object") return [indent + clean(value)]
  if (depth >= 3) return [indent + (Array.isArray(value) ? `${value.length} items` : "Use --json for full details")]
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index + 1), entry] as const)
    : Object.entries(value)
  const lines = entries.slice(0, 18).flatMap(([key, item]) => {
    if (Array.isArray(item) && item.length === 0) return [`${indent}${clean(key)}: none`]
    if (item !== null && typeof item === "object") {
      return [`${indent}${clean(key)}`, ...linesOf(item, `${indent}  `, depth + 1)]
    }
    return [`${indent}${clean(key)}: ${clean(item)}`]
  })
  if (entries.length > 18) lines.push(`${indent}… ${entries.length - 18} more; use --json for full details`)
  return lines
}

/**
 * How a handler wants its result shown to a person. Agents and explicit
 * formats never see it: the returned document stays the contract.
 * @category models
 * @since 1.0.0
 */
export interface Rendering {
  /**
   * A body already written for a person, printed in place of the generic
   * key/value summary. The command title and the Next actions still frame it.
   */
  readonly human?: string | undefined
  /** The command's follow-ups; results naming a run default to `runs()`. */
  readonly next?: FollowUps | undefined
}

/**
 * Preserve data for agents; render a bounded Clack result for humans.
 * Explicit JSON/format always keeps the original machine-readable document.
 * @category formatting
 * @since 1.0.0
 */
export const finish = <A>(context: Context, value: A, rendering: Rendering = {}): A => {
  const session = current()
  if (session === undefined || context.ok === undefined || value === undefined) return value
  const actions = nextActions(value, context, rendering.next)
  if (session.policy.structured) {
    // Incur merges CTA fields into arrays as numeric object keys. Preserve
    // existing array result contracts rather than changing their shape.
    return actions.length === 0 || Array.isArray(value) ? value : context.ok(value, { cta: { commands: actions } })
  }
  const summary = rendering.human === undefined
    ? linesOf(Redaction.redact(value)).slice(0, 80).join("\n") || "Done"
    : rendering.human.trimEnd()
  if (session.policy.progress === "live") clack.note(summary, session.command, { output: session.stdout })
  else session.stdout.write(`${session.command}\n${summary}\n`)
  if (actions.length > 0) {
    const next = actions.map((action) => `smthrs ${action.command}`).join("\n")
    if (session.policy.progress === "live") clack.log.info(`Next:\n${next}`, { output: session.stdout })
    else session.stdout.write(`Next:\n${next}\n`)
  }
  return context.ok(undefined)
}

/**
 * The Incur failure channel a guarded command reports through.
 * @category models
 * @since 1.0.0
 */
export interface Failing extends Context {
  readonly error: (error: { code: string; message: string; exitCode?: number }) => never
}

/**
 * How a guarded command names its failures.
 * @category models
 * @since 1.0.0
 */
export interface Refusal {
  /** Stable code for failures without a database code; defaults to the error tag, then `command_failed`. */
  readonly code?: string | undefined
  /** Exit status for failures other than a UsageError, which always exits 2. */
  readonly exitCode?: number | undefined
}

/**
 * Report one failure through Incur: a stable code, a redacted sentence, and
 * exit 2 for a UsageError.
 * @category constructors
 * @since 1.0.0
 */
export const fail = (context: Failing, cause: unknown, refusal: Refusal = {}): never => {
  const error = cause as { _tag?: string; message?: string } | null
  return context.error({
    code: NodeDatabase.isUnsupportedDatabase(cause) ?
      cause.code :
      refusal.code ?? error?._tag?.split("/").pop() ?? "command_failed",
    message: String(
      Redaction.redact(cause instanceof Error ? Failure.sentence(cause) : error?.message ?? String(cause))
    ),
    exitCode: error?._tag === "/cli/UsageError" ? 2 : refusal.exitCode ?? 1
  })
}

/**
 * The one Incur error boundary: run the handler, finish its result with the
 * declared follow-ups, and report any failure through `fail`.
 * @category constructors
 * @since 1.0.0
 */
export const guard = async <A>(
  context: Failing,
  body: () => Promise<A>,
  options: Refusal & {
    readonly next?: FollowUps | undefined
    readonly render?: ((value: A) => Rendering) | undefined
  } = {}
): Promise<A> => {
  try {
    const value = await body()
    return finish(context, value, { next: options.next, ...options.render?.(value) })
  } catch (cause) {
    return fail(context, cause, options)
  }
}
