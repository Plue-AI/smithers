/**
 * `node flows/organization/cli.ts <command>`: the organization's commands.
 *
 * Every command is a {@link Command} in {@link registry}: `serve` runs the
 * host; `qualify` scores the Org's cases on a scratch host; `submit`,
 * `status`, `answer`, `hire`, `delegate`, `retire`,
 * `meetings`, and `book` talk to a running host over its loopback control
 * RPC; `specialists` reads the roster; and the setup commands come from
 * `setup/index.ts`. A command resolves its exit code; nothing here exits the
 * process but the entry point at the bottom.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import * as Roster from "../../packages/smithers/agent/organization/src/Roster.ts"
import { cliKey, credentialFile, operations, readCredential, rpc } from "./client.ts"
import { command as qualify } from "./qualify/cli.ts"
import { defaultPort, environmentOf, resolve } from "./settings.ts"
import { glance } from "./setup/glance.ts"
import { type Command, commands as setupCommands, type Io, processIo } from "./setup/index.ts"
import { absolute, loadOrganization, nonEmpty, stateDirOf } from "./setup/settings.ts"

export type { Command, Io }

interface ClientFlags {
  readonly host?: string | undefined
  readonly port?: string | undefined
  readonly "state-dir"?: string | undefined
}

/**
 * The control RPC of the host a client command talks to, presenting the
 * credential the host wrote to its state directory (`--state-dir`,
 * `SMITHERS_ORG_STATE_DIR`, default `~/.smithers/org`).
 */
const connect = (values: ClientFlags, io: Io) => {
  const stateDir = absolute(io.cwd, nonEmpty(values["state-dir"]) ?? stateDirOf(io.env))
  const credential = readCredential(stateDir)
  if (credential === undefined) {
    throw new Error(`no host credential at ${credentialFile(stateDir)}; start the host with serve, or pass --state-dir`)
  }
  return rpc(
    `http://${values.host ?? "127.0.0.1"}:${values.port ?? io.env.SMITHERS_ORG_PORT ?? defaultPort}`,
    credential
  )
}

const clientOptions = { host: { type: "string" }, port: { type: "string" }, "state-dir": { type: "string" } } as const

/** `serve`: the host, standalone, in the foreground. */
export const serve: Command = {
  name: "serve",
  usage:
    "serve [--standalone] [--root <dir containing Org/>] [--state-dir <dir>] [--repo <name=path>]... [--check <name=command>]... [--max-rounds <n>] [--port <port>]",
  run: async (argv, io) => {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        standalone: { type: "boolean", default: false },
        root: { type: "string" },
        "state-dir": { type: "string" },
        repo: { type: "string", multiple: true },
        check: { type: "string", multiple: true },
        "max-rounds": { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        "env-file": { type: "string" }
      }
    })
    const environment = environmentOf(values, io.env, io.cwd)
    const settings = await resolve(values, environment, io.cwd)
    const [{ platform }, { NodeRuntime }, { start }] = await Promise.all([
      import("../../packages/smithers/src/internal/NodeControlHost.ts"),
      import("@effect/platform-node"),
      import("./serve.ts")
    ])
    NodeRuntime.runMain(await start({ settings, environment, platform, log: io.err }))
    return await new Promise<number>(() => {})
  }
}

/** `submit "<task>"`: starts a request and prints its run; `--wait` waits for it to settle. */
export const submit: Command = {
  name: "submit",
  usage:
    "submit \"<task>\" [--repo <name>] [--key <key>] [--wait [--root <dir containing Org/>]] [--port <port>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        ...clientOptions,
        repo: { type: "string" },
        key: { type: "string" },
        wait: { type: "boolean", default: false },
        root: { type: "string" }
      }
    })
    const text = positionals.join(" ").trim()
    if (text === "") {
      io.err(`usage: ${submit.usage}`)
      return 2
    }
    const ops = operations(connect(values, io))
    const key = cliKey(values.key)
    const started = await ops.submit({
      key,
      text,
      source: "cli",
      ...(values.repo === undefined ? {} : { repository: values.repo })
    })
    io.out(`${started.joined ? "joined" : "started"} ${started.runId}`)
    return values.wait ? await waitFor(ops, started.runId, { key, name: "deliver" }, values, io) : 0
  }
}

