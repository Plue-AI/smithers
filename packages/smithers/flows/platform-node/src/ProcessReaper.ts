/**
 * Reaping the processes a dead host incarnation abandoned.
 *
 * Scope closure cleans up work a live host still owns. On POSIX, a prepared
 * supervisor also receives private-channel EOF when its host disappears and
 * independently requests group cleanup. The durable ledger remains the fallback
 * when that cleanup is incomplete or cannot be verified; the next incarnation
 * uses this module to examine the recorded process identities before acting.
 *
 * The rules are narrow on purpose, because the input is a durable record that
 * outlived the process that wrote it and a pid is reused. A record is signalled
 * only when ALL of these hold:
 *
 * - it belongs to a DIFFERENT incarnation of the SAME `hostId`
 *   ({@link ProcessLedger.Service.orphans} already filters that);
 * - its owner is gone. A pid that exists but belongs to another user counts as
 *   alive, exactly as {@link HostLiveness} counts it, so only `ESRCH` reads as
 *   dead and every other answer keeps the record;
 * - it names a target the platform can actually signal. On POSIX that is a
 *   process group the child leads itself, so `pgid` has to be a safe integer
 *   above 1 and equal to `pid`; on Windows it is a pid, so `pgid` has to be
 *   absent. The check is made against the DURABLE record rather than trusted
 *   from it: `process.kill(-0, "SIGKILL")` signals this host's own process
 *   group, and `@smthrs/kernel`'s ledger schema admits zero;
 * - that group is not THIS process's group, and its pid is not this process's
 *   pid. The host's real process group is read from the operating system,
 *   because a stored number can claim anything and the shell that started this
 *   host shares its group. A host that cannot read its own group keeps the
 *   record rather than signalling it on a guard that did not run;
 * - the number still names the process the record describes. A record written
 *   before this machine booted names a pid from a pid space that no longer
 *   exists, and within one boot the recorded start time has to match the start
 *   time the operating system reports for that pid. A host that cannot ASK the
 *   question answers {@link StartTime} `unavailable`, which refuses the kill
 *   and keeps the record; no evidence never authorizes a signal.
 *
 * The outcome of the signal is part of the record. A kill that succeeds, or
 * that reports the group is already gone, retires the record through
 * {@link ProcessLedger.Service.reaped}; a kill that FAILS for any other reason
 * leaves the record inherited so the next incarnation tries again. A record
 * refused on grounds the operating system will not revisit — a number no
 * platform can signal, a pid that is gone, a start time that does not match — is
 * retired through {@link ProcessLedger.Service.skipped}, which says in the
 * journal that nothing was signalled and stops every later incarnation
 * re-examining a number the operating system has moved on from. The three
 * refusals a later incarnation CAN answer differently — `owner-alive`,
 * `identity-unverified`, and `own-group-unknown` — retire nothing.
 *
 * @since 0.1.0
 */
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { uptime } from "node:os"
import { parse } from "node:path"
import { packageRoot, resolveDefaultExecutable } from "./internal/AtomicFileSystemExecutable.ts"
import { usableExecutable } from "./internal/AtomicFileSystemTransport.ts"
import * as PipedProcess from "./internal/PipedProcess.ts"
import * as ProcessCleanup from "./internal/ProcessCleanup.ts"
import * as ProcSnapshot from "./internal/ProcSnapshot.ts"

/**
 * What the operating system can say about a pid.
 *
 * `unknown` is not `dead`. A pid this host may not signal answers `EPERM`, and
 * a reaper that read that as "gone" would kill another user's children on the
 * strength of a record it cannot verify.
 *
 * @category models
 * @since 0.1.0
 */
export type Liveness = "alive" | "dead" | "unknown"

/**
 * What happened when a process group was signalled.
 *
 * @category models
 * @since 0.1.0
 */
export type KillOutcome =
  /** The signal was delivered. */
  | "signalled"
  /** There was nothing left to signal, which is the same end state. */
  | "already-gone"
  /** The signal was refused, and the record must be tried again later. */
  | "failed"

/**
 * What the operating system can say about when a pid started.
 *
 * The three negative answers are deliberately distinct, because they authorize
 * three different decisions. `gone` is evidence — the pid does not exist, so
 * the record describes nothing and is retired unsignalled. `unavailable` is the
 * ABSENCE of evidence: `ps` is missing, unanswerable, or printed something no
 * clock can read, so the record is kept for an incarnation that can ask.
 * `unsupported` is a platform that has no such column at all, which falls back
 * to the boot-time comparison alone.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type StartTime =
  /** The operating system reports this start time, in epoch milliseconds. */
  | { readonly _tag: "started"; readonly startedAtMs: number }
  /** The pid names no process. */
  | { readonly _tag: "gone" }
  /** The question could not be asked on this host. */
  | { readonly _tag: "unavailable" }
  /** The platform has no start-time column at all. */
  | { readonly _tag: "unsupported" }

