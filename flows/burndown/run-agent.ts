/**
 * The worker's one action: run a coding agent's CLI for an assignment on the
 * machine a `Placement` provides, then read what it reported.
 */
import { Action } from "@smthrs/flow"
import { CommandSandbox, Sandbox } from "@smthrs/sandbox"
import { Context, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { homedir } from "node:os"
import { join } from "node:path"
import { type Account, accountEnv, discoverAccounts } from "./accounts.ts"
import type { ReadCommand } from "./cloud-export.ts"
import { Assignment, WorkerResult } from "./schema.ts"

/**
 * Runs the agent's CLI on the machine the host places this action on. The
 * result is a record of what the agent did, so replay reads it back instead of
 * re-running hours of agent work.
 */
export const RunAgent = Action.make("burndown/run-agent", {
  implementationVersion: "burndown/run-agent/v5",
  payload: Assignment,
  success: WorkerResult,
  error: Schema.String,
  nondeterministic: true
})

/** Where an assignment runs: the sandbox provider, its checkout, and the login it runs as. */
export interface Machine {
  readonly provider: Sandbox.Provider
  readonly workdir: string
  readonly stateDir: string
  readonly env: Record<string, string>
  /** Disposable per-run directory the run script creates first and deletes on exit. */
  readonly scratch?: string
  readonly logFile?: boolean
  readonly brief?: (text: string) => Effect.Effect<string, string>
  readonly files?: ReadonlyArray<{ readonly path: string; readonly contents: string }>
  readonly handoff?: (result: WorkerResult, read: ReadCommand) => Effect.Effect<WorkerResult, string>
  readonly command?: (script: string) => Effect.Effect<{ readonly script: string; readonly stdin?: Uint8Array }, string>
}

export class Placement extends Context.Service<Placement, {
  readonly machine: (assignment: Assignment, account: Account) => Effect.Effect<Machine, string>
}>()("burndown/Placement") {}

const repoDirs: Record<string, string> = {
  "smithersai/smithers": join(homedir(), "smithers"),
  "smithersai/plue": join(homedir(), "plue")
}

/**
 * This machine: the shared checkout on main, the account's local login dir,
 * run scratch removed when the agent exits, and one Go build cache for all runs.
 */
export const layerLocal = Layer.effect(Placement)(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return {
      machine: (assignment, account) => {
        const workdir = repoDirs[assignment.repo]
        const stateDir = join(homedir(), "Smithers-Ops/burndown/runs", assignment.key)
        const scratch = join(stateDir, "tmp")
        return workdir === undefined
          ? Effect.fail(`no local checkout for ${assignment.repo}`)
          : Effect.succeed({
            provider: CommandSandbox.make({ spawner, prefix: [], workdir, name: "local", heartbeat: "10 minutes" }),
            workdir,
            stateDir,
            scratch,
            env: { ...accountEnv(account), TMPDIR: scratch, GOCACHE: join(homedir(), ".cache/burndown/go-build") }
          })
      }
    }
  })
)

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** The CLI argv for the assignment's tool and model. The brief arrives on stdin. */
export const agentArgv = (assignment: Assignment, workdir: string): ReadonlyArray<string> =>
  assignment.tool === "codex"
    ? [
      "codex",
      "exec",
      "--json",
      "-m",
      assignment.model,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      workdir,
      "-"
    ]
    : ["claude", "-p", "--output-format", "json", "--model", assignment.model, "--no-session-persistence", "--dangerously-skip-permissions"]

const limitPattern = /usage limit|rate limit|hit your limit|limit reached|429 Too Many Requests/i

/** Only the CLI's completed assistant channel can report queue results. */
const finalReport = (tool: Assignment["tool"], output: string): { readonly text?: string; readonly failure?: string } => {
  const records: Array<Record<string, unknown>> = []
  try {
    const value = JSON.parse(output)
    if (value && typeof value === "object" && !Array.isArray(value)) records.push(value)
  } catch {
    for (const line of output.split("\n")) {
      try {
        const value = JSON.parse(line)
        if (value && typeof value === "object" && !Array.isArray(value)) records.push(value)
      } catch { /* Plain diagnostic lines are never reports. */ }
    }
  }
  if (tool === "claude") {
    const result = records.filter((record) => record.type === "result").at(-1)
    return result?.subtype === "success" && result.is_error === false && typeof result.result === "string"
      ? { text: result.result } : { failure: JSON.stringify(result) ?? "" }
  }
  let message: string | undefined
  let completed = false
  let failure: string | undefined
  for (const record of records) {
    if (record.type === "turn.started") { message = undefined; completed = false; failure = undefined }
    if (record.type === "item.completed") {
      const item = record.item as Record<string, unknown> | undefined
      if (item?.type === "agent_message") {
        message = typeof item.text === "string" ? item.text : undefined
        completed = false
      }
    }
    if (record.type === "turn.completed") completed = true
    if (record.type === "turn.failed" || record.type === "error") {
      completed = false
      failure = JSON.stringify(record)
    }
  }
  return failure !== undefined ? { failure } : completed && message !== undefined ? { text: message } : {}
}