type Operations = ReturnType<typeof operations>

/**
 * Waits until a run settles, naming each gate it parks on once, then prints
 * its status and, when the root is known, its receipt's status and summary.
 * Resolves 0 only when the run completed.
 */
const waitFor = async (
  ops: Operations,
  runId: string,
  receipt: { readonly key: string; readonly name: string },
  values: { readonly root?: string | undefined; readonly "state-dir"?: string | undefined },
  io: Io
): Promise<number> => {
  const asked = new Set<string>()
  for (;;) {
    const run = (await ops.runs({ runId }))[0]
    if (run !== undefined && ["completed", "failed", "cancelled"].includes(run.status)) {
      io.out(`${run.runId} ${run.status}`)
      const root = values.root ?? environmentOf(values, io.env, io.cwd).SMITHERS_ORG_ROOT
      const found = root === undefined ? undefined : await receiptOf(absolute(io.cwd, root), receipt.key, receipt.name)
      if (found !== undefined) io.out(`${found.status}: ${found.summary}\nreceipt ${found.path}`)
      return run.status === "completed" ? 0 : 1
    }
    for (const gate of run?.gates ?? []) {
      if (asked.has(gate.subjectDigest)) continue
      asked.add(gate.subjectDigest)
      io.out(`waiting on gate ${gate.gateId}: answer ${gate.gateId} approve|decline`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs(io)))
  }
}

/** How often `--wait` polls: `SMITHERS_ORG_POLL_MS`, default one second. */
const pollMs = (io: Io): number => {
  const ms = Number(io.env.SMITHERS_ORG_POLL_MS)
  return Number.isFinite(ms) && ms > 0 ? ms : 1_000
}

/** The receipt `<name>.json` a key names under `root`, when it was written. */
const receiptOf = async (root: string, key: string, name: string) => {
  const organization = await loadOrganization(root).catch(() => undefined)
  if (organization === undefined) return undefined
  const path = join(organization.loaded.organization.wiki.generatedDir, Actions.runDirectory(key), `${name}.json`)
  const text = await readFile(join(root, path), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const report =
    (JSON.parse(text) as { readonly report?: { readonly status?: string; readonly summary?: string } }).report
  return { path, status: report?.status ?? "unknown", summary: report?.summary ?? "" }
}

/** Waits until a run settles and resolves its status. */
const settle = async (ops: Operations, runId: string, io: Io): Promise<string> => {
  for (;;) {
    const run = (await ops.runs({ runId }))[0]
    if (run !== undefined && ["completed", "failed", "cancelled"].includes(run.status)) return run.status
    await new Promise((resolve) => setTimeout(resolve, pollMs(io)))
  }
}

/**
 * `status`: counts of running, parked, failed and done runs, then each run
 * that is not done with the gate to answer; `--run <id>` shows that run and
 * its gates; `--write` also rewrites the status page.
 */
export const status: Command = {
  name: "status",
  usage: "status [--run <id>] [--write] [--port <port>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { values } = parseArgs({
      args: [...argv],
      options: { ...clientOptions, run: { type: "string" }, write: { type: "boolean", default: false } }
    })
    const ops = operations(connect(values, io))
    if (values.write) {
      const started = await ops.writeStatus()
      const settled = await settle(ops, started.runId, io)
      io.out(`status page ${settled === "completed" ? "written" : settled} by ${started.runId}`)
      if (settled !== "completed") return 1
    }
    if (values.run === undefined) {
      for (const line of glance(await ops.runs())) io.out(line)
      return 0
    }
    const runs = await ops.runs({ runId: values.run })
    for (const run of runs) {
      io.out(`${run.runId}  ${run.flowId}  ${run.status}`)
      for (const gate of run.gates) {
        io.out(`  gate ${gate.gateId} ${gate.subjectDigest.slice(0, 16)}: ${gate.prompt.split("\n")[0]}`)
      }
    }
    if (runs.length === 0) io.out("no runs")
    return 0
  }
}