/**
 * The operating-system operations reaping needs.
 *
 * It is a seam, not an abstraction: `flows` ships exactly the two
 * implementations below and a test drives the Windows one on a POSIX host,
 * which is the only way that path is ever exercised in this repository.
 *
 * @category models
 * @since 0.1.0
 */
export interface System {
  /** Whether a pid names a process that still exists. */
  readonly isAlive: (pid: number) => Liveness
  /** When the process behind a pid started. */
  readonly startedAtMs: (pid: number) => StartTime
  /** The process group THIS process belongs to, or `null` where there are none. */
  readonly ownGroup: () => number | null
  /** When this machine booted, in epoch milliseconds. */
  readonly bootedAtMs: () => number
  /**
   * Whether the numbers in a record name something this platform may signal,
   * checked before any other guard consults them.
   */
  readonly refuseTarget: (record: ProcessLedger.ProcessRecord) => Refusal | undefined
  /** Ends an abandoned process and everything below it. */
  readonly killTree: (record: ProcessLedger.ProcessRecord) => KillOutcome
}

const errorCode = (cause: unknown): string | undefined => (cause as { readonly code?: string } | null)?.code

const liveness = (pid: number): Liveness => {
  try {
    // Signal 0 delivers nothing; it only asks whether the pid is signalable.
    process.kill(pid, 0)
    return "alive"
  } catch (cause) {
    // ESRCH is the only answer that means gone. EPERM means the process
    // exists and belongs to another user; anything else is a question this
    // host could not ask, and both keep the record rather than kill on it.
    return errorCode(cause) === "ESRCH" ? "dead" : "unknown"
  }
}

const bootedAtMs = (): number => Date.now() - Math.round(uptime() * 1000)

/**
 * The start time `ps` reports for a pid.
 *
 * `lstart` is the one start-time column both BSD (macOS) and procps (Linux)
 * spell the same way, and it prints an absolute time rather than an elapsed
 * one, so the answer does not drift between reading it and comparing it. It is
 * also a LOCALIZED column, so the probe pins `LC_ALL=C` and `TZ=UTC`.
 * Its text has no zone; parsing explicitly as UTC keeps the identity independent
 * of the host runtime's timezone.
 */
const startedAtMs = (executable: string) => (pid: number): StartTime => {
  const answer = ps(executable, "lstart", pid)
  if (answer._tag === "gone") {
    // A nonzero exit is `ps` saying the pid does not exist, but it is also what
    // a `ps` that rejected the column, or one that is not the `ps` this probe
    // expects, says about a pid that is very much alive. The kernel is asked
    // directly before a live process is retired as gone.
    return liveness(pid) === "dead" ? answer : { _tag: "unavailable" }
  }
  if (answer._tag !== "printed") return answer
  const parsed = Date.parse(`${answer.text} UTC`)
  return Number.isNaN(parsed) ? { _tag: "unavailable" } : { _tag: "started", startedAtMs: parsed }
}

/**
 * The absolute path the process probe is run from.
 *
 * Never a `PATH` lookup. The inherited environment belongs to whoever started
 * this host, and a planted `ps` that prints a fabricated start time — or none
 * at all — would decide whether a `SIGKILL` is authorized.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultPsExecutable = "/bin/ps"

/** How long the probe may take before it counts as an answer nobody gave. */
const psTimeoutMs = 5000

/** A live-release probe has its own short bound within the shutdown deadline. */
const cleanupProbeTimeoutMs = 2000

/**
 * One fixed-path snapshot supplies group membership, start identities and our
 * own group together. Only numeric fields and C-locale lstart are read; command
 * text and the caller's PATH never influence signal authority.
 */
