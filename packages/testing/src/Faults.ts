/**
 * Machine-global fault primitives: real process kills, and a skewed wall clock.
 *
 * Nothing here simulates a fault. `killProcess` sends a real signal to a real
 * pid and refuses to return until the operating system has reaped it, so a
 * suite can never claim it injected a fault against a process that was already
 * dead. The orphan helpers answer the question a kill leaves behind: a child
 * the killed process started is reparented to init, and a runtime that claims
 * containment has to be the thing that reaps it. `skewClock` moves the clock a
 * durable timer is measured against, which is the only way to observe what a
 * restarted host does with a deadline that has already passed.
 *
 * Both are process-global, which is why a suite built on them declares itself
 * a fault tier — `Smithers.FaultSuite`, `vitest.faults.config.ts`, no file
 * parallelism — instead of sitting beside a package's unit tests. They live
 * here rather than in each package that injects faults so there is one
 * implementation of "the process is really gone" for every one of them.
 *
 * @since 1.0.0
 */

import * as ProcessTable from "./ProcessTable.ts"

const pollIntervalMs = 25
const defaultTimeoutMs = 5_000
const OriginalDate = globalThis.Date
const originalNow = OriginalDate.now

/**
 * Whether a positive integer pid names a live process. Invalid pids return false.
 *
 * Signal 0 performs the permission and existence check without delivering
 * anything. `ESRCH` is the only answer that means "gone"; `EPERM` means the
 * process exists and belongs to somebody else.
 *
 * @since 1.0.0
 * @category refinements
 */
export const isAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * Whether a process group still has a member.
 *
 * Accepts a positive integer group id and negates it to address the whole
 * group, which is the unit `NodeRuntime.layerHost` containment works in.
 * Invalid group ids return false.
 *
 * @since 1.0.0
 * @category refinements
 */
export const isGroupAlive = (pgid: number): boolean => {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * The parent pid the operating system currently records for `pid`, or
 * `undefined` when the process is gone.
 *
 * This is the orphan test. A child whose parent was killed is reparented, and
 * on macOS and Linux the new parent is pid 1 (or a subreaper). A fault suite
 * that asserts containment has to read this rather than assume it.
 *
 * @since 1.0.0
 * @category getters
 */
export const parentPid = (pid: number): number | undefined => {
  const output = ProcessTable.query({ pid, columns: ["ppid"] }).trim()
  const parsed = Number(output.split(/\s+/)[0])
  /* v8 ignore next -- a selected pid yields one numeric parent or an empty row. */
  return output.length === 0 || !Number.isFinite(parsed) ? undefined : parsed
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits until `predicate` holds, or fails with `label` in the message.
 *
 * @since 1.0.0
 * @category utils
 */
export const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = defaultTimeoutMs
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(pollIntervalMs)
  }
}

/**
 * Waits until the operating system has reparented `pid` away from `expected`,
 * and returns the parent it settled on.
 *
 * Reparenting is not instantaneous: the kernel moves the child when the old
 * parent is reaped, which is after the signal is delivered. A suite that reads
 * `parentPid` once races that.
 *
 * @since 1.0.0
 * @category getters
 */
export const waitForReparent = async (
  pid: number,
  expected: number,
  timeoutMs = defaultTimeoutMs
): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const parent = parentPid(pid)
    if (parent === undefined) throw new Error(`pid ${pid} exited before it could be reparented`)
    if (parent !== expected) return parent
    if (Date.now() >= deadline) {
      throw new Error(`pid ${pid} still reports parent ${expected} after ${timeoutMs}ms`)
    }
    await sleep(pollIntervalMs)
  }
}

/**
 * Sends `signal` to a positive integer pid and waits for it to leave.
 * Invalid pids reject before any signal is sent.
 *
 * A pid that is already dead is an error rather than a no-op: the test that
 * called this believed it was injecting a fault, and it was not.
 *
 * @since 1.0.0
 * @category constructors
 */
export const killProcess = async (
  handle: { readonly pid?: number | undefined },
  signal: NodeJS.Signals = "SIGKILL",
  timeoutMs = defaultTimeoutMs
): Promise<void> => {
  const pid = handle.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`killProcess: invalid pid ${String(pid)}`)
  }
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      throw new Error(`killProcess: pid ${pid} was already dead, so ${signal} injected nothing`)
    }
    throw error
  }
  await waitFor(() => !isAlive(pid), `pid ${pid} to exit after ${signal}`, timeoutMs)
}

/**
 * Kills a whole process group, used to clean up what a test deliberately
 * orphaned. Invalid group ids are a no-op; valid ids must be positive integers.
 * Never throws: this is teardown.
 *
 * @since 1.0.0
 * @category constructors
 */
export const killGroup = (pgid: number, signal: NodeJS.Signals = "SIGKILL"): void => {
  if (!Number.isInteger(pgid) || pgid <= 0) return
  try {
    process.kill(-pgid, signal)
  } catch {
    // Already gone; teardown has nothing left to do.
  }
}

/**
 * A live clock skew.
 *
 * @since 1.0.0
 * @category models
 */
export interface SkewedClock {
  /** The skewed instant, in milliseconds. */
  readonly now: () => number
  /** Moves the skew further forward. */
  readonly advance: (ms: number) => void
  /** Puts the real clock back. Idempotent. */
  readonly restore: () => void
}

/**
 * Skews `Date.now`, `Date()`, and bare `new Date()` by `skewMs` for this process.
 * Each skew is relative to the real clock. Restoring any live handle reinstalls
 * the module's original Date and Date.now, regardless of restoration order.
 *
 * @since 1.0.0
 * @category constructors
 */
export const skewClock = (skewMs: number): SkewedClock => {
  let skew = skewMs
  let restored = false

  const now = (): number => originalNow.call(OriginalDate) + skew

  const SkewedDate = new Proxy(OriginalDate, {
    apply: () => new OriginalDate(now()).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget)
  })

  OriginalDate.now = now
  globalThis.Date = SkewedDate

  return {
    now,
    advance: (ms) => {
      skew += ms
    },
    restore: () => {
      if (restored) return
      restored = true
      OriginalDate.now = originalNow
      globalThis.Date = OriginalDate
    }
  }
}