/** Validate final report mappings; worker text cannot prove host-side closure. */
export const parseReport = (
  assignment: Assignment,
  exitCode: number,
  output: string,
  agentHours: number,
  diagnostics = ""
): WorkerResult => {
  const final = finalReport(assignment.tool, output)
  const report = final.text
  const notes = `${exitCode !== 0 ? output : report ?? output}\n${diagnostics}`.slice(-2000)
  const result = (status: WorkerResult["status"], commits: WorkerResult["commits"] = [], why = ""): WorkerResult => ({
    key: assignment.key, status, commits, notes: `${notes}${why ? `\n${why}` : ""}`, agentHours
  })
  if (exitCode !== 0) return result(limitPattern.test(output + diagnostics) ? "limited" : "failed")
  if (report === undefined) {
    return result(final.failure !== undefined && limitPattern.test(final.failure + diagnostics) ? "limited" : "failed", [],
      "No completed final assistant report")
  }
  if ([assignment.lead, ...assignment.extras].some((issue) => issue.repo !== assignment.repo)) {
    return result("failed", [], "Inconsistent assigned repositories")
  }
  const order = [assignment.lead.n, ...assignment.extras.map((issue) => issue.n)]
  if (new Set(order).size !== order.length) return result("failed", [], "Duplicate assigned issues")
  const byIssue = new Map<number, string>()
  const byCommit = new Map<string, number>()
  const statuses = new Map<number, string>()
  const readyLines: Array<{ readonly issue?: number; readonly commit: string }> = []
  let fenced = false
  let closed = false
  let blocked = false
  for (const line of report.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const ready = /^READY\s+(?:#?(\d+)\s+)?([0-9a-f]{40}|[0-9a-f]{64})\s*$/.exec(line)
    if (ready) {
      readyLines.push({
        ...ready[1] === undefined ? {} : { issue: Number(ready[1]) },
        commit: ready[2]!
      })
      continue
    }
    const status = /^(CLOSED|BLOCKED)\s+#?(\d+)(?:\s+.*)?$/.exec(line)
    if (status) {
      const issue = Number(status[2])
      if (!order.includes(issue)) return result("failed", [], "Unassigned report issue")
      if (statuses.has(issue) && statuses.get(issue) !== status[1]) {
        return result("failed", [], "Conflicting final issue status")
      }
      statuses.set(issue, status[1]!)
      closed ||= status[1] === "CLOSED"
      blocked ||= status[1] === "BLOCKED"
    } else if (/^(READY|CLOSED|BLOCKED)\b/.test(line)) {
      return result("failed", [], "Malformed final report line")
    }
  }
  // Reserve explicit issue identities before assigning ordered implicit results.
  for (const { issue, commit } of readyLines.filter((line) => line.issue !== undefined)) {
    if (!order.includes(issue!) ||
      (byIssue.has(issue!) && byIssue.get(issue!) !== commit) ||
      (byCommit.has(commit) && byCommit.get(commit) !== issue)) {
      return result("failed", [], "Invalid READY assignment mapping")
    }
    byIssue.set(issue!, commit)
    byCommit.set(commit, issue!)
  }
  for (const { commit } of readyLines.filter((line) => line.issue === undefined)) {
    if (byCommit.has(commit)) continue
    const issue = order.find((n) => !byIssue.has(n))
    if (issue === undefined) return result("failed", [], "Invalid READY assignment mapping")
    byIssue.set(issue, commit)
    byCommit.set(commit, issue)
  }
  if ([...byIssue.keys()].some((issue) => statuses.has(issue))) {
    return result("failed", [], "Conflicting final issue status")
  }
  if (closed) return result("blocked", [], "CLOSED needs a verified host closure receipt")
  const commits = order.flatMap((issue) => byIssue.has(issue) ? [{ issue, commit: byIssue.get(issue)! }] : [])
  return commits.length > 0 ? result("ready", commits) : result(blocked ? "blocked" : "failed")
}

/** Implements `RunAgent` over whichever `Placement` the host provides. */
export const layerRunAgent = (brief: (assignment: Assignment, machine: Machine) => string) =>
  RunAgent.toLayer(
    (assignment) =>
      Effect.gen(function*() {
        const placement = yield* Placement
        const accounts = yield* Effect.promise(() => discoverAccounts({ onlyIds: [assignment.account] }))
        const account = accounts.accounts.find((a) =>
          a.id === assignment.account || a.aliases.includes(assignment.account)
        )
        if (account === undefined) return yield* Effect.fail(`account ${assignment.account} is not available`)
        const machine = yield* placement.machine(assignment, account)
        const started = Date.now()
        const briefPath = `${machine.stateDir}/brief.md`
        const logPath = `${machine.stateDir}/agent.log`
        const reportPath = `${machine.stateDir}/agent.report.jsonl`
        const script = [
          `mkdir -p ${shellQuote(machine.stateDir)}`,
          ...machine.scratch === undefined ? [] : [
            `mkdir -p ${shellQuote(machine.scratch)}`,
            `trap ${shellQuote(`rm -rf ${shellQuote(machine.scratch)}`)} EXIT`,
            // dash runs EXIT traps on exit only; turn the usual stop signals into exits.
            `trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM`
          ],
          `cd ${shellQuote(machine.workdir)}`,
          `${agentArgv(assignment, machine.workdir).map(shellQuote).join(" ")} < ${shellQuote(briefPath)} > ${shellQuote(reportPath)} 2> ${shellQuote(logPath)}`,
          `code=$?`,
          `cat ${shellQuote(reportPath)}`,
          `printf '\nBURNDOWN_DIAGNOSTICS='`,
          `tail -c 20000 ${shellQuote(logPath)} | base64 | tr -d '\n'`,
          `printf '\n'`,
          `echo "BURNDOWN_EXIT=$code"`
        ].join("\n")
        const originalBrief = brief(assignment, machine)
        const text = machine.brief === undefined ? originalBrief : yield* machine.brief(originalBrief)
        const command = machine.command === undefined ? { script } : yield* machine.command(script)
        return yield* Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner
          yield* fs.makeDirectory(machine.stateDir, { recursive: true })
          yield* fs.writeFileString(briefPath, text)
          for (const file of machine.files ?? []) {
            yield* fs.writeFileString(file.path, file.contents)
          }
          const output = yield* spawner.string(
            ChildProcess.make("sh", ["-c", command.script], {
              ...command.stdin === undefined ? {} : { stdin: Stream.make(command.stdin) },
              env: { ...machine.env, SMITHERS_INSIDE_RUN: "1" },
              extendEnv: true
            })
          )
          const exit = /BURNDOWN_EXIT=(\d+)\s*$/.exec(output)
          const diagnostic = /\nBURNDOWN_DIAGNOSTICS=([A-Za-z0-9+/=]*)\nBURNDOWN_EXIT=\d+\s*$/.exec(output)
          const result = parseReport(
            assignment,
            exit === null ? 1 : Number(exit[1]),
            diagnostic === null ? "" : output.slice(0, diagnostic.index),
            (Date.now() - started) / 3_600_000,
            diagnostic === null ? output : Buffer.from(diagnostic[1]!, "base64").toString("utf8")
          )
          const read: ReadCommand = (program, args, stdin) =>
            Effect.scoped(Effect.gen(function*() {
              const handle = yield* spawner.spawn(
                ChildProcess.make(program, [...args], {
                  env: machine.env,
                  cwd: machine.workdir,
                  extendEnv: true,
                  ...stdin === undefined ? {} : { stdin: Stream.make(stdin) }
                })
              )
              const [stdout, , code] = yield* Effect.all([
                Stream.runCollect(handle.stdout),
                Stream.runDrain(handle.stderr),
                handle.exitCode
              ], { concurrency: "unbounded" })
              if (Number(code) !== 0) return yield* Effect.fail("Cloud committed-tree export command failed")
              const decoder = new TextDecoder()
              return stdout.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode()
            })).pipe(Effect.mapError(() => "Cloud committed-tree export command failed"))
          return machine.handoff === undefined ? result : yield* machine.handoff(result, read)
        }).pipe(
          Effect.provide(Sandbox.layerHost(machine.provider, { session: `burndown:${assignment.key}` })),
          Effect.scoped,
          Effect.mapError((cause) => `agent ${assignment.key} could not run: ${String(cause)}`)
        )
      }),
    { implementationVersion: "burndown/run-agent/v5" }
  )
