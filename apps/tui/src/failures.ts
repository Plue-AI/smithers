/**
 * What a person sees when a terminal act fails: one plain sentence that names
 * the key or command that acts on it.
 *
 * Every failure the TUI can show is a tagged error listed in `registry`, so a
 * new tag without copy does not compile. Anything else is unknown: it gets the
 * act's own sentence and never its message. The raw text of every failure goes
 * to `tui.log` (its path is in `/conversation`), never to the screen.
 *
 * Tagged errors keep their messages for the model and the log; this module is
 * the only place those become words for a person.
 */
import type * as Permission from "@smthrs/capability/Permission"
import type { Refused as CliRefused } from "@smthrs/cli/CliError"
import type * as Cell from "@smthrs/harness/Cell"
import * as Evaluator from "@smthrs/model/Evaluator"
import type * as FailureCopy from "@smthrs/model/FailureCopy"
import type { PlueFault } from "@smthrs/rpc/PlueFailureCodes"
import {
  presentUserFailure,
  type UserFailure,
  type UserFailureCopy,
  type UserFailureRegistry
} from "@smthrs/rpc/UserFailure"
import type { AgentError } from "./agents.ts"
import type { Refusal } from "./contributions.ts"
import type { FlowDiscoveryFailed, FlowError } from "./flows.ts"
import * as Log from "./log.ts"
import type { Failure as MonitorFailure } from "./monitors.ts"
import type { SearchFailed } from "./search.ts"
import type { Corrupt, WriteFailed } from "./session.ts"
import type { TabError } from "./tab-error.ts"
import type { AgentDepthExceeded } from "./workspace.ts"

/** Every tagged failure the TUI presents. */
export type Known =
  | CliRefused
  | AgentError
  | AgentDepthExceeded
  | Refusal
  | FlowError
  | FlowDiscoveryFailed
  | TabError
  | Corrupt
  | WriteFailed
  | MonitorFailure
  | Permission.GrantStoreError
  | SearchFailed

/** The act that failed; it names the sentence an unknown failure gets. */
export type Act =
  | "approvals"
  | "approval"
  | "cap"
  | "command"
  | "continue"
  | "estimates"
  | "flow"
  | "fork"
  | "harness"
  | "memory"
  | "monitor"
  | "resume"
  | "retry"
  | "search"
  | "session"
  | "sessions"
  | "shell"
  | "startup"
  | "stop"
  | "undo"
  | "wait"
  | "worker"

const unknownSentence: Readonly<Record<Act, string>> = {
  approvals: "Approvals could not be read.",
  approval: "Your answer was not sent; press y, n or a again.",
  cap: "The new cap was not applied.",
  command: "That command could not run.",
  continue: "The run did not continue; press c again.",
  estimates: "Estimates were not saved.",
  flow: "The flow could not start.",
  fork: "This conversation could not be forked.",
  harness: "The workspace could not be reached.",
  memory: "Memory could not be recalled.",
  monitor: "The monitor stopped.",
  resume: "That conversation could not be opened.",
  retry: "The retry could not start.",
  search: "Text search could not run.",
  session: "The conversation was not saved.",
  sessions: "Saved conversations could not be listed.",
  shell: "The command could not start.",
  startup: "The terminal could not start.",
  stop: "The stop was not sent; press x again.",
  undo: "Undo was not recorded.",
  wait: "The wait could not start.",
  worker: "The worker could not start."
}

const copy = (fault: PlueFault, sentence: string): UserFailureCopy => ({
  fault,
  sentence,
  actions: fault === "user" ? [] : ["retry"]
})

const agent = (failure: AgentError): UserFailureCopy => {
  const name = failure.subject
  switch (failure.code) {
    case "unknown_agent":
      return copy("user", `${name === undefined ? "No such agent" : `No agent named ${name}`}; /flows lists them.`)
    case "seat_as_agent":
      return copy("user", `${name ?? "That"} is a model; choose it with /model.`)
    case "not_an_agent":
      return copy("user", `${name ?? "That"} is a flow; run it with /flow.`)
    case "not_invocable":
      return copy("user", `${name ?? "That agent"} starts only from /flow.`)
    case "unreadable":
      return copy("infra", `${name === undefined ? "The agent file" : `Agent ${name}`} could not be read; press r.`)
    case "unknown_seat":
      return copy("user", `${name === undefined ? "The agent names an unknown model" : `Unknown model ${name}`}.`)
    case "unknown_effort":
      return copy("user", `${name === undefined ? "The agent names an unknown effort" : `Unknown effort ${name}`}.`)
    case "unavailable":
      return copy("infra", "Agents are not available in this session.")
  }
}

