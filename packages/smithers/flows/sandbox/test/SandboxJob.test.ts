import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"

describe("Sandbox.job retained lifecycle", () => {
  it("refuses scoped ephemeral providers before acquisition", () => {
    let acquired = false
    expect(() =>
      Sandbox.job({
        acquire: () => {
          acquired = true
          return Effect.die("unexpected")
        }
      }, { command: "true" })
    ).toThrow(/retained/)
    expect(acquired).toBe(false)
  })
})

import * as CommandLine from "@smthrs/kernel/CommandLine"
import { Fiber, FileSystem, Layer, Stream } from "effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import { platform } from "./helpers/containedPlatform.ts"
import { makeWorkSeed } from "./helpers/workSeed.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
const fixture = () =>
  Effect.gen(function*() {
    const root = mkdtempSync(join(tmpdir(), "sandbox-job-test-"))
    roots.push(root)
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    const provider = DirectorySandbox.make({ fs, spawner, root: join(root, "machines"), persistence: "sticky" })
    const seed = makeWorkSeed()
    const key = `test-${roots.length}#g1`
    yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* provider.acquire(key)
      yield* session.writeFile(join(session.workdir, "seed.bundle"), seed.bundle)
      const child = yield* session.spawn("git clone -q seed.bundle checkout", {})
      const code = yield* child.exitCode
      expect(code).toBe(0)
    }))
    const session = yield* Effect.scoped(provider.acquire(key))
    const checkout = join(session.workdir, "checkout")
    // macOS has no util-linux setsid. This executable performs the actual POSIX
    // syscall and execs the exact argv, rather than simulating process liveness.
    const launcher = join(root, "setsid")
    writeFileSync(launcher, "#!/usr/bin/env python3\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n")
    chmodSync(launcher, 0o755)
    const command =
      `printf worker >>starts; printf changed > new.txt; printf stdout; printf stderr >&2; sleep 0.2; exit 7`
    const options = {
      command,
      files: { [join(checkout, "binary.dat")]: new Uint8Array([0, 255, 0, 1]) },
      capture: { checkout },
      jobDirectory: join(root, "jobs")
    }
    const wrapped = {
      ...provider,
      acquire: (id: string) =>
        provider.acquire(id).pipe(
          Effect.map((s) => ({
            ...s,
            spawn: (command: string, options: Parameters<typeof s.spawn>[1]) =>
              s.spawn(command.replace("setsid /bin/sh", `${CommandLine.quote(launcher)} /bin/sh`), options)
          }))
        )
    }
    return { root, provider: wrapped, key, options, checkout }
  })
