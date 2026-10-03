import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import * as TestClock from "effect/testing/TestClock"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

// Fault injection stays at the filesystem boundary; all unaffected calls use
// real temporary directories and the public layer still spawns its CLI shim.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    readdir: vi.fn(actual.readdir),
    rmdir: vi.fn(actual.rmdir),
    unlink: vi.fn(actual.unlink)
  }
})
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
// Inject only a guard read failure after the real store pointer was resolved;
// the filesystem locks remain real and the CLI shim must never be invoked.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
const actualSyncFs = await vi.importActual<typeof import("node:fs")>("node:fs")
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})
const errno = (code: string) => Object.assign(new Error(code), { code })

const fixture = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await actualFs.realpath(await mkdtemp(join(tmpdir(), "flows-jj-lock-")))
      await mkdir(join(root, ".jj", "repo"), { recursive: true })
      await mkdir(join(root, "nested"))
      const binary = join(root, "jj-shim")
      await writeFile(
        binary,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "jj 0.39.0"; exit 0; fi
printf '%s\\n' "$*" >> calls
: > started
echo $$ > child-pid.tmp
mv child-pid.tmp child-pid
while [ -f hold ]; do /bin/sleep 0.01; done
# Both Git diff and its path metadata describe an empty change.
if [ "$1" = "diff" ] && [ "$2" = "--from" ]; then exit 0; fi
if [ "$1" = op ]; then echo 0abc; else printf "0abc\\nkkkk\\n"; fi
`
      )
      await chmod(binary, 0o755)
      const previous = process.env.SMITHERS_JJ_PATH
      process.env.SMITHERS_JJ_PATH = binary
      return { root, previous }
    }),
    // These live cases assert lock semantics. NodeJjVersion covers startup
    // latency under the test clock; allow preflight the full test watchdog here.
    ({ root }) => use(root).pipe(Effect.provideService(NodeJj.StartupTimeoutMs, 60_000)),
    ({ root, previous }) =>
      Effect.promise(async () => {
        if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
        else process.env.SMITHERS_JJ_PATH = previous
        await rm(root, { recursive: true, force: true })
      })
  )

const until = (predicate: () => Promise<boolean>) =>
  Effect.retry(Effect.promise(predicate).pipe(Effect.filterOrFail((ready) => ready)), {
    times: 3_000,
    schedule: Schedule.spaced(10)
  })

describe("NodeJj repository locks", () => {
  it.effect("times out a held fence without starting the waiting operation", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const acquired = yield* Deferred.make<void>()
        const holder = yield* Effect.forkChild(NodeJj.withRepositoryMutation(
          "apply",
          root,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never))
        ))
        yield* Deferred.await(acquired)
        let ran = false
        const waiter = yield* Effect.forkChild(
          NodeJj.withRepositoryMutation(
            "apply",
            root,
            Effect.sync(() => {
              ran = true
            })
          ).pipe(Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30), Effect.flip)
        )
        yield* TestClock.adjust(31)
        expect(yield* Fiber.join(waiter)).toMatchObject({ cause: { code: "lock_timeout" } })
        expect(ran).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
        yield* Fiber.interrupt(holder)
        yield* NodeJj.withRepositoryMutation("apply", root, Effect.void)
      })
    ))

  it.effect("allows an acquired operation to outlive the acquisition timeout", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const acquired = yield* Deferred.make<void>()
        const complete = yield* Deferred.make<string>()
        const operation = yield* Effect.forkChild(
          NodeJj.withRepositoryMutation(
            "apply",
            root,
            Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(complete)))
          ).pipe(Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30))
        )
        yield* Deferred.await(acquired)
        yield* TestClock.adjust(31)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(true)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
        yield* Deferred.succeed(complete, "completed")
        expect(yield* Fiber.join(operation)).toBe("completed")
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
      })
    ))

  it.live("releases both fences after SIGKILL of an acquired jj child", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => writeFile(join(root, "hold"), ""))
        const pending = yield* Effect.forkChild(jj.snapshot("killed").pipe(Effect.flip))
        yield* until(async () => existsSync(join(root, "child-pid")))
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(true)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
        const pid = Number(yield* Effect.promise(() => readFile(join(root, "child-pid"), "utf8")))
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        yield* Effect.sync(() => process.kill(pid, "SIGKILL"))
        expect(yield* Fiber.join(pending)).toMatchObject({ method: "snapshot" })
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
        yield* Effect.promise(() => rm(join(root, "hold")))
        expect(
          (yield* jj.snapshot("after-kill").pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 1_000)
          )).commitId
        ).toBe("0abc")
      })
    ))

  it.effect("reaches lock assertions after fixture startup exceeds the production deadline", () =>
    fixture((root) =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          const gate = join(root, "version-gate")
          execFileSync("mkfifo", [gate])
          await writeFile(
            join(root, "jj-shim"),
            `#!/bin/sh
cd "\${0%/*}"
if [ "$1" = "--version" ]; then
  exec 3< version-gate
  echo ready > ready.tmp
  /bin/mv ready.tmp ready
  read version <&3
  echo "$version"
else
  : > started
  if [ "$1" = op ]; then echo 0abc; else printf "0abc\\nkkkk\\n"; fi
fi
`
          )
          return open(gate, "r+")
        }),
        (gate) =>
          Effect.acquireUseRelease(
            Effect.forkChild(Effect.provide(Jj, NodeJj.layerAt(root))),
            (building) =>
              Effect.gen(function*() {
                yield* Effect.promise(async (signal) => {
                  for (;;) {
                    signal.throwIfAborted()
                    try {
                      await readFile(join(root, "ready"))
                      return
                    } catch (cause) {
                      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
                    }
                  }
                })
                // The FIFO holds a real child; only the test clock advances.
                yield* TestClock.adjust(5_200)
                yield* Effect.promise(() => gate.writeFile("jj 0.39.0\n"))
                const jj = yield* Fiber.join(building)
                vi.mocked(rename).mockRejectedValueOnce(errno("EACCES"))
                const error = yield* Effect.flip(jj.snapshot())
                expect(error).toMatchObject({ code: "unknown", module: "NodeJj", method: "snapshot" })
                expect(error.message).toContain("repository lock failed")
                expect(existsSync(join(root, "started"))).toBe(false)
              }),
            (building) => Fiber.interrupt(building)
          ),
        (gate) => Effect.promise(() => gate.close())
      )
    ))

  it.live("coordinates different workspaces sharing a store and bounds permit waits through cancellation", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const secondary = join(root, "secondary")
        yield* Effect.promise(async () => {
          await mkdir(join(secondary, ".jj"), { recursive: true })
          await writeFile(join(secondary, ".jj", "repo"), join(root, ".jj", "repo"))
        })
        let started = false
        const first = yield* Effect.forkChild(NodeJj.withRepositoryMutation(
          "apply",
          root,
          Effect.sync(() => {
            started = true
          }).pipe(Effect.andThen(Effect.never))
        ))
        yield* until(async () => started)
        const failure = yield* Effect.flip(
          NodeJj.withRepositoryMutation("apply", secondary, Effect.void).pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30)
          )
        )
        expect(failure.cause?.code).toBe("lock_timeout")
        yield* Fiber.interrupt(first)
        yield* NodeJj.withRepositoryMutation("apply", secondary, Effect.void)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
      })
    ))

  it.effect("retries only a shared Git index acquisition error, preserving permanent errors", () =>
    Effect.gen(function*() {
      for (
        const message of [
          "source conflict in index.lock",
          "Could not acquire lock for index file: /git/private.index.lock",
          "Could not acquire lock for index file: could not be obtained immediately after 1 attempt(s). '/git/private.index.lock'",
          "Could not acquire lock for index file: '/git/index.lock': permission denied",
          "cannot lock ref 'refs/heads/main': permission denied",
          "cannot lock ref 'refs/heads/main': is at abc but expected def",
          "invalid revision"
        ]
      ) {
        let calls = 0
        const failure = { message }
        const answer = yield* Effect.flip(NodeJj.retryGitIndexLock(Effect.suspend(() => {
          calls++
          return Effect.fail(failure)
        })))
        expect(answer).toBe(failure)
        expect(calls).toBe(1)
      }
    }))

  it.effect("retries transient ref-lock failures and succeeds after contention clears", () =>
    Effect.gen(function*() {
      for (const detail of ["File exists", "another Git process", "reference already locked"]) {
        let calls = 0
        const pending = yield* Effect.forkChild(NodeJj.retryGitIndexLock(Effect.suspend(() => {
          calls++
          return calls === 1
            ? Effect.fail({ message: `cannot lock ref 'refs/heads/main': ${detail}` })
            : Effect.succeed("fetched")
        })))
        yield* TestClock.adjust(100)
        expect(yield* Fiber.join(pending)).toBe("fetched")
        expect(calls).toBe(2)
      }
    }))

  it.effect("bounds persistent ref-lock contention and stops retries on cancellation", () =>
    Effect.gen(function*() {
      let calls = 0
      const failure = { message: "cannot lock ref 'refs/heads/main': File exists" }
      const retrying = NodeJj.retryGitIndexLock(Effect.suspend(() => {
        calls++
        return Effect.fail(failure)
      }))
      const exhausted = yield* Effect.forkChild(Effect.flip(retrying))
      yield* TestClock.adjust(120_000)
      expect(yield* Fiber.join(exhausted)).toBe(failure)
      expect(calls).toBe(1_201)
      const cancelled = yield* Effect.forkChild(retrying)
      yield* TestClock.adjust(0)
      expect(calls).toBe(1_202)
      yield* Fiber.interrupt(cancelled)
      yield* TestClock.adjust(120_000)
      expect(calls).toBe(1_202)
    }))

  for (const method of ["status", "root"] as const) {
    it.live(`bounds public ${method} before spawn and releases its waiting fence on cancellation`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const secondary = join(root, "secondary")
          yield* Effect.promise(async () => {
            await mkdir(join(secondary, ".jj"), { recursive: true })
            await writeFile(join(secondary, ".jj", "repo"), join(root, ".jj", "repo"))
          })
          let started = false
          const holder = yield* Effect.forkChild(NodeJj.withRepositoryMutation(
            "apply",
            root,
            Effect.sync(() => {
              started = true
            }).pipe(Effect.andThen(Effect.never))
          ))
          yield* until(async () => started)
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(secondary))
          const operation = method === "status" ? jj.status() : jj.root!(secondary)
          const failure = yield* Effect.flip(operation.pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30)
          ))
          expect(failure).toMatchObject({ method, cause: { code: "lock_timeout" } })
          expect(existsSync(join(secondary, "started"))).toBe(false)
          const waiting = yield* Effect.forkChild(operation)
          yield* until(async () => existsSync(join(secondary, ".jj", "smithers.lock")))
          yield* Fiber.interrupt(waiting)
          expect(existsSync(join(secondary, ".jj", "smithers.lock"))).toBe(false)
          expect(existsSync(join(secondary, "started"))).toBe(false)
          expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
          yield* Fiber.interrupt(holder)
          yield* operation
          expect(existsSync(join(secondary, "started"))).toBe(true)
          expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
        })
      ))
  }

  it.live("fences root on its actual directory independently of the bound workspace", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const other = join(root, "other")
        yield* Effect.promise(() => mkdir(join(other, ".jj", "repo"), { recursive: true }))
        let held = false
        const holder = yield* Effect.forkChild(NodeJj.withRepositoryMutation(
          "apply",
          root,
          Effect.sync(() => {
            held = true
          }).pipe(Effect.andThen(Effect.never))
        ))
        yield* until(async () => held)
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* jj.root!(other)
        expect(existsSync(join(other, "started"))).toBe(true)
        expect(existsSync(join(root, "started"))).toBe(false)
        expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(true)
        expect(existsSync(join(other, ".jj", "repo", "smithers.lock"))).toBe(false)
        yield* Fiber.interrupt(holder)
      })
    ))

  for (const code of ["EACCES", "ENOENT"]) {
    it.live(`refuses a ${code} store-pointer inspection failure before CLI spawn and releases both fences`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const secondary = join(root, "secondary")
          const pointer = join(secondary, ".jj", "repo")
          yield* Effect.promise(async () => {
            await mkdir(join(secondary, ".jj"), { recursive: true })
            await writeFile(pointer, join(root, ".jj", "repo"))
          })
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(secondary))
          vi.mocked(readFileSync).mockClear()
          vi.mocked(readFileSync).mockImplementationOnce(actualSyncFs.readFileSync).mockImplementationOnce(() => {
            throw errno(code)
          })
          const failure = yield* Effect.flip(jj.status())
          expect(failure).toMatchObject({ code: "unknown", method: "status", cause: { code, message: code } })
          expect(failure.message).toContain("could not inspect repository configuration")
          expect(vi.mocked(readFileSync).mock.calls.map(([path]) => path)).toEqual([pointer, pointer])
          expect(existsSync(join(secondary, "started"))).toBe(false)
          expect(existsSync(join(secondary, ".jj", "smithers.lock"))).toBe(false)
          expect(existsSync(join(root, ".jj", "repo", "smithers.lock"))).toBe(false)
        })
      ))
  }

  it.effect("exhausts a finite retry budget independently for each execution", () =>
    Effect.gen(function*() {
      let calls = 0
      const failure = {
        message:
          "Could not acquire lock for index file: could not be obtained immediately after 1 attempt(s). '/git/index.lock'"
      }
      const retrying = NodeJj.retryGitIndexLock(Effect.suspend(() => {
        calls++
        return Effect.fail(failure)
      }))
      for (let run = 0; run < 2; run++) {
        const pending = yield* Effect.forkChild(Effect.flip(retrying))
        yield* TestClock.adjust(120_000)
        expect(yield* Fiber.join(pending)).toBe(failure)
        expect(calls).toBe(1_201 * (run + 1))
      }
    }))

  it.live("leaves the CLI to report operations outside a workspace", () =>
    fixture((root) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => rm(join(root, ".jj"), { recursive: true }))
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        expect((yield* jj.snapshot()).commitId).toBe("0abc")
      })
    ))

  it.live("finds a repository from a nested directory", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(join(root, "nested")))
        expect((yield* jj.snapshot()).commitId).toBe("0abc")
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
      })
    ))

  for (const cause of [errno("EACCES"), null, "filesystem failure", {}]) {
    it.effect(`reports an acquisition failure as a typed lock error: ${String(cause)}`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          vi.mocked(rename).mockRejectedValueOnce(cause)
          const error = yield* Effect.flip(jj.snapshot())
          expect(error).toMatchObject({ code: "unknown", module: "NodeJj", method: "snapshot" })
          expect(error.message).toContain("repository lock failed")
          expect(yield* Effect.promise(() => readdir(join(root, ".jj")))).toEqual(["repo"])
        })
      ))
  }

  for (const code of ["ENOTEMPTY", "EEXIST"]) {
    it.live(`retries a lock that disappeared after contention (${code})`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          vi.mocked(rename).mockRejectedValueOnce(errno(code))
          vi.mocked(readdir).mockRejectedValueOnce(errno("ENOENT"))
          expect((yield* jj.snapshot()).commitId).toBe("0abc")
        })
      ))
  }

  it.live("reports unreadable lock ownership without running a mutation", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        vi.mocked(rename).mockRejectedValueOnce(errno("ENOTEMPTY"))
        vi.mocked(readdir).mockRejectedValueOnce(errno("EACCES"))
        expect((yield* Effect.flip(jj.snapshot())).message).toContain("EACCES")
        expect(existsSync(join(root, "started"))).toBe(false)
      })
    ))

  it.live("tolerates another reclaimer removing the dead owner's entry and directory", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const lock = join(root, ".jj", "smithers.lock")
        yield* Effect.promise(async () => {
          await mkdir(lock)
          await writeFile(join(lock, `${hostname()}-2147483647-dead`), "")
        })
        vi.mocked(unlink).mockImplementationOnce(async (path) => {
          await actualFs.unlink(path)
          throw errno("ENOENT")
        })
        vi.mocked(rmdir).mockImplementationOnce(async (path) => {
          await actualFs.rmdir(path)
          throw errno("ENOENT")
        })
        expect((yield* jj.snapshot()).commitId).toBe("0abc")
      })
    ))

  for (const code of ["ENOTEMPTY", "EEXIST"]) {
    it.live(`does not delete a replacement lock during stale recovery (${code})`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const lock = join(root, ".jj", "smithers.lock")
          const replacement = join(lock, `${hostname()}-${process.pid}-replacement`)
          yield* Effect.promise(async () => {
            await mkdir(lock)
            await writeFile(join(lock, `${hostname()}-2147483647-dead`), "")
          })
          vi.mocked(rmdir).mockImplementationOnce(async () => {
            await writeFile(replacement, "")
            throw errno(code)
          })
          const pending = yield* Effect.forkChild(jj.snapshot())
          yield* until(async () => existsSync(replacement))
          yield* Fiber.interrupt(pending)
          expect(existsSync(replacement)).toBe(true)
          expect(existsSync(join(root, "started"))).toBe(false)
        })
      ))
  }

  for (const operation of [unlink, rmdir]) {
    it.live(`keeps the result if lock release fails at ${operation.name}`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          vi.mocked(operation).mockRejectedValueOnce(errno("EACCES"))
          expect((yield* jj.snapshot()).commitId).toBe("0abc")
        })
      ))
  }

  for (
    const [owner, code] of [
      [`${hostname()}-2147483647-denied`, "EPERM"],
      [`remote-${hostname()}-2147483647-foreign`, "ESRCH"],
      ["2147483647-legacy", "ESRCH"]
    ]
  ) {
    it.effect(`preserves an owner whose death cannot be established locally: ${owner}`, () =>
      fixture((root) =>
        Effect.gen(function*() {
          const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
          const lock = join(root, ".jj", "smithers.lock")
          yield* Effect.promise(async () => {
            await mkdir(lock)
            await writeFile(join(lock, owner!), "")
          })
          const kill = vi.spyOn(process, "kill").mockImplementation(() => {
            throw errno(code!)
          })
          const pending = yield* Effect.forkChild(Effect.flip(
            jj.snapshot().pipe(
              Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30)
            )
          ))
          yield* Effect.promise(async (signal) => {
            for (;;) {
              signal.throwIfAborted()
              const inspection = vi.mocked(readdir).mock.calls.findIndex(([path]) => path === lock)
              if (inspection >= 0 && (code !== "EPERM" || kill.mock.calls.length > 0)) {
                await vi.mocked(readdir).mock.results[inspection]!.value
                return
              }
              await new Promise<void>((resolve) => setImmediate(resolve))
            }
          })
          yield* TestClock.adjust(31)
          expect((yield* Fiber.join(pending)).message).toContain("timed out waiting")
          expect(existsSync(join(lock, owner!))).toBe(true)
          if (code === "EPERM") expect(kill).toHaveBeenCalledWith(2147483647, 0)
          else expect(kill).not.toHaveBeenCalled()
        })
      ))
  }

  it.live("times out on unknown ownership without removing the lock", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const lock = join(root, ".jj", "smithers.lock")
        yield* Effect.promise(async () => {
          await mkdir(lock)
          await writeFile(join(lock, "unknown-owner"), "")
        })
        const refused = yield* Effect.flip(
          jj.snapshot().pipe(
            Effect.provideService(NodeJj.RepositoryMutationTimeoutMs, 30)
          )
        )
        expect(refused.message).toContain("timed out waiting")
        expect(refused.cause).toMatchObject({ name: "JjInternalFault", code: "lock_timeout" })
        expect(existsSync(join(lock, "unknown-owner"))).toBe(true)
      })
    ))

  it.live("releases the lock after cancelling an active snapshot", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const jj = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => writeFile(join(root, "hold"), ""))
        const pending = yield* Effect.forkChild(jj.snapshot("cancelled"), { startImmediately: true })
        yield* until(async () => existsSync(join(root, "started")))
        yield* Fiber.interrupt(pending)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
        yield* Effect.promise(() => rm(join(root, "hold")))
        expect((yield* jj.snapshot()).commitId).toBe("0abc")
      })
    ))

  it.live("cancels a waiter without deleting another live owner's lock", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const lock = join(root, ".jj", "smithers.lock")
        yield* Effect.promise(async () => {
          await mkdir(lock)
          await writeFile(join(lock, `${hostname()}-${process.pid}-other`), "")
        })
        const pending = yield* Effect.forkChild(
          Effect.flatMap(Jj, (jj) => jj.restore("5a7ed")).pipe(Effect.provide(NodeJj.layerAt(root)))
        )
        yield* until(async () => (await readdir(join(root, ".jj"))).some((name) => name.startsWith(".smithers-lock-")))
        yield* Fiber.interrupt(pending)
        expect((yield* Effect.promise(() => readdir(lock))).sort()).toEqual([`${hostname()}-${process.pid}-other`])
        expect(yield* Effect.promise(() => readdir(join(root, ".jj")))).toEqual(["repo", "smithers.lock"])
        expect(existsSync(join(root, "started"))).toBe(false)
      })
    ))

  it.live("holds snapshot, restore, diff and revert together across separately built layers", () =>
    fixture((root) =>
      Effect.gen(function*() {
        const first = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        const second = yield* Effect.provide(Jj, NodeJj.layerAt(root))
        yield* Effect.promise(() => writeFile(join(root, "hold"), ""))
        const snapshot = yield* Effect.forkChild(first.snapshot("held"), { startImmediately: true })
        yield* until(async () => existsSync(join(root, "started")))
        const followers = yield* Effect.forkChild(
          Effect.all([second.restore("5a7ed"), second.diff("5a7ed", "@"), second.revert!("5a7ed")], {
            concurrency: "unbounded"
          })
        )
        yield* Effect.sleep("100 millis")
        expect((yield* Effect.promise(() => readFile(join(root, "calls"), "utf8"))).trim().split("\n")).toHaveLength(1)
        yield* Effect.promise(() => rm(join(root, "hold")))
        yield* Fiber.join(snapshot)
        yield* Fiber.join(followers)
        expect(existsSync(join(root, ".jj", "smithers.lock"))).toBe(false)
      })
    ))
})