const psGroupSnapshot = (pgid: number): ProcessCleanup.Snapshot | undefined => {
  const result = spawnSync(defaultPsExecutable, ["-A", "-o", "pid=,pgid=,stat=,lstart="], {
    encoding: "utf8",
    timeout: cleanupProbeTimeoutMs,
    killSignal: "SIGKILL",
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" }
  })
  if (result.error !== undefined || result.signal !== null || result.status !== 0) return undefined
  let own: number | undefined
  const members: Array<ProcessCleanup.Member> = []
  for (const line of result.stdout.trim().split("\n")) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s+(.+)$/.exec(line)
    if (match === null) return undefined
    const pid = Number(match[1])
    const group = Number(match[2])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group)) return undefined
    if (pid === process.pid) own = group
    if (group !== pgid) continue
    const started = Date.parse(`${match[4]!} UTC`)
    if (Number.isNaN(started)) return undefined
    members.push({ pid, startedAtMs: started, zombie: match[3]!.startsWith("Z") })
  }
  return own === undefined || own <= 0 ? undefined : { ownGroup: own, members }
}

/**
 * The observation the supervisor polls, from the source that platform has.
 *
 * Linux publishes the whole process table as files under `/proc`, which is
 * where `ps` itself reads it, so the kernel is asked directly. That needs no
 * `procps` in the image, cannot be answered by a planted binary, and costs no
 * fork on a poll that runs every 10ms. A missing `/bin/ps` is not a
 * hypothetical: `procps` is not in `debian:bookworm-slim`, and on Cloud CI run
 * 11727 every spawned target in every task finished its work and then failed
 * cleanup verification with `Unknown: ChildProcess.kill`, because this
 * observation could not be made.
 *
 * Every other POSIX host keeps the `ps` reading, which is the only portable
 * spelling of this question off Linux.
 *
 * @category constructors
 * @since 1.0.0
 */
export const groupSnapshotFor = (platform: string): (pgid: number) => ProcessCleanup.Snapshot | undefined =>
  platform === "linux" ? ProcSnapshot.snapshot(ProcSnapshot.defaultProcRoot) : psGroupSnapshot

/**
 * Whether the kernel reports no process at all in a group.
 *
 * Signal 0 delivers nothing; it only asks the kernel whether the group has a
 * member. `ESRCH` is the one answer that proves the group empty, with no fork
 * and no process table to parse, so it still answers on a loaded host where a
 * `ps` snapshot cannot be taken. A live member, a zombie (macOS answers
 * `EPERM`, Linux succeeds), another user's member or any other error answers
 * `false`, which leaves the question to the snapshot.
 *
 * @category constructors
 * @since 1.0.0
 */
export const groupVacant = (pgid: number): boolean => {
  // kill(0) and kill(-1) address the caller's group and every process.
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false
  try {
    process.kill(-pgid, 0)
    return false
  } catch (cause) {
    return errorCode(cause) === "ESRCH"
  }
}

/**
 * Live cleanup for Node and Bun contained spawners.
 *
 * A trusted supervisor remains the group owner after the target exits. It
 * enforces cleanup on target completion, parent loss and explicit release; the
 * target starts only after its owner is durably recorded. Host observations
 * never signal a pid: they only shorten the owner's deadline or verify an empty
 * group before retiring its record. Failed verification retains the record.
 *
 * @category constructors
 * @since 1.0.0
 */
export const processLifecycle = ProcessCleanup.lifecycle({
  platform: process.platform,
  snapshot: groupSnapshotFor(process.platform),
  vacant: groupVacant
})

/**
 * The default grace period for a contained host spawner.
 *
 * The platform is always the running platform; callers cannot describe a
 * Windows ledger identity for a process that actually leads a POSIX group.
 * @category models
 * @since 1.0.0
 */
export type SpawnerOptions = Omit<ContainedSpawner.Options, "platform">

/**
 * Provides a ledger-backed spawner with this platform's prepared cleanup.
 *
 * Native pipe listeners live until their descriptors close, including writes
 * interrupted by owner loss. The kernel expands pipelines before this private
 * standard-command adapter is called. Windows owners join a native job before
 * activation; POSIX owners enforce their process-group cleanup deadline.
 *
 * The caller supplies the durable or in-memory ledger. This layer records new
 * owners; {@link layer} separately reaps
 * records inherited from a previous host incarnation.
 * @category layers
 * @since 1.0.0
 */
export const layerSpawner = (
  options?: SpawnerOptions
): Layer.Layer<ChildProcessSpawner, never, ProcessLedger.ProcessLedger> => {
  const contained = ContainedSpawner.layer({ graceMs: options?.graceMs, platform: process.platform }, processLifecycle)
  const standard = makeSpawner((command) =>
    PipedProcess.spawn(command as ChildProcess.StandardCommand, undefined, true)
  )
  return Layer.provide(contained, Layer.succeed(ChildProcessSpawner)(standard))
}

/** A whole number and nothing else, which is all a `pgid` column may be. */
const decimal = /^[0-9]+$/

