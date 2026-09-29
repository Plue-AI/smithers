import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import * as TestClock from "effect/testing/TestClock"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
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
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})
const errno = (code: string) => Object.assign(new Error(code), { code })

const fixture = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "flows-jj-lock-"))
      await mkdir(join(root, ".jj"))
      await mkdir(join(root, "nested"))
      const binary = join(root, "jj-shim")
      await writeFile(
        binary,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "jj 0.39.0"; exit 0; fi
printf '%s\\n' "$*" >> calls
: > started
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
          expect(yield* Effect.promise(() => readdir(join(root, ".jj")))).toEqual([])
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
    it.live(`preserves an owner whose death cannot be established locally: ${owner}`, () =>
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
          let now = 0
          vi.spyOn(Date, "now").mockImplementation(() => now += 120_001)
          expect((yield* Effect.flip(jj.snapshot())).message).toContain("timed out waiting")
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
        let now = 0
        vi.spyOn(Date, "now").mockImplementation(() => now += 120_001)
        expect((yield* Effect.flip(jj.snapshot())).message).toContain("timed out waiting")
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
        expect(yield* Effect.promise(() => readdir(join(root, ".jj")))).toEqual(["smithers.lock"])
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