const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(platform), Effect.provide(KeyValueStore.layerMemory))
const exited = (job: ReturnType<typeof Sandbox.job>, handle: Sandbox.JobHandle, key: string) =>
  Effect.gen(function*() {
    for (let i = 0; i < 30; i++) {
      const status = yield* job.status(handle, key)
      if (status._tag === "Exited") return status
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(
      `job never exited: ${readFileSync(join(handle.directory, "err"), "utf8")}; pid=${
        existsSync(join(handle.directory, "pid")) ? readFileSync(join(handle.directory, "pid"), "utf8") : "missing"
      }`
    )
  })

describe("retained directory process conformance", () => {
  it.live("concurrent starts launch once, survive their scopes, and replay collected work after destruction", () =>
    withPlatform(Effect.gen(function*() {
      const f = yield* fixture()
      const job = Sandbox.job(f.provider, f.options)
      const handles = yield* Effect.all([job.start(undefined, f.key), job.start(undefined, f.key)], {
        concurrency: "unbounded"
      })
      expect(handles[0]).toEqual(handles[1])
      const handle = handles[0]!
      const end = yield* exited(job, handle, f.key)
      expect(end.exitCode).toBe(7)
      expect(readFileSync(join(f.checkout, "starts"), "utf8")).toBe("worker")
      expect(new Uint8Array(readFileSync(join(f.checkout, "binary.dat")))).toEqual(new Uint8Array([0, 255, 0, 1]))
      const durableDir = join(f.root, "receipts")
      const result = yield* job.collect(handle, f.key, end).pipe(
        Effect.provide(KeyValueStore.layerFileSystem(durableDir))
      )
      expect(result).toMatchObject({ stdout: "stdout", stderr: "stderr", exitCode: 7, work: { _tag: "Changed" } })
      expect(result.work._tag === "Changed" && result.work.patch).toContain("new.txt")
      expect(existsSync(handle.workdir)).toBe(false)
      const recovered = Sandbox.job(f.provider, f.options)
      // Reconstruct the filesystem store after the machine has gone.
      expect(
        yield* recovered.collect(handle, f.key, end).pipe(Effect.provide(KeyValueStore.layerFileSystem(durableDir)))
      ).toEqual(result)
      expect(yield* recovered.status(handle, f.key)).toEqual({ _tag: "Lost" })
    })))
  it.live("cancel tombstones and ends the detached group; repeated cancellation is safe", () =>
    withPlatform(Effect.gen(function*() {
      const f = yield* fixture()
      const job = Sandbox.job(f.provider, {
        ...f.options,
        command: "sleep 30 & echo $! > nested.pid; echo started > started; wait"
      })
      const handle = yield* job.start(undefined, f.key)
      for (let i = 0; i < 100 && !existsSync(join(handle.directory, "pid")); i++) yield* Effect.sleep("10 millis")
      yield* Effect.sleep("2500 millis")
      expect(yield* job.status(handle, f.key)).toEqual({ _tag: "Running" })
      const pid = Number(readFileSync(join(handle.directory, "pid"), "utf8"))
      for (let i = 0; i < 100 && !existsSync(join(f.checkout, "nested.pid")); i++) yield* Effect.sleep("10 millis")
      const nested = Number(readFileSync(join(f.checkout, "nested.pid"), "utf8"))
      yield* job.cancel(handle, f.key)
      expect(existsSync(join(handle.directory, "cancelled"))).toBe(true)
      expect(() => process.kill(pid, 0)).toThrow()
      expect(() => process.kill(nested, 0)).toThrow()
      yield* job.cancel(handle, f.key)
      expect(yield* job.status(handle, f.key)).toEqual({ _tag: "Lost" })
    })))
  it.live("a cancelled mkdir winner cannot launch work after a concurrent start observes it", () =>
    withPlatform(Effect.gen(function*() {
      const f = yield* fixture()
      const ready = join(f.root, "ready"), release = join(f.root, "release"), worked = join(f.root, "worked")
      let first = true
      const gated = {
        ...f.provider,
        acquire: (id: string) =>
          f.provider.acquire(id).pipe(
            Effect.map((session) => ({
              ...session,
              spawn: (command: string, options: Parameters<typeof session.spawn>[1]) => {
                if (first && command.includes("if mkdir")) {
                  first = false
                  command = command.replace(
                    "; then\nprintf %s",
                    `; then\ntouch ${CommandLine.quote(ready)}; while ! test -f ${
                      CommandLine.quote(release)
                    }; do sleep 0.02; done\nprintf %s`
                  )
                }
                return session.spawn(command, options)
              }
            }))
          )
      }
      const job = Sandbox.job(gated, { ...f.options, command: `touch ${CommandLine.quote(worked)}` })
      const starting = yield* Effect.forkChild(Effect.exit(job.start(undefined, f.key)))
      for (let i = 0; i < 200 && !existsSync(ready); i++) yield* Effect.sleep("10 millis")
      expect(existsSync(ready)).toBe(true)
      const handle = yield* job.start(undefined, f.key)
      expect(yield* job.status(handle, f.key)).toEqual({ _tag: "Lost" })
      yield* job.cancel(handle, f.key)
      writeFileSync(release, "")
      const delayed = yield* Fiber.join(starting)
      expect(Exit.isFailure(delayed)).toBe(true)
      expect(existsSync(worked)).toBe(false)
    })))
  it.live("does not mistake a transport failure for Lost", () =>
    withPlatform(Effect.gen(function*() {
      const f = yield* fixture()
      const failing = {
        ...f.provider,
        attach: () => Effect.fail(new ProviderError({ code: "unavailable", message: "connection reset" }))
      }
      const job = Sandbox.job(failing, f.options)
      const handle = yield* job.start(undefined, f.key)
      const status = yield* Effect.exit(job.status(handle, f.key))
      expect(Exit.isFailure(status)).toBe(true)
      if (Exit.isFailure(status)) expect(String(status.cause)).toContain("connection reset")
      yield* f.provider.destroy!(handle)
    })))
})

// Unit transport fixtures isolate author validation and error propagation. Real
// process, filesystem, group, and crash behavior is exercised above and by the
// guarded microVM suite; these failures cannot be injected into a real network
// deterministically without changing its transport implementation.
const scriptFixture = () => {
  const state = {
    status: "Running",
    code: 0,
    key: "job#g1",
    missingKey: false,
    readFailure: false,
    destroys: 0,
    destroyFailure: false,
    acquires: 0,
    attachFailure: undefined as ProviderError | undefined,
    reads: new Map<string, string>(),
    commands: [] as string[]
  }
  const session: import("../src/Sandbox/Session.ts").Session = {
    id: state.key,
    remoteId: "machine",
    workdir: "/checkout",
    spawn: (command) => {
      state.commands.push(command)
      const stdout = command.startsWith("if test -f") ? state.status : ""
      return Effect.succeed({
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.make(new TextEncoder().encode("remote error")),
        exitCode: Effect.succeed(state.code)
      })
    },
    writeFile: () => Effect.void,
    readFile: (path) => {
      if (state.readFailure) return Effect.fail(new ProviderError({ code: "unavailable", message: "read failed" }))
      if (path.endsWith("/key")) {
        return state.missingKey
          ? Effect.fail(new ProviderError({ code: "not_found", message: "initializing" }))
          : Effect.succeed(new TextEncoder().encode(state.key))
      }
      const suffix = path.split("/").at(-1)!
      const value = state.reads.get(suffix) ??
        ({ out: "out", err: "err", exit: "0", base: "abc" } as Record<string, string>)[suffix]
      return value === undefined
        ? Effect.fail(new ProviderError({ code: "not_found", message: "missing" }))
        : Effect.succeed(new TextEncoder().encode(value))
    }
  }
  const provider: Sandbox.Provider = {
    retained: true,
    acquire: () => {
      state.acquires++
      return Effect.succeed(session)
    },
    attach: () => state.attachFailure ? Effect.fail(state.attachFailure) : Effect.succeed(session),
    destroy: () => {
      state.destroys++
      return state.destroyFailure
        ? Effect.fail(new ProviderError({ code: "unavailable", message: "destroy failed" }))
        : Effect.void
    }
  }
  const job = Sandbox.job(provider, {
    command: () => "true",
    files: () => ({ "brief.txt": new Uint8Array([1, 2, 3]) })
  })
  return { state, provider, job }
}
const typedFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(effect)
    return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  })