/**
 * One `ps` column for one pid.
 *
 * `printed` is an answer; every other tag is the absence of one. A nonzero exit
 * with no error is `ps` saying the pid does not exist, which is evidence; a
 * spawn that failed, a signal, or a timeout is not.
 */
const ps = (
  executable: string,
  column: string,
  pid: number
): { readonly _tag: "printed"; readonly text: string } | StartTime => {
  const result = spawnSync(executable, ["-o", `${column}=`, "-p", String(pid)], {
    encoding: "utf8",
    timeout: psTimeoutMs,
    // `SIGKILL` rather than the default `SIGTERM`, because this call blocks the
    // event loop while a host is being built: `spawnSync` keeps waiting past
    // the deadline for a process that ignores the signal, so a `TERM` the probe
    // can decline is not a deadline at all.
    killSignal: "SIGKILL",
    // An empty-ish environment for the same reason the helper in
    // `AtomicFileSystem` gets one: nothing the caller exported may change what
    // this answers. Pin both the column's spelling and its timezone; the parser
    // supplies UTC explicitly because `lstart` does not print a zone.
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" }
  })
  if (result.error !== undefined || result.signal !== null || result.status === null) {
    return { _tag: "unavailable" }
  }
  if (result.status !== 0) return { _tag: "gone" }
  const printed = result.stdout.trim()
  return printed === "" ? { _tag: "unavailable" } : { _tag: "printed", text: printed }
}

/**
 * This process's own process group.
 *
 * Node exposes no `getpgrp`, so the answer comes from `ps`, which both BSD and
 * procps spell `pgid`. A host that cannot read it answers `null` and loses one
 * guard, which is why the pid comparison below is kept as well.
 *
 * The text is required to be one run of decimal digits naming a real group,
 * rather than run through `Number.parseInt`, which reads a PREFIX: `"12 34"`,
 * `"12abc"`, and `"0x10"` all become a number that is not this host's group. A
 * wrong number is worse here than no number at all. It silently passes the
 * own-group comparison in {@link refuse}, and because it is not `null` it also
 * suppresses the `own-group-unknown` refusal that exists to say the comparison
 * could not be made, so the guard neither runs nor reports that it did not run
 * and a `SIGKILL` goes out on it. Anything else answers `null`, which refuses.
 */
const ownGroup = (executable: string) => (): number | null => {
  const answer = ps(executable, "pgid", process.pid)
  if (answer._tag !== "printed") return null
  if (!decimal.test(answer.text)) return null
  const parsed = Number(answer.text)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * How a {@link System} asks the operating system its questions, and whose
 * identity it must never signal.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface SystemOptions {
  /**
   * The absolute `ps` the identity probe runs. Default
   * {@link defaultPsExecutable}. It is configuration for a host that installs
   * `ps` somewhere else, and the seam the probe's own parsing is driven
   * through; it is never a `PATH` lookup. Windows has no such probe and
   * ignores it.
   */
  readonly psExecutable?: string | undefined
  /** Absolute native helper for Windows process identity queries; never a PATH lookup. */
  readonly processExecutable?: string | undefined
  /**
   * The pid this system must never signal, nor signal the group of. Default
   * `process.pid`. {@link Options.ownerPid} is the same identity at the sweep
   * level; this one is what {@link System.killTree} enforces on its own,
   * because that function is exported and a caller can reach it without going
   * through {@link reap}.
   */
  readonly ownerPid?: number | undefined
}

/**
 * Whether a durable record names a POSIX process group this host may signal.
 *
 * `process.kill(-pgid, ...)` turns the stored number into a target directly, so
 * every value that is not a real foreign group has to be refused before it gets
 * there: `0` signals THIS process's group, a negative value stops naming a
 * group at all and names a single pid, and a `pgid` that differs from `pid`
 * describes a child that does not lead the group it claims —
 * `ContainedSpawner.groupOf` writes `pgid === pid` for every detached POSIX
 * child, so anything else is a record no writer in this repository produced.
 */
const refusePosixTarget = (record: ProcessLedger.ProcessRecord): Refusal | undefined => {
  if (record.pgid === null) return "no-group"
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1) return "invalid-record"
  if (!Number.isSafeInteger(record.pgid) || record.pgid <= 1) return "invalid-record"
  return record.pgid === record.pid ? undefined : "invalid-record"
}

/**
 * Whether a durable record names a Windows process tree this host may signal.
 *
 * Windows has no process groups, so `ContainedSpawner.groupOf` records `null`
 * there and `taskkill /T` walks the tree from the pid instead. A win32 record
 * carrying a number is therefore a record some other platform wrote.
 */
