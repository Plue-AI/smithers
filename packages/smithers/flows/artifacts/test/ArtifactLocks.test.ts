import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import * as ArtifactLocks from "../src/internal/ArtifactLocks.ts"

const digest = "0".repeat(64)
const directory = ".objects"
const lockPath = `${directory}/${ArtifactLocks.directoryName}/${digest}.lock`

const platformError = (tag: PlatformError.SystemErrorTag, method: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: tag, module: "test", method })

const fileInfo = (mtime: Date) =>
  ({
    type: "File",
    mtime: Option.some(mtime),
    size: BigInt(0)
  }) as FileSystem.File.Info

const directoryInfo = {
  type: "Directory",
  mtime: Option.none(),
  size: BigInt(0),
  dev: 1,
  ino: Option.some(1)
} as unknown as FileSystem.File.Info

/** Answers the lock directory's own identity check; `overrides.stat` scripts the lock files. */
const isLockDirectory = (path: string): boolean => path.endsWith(`/${ArtifactLocks.directoryName}`)

const host = (overrides: Partial<FileSystem.FileSystem> = {}) => {
  let owner = ""
  let removes = 0
  let heartbeats = 0
  let fs = FileSystem.makeNoop({
    makeDirectory: (() => Effect.void) as never,
    writeFileString: ((_path: string, value: string) =>
      Effect.sync(() => {
        owner = value
      })) as never,
    readFileString: (() => Effect.sync(() => owner)) as never,
    remove: (() =>
      Effect.sync(() => {
        removes++
      })) as never,
    stat: (() => Effect.succeed(fileInfo(new Date()))) as never,
    rename: (() => Effect.void) as never,
    utimes: (() =>
      Effect.sync(() => {
        heartbeats++
      })) as never,
    ...overrides
  })
  const stat = fs.stat
  fs = {
    ...fs,
    stat: ((path: string) => isLockDirectory(path) ? Effect.succeed(directoryInfo) : stat(path)) as never
  }
  return { fs, owner: () => owner, removes: () => removes, heartbeats: () => heartbeats }
}

const run = <A, E, R>(fs: FileSystem.FileSystem, effect: Effect.Effect<A, E, R>) =>
  ArtifactLocks.withDigest(fs, directory, digest, effect, (cause) => cause)

/**
 * Collects what the heartbeat reports instead of printing it. A lock lost
 * underneath a live holder is the one condition in this module an operator has
 * to be able to see, so the tests that drive it assert the record.
 */
const capture = () => {
  const messages: Array<unknown> = []
  return { messages, logger: Logger.layer([Logger.make<unknown, void>(({ message }) => messages.push(message))]) }
}

const claimPath = `${lockPath}.reclaim-crashed`

/**
 * A path-aware host for the reclaim protocol: each file has an owner token and
 * an mtime, `wx` refuses an existing path, and `hooks` script the interleavings
 * a second process would cause.
 */