const flow = (failure: FlowError): UserFailureCopy => {
  const name = failure.subject
  switch (failure.code) {
    case "unknown_flow":
      return copy("user", `${name === undefined ? "No such flow" : `No flow named ${name}`}; /flows lists them.`)
    case "unloaded":
      return copy("user", `Restart to load ${name ?? "the flow"}.`)
    case "refused":
      return copy("user", `${name ?? "That flow"} cannot start here.`)
    case "denied":
      return copy("user", `${name ?? "The flow"} was not approved.`)
    case "person_only":
      return copy("user", `${name ?? "That flow"} starts only from /flow.`)
    case "stopped":
      return copy("user", "Stopped.")
    case "invalid_input":
      return copy("user", `${name ?? "The flow"} did not accept that input.`)
    case "launch":
      return copy("infra", `${name ?? "The flow"} could not launch; press r.`)
    case "control":
      return copy("infra", "Lost contact with the flow runner; press r.")
  }
}

const tab = (failure: TabError): UserFailureCopy => {
  const id = failure.subject
  switch (failure.code) {
    case "unknown_tab":
      return copy("user", `${id === undefined ? "No such tab" : `No tab ${id}`}.`)
    case "not_retryable":
      return copy("user", "Only a failed, stopped or parked tab can be retried.")
    case "not_capped":
      return copy("user", "Only a worker stopped at its cap takes a new one.")
    case "not_failed":
      return copy("user", "Only a failed tab can wait.")
    case "closed":
      return copy("user", "This session is closing.")
    case "flows_unavailable":
      return copy("infra", "Flows are not available in this session.")
  }
}

const judge: Readonly<Record<Extract<MonitorFailure, { _tag: "JevFailed" }>["code"], string>> = {
  unconfigured: Evaluator.unconfiguredMessage,
  unreachable: "Jev could not be reached.",
  refused: "Jev refused the request.",
  empty: "Jev gave no answer.",
  timeout: "Jev timed out.",
  invalid_answer: "Jev gave an unusable answer.",
  invalid_question: "Jev could not take this question."
}

const grant: Readonly<Record<Permission.GrantStoreError["code"], UserFailureCopy>> = {
  duplicate_request: copy("user", "That request was already answered."),
  request_not_found: copy("user", "That request is gone; it was answered or withdrawn."),
  journal_failed: copy("infra", "Your answer was not saved; press y, n or a again."),
  store_closed: copy("user", "This session is closing."),
  invalid_resolution: copy("bug", "That answer does not fit this request.")
}

const search: Readonly<Record<SearchFailed["reason"], UserFailureCopy>> = {
  "missing-rg": copy("user", "Text search needs ripgrep (rg) installed."),
  "missing-directory": copy("user", "This folder is gone; text search cannot run here."),
  "bad-pattern": copy("user", "That pattern is not a valid regex."),
  "rg-error": copy("infra", "Text search failed.")
}

export const registry: UserFailureRegistry<Known> = {
  "/cli/Refused": (failure) => copy(failure.fault, unknownSentence.command),
  "@smthrs/capability/GrantStoreError": (failure) => grant[failure.code],
  AgentError: agent,
  AgentDepthExceeded: copy("user", "Workers can delegate three levels deep."),
  ContributionRefused: (failure) =>
    copy(
      "bug",
      failure.code === "limit"
        ? "A plugin reached its limit."
        : failure.code === "collision"
        ? "A plugin key clashes with another."
        : "A plugin sent something invalid."
    ),
  FlowError: flow,
  FlowDiscoveryFailed: copy("infra", "Flows could not be listed; the last list stays."),
  TabError: tab,
  SessionCorrupt: (failure) => copy("infra", `That conversation is damaged at line ${failure.line}.`),
  SessionWriteFailed: copy("infra", "The conversation is not being saved; check the disk."),
  JevFailed: (failure) => copy(Evaluator.faults[failure.code], judge[failure.code]),
  LunaFailed: copy("dependency", "Luna could not summarize the change."),
  SourceFailed: copy("infra", "The watched source could not be read."),
  Refused: copy("user", "The watch command was not approved."),
  SearchFailed: (failure) => search[failure.reason]
}

/** Where a person reads raw detail: `/conversation` shows the log path. */
export const inTerminal = "Details: /conversation"

/** The sentence alone, for a render that repeats; whoever caught the failure logged it. */
export const sentence = (act: Act, error: unknown): string =>
  presentUserFailure(registry, error, {
    unknown: { fault: "bug", sentence: unknownSentence[act], actions: ["retry"] }
  }).sentence

/**
 * What makes two failures the same one: each link of the cause chain's tag,
 * name, message or primitive text, never a stack frame. Cycles and chains
 * deeper than eight links stop the walk.
 */
