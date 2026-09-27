/**
 * `smthrs up -d`: launch a run in a process that outlives this one.
 *
 * The 0.x launcher's hard-won rule is carried over unchanged: a detached
 * launch returns only after the child has *proved* it persisted the run row,
 * never on spawn success. A launcher that returns on spawn reports a run id
 * for a process that may already have died on a missing credential, and the
 * operator finds out minutes later from an empty `ps`.
 *
 * The child writes one line to its own log the moment the control plane hands
 * back an `Accepted` receipt (see {@link admissionLine}). The line is the
 * wake-up; the proof is the run row. The log is the child's whole
 * stdout/stderr, which every tool, agent and shell the run spawns shares, and
 * those processes inherit the nonce, so any id in the log is a claim, not a
 * fact. The parent asks its own control store, through
 * {@link Options.admission}, whether each announced id is a run row that
 * belongs to this launch, and only then renames the log onto the run id and
 * prints the receipt. A child that exits before an announced id is confirmed,
 * or that is still unconfirmed at the deadline, is reported as a failed launch
 * with the log's tail attached.
 *
 * @since 1.0.0
 */

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import * as Project from "./Project.ts"

/**
 * The environment name that tells a `smthrs run` child it was launched
 * detached, and which nonce to stamp its admission line with.
 *
 * Internal parent-to-child handoff: never set it by hand.
 *
 * @category constants
 * @since 1.0.0
 */
export const admissionVariable = "SMITHERS_INTERNAL_DETACHED_ADMISSION"

/**
 * How long a launch waits for the admission line before giving up, and the
 * multiple of that window a *live* child is granted on top.
 *
 * A child that is still alive at the deadline is booting slowly, not stuck:
 * module-graph parse alone can exceed the window on a loaded machine. Only a
 * child that is both silent and alive past the grace window is terminated.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultTimeoutMs = 30_000

/**
 * Grace given to each of SIGTERM and SIGKILL during failed-launch cleanup.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultTerminationGraceMs = 2_000

/** The extra multiple of the timeout a still-running child is granted. */
const liveChildGraceMultiple = 4

/** How much of the log tail is reported with a failed launch. */
const tailBytes = 32 * 1024

/** How often the parent re-reads the log while waiting. */
const pollIntervalMs = 50

/**
 * The line a detached child writes once its run row is durable.
 *
 * @category constructors
 * @since 1.0.0
 */
export const admissionLine = (nonce: string, runId: string): string =>
  `SMITHERS_DETACHED_ADMISSION=run:${nonce} runId=${runId}`

/**
 * The run-id shapes admitted onto a log filename.
 *
 * The id is parsed out of the child's combined stdout/stderr — a stream that
 * workflow code, agent transcripts, and tool output all write to — so it is
 * untrusted input at a path boundary: it becomes the filename the pending log
 * is renamed onto, and the name any earlier log at that path is moved aside
 * under. One filename component is the whole contract: alphanumerics, dot,
 * underscore and dash, starting alphanumeric, bounded so the `.log` and
 * `.superseded-<nonce>.log` suffixes stay inside filename limits. Anything
 * else (`../`, absolute, separator-bearing) would rename files outside the
 * log directory and is treated as no admission line at all. Every id the
 * control plane mints (`run-<sequence>`, uuids) fits this shape.
 */
const filenameSafeRunId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Every distinct filename-safe run id announced in a log tail under this
 * nonce's admission line, in order of first appearance.
 *
 * Each id is a candidate only: the log is untrusted, so a forged line can
 * appear before, after, or instead of the honest one. {@link launch} confirms
 * a candidate against the control store before it trusts it.
 *
 * @category getters
 * @since 1.0.0
 */
export const announcedRunIds = (tail: string, nonce: string): ReadonlyArray<string> => {
  const marker = `SMITHERS_DETACHED_ADMISSION=run:${nonce} runId=`
  const found: Array<string> = []
  let start = tail.indexOf(marker)
  while (start >= 0) {
    const rest = tail.slice(start + marker.length)
    const end = rest.search(/\s/)
    const runId = end < 0 ? rest : rest.slice(0, end)
    if (filenameSafeRunId.test(runId) && !found.includes(runId)) found.push(runId)
    start = tail.indexOf(marker, start + marker.length)
  }
  return found
}