const refuseWindowsTarget = (record: ProcessLedger.ProcessRecord): Refusal | undefined => {
  if (record.pgid !== null) return "invalid-record"
  return Number.isSafeInteger(record.pid) && record.pid > 1 && record.pid <= 0xffff_ffff ? undefined : "invalid-record"
}

/**
 * Reaping on a POSIX host, with the identity probe configured.
 *
 * The group is killed outright rather than asked politely first. `SIGTERM`
 * buys a graceful shutdown only when someone is left to wait for it, and the
 * incarnation that owned these processes is by definition gone.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const posixSystemWith = (options?: SystemOptions): System =>
  posixSystemFrom({
    startedAtMs: startedAtMs(options?.psExecutable ?? defaultPsExecutable),
    ownGroup: ownGroup(options?.psExecutable ?? defaultPsExecutable),
    bootedAtMs
  }, options?.ownerPid ?? process.pid)

/**
 * Where a Linux {@link System} reads the process table, and whose identity it
 * must never signal.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface ProcSystemOptions {
  /** The `/proc` mount the probes read. Default `/proc`. */
  readonly procRoot?: string | undefined
  /** The pid this system must never signal, nor signal the group of. Default `process.pid`. */
  readonly ownerPid?: number | undefined
}

/**
 * Reaping on Linux, with every identity question read from `/proc` rather
 * than from `ps`.
 *
 * `procps` is not in `debian:bookworm-slim` (Cloud CI run 11727), and a
 * `ps`-based reaper on such a host can read neither its own group nor any
 * start time, so it refuses every orphan as `own-group-unknown` on every
 * restart. The live-cleanup observation ({@link groupSnapshotFor}) already
 * reads `/proc` for the same reason; this is the crash-recovery half.
 *
 * A pid with no `/proc/<pid>/stat` is `gone` only when the kernel also says so,
 * because a `hidepid` mount hides another user's live process the same way.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const procSystemWith = (options?: ProcSystemOptions): System => {
  const root = options?.procRoot ?? ProcSnapshot.defaultProcRoot
  const readStart = ProcSnapshot.startedAtMs(root)
  return posixSystemFrom({
    startedAtMs: (pid) => {
      const answer = readStart(pid)
      return answer._tag === "gone" && liveness(pid) !== "dead" ? { _tag: "unavailable" } : answer
    },
    ownGroup: ProcSnapshot.ownGroup(root),
    bootedAtMs: () => ProcSnapshot.bootMs(root) ?? bootedAtMs()
  }, options?.ownerPid ?? process.pid)
}

/** The POSIX kill path over whichever probes the platform answers with. */
const posixSystemFrom = (
  probes: Pick<System, "startedAtMs" | "ownGroup" | "bootedAtMs">,
  ownerPid: number
): System => {
  const readOwnGroup = probes.ownGroup
  return {
    isAlive: liveness,
    startedAtMs: probes.startedAtMs,
    ownGroup: readOwnGroup,
    bootedAtMs: probes.bootedAtMs,
    refuseTarget: refusePosixTarget,
    killTree: (record) => {
      // Repeated here and not only in `refuse`: this function is exported, and
      // the negation below is the one place a stored number becomes a signal.
      if (refusePosixTarget(record) !== undefined) return "failed"
      // The host's own identity, repeated for the same reason. `refuse` holds
      // one `ownGroup` reading for the whole sweep; a caller that reaches this
      // function directly has made no such reading, and `process.kill(-pgid)`
      // does not care which way the number arrived. A group that cannot be
      // read is a comparison that did not happen, so nothing is signalled.
      if (record.pid === ownerPid || record.pgid === ownerPid) return "failed"
      const group = readOwnGroup()
      if (group === null || record.pid === group || record.pgid === group) return "failed"
      try {
        process.kill(-(record.pgid as number), "SIGKILL")
        return "signalled"
      } catch (cause) {
        // The group settled between the liveness check and the signal: the end
        // state is the one that was wanted. Anything else is a kill that did NOT
        // happen, and saying so is what gets the record tried again.
        return errorCode(cause) === "ESRCH" ? "already-gone" : "failed"
      }
    }
  }
}

