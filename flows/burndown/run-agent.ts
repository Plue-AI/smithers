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
  implementationVersion: "burndown/run-agent/v1",
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

/** This machine: the shared checkout on main, the account's local login dir. */
export const layerLocal = Layer.effect(Placement)(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return {
      machine: (assignment, account) => {
        const workdir = repoDirs[assignment.repo]
        return workdir === undefined
          ? Effect.fail(`no local checkout for ${assignment.repo}`)
          : Effect.succeed({
            provider: CommandSandbox.make({ spawner, prefix: [], workdir, name: "local", heartbeat: "10 minutes" }),
            workdir,
            stateDir: join(homedir(), "Smithers-Ops/burndown/runs", assignment.key),
            env: accountEnv(account)
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
      "-m",
      assignment.model,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      workdir,
      "-"
    ]
    : ["claude", "-p", "--model", assignment.model, "--no-session-persistence", "--dangerously-skip-permissions"]

const limitPattern = /usage limit|rate limit|hit your limit|limit reached|429 Too Many Requests/i

/** Reads the agent's report lines: `READY #<n> <commit>`, `CLOSED #<n>`, `BLOCKED #<n> <why>`. */
export const parseReport = (
  assignment: Assignment,
  exitCode: number,
  tail: string,
  agentHours: number
): WorkerResult => {
  // `READY <commit>` lines arrive in bundle order: lead first, then each extra.
  const order = [assignment.lead.n, ...assignment.extras.map((e) => e.n)]
  const commits = [...tail.matchAll(/^READY\s+(?:#?(\d+)\s+)?([0-9a-f]{7,64})\s*$/gm)].map((m, i) => ({
    issue: m[1] === undefined ? (order[i] ?? assignment.lead.n) : Number(m[1]),
    commit: m[2]!
  }))
  const closed = /^CLOSED\s+#?\d+/m.test(tail)
  const blocked = /^BLOCKED\s+#?\d+/m.test(tail)
  const status = commits.length > 0
    ? "ready"
    : closed
    ? "closed"
    : blocked
    ? "blocked"
    : exitCode !== 0 && limitPattern.test(tail)
    ? "limited"
    : "failed"
  return {
    key: assignment.key,
    status,
    commits,
    notes: tail.slice(-2000),
    agentHours
  }
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
        const script = [
          `mkdir -p ${shellQuote(machine.stateDir)}`,
          `cd ${shellQuote(machine.workdir)}`,
          `${agentArgv(assignment, machine.workdir).map(shellQuote).join(" ")} < ${shellQuote(briefPath)}${
            machine.logFile === false ? "" : ` > ${shellQuote(logPath)} 2>&1`
          }`,
          `code=$?`,
          ...machine.logFile === false ? [] : [`tail -c 20000 ${shellQuote(logPath)}`],
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
          const result = parseReport(
            assignment,
            exit === null ? 1 : Number(exit[1]),
            output,
            (Date.now() - started) / 3_600_000
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
    { implementationVersion: "burndown/run-agent/v1" }
  )
