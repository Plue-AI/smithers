/**
 * `qualify`: runs an organization's cases against a host with real seats
 * and writes a dated scorecard.
 *
 * The command starts its own host over a scratch state directory and a
 * scratch copy of the organization (`Org/` and every page a role's knowledge
 * grants name), with scratch clones of the configured repositories, so
 * qualification never touches the live host's state, memory, receipts, or
 * branches. Seats resolve exactly as `serve` resolves them. Each case runs
 * `--runs` times (a delivery case `--delivery-runs` times, `--runs` by
 * default), at most `--concurrency` at once: a role case as one
 * `organization/qualify` run, a delivery case as one request through
 * `organization/intake`. Every attempt is scored against the case's
 * expectations (`cases.ts`), and the scorecard goes to
 * `<generatedDir>/Qualification-<date>.md` in the real organization.
 *
 * `node flows/organization/qualify/cli.ts [flags]` runs it directly; the
 * organization CLI registers it as `qualify`.
 */
import { Effect } from "effect"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Workspace from "../../../packages/smithers/agent/organization/src/Workspace.ts"
import * as MicrosandboxSandbox from "../../../packages/smithers/flows/sandbox/src/MicrosandboxSandbox/index.ts"
import { operations, readCredential, rpc } from "../client.ts"
import { environmentOf, resolve, type Settings } from "../settings.ts"
import { type Command, type Io, processIo } from "../setup/index.ts"
import * as SetupMicrosandbox from "../setup/microsandbox.ts"
import { absolute } from "../setup/settings.ts"
import * as Cases from "./cases.ts"
import { render, type Scored, type Skipped } from "./scorecard.ts"

const here = dirname(fileURLToPath(import.meta.url))
/** The organization CLI, whose `serve` starts the qualification host. */
const organizationCli = join(dirname(here), "cli.ts")

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })

const integer = (name: string, value: string | undefined, fallback: number, max: number) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`)
  }
  return parsed
}

/** Today's local date as the scorecard names it, and a key-safe stamp for this invocation. */
const clock = (now = new Date()) => ({
  date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
  stamp: now.toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)
})

/** A scratch copy of the organization: `Org/` and every wiki path a role's knowledge names. */
const copyOrganization = (settings: Settings, into: string) => {
  const paths = new Set([settings.organization.rosterDir])
  for (const profile of settings.snapshot.roster.profiles.values()) {
    for (const path of profile.grants.knowledge) paths.add(path.replace(/\/+$/, ""))
  }
  for (const path of paths) {
    const source = join(settings.root, path)
    if (!existsSync(source)) continue
    cpSync(source, join(into, path), {
      recursive: true,
      filter: (entry) => !entry.split("/").some((part) => part === ".git" || part === "node_modules")
    })
  }
}

/**
 * Sets every profile's daily task budget in the scratch copy to `tasks` of
 * its own: qualification runs each case several times in one day, which says
 * nothing about the budget; every other part of a profile is qualified as
 * written.
 */
const liftDailyBudgets = (directory: string, tasks: (own: number) => number) => {
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const path = join(entry.parentPath, entry.name)
    const text = readFileSync(path, "utf8")
    const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1
    if (end < 0) continue
    const head = text.slice(0, end).replace(
      /(\btasksPerDay:\s*)(\d+)/g,
      (_, key: string, own: string) => `${key}${tasks(Number(own))}`
    )
    if (head !== text.slice(0, end)) writeFileSync(path, head + text.slice(end))
  }
}

/** Scratch clones of the configured repositories: a landed change goes to a clone, never the original. */
const cloneRepositories = (settings: Settings, into: string) =>
  Object.entries(settings.repositories).map(([name, path], index) => {
    const clone = join(into, `repo-${index}`)
    execFileSync("git", ["clone", "--quiet", "--local", "--no-checkout", path, clone], { stdio: "ignore" })
    return [name, clone] as const
  })

/**
 * Removes every machine and prepared base the qualification host's
 * installation left behind. The installation lives only as long as the run,
 * so its bases would otherwise stay on disk (several GiB each) for good.
 */
const reap = async (owner: string) => {
  const install = SetupMicrosandbox.locate()
  if (install === undefined) return
  const sdk = await SetupMicrosandbox.sdkOf(install)
  sdk.setDefaultBackend("local")
  await Effect.runPromise(
    MicrosandboxSandbox.reap({ sdk, owner, isAlive: () => Effect.succeed(false) }).pipe(
      Effect.andThen(MicrosandboxSandbox.pruneSnapshots(sdk, Workspace.basePrefix(owner), 0))
    )
  )
}

/** The wiki root's git commit, `+` when its tree has uncommitted changes; `undefined` outside git. */
const wikiRevision = (root: string): string | undefined => {
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
  if (head.status !== 0) return undefined
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })
  return `${head.stdout.trim().slice(0, 12)}${status.stdout.trim() === "" ? "" : "+"}`
}

/** SHA-256 over every case page's name and bytes, in name order. */
const casesDigest = (directory: string): string => {
  const hash = createHash("sha256")
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".md")).sort()) {
    hash.update(`${name}\0`).update(readFileSync(join(directory, name))).update("\0")
  }
  return hash.digest("hex")
}

/** Whether `revision` names a commit in `repo`. */
const hasCommit = (repo: string, revision: string): boolean => {
  if (revision.startsWith("-")) return false
  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${revision}^{commit}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** The files a commit in `repo` changed. */
const filesOf = (repo: string, commit: string): ReadonlyArray<string> =>
  execFileSync("git", ["-C", repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

const usage =
  "qualify [--root <dir containing Org/>] [--state-dir <dir>] [--case <id>]... [--role <id>]... [--only role|delivery] [--runs <n>] [--delivery-runs <n>] [--concurrency <n>] [--timeout <minutes>] [--keep] [--real-budgets] [--serve-with <cli module>]"

/** `qualify`: run the organization's cases and write the scorecard. */
export const command: Command = {
  name: "qualify",
  usage,
  run: async (argv, io) => {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        root: { type: "string" },
        "state-dir": { type: "string" },
        "env-file": { type: "string" },
        repo: { type: "string", multiple: true },
        case: { type: "string", multiple: true },
        role: { type: "string", multiple: true },
        runs: { type: "string" },
        "delivery-runs": { type: "string" },
        concurrency: { type: "string" },
        timeout: { type: "string" },
        keep: { type: "boolean", default: false },
        "real-budgets": { type: "boolean", default: false },
        only: { type: "string" },
        "serve-with": { type: "string" }
      }
    })
    const runs = integer("--runs", values.runs, 3, 50)
    const deliveryRuns = integer("--delivery-runs", values["delivery-runs"], runs, 50)
    const runsOf = (entry: Cases.Case) => entry.mode === "delivery" ? deliveryRuns : runs
    const rounds = Math.max(runs, deliveryRuns)
    const concurrency = integer("--concurrency", values.concurrency, 2, 16)
    const timeoutMs = integer("--timeout", values.timeout, 30, 240) * 60_000
    const environment = environmentOf(values, io.env, io.cwd)
    /** The repository a workspace case's principal works in: the case's, or the first configured one it is granted. */
    const workspaceOf = (
      entry: Cases.RoleCase,
      profile: {
        readonly grants: { readonly tools: ReadonlyArray<string>; readonly repositories: ReadonlyArray<string> }
      }
    ) => {
      if (!profile.grants.tools.includes("workspace")) return undefined
      const granted = profile.grants.repositories.filter((name) => Object.hasOwn(settings.repositories, name))
      return entry.repository === undefined
        ? granted[0]
        : granted.includes(entry.repository)
        ? entry.repository
        : undefined
    }
    const scratch = mkdtempSync(join(tmpdir(), "organization-qualify-"))
    const stateDir = join(scratch, "state")
    const root = join(scratch, "root")
    const settings = await resolve(
      { root: values.root, repo: values.repo, "state-dir": stateDir },
      environment,
      io.cwd
    )
    const casesDir = settings.organization.casesDir ?? `${settings.organization.rosterDir}/Cases`
    const graded = {
      wiki: wikiRevision(settings.root),
      roster: settings.snapshot.revision,
      cases: casesDigest(join(settings.root, casesDir))
    }
    copyOrganization(settings, root)
    const cases = await Cases.load(settings.root, casesDir)
    const selected = cases.filter((entry) =>
      (values.case === undefined || values.case.includes(entry.id)) &&
      (values.role === undefined || entry.mode === "invalid" || values.role.includes(entry.principal)) &&
      (values.only === undefined || entry.mode === "invalid" || entry.mode === values.only)
    )
    const invalid: Array<Skipped> = selected.filter((entry): entry is Cases.Invalid => entry.mode === "invalid")
      .map((entry) => ({ caseId: entry.id, principal: "", reason: entry.reason }))
    const pending: Array<Skipped> = []
    const runnable: Array<Cases.Case> = []
    for (const entry of selected) {
      if (entry.mode === "invalid") continue
      const reason = Cases.pending(entry)
      const profile = settings.snapshot.roster.profiles.get(entry.principal)
      if (reason !== undefined) pending.push({ caseId: entry.id, principal: entry.principal, reason })
      else if (profile === undefined) {
        invalid.push({
          caseId: entry.id,
          principal: entry.principal,
          reason: `${entry.principal} is not in the roster`
        })
      } else if (
        entry.mode === "role" && entry.requires.includes("workspace") && workspaceOf(entry, profile) === undefined
      ) {
        pending.push({
          caseId: entry.id,
          principal: entry.principal,
          reason: `needs workspace: no configured repository ${entry.principal} works in`
        })
      } else if (
        entry.mode === "role" && entry.revision !== undefined &&
        !hasCommit(settings.repositories[workspaceOf(entry, profile)!]!, entry.revision)
      ) {
        pending.push({
          caseId: entry.id,
          principal: entry.principal,
          reason: `needs revision ${entry.revision} in ${workspaceOf(entry, profile)}`
        })
      } else runnable.push(entry)
    }
    // Each attempt is a handful of role tasks at most; a delivery is one per role it reaches per round.
    // With the real budgets, each round of attempts is one day's work: a day's budget per round.
    liftDailyBudgets(
      join(root, settings.organization.rosterDir),
      values["real-budgets"] ? (own) => own * rounds : () => Math.max(1, runnable.length) * rounds * 8
    )
    const repositories = runnable.some((entry) => entry.mode === "delivery" || entry.requires.includes("workspace"))
      ? cloneRepositories(settings, scratch)
      : Object.entries(settings.repositories)
    const port = await freePort()
    const childEnvironment: Record<string, string> = {}
    for (const [name, value] of Object.entries(environment)) {
      if (value !== undefined && !name.startsWith("SMITHERS_SLACK_")) childEnvironment[name] = value
    }
    const host = spawn(process.execPath, [
      values["serve-with"] === undefined ? organizationCli : absolute(io.cwd, values["serve-with"]),
      "serve",
      "--standalone",
      "--root",
      root,
      "--state-dir",
      stateDir,
      "--port",
      String(port),
      ...repositories.flatMap(([name, path]) => ["--repo", `${name}=${path}`])
    ], { cwd: io.cwd, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    host.stdout.on("data", (data) => (output += data))
    host.stderr.on("data", (data) => (output += data))
    const stop = async () => {
      if (host.exitCode !== null || host.signalCode !== null) return
      const exited = new Promise((resolve) => host.once("exit", resolve))
      host.kill("SIGINT")
      await Promise.race([exited, pause(15_000)])
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL")
    }
    // Stopped from outside, the host and its machines go with this process.
    const interrupted = (signal: NodeJS.Signals) => {
      void stop().then(() => reap(settings.installation)).finally(() => process.exit(signal === "SIGINT" ? 130 : 143))
    }
    process.once("SIGINT", interrupted)
    process.once("SIGTERM", interrupted)
    try {
      const base = `http://127.0.0.1:${port}`
      for (let i = 0;; i++) {
        if (host.exitCode !== null) throw new Error(`the qualification host exited:\n${output}`)
        if (await fetch(`${base}/health`).then((response) => response.ok, () => false)) break
        if (i > 1_200) throw new Error(`the qualification host did not listen:\n${output}`)
        await pause(100)
      }
      const ops = operations(rpc(base, readCredential(stateDir)))
      const { date, stamp } = clock()
      const generated = join(root, settings.organization.wiki.generatedDir)
      const settle = async (runId: string) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const view = (await ops.runs({ runId }))[0]
          if (view !== undefined && ["completed", "failed", "cancelled"].includes(view.status)) return view.status
          await pause(1_000)
        }
        return "timed-out"
      }
      /** What the host logged about a run, for an attempt that left no receipt. */
      const logged = (runId: string) => {
        const lines = output.split("\n").filter((line) => line.includes(runId)).slice(0, 3)
        return lines.length === 0 ? "" : `: ${lines.join(" / ").slice(0, 600)}`
      }
      /**
       * A case's host commands, run in order against the qualification
       * host's state, each as the context entry the principal sees.
       */
      const hostRun = (entry: Cases.RoleCase, n: number) => {
        if (entry.commands.length === 0) return []
        const directory = join(scratch, `drill-${entry.id}-${n}`)
        mkdirSync(directory, { recursive: true })
        return entry.commands.map((template) => {
          const argv = template.map((part) => part.replaceAll(Cases.drill, directory))
          const full = argv.includes("--state-dir") ? argv : [...argv, "--state-dir", stateDir]
          const ran = spawnSync(process.execPath, [organizationCli, ...full], {
            cwd: io.cwd,
            env: childEnvironment,
            encoding: "utf8",
            timeout: 600_000
          })
          const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim()
          return {
            source: { provider: "host", id: argv[0]! },
            provenance: { retrievedAtMs: Date.now() },
            text: `Provenance: run on the organization host for this task\n\n$ smithers-org ${full.join(" ")}\nexit ${
              ran.status ?? ran.signal ?? ran.error?.message
            }\n${output}`
          }
        })
      }
      const attempt = async (entry: Cases.Case, n: number): Promise<Scored> => {
        const started = Date.now()
        const key = `qualify:${stamp}:${entry.id}:${n}`.slice(0, 128)
        const directory = join(generated, Actions.runDirectory(key))
        let reasons: ReadonlyArray<string>
        let receipt: string | undefined
        try {
          if (entry.mode === "role") {
            const profile = settings.snapshot.roster.profiles.get(entry.principal)!
            const { context: given, task } = Cases.taskOf(entry, profile.reportsTo, Date.now())
            const context = [...given, ...hostRun(entry, n)]
            const repository = entry.requires.includes("workspace") ? workspaceOf(entry, profile) : undefined
            const run = await ops.start(
              "organization/qualify",
              {
                key,
                principal: entry.principal,
                task,
                context,
                ...(repository === undefined ? {} : { repository }),
                ...(repository === undefined || entry.revision === undefined ? {} : { commit: entry.revision }),
                ...(repository === undefined || entry.checks === undefined ? {} : { checks: entry.checks })
              },
              key
            )
            const status = await settle(run.runId)
            receipt = join(directory, "qualify.json")
            const recorded = readJson(receipt)
            reasons = recorded === undefined
              ? [`${Cases.infrastructure} run ${status}, no receipt${logged(run.runId)}`]
              : Cases.scoreRole(entry, recorded.outcome as Cases.RoleOutcome)
          } else {
            const run = await ops.submit({
              key,
              text: entry.request.text,
              source: "cli",
              ...(entry.request.repository === undefined ? {} : { repository: entry.request.repository })
            })
            const status = await settle(run.runId)
            receipt = join(directory, "deliver.json")
            const recorded = readJson(receipt)
            const report = recorded?.report
            const repository = recorded?.admission?.repository as string | undefined
            const clone = repositories.find(([name]) => name === repository)?.[1]
            const commit = report?.applied?.commit as string | undefined
            reasons = Cases.scoreDelivery(entry, {
              report,
              files: clone === undefined || commit === undefined ? [] : filesOf(clone, commit),
              document: typeof report?.document === "string" ? readText(join(root, report.document)) : undefined,
              failure: `run ${status}, no receipt${logged(run.runId)}`
            })
          }
        } catch (error) {
          reasons = [`${Cases.infrastructure} ${error instanceof Error ? error.message : String(error)}`]
        }
        const seconds = Math.round((Date.now() - started) / 1_000)
        io.out(
          `${reasons.length === 0 ? "pass" : "FAIL"} ${entry.id} #${n} ${seconds}s${
            reasons.length === 0 ? "" : `: ${reasons.join("; ")}`
          }`
        )
        return { caseId: entry.id, principal: entry.principal, kind: entry.kind, attempt: n, reasons, receipt, seconds }
      }
      const queue = runnable.flatMap((entry) =>
        Array.from({ length: runsOf(entry) }, (_, index) => [entry, index + 1] as const)
      )
      const scored: Array<Scored> = []
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) scored.push(await attempt(...next))
      }))
      const seats = Object.fromEntries(
        [...settings.snapshot.roster.profiles.values()].map((profile) => [profile.id, profile.seat])
      )
      const directory = join(settings.root, settings.organization.wiki.generatedDir)
      mkdirSync(directory, { recursive: true })
      let path = join(directory, `Qualification-${date}.md`)
      for (let suffix = 2; existsSync(path); suffix++) path = join(directory, `Qualification-${date}-${suffix}.md`)
      writeFileSync(path, render({ date, runs, deliveryRuns, seats, scored, pending, invalid, graded }))
      const passed = scored.filter((entry) => entry.reasons.length === 0).length
      io.out(`${passed}/${scored.length} passed; scorecard ${path}`)
      if (values.keep) io.out(`kept ${scratch}`)
      return passed === scored.length && invalid.length === 0 ? 0 : 1
    } finally {
      process.off("SIGINT", interrupted)
      process.off("SIGTERM", interrupted)
      await stop()
      await reap(settings.installation).catch((error: unknown) => io.err(`machines not reaped: ${String(error)}`))
      if (values.keep) writeFileSync(join(scratch, "host.log"), output)
      else rmSync(scratch, { recursive: true, force: true })
    }
  }
}

/** Runs `qualify` with the process's arguments. */
export const main = async (argv: ReadonlyArray<string>, io: Io = processIo()): Promise<number> => {
  try {
    return await command.run(argv, io)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    io.err(`usage: ${usage}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