describe("retained job validation and failures", () => {
  it.each(["relative", "/a/../b", "/a\0b", "/tmp/.smthrs-sbx", "/tmp/.smthrs-sbx/jobs"])(
    "refuses unsafe root %s",
    (root) => {
      const f = scriptFixture()
      expect(() => Sandbox.job(f.provider, { command: "true", jobDirectory: root })).toThrow(/jobDirectory/)
      expect(f.state.acquires).toBe(0)
    }
  )
  it.effect("rejects bad keys and reserved files before acquiring", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      expect(yield* typedFailure(f.job.start(undefined, " "))).toBeDefined()
      for (const path of ["", "../escape", "/var/lib/smthrs-jobs/metadata", "nul\0file"]) {
        const job = Sandbox.job(f.provider, { command: "true", files: { [path]: new Uint8Array() } })
        expect(yield* typedFailure(job.start(undefined, f.state.key))).toBeDefined()
      }
      expect(f.state.acquires).toBe(0)
    }))
  it.effect("refuses captured metadata and launcher failures", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      const overlap = Sandbox.job(f.provider, { command: "true", jobDirectory: "/checkout/jobs" })
      expect(yield* typedFailure(overlap.start(undefined, f.state.key))).toBeDefined()
      f.state.code = 125
      expect(yield* typedFailure(f.job.start(undefined, f.state.key))).toBeDefined()
    }))
  it.effect("duplicate initialization with no key file still returns a handle", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      f.state.missingKey = true
      const handle = yield* f.job.start(undefined, f.state.key)
      expect(handle.id).toBe(f.state.key)
    }))
  it.effect("preserves read errors and refuses another directory owner", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      f.state.readFailure = true
      expect(yield* typedFailure(f.job.start(undefined, f.state.key))).toBeDefined()
      f.state.readFailure = false
      expect(yield* typedFailure(f.job.start(undefined, "other#g1"))).toBeDefined()
    }))
  it.effect("status reports all outcomes and refuses corrupt records or mismatched handles", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      const handle = yield* f.job.start(undefined, f.state.key)
      for (
        const [status, result] of [["Running", { _tag: "Running" }], ["Lost", { _tag: "Lost" }], ["Exited 17", {
          _tag: "Exited",
          exitCode: 17
        }]] as const
      ) {
        f.state.status = status
        expect(yield* f.job.status(handle, f.state.key)).toEqual(result)
      }
      f.state.status = "Exited invalid"
      expect(yield* typedFailure(f.job.status(handle, f.state.key))).toBeDefined()
      f.state.code = 9
      expect(yield* typedFailure(f.job.status(handle, f.state.key))).toBeDefined()
      expect(yield* typedFailure(f.job.status(handle, "other"))).toBeDefined()
      expect(yield* typedFailure(f.job.cancel(handle, "other"))).toBeDefined()
      expect(yield* typedFailure(f.job.collect(handle, "other", { _tag: "Exited", exitCode: 0 }))).toBeDefined()
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
  it.effect("collect persists before failing destroy and replays without reading a missing machine", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      const handle = yield* f.job.start(undefined, f.state.key)
      f.state.destroyFailure = true
      expect(yield* typedFailure(f.job.collect(handle, f.state.key, { _tag: "Exited", exitCode: 0 }))).toBeDefined()
      f.state.destroyFailure = false
      f.state.attachFailure = new ProviderError({ code: "not_found", message: "machine gone" })
      expect(yield* f.job.collect(handle, f.state.key, { _tag: "Exited", exitCode: 0 })).toMatchObject({
        stdout: "out",
        stderr: "err",
        exitCode: 0
      })
      expect(f.state.destroys).toBe(2)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
  it.effect("collect refuses corrupt exits and receipts", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      const handle = yield* f.job.start(undefined, f.state.key)
      f.state.reads.set("exit", "wrong")
      expect(yield* typedFailure(f.job.collect(handle, f.state.key, { _tag: "Exited", exitCode: 0 }))).toBeDefined()
      const store = yield* KeyValueStore.KeyValueStore
      yield* store.set(`@smthrs/sandbox/job/collected/${encodeURIComponent(f.state.key)}`, "bad json")
      expect(yield* typedFailure(f.job.collect(handle, f.state.key, { _tag: "Exited", exitCode: 0 }))).toBeDefined()
      expect(f.state.destroys).toBe(0)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
  it.effect("receipt read and write failures preserve the machine", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      const handle = yield* f.job.start(undefined, f.state.key)
      const store = yield* KeyValueStore.KeyValueStore
      const error = new KeyValueStore.KeyValueStoreError({ method: "get", message: "store down" })
      const noRead = { ...store, get: () => Effect.fail(error) }
      expect(
        yield* typedFailure(
          f.job.collect(handle, f.state.key, { _tag: "Exited", exitCode: 0 }).pipe(
            Effect.provideService(KeyValueStore.KeyValueStore, noRead)
          )
        )
      ).toMatchObject({ code: "unavailable" })
      const noWrite = { ...store, set: () => Effect.fail(error) }
      expect(
        yield* typedFailure(
          f.job.collect(handle, f.state.key, { _tag: "Exited", exitCode: 0 }).pipe(
            Effect.provideService(KeyValueStore.KeyValueStore, noWrite)
          )
        )
      ).toMatchObject({ code: "unavailable" })
      expect(f.state.destroys).toBe(0)
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
  it.effect("cancel refuses transport and shell failures without destroying unconfirmed work", () =>
    Effect.gen(function*() {
      const f = scriptFixture()
      const handle = yield* f.job.start(undefined, f.state.key)
      f.state.attachFailure = new ProviderError({ code: "unavailable", message: "uncertain" })
      expect(yield* typedFailure(f.job.cancel(handle, f.state.key))).toBeDefined()
      expect(f.state.destroys).toBe(0)
      f.state.attachFailure = undefined
      f.state.code = 125
      expect(yield* typedFailure(f.job.cancel(handle, f.state.key))).toBeDefined()
      expect(f.state.destroys).toBe(0)
      f.state.attachFailure = new ProviderError({ code: "not_found", message: "gone" })
      yield* f.job.cancel(handle, f.state.key)
      expect(f.state.destroys).toBe(1)
    }))
})

describe("retained directory identity", () => {
  it.live("refuses a foreign machine handle without removing the owned directory", () =>
    withPlatform(Effect.gen(function*() {
      const f = yield* fixture()
      const session = yield* Effect.scoped(f.provider.acquire(f.key))
      const wrong = { id: session.id, remoteId: "/foreign" }
      expect(yield* typedFailure(Effect.scoped(f.provider.attach!(wrong)))).toMatchObject({ code: "spawn_error" })
      expect(yield* typedFailure(f.provider.destroy!(wrong))).toMatchObject({ code: "spawn_error" })
      expect(existsSync(session.workdir)).toBe(true)
      yield* f.provider.destroy!(session)
    })))
})