const files = (
  initial: Record<string, { readonly value: string; readonly mtime: number }>,
  hooks: {
    readonly read?: (path: string) => Effect.Effect<string, PlatformError.PlatformError> | undefined
    readonly write?: (path: string) => Effect.Effect<void, PlatformError.PlatformError> | undefined
    readonly rename?: (from: string) => void
  } = {}
) => {
  const state = new Map(Object.entries(initial).map(([path, file]) => [path, { ...file }]))
  const renames: Array<string> = []
  // Hooks run when the operation runs, not when the effect is built: the lock
  // module builds its release read before acquiring.
  const fs = FileSystem.makeNoop({
    makeDirectory: (() => Effect.void) as never,
    writeFileString: ((path: string, value: string, options?: { flag?: string }) =>
      Effect.suspend(() =>
        hooks.write?.(path) ?? Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.suspend(() => {
            if (options?.flag === "wx" && state.has(path)) {
              return Effect.fail(platformError("AlreadyExists", "writeFileString"))
            }
            state.set(path, { value, mtime: now })
            return Effect.void
          }))
      )) as never,
    readFileString: ((path: string) =>
      Effect.suspend(() => {
        const hooked = hooks.read?.(path)
        if (hooked !== undefined) {
          return hooked
        }
        const file = state.get(path)
        return file === undefined
          ? Effect.fail(platformError("NotFound", "readFileString"))
          : Effect.succeed(file.value)
      })) as never,
    stat: ((path: string) =>
      Effect.suspend(() => {
        const file = state.get(path)
        return file === undefined
          ? Effect.fail(platformError("NotFound", "stat"))
          : Effect.succeed(fileInfo(new Date(file.mtime)))
      })) as never,
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        hooks.rename?.(from)
        const file = state.get(from)
        if (file === undefined) {
          return Effect.fail(platformError("NotFound", "rename"))
        }
        renames.push(file.value)
        state.set(to, file)
        state.delete(from)
        return Effect.void
      })) as never,
    remove: ((path: string) =>
      Effect.sync(() => void state.delete(path))) as never,
    utimes: (() => Effect.void) as never
  })
  return { fs, state, renames }
}

describe("stale lock reclamation", () => {
  it.effect("treats a lock that vanishes before its owner is read as free", () =>
    Effect.gen(function*() {
      let reads = 0
      const fixture = files({ [lockPath]: { value: "crashed", mtime: 0 } }, {
        read: (path) => {
          if (path !== lockPath || reads++ > 0) return undefined
          fixture.state.delete(lockPath)
          return Effect.fail(platformError("NotFound", "readFileString"))
        }
      })
      yield* run(fixture.fs, Effect.void)
      // One read found nothing during acquisition; the other is the release.
      expect(reads).toBe(2)
      expect(fixture.renames).toEqual([])
    }))

  it.effect("propagates an owner read refusal", () =>
    Effect.gen(function*() {
      const fixture = files({ [lockPath]: { value: "crashed", mtime: 0 } }, {
        read: () => Effect.fail(platformError("PermissionDenied", "readFileString"))
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))

  it.effect("propagates a claim refusal other than AlreadyExists", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      const fixture = files({ [lockPath]: { value: "crashed", mtime: 0 } }, {
        write: (path) =>
          path === claimPath ? Effect.fail(platformError("PermissionDenied", "writeFileString")) : undefined
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
      expect(fixture.renames).toEqual([])
    }))

  it.effect("leaves a stale lock to the contender holding its claim", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      const now = yield* Clock.currentTimeMillis
      const fixture = files({
        [lockPath]: { value: "crashed", mtime: 0 },
        [claimPath]: { value: "a-peer", mtime: now }
      })
      const running = yield* run(fixture.fs, Effect.void).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("50 millis")
      expect(fixture.renames).toEqual([])
      expect(fixture.state.get(claimPath)?.value).toBe("a-peer")
      expect(running.pollUnsafe()).toBeUndefined()
      // The peer finishes without moving anything; the claim is free again.
      fixture.state.delete(claimPath)
      yield* TestClock.adjust("25 millis")
      yield* Fiber.join(running)
      expect(fixture.renames).toEqual(["crashed"])
      expect([...fixture.state.keys()]).toEqual([])
    }))

  it.effect("clears a claim abandoned by a crashed reclaimer", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      const fixture = files({
        [lockPath]: { value: "crashed", mtime: 0 },
        [claimPath]: { value: "a-dead-peer", mtime: 0 }
      })
      const running = yield* run(fixture.fs, Effect.void).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("25 millis")
      yield* Fiber.join(running)
      expect(fixture.renames).toEqual(["crashed"])
      expect([...fixture.state.keys()]).toEqual([])
    }))

  it.effect("keeps an abandoned claim that a peer replaced or removed before cleanup", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      const now = yield* Clock.currentTimeMillis
      let claimReads = 0
      const fixture = files({
        [lockPath]: { value: "crashed", mtime: 0 },
        [claimPath]: { value: "a-dead-peer", mtime: 0 }
      }, {
        read: (path) => {
          if (path !== claimPath) return undefined
          claimReads += 1
          // First pass: the claim is gone by the time its owner is read.
          if (claimReads === 1) return Effect.fail(platformError("NotFound", "readFileString"))
          // Second pass: a live peer replaced it between the age check and removal.
          if (claimReads === 3) {
            fixture.state.set(claimPath, { value: "a-live-peer", mtime: now })
            return Effect.succeed("a-live-peer")
          }
          return undefined
        }
      })
      const running = yield* run(fixture.fs, Effect.void).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("50 millis")
      expect(fixture.state.get(claimPath)?.value).toBe("a-live-peer")
      expect(fixture.renames).toEqual([])
      expect(running.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(running)
    }))

  it.effect("hands back a live lock that took the path between the re-read and the rename", () =>
    Effect.gen(function*() {
      // A stalled owner released and a new owner acquired inside the claim
      // winner's last gap, so the rename moved a live lock. It goes back with
      // an atomic create, and the winner keeps waiting on it.
      yield* TestClock.adjust("2 minutes")
      const fixture = files({ [lockPath]: { value: "crashed", mtime: 0 } }, {
        rename: (from) => {
          if (from === lockPath && fixture.renames.length === 0) {
            fixture.state.set(lockPath, { value: "a-live-owner", mtime: 120_000 })
          }
        }
      })
      const running = yield* run(fixture.fs, Effect.void).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("50 millis")
      expect(fixture.renames).toEqual(["a-live-owner"])
      expect(fixture.state.get(lockPath)?.value).toBe("a-live-owner")
      expect([...fixture.state.keys()]).toEqual([lockPath])
      expect(running.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(running)
    }))
})