/**
 * Reads the last bytes of a log file, or `""` when there is nothing to read.
 *
 * @category getters
 * @since 1.0.0
 */
export const logTail = (file: string, maxBytes: number = tailBytes): string => {
  if (!existsSync(file)) return ""
  let descriptor: number | undefined
  try {
    descriptor = openSync(file, "r")
    const size = fstatSync(descriptor).size
    const length = Math.min(size, Math.max(1, maxBytes))
    const buffer = Buffer.alloc(length)
    readSync(descriptor, buffer, 0, length, Math.max(0, size - length))
    return buffer.toString("utf8")
  } catch {
    return ""
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/**
 * Reads a log from `offset` to its current end. The bytes are decoded as
 * latin1 so a read that splits a multi-byte character cannot corrupt the
 * ASCII admission line around it.
 */
const readFrom = (file: string, offset: number): { readonly text: string; readonly next: number } => {
  let descriptor: number | undefined
  try {
    descriptor = openSync(file, "r")
    const size = fstatSync(descriptor).size
    if (size <= offset) return { text: "", next: offset }
    const buffer = Buffer.alloc(size - offset)
    const read = readSync(descriptor, buffer, 0, buffer.length, offset)
    return { text: buffer.toString("latin1", 0, read), next: offset + read }
  } catch {
    return { text: "", next: offset }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** The longest unterminated line kept between reads; an admission line is far shorter. */
const carryBytes = 4 * 1024

/** Whether a POSIX process group still has a member. */
const processGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as { readonly code?: string } | null)?.code !== "ESRCH"
  }
}

const childAlive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (predicate()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await sleep(Math.min(pollIntervalMs, remaining))
  }
  return true
}

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as { readonly code?: string } | null)?.code !== "ESRCH") throw error
  }
}

/** SIGTERM, then SIGKILL, aimed at the child's process group. */
const terminateGroup = async (pid: number, grace: number): Promise<boolean> => {
  if (!processGroupAlive(pid)) return true
  try {
    signalGroup(pid, "SIGTERM")
  } catch {
    return false
  }
  if (await waitUntil(() => processGroupAlive(pid), grace)) return true
  try {
    signalGroup(pid, "SIGKILL")
  } catch {
    return false
  }
  return waitUntil(() => processGroupAlive(pid), grace)
}

/**
 * SIGTERM, then SIGKILL, aimed at the child handle alone.
 *
 * The whole containment claim is then about the leader rather than the group,
 * which is exactly what a host without process groups can promise.
 */
const terminateHandle = async (child: ChildProcess, grace: number): Promise<boolean> => {
  if (!childAlive(child)) return true
  try {
    child.kill("SIGTERM")
  } catch {
    return !childAlive(child)
  }
  if (await waitUntil(() => childAlive(child), grace)) return true
  try {
    child.kill("SIGKILL")
  } catch {
    return !childAlive(child)
  }
  return waitUntil(() => childAlive(child), grace)
}

/**
 * Terminates and reaps a child that never reached admission.
 *
 * On POSIX the group, not just its leader, must disappear before this resolves.
 * A cooperative group gets SIGTERM; a group still present after the grace
 * window gets SIGKILL and another bounded reap window. The boolean is false
 * when the host could not confirm containment, so a caller never reports an
 * orphan-prone launch as successfully terminated.
 *
 * `platform` is the host whose process model the containment is judged against,
 * and it is a parameter for the same reason `@smthrs/flows`'s containment
 * options take one: Windows has no process groups, so the handle is the only
 * thing that can be signalled there, and a host that runs its coverage on POSIX
 * has no other way to exercise what it ships to Windows.
 *
 * @category destructors
 * @since 1.0.0
 */