/**
 * Reaping on a POSIX host: one `SIGKILL` to the abandoned process group, with
 * the identity probe at {@link defaultPsExecutable}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const posixSystem: System = posixSystemWith()

/**
 * Reaping on Windows, with the identity the sweep must never signal
 * configured.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const windowsSystemWith = (options?: SystemOptions): System => {
  const ownerPid = options?.ownerPid ?? process.pid
  const startedAtMs = (pid: number): StartTime => {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0xffff_ffff) return { _tag: "unavailable" }
    try {
      const configured = options?.processExecutable ?? process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
      const executable = configured === undefined
        ? resolveDefaultExecutable(packageRoot, undefined)
        : usableExecutable(configured, undefined)
      const result = spawnSync(executable, ["--process-info", String(pid)], {
        cwd: parse(process.execPath).root,
        env: {},
        encoding: "utf8",
        timeout: psTimeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4096
      })
      if (result.error !== undefined || result.signal !== null || result.status !== 0) return { _tag: "unavailable" }
      const value = JSON.parse(result.stdout) as { readonly status?: unknown; readonly startedAtMs?: unknown } | null
      if (value?.status === "gone") return { _tag: "gone" }
      return value?.status === "started" && typeof value.startedAtMs === "number" &&
          Number.isSafeInteger(value.startedAtMs) && value.startedAtMs >= 0
        ? { _tag: "started", startedAtMs: value.startedAtMs }
        : { _tag: "unavailable" }
    } catch {
      return { _tag: "unavailable" }
    }
  }
  return {
    isAlive: liveness,
    startedAtMs,
    ownGroup: () => null,
    bootedAtMs,
    refuseTarget: (record) => record.pid === ownerPid ? "own-group" : refuseWindowsTarget(record),
    killTree: (record) => {
      if (refuseWindowsTarget(record) !== undefined) return "failed"
      // `taskkill /T` walks the tree DOWN from the pid it is given, so a record
      // naming this host takes the host and everything it started with it.
      if (record.pid === ownerPid) return "failed"
      const result = spawnSync("taskkill", ["/pid", String(record.pid), "/T", "/F"], { stdio: "ignore" })
      if (result.error !== undefined) return "failed"
      // 128 is `taskkill`'s "no such process", which is the same end state a
      // successful kill produces.
      if (result.status === 0) return "signalled"
      return result.status === 128 ? "already-gone" : "failed"
    }
  }
}

/**
 * Reaping on Windows, which has no process groups: `taskkill /T /F` by pid.
 *
 * **Windows is outside the 1.0.0-rc.0 support contract**
 * (`docs/pages/installation.md`). Full Windows process containment remains
 * under verification. It is kept — and reachable through {@link reap} rather than only
 * by calling it directly — because a reaper that silently retired every win32
 * record would be the "excluded feature that appears to work partially" the
 * release policy forbids. Treat it as unsupported best-effort.
 *
 * The packaged native helper reads creation time from a pinned process handle.
 * A missing helper, malformed reply, or denied query keeps the durable record
 * for retry. Windows has no process groups, so own-group refusal uses the pid.
 *
 * @category constructors
 * @since 0.1.0
 */
export const windowsSystem: System = windowsSystemWith()

/**
 * Reaping on Linux from the kernel's own `/proc`.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const procSystem: System = procSystemWith()

/**
 * Selects the reaping implementation a platform needs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const systemFor = (platform: string): System =>
  platform === "win32" ? windowsSystem : platform === "linux" ? procSystem : posixSystem

/**
 * How far apart a recorded start time and the operating system's may be and
 * still describe the same process.
 *
 * `lstart` has one-second granularity and the ledger writes its record just
 * after the spawn returns, so the two never agree exactly. Two seconds covers
 * the gap; a pid the operating system handed to somebody else is minutes or
 * hours away from it, not milliseconds.
 *
 * @category models
 * @since 0.1.0
 */
export const identityToleranceMs = 2000

/**
 * Reaper configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The pid this host must never signal a group for. Default `process.pid`. */
  readonly ownerPid?: number | undefined
  /** The operating-system seam. Default {@link systemFor} of `process.platform`. */
  readonly system?: System | undefined
}

/**
 * Why a record was not signalled.
 *
 * @category models
 * @since 0.1.0
 */
export type Refusal =
  /** The incarnation that started it is still running and will contain it. */
  | "owner-alive"
  /** It shared its owner's process group, so there is no group to signal. */
  | "no-group"
  /** It named this host's own process group or pid. */
  | "own-group"
  /** This host could not read its OWN process group, so it cannot rule that out. */
  | "own-group-unknown"
  /** Its numbers do not name anything this platform may signal. */
  | "invalid-record"
  /** It was written before this machine booted, so the pid space is not the same. */
  | "pre-boot"
  /** The pid it names does not exist, so there is no identity to confirm. */
  | "process-gone"
  /** The pid exists but did not start when the record says it did. */
  | "identity-mismatch"
  /** This host could not ask when the pid started, so it must not signal it. */
  | "identity-unverified"
  /** The signal was refused, so the record stays for the next incarnation. */
  | "kill-failed"