describe("artifact lockfile failure and race handling", () => {
  it.effect("includes same-process semaphore contention in the acquisition deadline", () =>
    Effect.gen(function*() {
      const fixture = host()
      const entered = yield* Deferred.make<void>()
      const holder = yield* run(
        fixture.fs,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never)
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const waiter = yield* run(fixture.fs, Effect.void).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust("3 minutes")
      expect(waiter.pollUnsafe()).toBeDefined()
      expect(Exit.isFailure(yield* Fiber.join(waiter))).toBe(true)
      expect(holder.pollUnsafe()).toBeUndefined()
      const next = yield* run(fixture.fs, Effect.void).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(next.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(holder)
      yield* Fiber.join(next)
    }))

  it.effect("includes directory creation in the acquisition deadline", () =>
    Effect.gen(function*() {
      const fixture = host({ makeDirectory: (() => Effect.never) as never })
      const waiter = yield* run(fixture.fs, Effect.void).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust("2 minutes")
      expect(Exit.isFailure(yield* Fiber.join(waiter))).toBe(true)
      expect(fixture.removes()).toBe(0)
    }))

  it.effect("does not serialize the same digest across objects directories", () =>
    Effect.gen(function*() {
      const fixture = host()
      const entered = yield* Deferred.make<void>()
      const holder = yield* ArtifactLocks.withDigest(
        fixture.fs,
        "objects-A",
        digest,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        (cause) => cause,
        "process"
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const other = yield* ArtifactLocks.withDigest(fixture.fs, "objects-B", digest, Effect.void, (cause) =>
        cause, "process").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(other.pollUnsafe()).toBeDefined()
      yield* Fiber.interrupt(holder)
      yield* Fiber.join(other)
    }))

  it.effect("propagates an atomic-create failure other than AlreadyExists", () =>
    Effect.gen(function*() {
      const fixture = host({
        writeFileString: (() => Effect.fail(platformError("PermissionDenied", "writeFileString"))) as never
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))

  it.effect("retries when a contended lock vanishes before stat", () =>
    Effect.gen(function*() {
      let writes = 0
      let owner = ""
      const fixture = host({
        writeFileString: ((_path: string, value: string) =>
          Effect.suspend(() => {
            writes++
            if (writes === 1) return Effect.fail(platformError("AlreadyExists", "writeFileString"))
            owner = value
            return Effect.void
          })) as never,
        stat: (() => Effect.fail(platformError("NotFound", "stat"))) as never,
        readFileString: (() => Effect.sync(() => owner)) as never
      })
      const running = yield* run(fixture.fs, Effect.void).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("25 millis")
      yield* Fiber.join(running)
      expect(writes).toBe(2)
    }))

  it.effect("propagates a contended-lock stat refusal", () =>
    Effect.gen(function*() {
      const fixture = host({
        writeFileString: (() => Effect.fail(platformError("AlreadyExists", "writeFileString"))) as never,
        stat: (() => Effect.fail(platformError("PermissionDenied", "stat"))) as never
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))

  it.effect("retries when a stale lock vanishes before its atomic rename", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      let lockWrites = 0
      const files = new Map<string, string>([[lockPath, "crashed"]])
      const fixture = host({
        writeFileString: ((path: string, value: string) =>
          Effect.suspend(() => {
            if (path === lockPath) lockWrites++
            if (path === lockPath && lockWrites === 1) {
              return Effect.fail(platformError("AlreadyExists", "writeFileString"))
            }
            files.set(path, value)
            return Effect.void
          })) as never,
        stat: (() => Effect.succeed(fileInfo(new Date(0)))) as never,
        rename: (() => Effect.fail(platformError("NotFound", "rename"))) as never,
        readFileString: ((path: string) => Effect.sync(() => files.get(path) ?? "")) as never
      })
      yield* run(fixture.fs, Effect.void)
      expect(lockWrites).toBe(2)
    }))

  it.effect("propagates a stale-lock rename refusal", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      const files = new Map<string, string>([[lockPath, "crashed"]])
      const fixture = host({
        writeFileString: ((path: string, value: string) =>
          Effect.suspend(() => {
            if (files.has(path)) return Effect.fail(platformError("AlreadyExists", "writeFileString"))
            files.set(path, value)
            return Effect.void
          })) as never,
        readFileString: ((path: string) => Effect.sync(() => files.get(path) ?? "")) as never,
        stat: (() => Effect.succeed(fileInfo(new Date(0)))) as never,
        rename: (() => Effect.fail(platformError("PermissionDenied", "rename"))) as never
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))

  it.effect("moves a stale lock generation at most once across concurrent reclaimers", () =>
    Effect.gen(function*() {
      // Both contenders read the crashed owner and measure it stale before
      // either renames. The first reclaims and takes the lock; the second's
      // verdict names a generation that is gone, so it must not move the
      // first's fresh lock.
      yield* TestClock.adjust("2 minutes")
      const files = new Map<string, { value: string; mtime: number }>([[lockPath, { value: "crashed", mtime: 0 }]])
      const renames: Array<string> = []
      let staleReads = 0
      const bothMeasured = yield* Deferred.make<void>()
      const fs = FileSystem.makeNoop({
        makeDirectory: (() => Effect.void) as never,
        writeFileString: ((path: string, value: string, options?: { flag?: string }) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.suspend(() => {
              if (options?.flag === "wx" && files.has(path)) {
                return Effect.fail(platformError("AlreadyExists", "writeFileString"))
              }
              files.set(path, { value, mtime: now })
              return Effect.void
            }))) as never,
        readFileString: ((path: string) =>
          Effect.suspend(() => {
            const file = files.get(path)
            return file === undefined
              ? Effect.fail(platformError("NotFound", "readFileString"))
              : Effect.succeed(file.value)
          })) as never,
        stat: ((path: string) =>
          Effect.suspend(() => {
            const file = files.get(path)
            if (file === undefined) return Effect.fail(platformError("NotFound", "stat"))
            const info = Effect.succeed(fileInfo(new Date(file.mtime)))
            if (path !== lockPath || file.value !== "crashed" || staleReads >= 2) {
              return info
            }
            staleReads++
            return staleReads === 2
              ? Deferred.succeed(bothMeasured, undefined).pipe(Effect.andThen(info))
              : Deferred.await(bothMeasured).pipe(Effect.andThen(info))
          })) as never,
        rename: ((from: string, to: string) =>
          Effect.suspend(() => {
            const file = files.get(from)
            if (file === undefined) {
              return Effect.fail(platformError("NotFound", "rename"))
            }
            renames.push(file.value)
            files.set(to, file)
            files.delete(from)
            return Effect.void
          })) as never,
        remove: ((path: string) =>
          Effect.sync(() => void files.delete(path))) as never,
        utimes: (() => Effect.void) as never
      })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const first = yield* ArtifactLocks.withDigest(
        fs,
        directory,
        digest,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        (cause) => cause
      ).pipe(Effect.forkChild({ startImmediately: true }))
      // A second FileSystem service stands in for another process, so the
      // in-process semaphore does not serialize the two.
      const second = yield* ArtifactLocks.withDigest({ ...fs }, directory, digest, Effect.void, (cause) => cause)
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* TestClock.adjust("25 millis")
      expect(renames).toEqual(["crashed"])
      expect(second.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* TestClock.adjust("25 millis")
      yield* Fiber.join(second)
      expect(renames).toEqual(["crashed"])
      expect([...files.keys()]).toEqual([])
    }))

  it.effect("bounds acquisition when a live owner never releases", () =>
    Effect.gen(function*() {
      const fixture = host({
        writeFileString: (() => Effect.fail(platformError("AlreadyExists", "writeFileString"))) as never,
        stat: (() => Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.succeed(fileInfo(new Date(now))))) as never
      })
      const waiting = yield* run(fixture.fs, Effect.void).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("2 minutes")
      expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true)
    }))

  it.effect("heartbeats while the protected operation remains active", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let owner = ""
      const fixture = host({
        writeFileString: ((_path: string, value: string) =>
          Effect.sync(() => {
            owner = value
          }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)))) as never,
        readFileString: (() => Effect.sync(() => owner)) as never
      })
      const running = yield* run(fixture.fs, Deferred.await(release)).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("10 seconds")
      expect(fixture.heartbeats()).toBeGreaterThan(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
    }))

  it.effect("stops heartbeating once the lock names a different owner", () =>
    Effect.gen(function*() {
      // A holder stalled past the stale bound has its lock reaped and replaced.
      // If its heartbeat kept touching that pathname it would freshen a lock it
      // does not own, and the replacement could never be judged stale while the
      // zombie ran — a hard-killed replacement would hold the digest until the
      // zombie's own operation ended, two minutes at a time for every waiter.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = host({
        writeFileString: (() => Deferred.succeed(entered, undefined).pipe(Effect.asVoid)) as never,
        readFileString: (() => Effect.succeed("a-replacement-owner")) as never
      })
      const log = capture()
      const running = yield* run(fixture.fs, Deferred.await(release)).pipe(
        Effect.provide(log.logger),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("60 seconds")
      expect(fixture.heartbeats()).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      // And it must not delete the replacement on the way out either.
      expect(fixture.removes()).toBe(0)
      // The protected effect is still running unfenced at this point, so the
      // heartbeat must not retire silently.
      expect(log.messages).toEqual([[
        "Artifact lock was reclaimed while its holder was still running",
        { digest, state: "foreign" }
      ]])
    }))

  it.effect("stops heartbeating once the lock is gone", () =>
    Effect.gen(function*() {
      // A reaped lock leaves nothing to freshen. Reading it back fails
      // `NotFound`, which ends the heartbeat rather than retrying forever.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = host({
        writeFileString: (() => Deferred.succeed(entered, undefined).pipe(Effect.asVoid)) as never,
        readFileString: (() => Effect.fail(platformError("NotFound", "readFileString"))) as never
      })
      const log = capture()
      const running = yield* run(fixture.fs, Deferred.await(release)).pipe(
        Effect.provide(log.logger),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("60 seconds")
      expect(fixture.heartbeats()).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(log.messages).toEqual([[
        "Artifact lock was reclaimed while its holder was still running",
        { digest, state: "gone" }
      ]])
    }))

  it.effect("keeps heartbeating across a read the host transiently refused", () =>
    Effect.gen(function*() {
      // A refused read is no evidence about ownership either way. Ending the
      // heartbeat on it would retire a lock this call still holds: the file
      // goes stale in 60 seconds, another process reaps it, and this holder
      // keeps working unfenced. The beat is skipped and the next one retries.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let owner = ""
      let reads = 0
      const fixture = host({
        writeFileString: ((_path: string, value: string) =>
          Effect.sync(() => {
            owner = value
          }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)))) as never,
        readFileString: (() =>
          Effect.suspend(() => {
            reads += 1
            return reads <= 2
              ? Effect.fail(platformError("PermissionDenied", "readFileString"))
              : Effect.succeed(owner)
          })) as never
      })
      const log = capture()
      const running = yield* run(fixture.fs, Deferred.await(release)).pipe(
        Effect.provide(log.logger),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("20 seconds")
      expect(fixture.heartbeats()).toBe(0)
      yield* TestClock.adjust("20 seconds")
      expect(fixture.heartbeats()).toBeGreaterThan(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      // A refused read is not evidence the lock was lost, so it must not raise
      // the warning that means it was.
      expect(log.messages).toEqual([])
    }))

  it.effect("gives a digest one in-process lock even when an effect value is reused", () =>
    Effect.gen(function*() {
      // The bookkeeping that decides which callers share a semaphore has to be
      // per-execution, not per-construction. `ArtifactBackupLease` builds its
      // gate once and runs it on every heartbeat, so a per-construction count
      // retires the entry while a holder is still inside it, and the next
      // caller mints a second semaphore for the same digest. Two writers then
      // serialize against nothing.
      const fixture = host()
      let runs = 0
      let concurrent = 0
      let peak = 0
      const holding = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const body = Effect.gen(function*() {
        runs += 1
        // The first run exists only to retire the entry behind the reused value.
        if (runs === 1) return
        concurrent += 1
        peak = Math.max(peak, concurrent)
        yield* Deferred.succeed(holding, undefined)
        yield* Deferred.await(finish)
        concurrent -= 1
      })
      const reused = ArtifactLocks.withDigest(fixture.fs, directory, digest, body, (cause) => cause, "process")
      yield* reused
      const holder = yield* Effect.forkChild(reused, { startImmediately: true })
      yield* Deferred.await(holding)
      const contender = yield* Effect.forkChild(
        ArtifactLocks.withDigest(fixture.fs, directory, digest, body, (cause) => cause, "process"),
        { startImmediately: true }
      )
      yield* Effect.yieldNow
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(holder)
      yield* Fiber.join(contender)
      expect(peak).toBe(1)
    }))

  it.effect("does not delete a replacement lock owned by another process", () =>
    Effect.gen(function*() {
      const fixture = host({ readFileString: (() => Effect.succeed("different-owner")) as never })
      yield* run(fixture.fs, Effect.void)
      expect(fixture.removes()).toBe(0)
    }))

  it.effect("swallows a missing lock during release", () =>
    Effect.gen(function*() {
      const fixture = host({
        readFileString: (() => Effect.fail(platformError("NotFound", "readFileString"))) as never
      })
      yield* run(fixture.fs, Effect.void)
    }))

  it.effect("propagates a release failure while the lock still exists", () =>
    Effect.gen(function*() {
      const fixture = host({
        readFileString: (() => Effect.fail(platformError("PermissionDenied", "readFileString"))) as never
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))
})