export const identity = (error: unknown): string => {
  const parts: Array<string> = []
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; depth < 8 && !seen.has(current); depth++) {
    if (typeof current !== "object" || current === null) {
      parts.push(
        typeof current === "symbol" ? `symbol:${current.description ?? ""}` : `${typeof current}:${String(current)}`
      )
      break
    }
    seen.add(current)
    const each = current as { readonly _tag?: unknown; readonly name?: unknown; readonly message?: unknown }
    parts.push([each._tag, each.name, each.message].map((part) => typeof part === "string" ? part : "").join(":"))
    if (!("cause" in current)) break
    current = (current as { readonly cause?: unknown }).cause
  }
  return parts.join("\n")
}

/**
 * Presents one failure and writes its raw detail to the log. A failure the
 * person caused needs no detail; any other names where the detail is.
 */
export const present = (act: Act, error: unknown): UserFailure => {
  const failure = presentUserFailure(registry, error, {
    unknown: { fault: "bug", sentence: unknownSentence[act], actions: ["retry"] }
  })
  if (failure.fault !== "user") Log.write(`failure.${act}`, error)
  return failure
}

/** For a headless command: logs the raw detail and names the log file. */
export const detailsIn = (error: unknown, tag = "failure.harness"): string => {
  Log.write(tag, error)
  return `Details: ${Log.path()}`
}

/** A grant store's refusal code, as the error `present` takes. */
export const grantRefusal = (code: Permission.GrantStoreError["code"]) =>
  ({ _tag: "@smthrs/capability/GrantStoreError", code }) as const

/** The one line a status bar or stderr shows. */
export const line = (act: Act, error: unknown, details: string = inTerminal): string => {
  const failure = present(act, error)
  return failure.fault === "user" ? failure.sentence : `${failure.sentence} ${details}`
}

const step = (fault: PlueFault, sentence: string): UserFailureCopy => ({ fault, sentence, actions: [] })

/** A step the harness refused, by its stable code; the agent is asked again, so no key acts on it. */
const rejectedStep: Readonly<Record<Cell.RejectionCode, UserFailureCopy>> = {
  no_cell: step("dependency", "The agent wrote no code for this step."),
  output_truncated: step("dependency", "The agent's reply was cut off."),
  imports_forbidden: step("policy", "This step used an import that is not allowed."),
  compile_failed: step("dependency", "This step's code did not compile."),
  invalid_transition: step("dependency", "This step returned an unusable result."),
  unsupported_language: step("dependency", "This step was written in an unsupported language."),
  limit_exceeded: step("policy", "This step hit its limit."),
  stalled: step("infra", "This step stalled.")
}
const raisedStep = step("dependency", "This step failed.")

/**
 * A failed or rejected step in the transcript. A rejected step's text is its
 * rejection code; a failed step's is the raw `name: message` it threw. Either
 * stays in `detail`, which the transcript shows only under Ctrl+O.
 */
export const cellFailure = (status: "failed" | "rejected", error: string): UserFailure => {
  const words: UserFailureCopy | undefined = status === "rejected"
    ? rejectedStep[error as Cell.RejectionCode]
    : raisedStep
  return words === undefined
    ? { ...raisedStep, tag: null, detail: error }
    : { ...words, tag: status === "rejected" ? error : "raised", detail: error }
}

/** A failed call inside a step: the person's denial, or the flow's raw message kept for Ctrl+O. */
export const callFailure = (call: { readonly denied?: true; readonly message: string }): UserFailure =>
  call.denied === true
    ? { fault: "user", sentence: "Not approved.", actions: [], tag: "denied", detail: call.message }
    : { ...step("bug", "This action failed."), tag: null, detail: call.message }

/** Whether a failure's copy quotes a host's own setup text: a seat to sign in to, a key to set, a judge to opt in to. */
const instructs = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  for (let current = error; typeof current === "object" && current !== null && !seen.has(current);) {
    seen.add(current)
    const record = current as { readonly _tag?: unknown; readonly reason?: unknown }
    if (
      record._tag === "@smthrs/agent/Seat/SeatUnresolved" || record._tag === "flows/model/EvaluatorError" ||
      record._tag === "flows/model/ClassifierError" ||
      (record._tag === "@smthrs/agent/Seat/SeatUnrouted" && record.reason !== "no_candidates" &&
        record.reason !== "interrupted")
    ) return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

/**
 * A worker failure's copy as its result card says it. Setup instructions
 * (seats, environment variables, sign-in commands) stay in details (Ctrl+O)
 * and in the help a parent is asked for, never on the card.
 */
export const onCard = (error: unknown, described: FailureCopy.Description): FailureCopy.Description =>
  instructs(error) ? { ...described, line: "" } : described