/**
 * The refusals that leave a record inherited instead of retiring it.
 *
 * A refusal is final when the operating system has moved on from the number:
 * saying so in the journal is what stops every later incarnation re-examining
 * it. These three are not final. `owner-alive` means the incarnation that owns
 * the record will contain its own children; `identity-unverified` and
 * `own-group-unknown` mean this host could not ask a question at all — a host
 * that CAN ask has to get the chance.
 */
const retained: ReadonlySet<Refusal> = new Set<Refusal>([
  "owner-alive",
  "identity-unverified",
  "own-group-unknown"
])

/**
 * One record, and what the reaper decided about it.
 *
 * The two outcomes are a union rather than one shape with an optional field so
 * that `killed` narrows the reason: after `if (!entry.killed)` the
 * {@link Refusal} is there to read, and a killed record cannot be built
 * carrying a reason it never had. The runtime objects are unchanged — a killed
 * entry simply omits `refusal`.
 *
 * @category models
 * @since 0.1.0
 */
export type Reaped =
  | {
    readonly record: ProcessLedger.ProcessRecord
    readonly killed: true
    /** Never present when `killed` is `true`. */
    readonly refusal?: never
  }
  | {
    readonly record: ProcessLedger.ProcessRecord
    readonly killed: false
    /** Present exactly when `killed` is `false`. */
    readonly refusal: Refusal
  }

/** The identity half of the decision, split out because it reads as a list. */
const refuseOnIdentity = (
  system: System,
  record: ProcessLedger.ProcessRecord,
  bootMs: number
): Refusal | undefined => {
  // A record older than this boot names a pid from a pid space that no longer
  // exists. The tolerance points BACKWARDS from the boot instant on purpose:
  // `uptime` is second-granular, so a record written moments after boot could
  // otherwise be read as predating it, and refusing to kill is the safe way to
  // be wrong.
  //
  // The consequence is a narrow, deliberate leak, and it is a leak rather than
  // a retry: `reap` retires a `pre-boot` refusal through `ledger.skipped`, so a
  // group spawned within `identityToleranceMs` of the computed boot instant is
  // never reaped by any later incarnation either. That is the price of refusing
  // to kill on an instant `uptime` can only place to the nearest second.
  if (record.startedAtMs < bootMs + identityToleranceMs) return "pre-boot"
  const started = system.startedAtMs(record.pid)
  // A platform with no start-time column at all has already been checked
  // against this boot, which is the whole of its documented weaker guarantee.
  if (started._tag === "unsupported") return undefined
  if (started._tag === "gone") return "process-gone"
  if (started._tag === "unavailable") return "identity-unverified"
  return Math.abs(started.startedAtMs - record.startedAtMs) <= identityToleranceMs
    ? undefined
    : "identity-mismatch"
}

/** Everything the reaper checks before it is willing to signal a record. */
const refuse = (
  system: System,
  record: ProcessLedger.ProcessRecord,
  ownerPid: number,
  ownGroup: number | null,
  bootMs: number
): Refusal | undefined => {
  // The host's own identity comes first, before the platform is consulted at
  // all: a record naming this process is refused on every platform, whatever
  // shape its numbers have.
  if (record.pgid === ownerPid || record.pid === ownerPid) return "own-group"
  if (ownGroup !== null && (record.pgid === ownGroup || record.pid === ownGroup)) return "own-group"
  const target = system.refuseTarget(record)
  if (target !== undefined) return target
  // A record naming a group can only be cleared of naming THIS host's group by
  // reading that group. When the probe cannot answer, the comparison above was
  // not made rather than made and passed, so the record is kept instead of
  // signalled on a guard that did not run.
  if (record.pgid !== null && ownGroup === null) return "own-group-unknown"
  if (system.isAlive(record.ownerPid) !== "dead") return "owner-alive"
  return refuseOnIdentity(system, record, bootMs)
}

/**
 * Kills the process groups a previous incarnation of this host abandoned.
 *
 * Returns one entry per inherited record so a caller can log what it decided;
 * `killed: false` carries the {@link Refusal} that produced it. Fails with
 * {@link ProcessLedger.ProcessLedgerReplayError} when the inherited history
 * cannot be read to its end: nothing is signalled or retired, so the next
 * sweep inherits every record again.
 *
 * @category constructors
 * @since 0.1.0
 */