/** `answer <gate> approve|decline`: answers an approval gate a run is parked on. */
export const answer: Command = {
  name: "answer",
  usage: "answer <gate> approve|decline [--run <id>] [--reason <text>] [--port <port>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { ...clientOptions, run: { type: "string" }, reason: { type: "string" } }
    })
    const [gateId, choice] = positionals
    if (gateId === undefined || (choice !== "approve" && choice !== "decline")) {
      io.err(`usage: ${answer.usage}`)
      return 2
    }
    const gate = await operations(connect(values, io)).answer({
      gateId,
      approved: choice === "approve",
      runId: values.run,
      reason: values.reason
    })
    io.out(`${choice === "approve" ? "approved" : "declined"} ${gate.gateId} for ${gate.runId}`)
    return 0
  }
}

const startOptions = {
  ...clientOptions,
  key: { type: "string" },
  wait: { type: "boolean", default: false },
  root: { type: "string" }
} as const

interface StartFlags extends ClientFlags {
  readonly key?: string | undefined
  readonly wait?: boolean | undefined
  readonly root?: string | undefined
}

/**
 * Starts `organization/<flow>` through the host's control plane under `key`
 * (the same key joins the run it started) and prints its run; with `--wait`,
 * waits and prints the receipt `<name>.json` the flow writes under
 * `receiptKey`.
 */
const launch = async (
  values: StartFlags,
  io: Io,
  flow: string,
  input: Readonly<Record<string, unknown>>,
  key: string,
  receipt: { readonly key: string; readonly name: string }
): Promise<number> => {
  const ops = operations(connect(values, io))
  const started = await ops.start(`organization/${flow}`, input, key)
  io.out(`${started.joined ? "joined" : "started"} ${started.runId}`)
  return values.wait ? await waitFor(ops, started.runId, receipt, values, io) : 0
}

const usageError = (command: Command, io: Io): number => {
  io.err(`usage: ${command.usage}`)
  return 2
}

/** `hire <parent> "<need>"`: the parent hires a specialist; `--task` hands it a first task. */
export const hire: Command = {
  name: "hire",
  usage:
    "hire <parent> \"<need>\" [--task \"<task>\" [--acceptance <line>]...] [--key <key>] [--wait [--root <dir>]] [--port <port>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { ...startOptions, task: { type: "string" }, acceptance: { type: "string", multiple: true } }
    })
    const [parent, ...rest] = positionals
    const need = rest.join(" ").trim()
    if (parent === undefined || need === "" || (values.acceptance !== undefined && values.task === undefined)) {
      return usageError(hire, io)
    }
    const key = cliKey(values.key)
    return launch(
      values,
      io,
      "hire",
      {
        key,
        parent,
        need,
        ...(values.task === undefined ? {} : { task: values.task }),
        ...(values.acceptance === undefined ? {} : { acceptance: values.acceptance })
      },
      key,
      { key, name: "hire" }
    )
  }
}

/** `delegate <parent> <specialist> "<objective>"`: the parent hands a task to its hire and reviews it. */
export const delegate: Command = {
  name: "delegate",
  usage:
    "delegate <parent> <specialist> \"<objective>\" [--input <text>]... [--acceptance <line>]... [--key <key>] [--wait [--root <dir>]] [--port <port>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        ...startOptions,
        input: { type: "string", multiple: true },
        acceptance: { type: "string", multiple: true }
      }
    })
    const [parent, specialist, ...rest] = positionals
    const objective = rest.join(" ").trim()
    if (parent === undefined || specialist === undefined || objective === "") return usageError(delegate, io)
    const key = cliKey(values.key)
    return launch(
      values,
      io,
      "delegate",
      {
        key,
        parent,
        specialist,
        objective,
        ...(values.input === undefined ? {} : { inputs: values.input }),
        ...(values.acceptance === undefined ? {} : { acceptance: values.acceptance })
      },
      key,
      { key, name: "delegate" }
    )
  }
}