export const terminate = async (
  child: ChildProcess,
  graceMs: number = defaultTerminationGraceMs,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> => {
  const grace = Number.isFinite(graceMs) ? Math.max(1, Math.trunc(graceMs)) : defaultTerminationGraceMs
  const pid = child.pid
  // A spawn that never became a process. Node reports the failure
  // asynchronously and leaves the handle with no pid, and it sets `exitCode`
  // to -2, so `terminateHandle`'s liveness check reads the handle as already
  // ended and this function used to answer `true`. That is a containment claim
  // for a child the host never reached: the caller renders "was terminated" for
  // something it never had. There is no group to signal and no exit to
  // observe, so the honest answer is that containment was not confirmed.
  if (pid === undefined) return false
  return platform === "win32" ? terminateHandle(child, grace) : terminateGroup(pid, grace)
}

/**
 * A successful detached launch.
 *
 * @category models
 * @since 1.0.0
 */
export interface Launched {
  readonly runId: string
  readonly logFile: string
  readonly pid: number | undefined
}

/**
 * A launch that never reached admission.
 *
 * @category models
 * @since 1.0.0
 */
export interface Rejected {
  readonly reason: string
  readonly tail: string
  readonly logFile: string
}

/**
 * Arguments accepted by {@link launch}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The project root; the log lands under its `.flows/logs`. */
  readonly root: string
  /** The serialized plan approval payload the child runs. */
  readonly payload: string
  /** Extra arguments handed to the child, such as `--remote`. */
  readonly passthrough?: ReadonlyArray<string> | undefined
  /** Cancellation owns the child until the admission result is handed back. */
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** The Node executable and CLI entry the child re-executes. */
  readonly execPath?: string | undefined
  readonly entry?: string | undefined
  readonly intervalMs?: number | undefined
  /**
   * Whether `runId` names a durable run row that belongs to this launch, read
   * from the parent's own control store. The log only nominates candidates;
   * this is the proof. `false` refuses the candidate for good: the child
   * announces only after the row commits, so an honest id is visible on its
   * first check. A rejected promise means the store could not answer, and the
   * candidate is asked again on the next poll.
   */
  readonly admission: (runId: string) => Promise<boolean>
  /** Grace given to each cleanup signal before admission ownership transfers. */
  readonly terminationGraceMs?: number | undefined
  /** Where a slow-boot notice goes; stderr in production. */
  readonly onSlowBoot?: ((message: string) => void) | undefined
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Launches an approved plan in a detached process and waits until an id it
 * announces is confirmed by {@link Options.admission}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const launch = async (options: Options): Promise<Launched | Rejected> => {
  options.signal?.throwIfAborted()
  const timeoutMs = Math.max(1, options.timeoutMs ?? defaultTimeoutMs)
  const maxWaitMs = timeoutMs * liveChildGraceMultiple
  const intervalMs = Math.max(1, options.intervalMs ?? pollIntervalMs)
  const nonce = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const directory = Project.logDirectory(options.root)
  mkdirSync(directory, { recursive: true })
  // The run id does not exist until the child is admitted, so the log opens
  // under the nonce and is renamed onto the run id afterwards. On POSIX the
  // child keeps writing through its open descriptor across the rename, so no
  // output is lost and no second file appears.
  const pending = join(directory, `pending-${nonce}.log`)
  const descriptor = openSync(pending, "a")

  let child: ChildProcess
  try {
    child = spawn(
      options.execPath ?? process.execPath,
      [options.entry ?? process.argv[1]!, "run", options.payload, ...(options.passthrough ?? [])],
      {
        cwd: options.root,
        detached: true,
        stdio: ["ignore", descriptor, descriptor],
        env: { ...(options.environment ?? process.env), [admissionVariable]: nonce }
      }
    )
  } finally {
    closeSync(descriptor)
  }
  // Keep the child referenced until admission or cleanup completes. An
  // interrupted CLI must remain alive long enough to escalate and reap it.
  let handedOff = false
  let termination: Promise<boolean> | undefined
  const cleanup = () => termination ??= terminate(child, options.terminationGraceMs)
  let wake = () => {}
  const onAbort = () => wake()
  let spawnError: Error | undefined
  const onError = (error: Error) => {
    spawnError = error
    wake()
  }
  child.on("error", onError)
  options.signal?.addEventListener("abort", onAbort, { once: true })

  const startedAt = Date.now()
  let notified = false
  // The log is scanned forward from the last offset, not re-read as a tail:
  // a chatty run can push the honest line out of any bounded tail between
  // two polls, and a forged line written after it must not be all that is
  // left to see. Refused ids stay refused; the store, not the log, decides.
  let scanned = 0
  let carry = ""
  const candidates: Array<string> = []
  const refused = new Set<string>()
  let lastVerifyError: unknown
  const refusal = (): string => {
    const named = [...refused].slice(0, 8).join(", ")
    const refusedText = refused.size === 0
      ? ""
      : ` The engine announced ${named}${
        refused.size > 8 ? ` and ${refused.size - 8} more` : ""
      }, but the control store holds no run for this launch's plan under ${
        refused.size === 1 ? "that id" : "those ids"
      }.`
    const errorText = lastVerifyError === undefined
      ? ""
      : ` The control store could not confirm admission: ${String(lastVerifyError)}.`
    return `${refusedText}${errorText}`
  }
  const nominate = (final: boolean) => {
    const read = readFrom(pending, scanned)
    scanned = read.next
    const text = carry + read.text
    // Only whole lines are parsed until the child is gone, so an id split
    // across two reads is never nominated by its prefix.
    const cut = final ? text.length : text.lastIndexOf("\n") + 1
    carry = text.slice(cut).slice(-carryBytes)
    for (const runId of announcedRunIds(text.slice(0, cut), nonce)) {
      if (!candidates.includes(runId)) candidates.push(runId)
    }
  }
  const confirmed = async (final: boolean): Promise<string | undefined> => {
    nominate(final)
    for (const runId of candidates) {
      if (refused.has(runId)) continue
      try {
        if (await options.admission(runId)) return runId
        refused.add(runId)
      } catch (error) {
        lastVerifyError = error
      }
    }
    return undefined
  }
  try {
    for (;;) {
      if (options.signal?.aborted) {
        return { reason: "Detached launch interrupted before admission.", tail: logTail(pending), logFile: pending }
      }
      if (spawnError !== undefined) throw spawnError
      const exited = child.exitCode !== null || child.signalCode !== null
      const runId = await confirmed(exited)
      // The readiness proof wins over a later child exit: once the run row is
      // durable, a child that dies afterwards is the stale-run sweep's
      // problem, not the launcher's.
      if (runId !== undefined) {
        const file = Project.logFile(options.root, runId)
        // A run id can arrive at a path that already holds a log — a resumed
        // run keeps its id, and so does anything that replays one. Renaming
        // straight over it destroyed the earlier run's only record. Move it
        // aside under this launch's nonce instead: the receipt still names the
        // canonical path, and nothing an operator may still be reading is
        // deleted to get there.
        if (existsSync(file)) renameSync(file, join(directory, `${runId}.superseded-${nonce}.log`))
        renameSync(pending, file)
        handedOff = true
        child.unref()
        return { runId, logFile: file, pid: child.pid }
      }
      const tail = logTail(pending)
      if (exited) {
        const status = child.signalCode === null ? `exit ${child.exitCode}` : `signal ${child.signalCode}`
        return {
          reason: `Detached engine exited before admission (${status}).${refusal()}`,
          tail,
          logFile: pending
        }
      }
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs >= maxWaitMs) {
        const terminated = await cleanup()
        return {
          reason: `Detached engine did not reach admission within ${maxWaitMs}ms. The engine process (pid ${
            child.pid ?? "unknown"
          }) was still alive and ${
            terminated ? "was terminated" : "could not be confirmed terminated"
          }.${refusal()} Set SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS to raise the window.`,
          tail,
          logFile: pending
        }
      }
      if (elapsedMs >= timeoutMs && !notified) {
        notified = true
        const notify = options.onSlowBoot ??
          ((line: string) => {
            process.stderr.write(`${line}\n`)
          })
        notify(
          `smthrs: detached engine (pid ${child.pid ?? "unknown"}) is still booting after ${
            Math.round(elapsedMs / 1000)
          }s; waiting up to ${Math.round(maxWaitMs / 1000)}s.`
        )
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(intervalMs, maxWaitMs - elapsedMs))
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
        // onSlowBoot can synchronously abort the launch before this wait.
        if (options.signal?.aborted) wake()
      })
    }
  } catch (error) {
    return {
      reason: `Detached launch failed before admission: ${String(error)}`,
      tail: logTail(pending),
      logFile: pending
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    wake()
    if (!handedOff) await cleanup()
    child.removeListener("error", onError)
  }
}

/**
 * Removes a rejected launch's pending log.
 *
 * @category destructors
 * @since 1.0.0
 */
export const discard = (rejected: Rejected): void => {
  try {
    unlinkSync(rejected.logFile)
  } catch {
    // A log that is already gone needs no cleanup.
  }
}

/**
 * Whether a `Launched` was produced, as opposed to a `Rejected`.
 *
 * @category guards
 * @since 1.0.0
 */
export const isLaunched = (result: Launched | Rejected): result is Launched => "runId" in result