export const reap = (
  options?: Options
): Effect.Effect<ReadonlyArray<Reaped>, ProcessLedger.ProcessLedgerReplayError, ProcessLedger.ProcessLedger> =>
  Effect.gen(function*() {
    const ledger = yield* ProcessLedger.ProcessLedger
    const system = options?.system ?? systemFor(process.platform)
    const ownerPid = options?.ownerPid ?? process.pid
    const ownGroup = system.ownGroup()
    const bootMs = system.bootedAtMs()
    const orphans = yield* ledger.orphans
    const decided: Array<Reaped> = []
    for (const record of orphans) {
      const refusal = refuse(system, record, ownerPid, ownGroup, bootMs)
      if (refusal === undefined) {
        const outcome = system.killTree(record)
        if (outcome === "failed") {
          // Nothing was killed, so nothing is retired: leaving the record
          // inherited is what makes the next incarnation try again.
          decided.push({ record, killed: false, refusal: "kill-failed" })
          continue
        }
        yield* retire(ledger.reaped(record), record.pid, "reaped")
        decided.push({ record, killed: true })
        continue
      }
      // A retained refusal is not this host's to retire; every other refusal is
      // final and says so in the journal.
      if (!retained.has(refusal)) {
        yield* retire(ledger.skipped(record, refusal), record.pid, "reap-skipped")
      }
      decided.push({ record, killed: false, refusal })
    }
    return decided
  })

/**
 * Writes one ledger retirement, logging rather than failing the sweep.
 *
 * A retirement that does not commit is not a lost kill: the process is already
 * dead and the record stays inherited, so the next incarnation reads it, finds
 * the pid gone, and retires it then. Failing the whole sweep over it would
 * take the host down for a bookkeeping write.
 */
const retire = (
  write: Effect.Effect<void, unknown>,
  pid: number,
  what: string
): Effect.Effect<void> =>
  write.pipe(
    Effect.catch((error) => Effect.logWarning(`process reaper could not journal ${what} for ${pid}`, error))
  )

/**
 * Refusals that leave a dead incarnation's process running with no live owner
 * to contain it: the host could not ask, or its signal failed.
 */
const unreaped: ReadonlySet<Refusal> = new Set<Refusal>(["identity-unverified", "own-group-unknown", "kill-failed"])

/**
 * Counter over inherited records the reaper did not kill, with a `refusal`
 * attribute naming why.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const refusals = Metric.counter("flows_process_reaper_refusals", {
  description: "Inherited process records the reaper did not kill, by refusal"
})

/**
 * Reports one sweep: a counter update per refusal and one summary line. The
 * line is a warning when a record stays inherited (a retained refusal) or a
 * signal failed, because either leaves a crashed incarnation's processes
 * running with nothing else to say so.
 *
 * @category layers
 * @since 1.0.0-rc.1
 */
export const report = (decided: ReadonlyArray<Reaped>): Effect.Effect<void> =>
  Effect.gen(function*() {
    if (decided.length === 0) return
    const counts: Partial<Record<Refusal, number>> = {}
    let killed = 0
    for (const entry of decided) {
      if (entry.killed) {
        killed += 1
        continue
      }
      counts[entry.refusal] = (counts[entry.refusal] ?? 0) + 1
    }
    for (const [refusal, count] of Object.entries(counts)) {
      yield* Metric.update(Metric.withAttributes(refusals, { refusal }), count)
    }
    const annotations = { killed, ...counts }
    const alarming = decided.some((entry) => !entry.killed && unreaped.has(entry.refusal))
    const line = "process reaper swept inherited records"
    yield* (alarming ? Effect.logWarning(line) : Effect.logInfo(line)).pipe(Effect.annotateLogs(annotations))
  })

/**
 * Runs {@link reap} once while the layer is built.
 *
 * Compose it into a host layer so standing a host up is also what cleans up
 * after the incarnation that crashed. A history that cannot be read refuses
 * the sweep with an error log and leaves every record inherited; the host
 * still starts, because the processes it will spawn are recorded and
 * contained regardless. Every decision is {@link report}ed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options?: Options): Layer.Layer<never, never, ProcessLedger.ProcessLedger> =>
  Layer.effectDiscard(
    reap(options).pipe(
      Effect.flatMap(report),
      Effect.catchTag(
        "@smthrs/kernel/ProcessLedgerReplayError",
        (error) => Effect.logError("process reaper refused to sweep: the ledger history is incomplete", error)
      )
    )
  )