/** `retire <principal>`: retires a hire and everything it hired. */
export const retire: Command = {
  name: "retire",
  usage: "retire <principal> [--key <key>] [--wait [--root <dir>]] [--port <port>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({ args: [...argv], allowPositionals: true, options: startOptions })
    const [principal, ...rest] = positionals
    if (principal === undefined || rest.length > 0) return usageError(retire, io)
    const key = cliKey(values.key)
    return launch(values, io, "retire", { key, principal }, key, { key, name: "retire" })
  }
}

/** `meetings plan`: plans the weekly one-on-ones now rather than at the daily run. */
export const meetings: Command = {
  name: "meetings",
  usage: "meetings plan [--wait [--root <dir>]] [--port <port>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({ args: [...argv], allowPositionals: true, options: startOptions })
    if (positionals.length !== 1 || positionals[0] !== "plan") return usageError(meetings, io)
    return launch(values, io, "meetings-plan", {}, `meetings-plan:${cliKey(values.key)}`, {
      key: "meetings",
      name: "plan"
    })
  }
}

/** `book <role> <minutes> "<purpose>"`: the assistant books extra time with the owner for a role. */
export const book: Command = {
  name: "book",
  usage:
    "book <role> <minutes 5-240> \"<purpose>\" [--not-before <time>] [--key <key>] [--wait [--root <dir>]] [--port <port>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { ...startOptions, "not-before": { type: "string" } }
    })
    const [requestedBy, length, ...rest] = positionals
    const purpose = rest.join(" ").trim()
    const minutes = Number(length)
    const notBefore = values["not-before"] === undefined ? undefined : Date.parse(values["not-before"])
    if (
      requestedBy === undefined || purpose === "" || !Number.isInteger(minutes) || minutes < 5 || minutes > 240 ||
      (notBefore !== undefined && Number.isNaN(notBefore))
    ) return usageError(book, io)
    const key = cliKey(values.key)
    return launch(
      values,
      io,
      "meetings-book",
      {
        key,
        requestedBy,
        purpose,
        minutes,
        ...(notBefore === undefined ? {} : { notBefore })
      },
      key,
      { key, name: "book" }
    )
  }
}

/** `specialists`: every hired principal in the roster, with its status and hirer. */
export const specialists: Command = {
  name: "specialists",
  usage: "specialists [--root <dir containing Org/>] [--state-dir <dir>]",
  run: async (argv, io) => {
    const { values } = parseArgs({
      args: [...argv],
      options: { root: { type: "string" }, "state-dir": { type: "string" }, "env-file": { type: "string" } }
    })
    const root = values.root ?? environmentOf(values, io.env, io.cwd).SMITHERS_ORG_ROOT ?? io.cwd
    const organization = await loadOrganization(absolute(io.cwd, root))
    const hired = [...organization.snapshot.roster.profiles.values()].filter(Roster.isHired)
      .sort((left, right) => left.id.localeCompare(right.id))
    for (const profile of hired) {
      io.out(
        `${profile.id}  ${profile.status}  ${profile.kind}  ${profile.hiredBy ?? profile.reportsTo}  ${profile.name}`
      )
    }
    if (hired.length === 0) io.out("no specialists")
    return 0
  }
}

/** Every command, by name. */
export const registry: ReadonlyMap<string, Command> = new Map(
  [serve, submit, status, answer, qualify, hire, delegate, retire, meetings, book, specialists, ...setupCommands].map((
    command
  ) => [command.name, command])
)

/** Runs one command line against the registry and resolves its exit code. */
export const main = async (argv: ReadonlyArray<string>, io: Io = processIo()): Promise<number> => {
  const [name, ...rest] = argv
  const command = name === undefined ? undefined : registry.get(name)
  if (command === undefined) {
    for (const candidate of registry.values()) io.err(`usage: ${candidate.usage}`)
    return 2
  }
  try {
    return await command.run(rest, io)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
