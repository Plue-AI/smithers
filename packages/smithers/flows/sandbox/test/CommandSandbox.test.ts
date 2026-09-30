import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Scope, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import { pidDirectory } from "../src/internal/pidDirectory.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-command-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** `sh -c "$1"` re-parses one argument the way `ssh` hands its command to the remote login shell. */
const joined = ["/bin/sh", "-c", "eval \"$1\"", "joined"]

/**
 * A machine that can be told, mid-session, to stop answering, to refuse new
 * sessions, or to restart. Its boot id is a file a fake `cat` on its PATH
 * serves for `/proc/sys/kernel/random/boot_id`, so a restart is one write.
 */
const switchable = (spawner: ChildProcessSpawner["Service"], name: string) => {
  const bin = join(root, `${name}-bin`)
  const boot = join(bin, "boot_id")
  mkdirSync(bin, { recursive: true })
  writeFileSync(boot, "boot-1\n")
  writeFileSync(
    join(bin, "cat"),
    `#!/bin/sh\nif [ "$1" = /proc/sys/kernel/random/boot_id ]; then exec /bin/cat ${boot}; fi\nexec /bin/cat "$@"\n`,
    { mode: 0o755 }
  )
  let state: "up" | "silent" | "refusing" | "unbuildable" = "up"
  const provider = CommandSandbox.make({
    spawner,
    workdir: join(root, name),
    heartbeat: "500 millis",
    prefix: Effect.suspend(() =>
      state === "up"
        ? Effect.succeed(["env", `PATH=${bin}:/usr/bin:/bin`])
        : state === "silent"
        ? Effect.succeed(["/bin/sh", "-c", "sleep 30", "silent"])
        : state === "refusing"
        ? Effect.succeed(["/bin/sh", "-c", "exit 255", "refusing"])
        : Effect.fail(new ProviderError({ code: "unavailable", message: "the workspace grant could not be fetched" }))
    )
  })
  return {
    provider,
    set: (next: typeof state) => (state = next),
    restart: () => writeFileSync(boot, "boot-2\n"),
    /** Puts the machine back as the scope closes, so teardown never waits on it. */
    restore: Effect.addFinalizer(() => Effect.sync(() => (state = "up")))
  }
}

/**
 * Waits, on real timers, until the command behind `pidfile` has started: the
 * spawn line writes the pid after the boot record, so a written pid means a
 * complete record.
 */
const untilStarted = (session: string, index: number) =>
  Effect.promise(async () => {
    const pidfile = join(pidDirectory, sessionSlug(session), `${index}.pid`)
    while (!existsSync(pidfile) || readFileSync(pidfile, "utf8").trim() === "") {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })

/** Real time passes; the heartbeat runs on real timers. */
const wait = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

describe("CommandSandbox", () => {
  it.effect("passes SandboxConformance over an empty prefix", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const provider = CommandSandbox.make({ spawner, prefix: [], workdir: join(root, "conformance") })
      const violations = yield* SandboxConformance.check(provider, { provides: { kill: true, ping: true } })
      expect(violations).toEqual([])
    }).pipe(Effect.provide(platform)), 120_000)

  it.effect(
    "passes SandboxConformance over a prefix that joins the guest argv into one command line",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const provider = CommandSandbox.make({
          spawner,
          prefix: joined,
          joinsArguments: true,
          workdir: join(root, "joined")
        })
        const violations = yield* SandboxConformance.check(provider, { provides: { kill: true, ping: true } })
        expect(violations).toEqual([])
      }).pipe(Effect.provide(platform)),
    120_000
  )

  it.effect(
    "quotes every guest argument for a joining prefix, so shell syntax survives the second parse",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const provider = CommandSandbox.make({
          spawner,
          prefix: joined,
          joinsArguments: true,
          workdir: join(root, "q")
        })
        const session = yield* provider.acquire("quoted")
        const process = yield* session.spawn("printf '%s|' \"a b\" 'c'\"'\"'d'", {})
        expect(yield* Stream.mkString(Stream.decodeText(process.stdout))).toBe("a b|c'd|")
        expect(yield* process.exitCode).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(platform)),
    30_000
  )

  for (const state of ["silent", "refusing", "unbuildable"] as const) {
    it.effect(`ends a running command with unavailable when the machine is ${state}`, () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = switchable(spawner, state)
        const session = yield* machine.provider.acquire(state)
        const process = yield* session.spawn("sleep 30", {})
        // Added last, so it runs first: teardown then reaches a machine that answers.
        yield* machine.restore
        // A beat that answers as the same boot leaves the command running.
        yield* wait(1_200)
        machine.set(state)
        const started = Date.now()
        const error = yield* Effect.flip(process.exitCode)
        expect(error).toMatchObject({
          code: "unavailable",
          message: "machine stopped answering; the command may still be running there"
        })
        expect(Date.now() - started).toBeLessThan(5_000)
      }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)
  }

  it.effect("ends every command a restart took, then runs the next one on the new boot", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const machine = switchable(spawner, "restarted")
      const session = yield* machine.provider.acquire("restarted")
      const first = yield* session.spawn("sleep 30", {})
      const second = yield* session.spawn("sleep 30", {})
      // Both record the boot they started on before the machine restarts.
      yield* untilStarted("restarted", 0)
      yield* untilStarted("restarted", 1)
      machine.restart()
      for (const lost of [first, second]) {
        expect(yield* Effect.flip(lost.exitCode)).toMatchObject({
          code: "unavailable",
          message: "machine restarted; the command it was running is gone"
        })
      }
      const next = yield* session.spawn("sleep 1.5; echo still-here", {})
      expect(yield* Stream.mkString(Stream.decodeText(next.stdout))).toBe("still-here\n")
      expect(yield* next.exitCode).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)

  it.effect(
    "ends every read the machine's restart took, and reads on the new boot after",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = switchable(spawner, "read-restart")
        const session = yield* machine.provider.acquire("read-restart")
        // A read of a FIFO with no writer blocks, so the read outlives beats.
        spawnSync("mkfifo", [join(root, "read-restart", "blocked")])
        spawnSync("mkfifo", [join(root, "read-restart", "blocked-too")])
        writeFileSync(join(root, "read-restart", "plain.txt"), "after\n")
        const blocked = yield* Effect.forkChild(Effect.flip(session.readFile(join(root, "read-restart", "blocked"))))
        const also = yield* Effect.forkChild(Effect.flip(session.readFile(join(root, "read-restart", "blocked-too"))))
        yield* wait(1_200)
        machine.restart()
        for (const read of [blocked, also]) {
          expect(yield* Fiber.join(read)).toMatchObject({
            code: "unavailable",
            message: "machine restarted; the command it was running is gone"
          })
        }
        expect(new TextDecoder().decode(yield* session.readFile(join(root, "read-restart", "plain.txt")))).toBe(
          "after\n"
        )
      }).pipe(Effect.scoped, Effect.provide(platform)),
    30_000
  )

  it.effect("ends a read when the machine stops answering", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const machine = switchable(spawner, "read-silent")
      const session = yield* machine.provider.acquire("read-silent")
      spawnSync("mkfifo", [join(root, "read-silent", "blocked")])
      const blocked = yield* Effect.forkChild(Effect.flip(session.readFile(join(root, "read-silent", "blocked"))))
      yield* wait(200)
      yield* machine.restore
      machine.set("refusing")
      expect(yield* Fiber.join(blocked)).toMatchObject({
        code: "unavailable",
        message: "machine stopped answering; the command may still be running there"
      })
    }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)

  it.effect("counts a wiped boot record, as a real restart leaves /tmp, as a restart", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const machine = switchable(spawner, "wiped")
      const session = yield* machine.provider.acquire("wiped")
      const lost = yield* session.spawn("sleep 30", {})
      yield* untilStarted("wiped", 0)
      rmSync(join(pidDirectory, sessionSlug("wiped"), "0.pid.boot"))
      expect(yield* Effect.flip(lost.exitCode)).toMatchObject({
        code: "unavailable",
        message: "machine restarted; the command it was running is gone"
      })
    }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)

  it.effect("counts a restart while a command is still starting as a restart", () =>
    Effect.gen(function*() {
      const local = yield* ChildProcessSpawner
      let holdNext = false
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      // Hold the next guest's framed script, so it never records a boot or pid.
      const spawner = makeSpawner((command) => {
        const hold = holdNext
        holdNext = false
        return hold && command._tag === "StandardCommand" && Stream.isStream(command.options.stdin)
          ? local.spawn(
            ChildProcess.make(command.command, command.args, {
              ...command.options,
              stdin: Stream.concat(Stream.fromEffectDrain(Effect.promise(() => held)), command.options.stdin)
            })
          )
          : local.spawn(command)
      })
      yield* Effect.addFinalizer(() => Effect.sync(release))
      const machine = switchable(spawner, "starting-restart")
      const session = yield* machine.provider.acquire("starting-restart")
      holdNext = true
      const lost = yield* session.spawn("sleep 30", {})
      // Beats on the unchanged boot keep the unstarted command waiting.
      yield* wait(1_200)
      expect(existsSync(join(pidDirectory, sessionSlug("starting-restart"), "0.pid"))).toBe(false)
      machine.restart()
      expect(yield* Effect.flip(lost.exitCode)).toMatchObject({
        code: "unavailable",
        message: "machine restarted; the command it was running is gone"
      })
    }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)

  it.effect(
    "counts pid and boot records wiped after the command was seen started as a restart",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = switchable(spawner, "records-wiped")
        const session = yield* machine.provider.acquire("records-wiped")
        const lost = yield* session.spawn("sleep 30", {})
        yield* untilStarted("records-wiped", 0)
        // A beat sees the command started before its records vanish.
        yield* wait(1_200)
        const pidfile = join(pidDirectory, sessionSlug("records-wiped"), "0.pid")
        renameSync(pidfile, `${pidfile}.kept`)
        renameSync(`${pidfile}.boot`, `${pidfile}.boot.kept`)
        // Put the pid back as the scope closes, so teardown signals the command.
        yield* Effect.addFinalizer(() => Effect.sync(() => renameSync(`${pidfile}.kept`, pidfile)))
        expect(yield* Effect.flip(lost.exitCode)).toMatchObject({
          code: "unavailable",
          message: "machine restarted; the command it was running is gone"
        })
      }).pipe(Effect.scoped, Effect.provide(platform)),
    30_000
  )

  it.effect(
    "keeps a long read running on the boot a spawned command's heartbeat adopted",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const machine = switchable(spawner, "adopted")
        const session = yield* machine.provider.acquire("adopted")
        const lost = yield* session.spawn("sleep 30", {})
        yield* untilStarted("adopted", 0)
        machine.restart()
        yield* Effect.flip(lost.exitCode)
        const fifo = join(root, "adopted", "slow")
        spawnSync("mkfifo", [fifo])
        const reading = yield* Effect.forkChild(session.readFile(fifo))
        // Beats pass while the read waits on its writer.
        yield* wait(1_500)
        spawn("/bin/sh", ["-c", `printf late > ${fifo}`])
        expect(new TextDecoder().decode(yield* Fiber.join(reading))).toBe("late")
      }).pipe(Effect.scoped, Effect.provide(platform)),
    30_000
  )

  it.effect("keeps a command started after an idle restart running", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const machine = switchable(spawner, "idle-restart")
      const session = yield* machine.provider.acquire("idle-restart")
      machine.restart()
      const after = yield* session.spawn("sleep 1.5; echo on-the-new-boot", {})
      expect(yield* Stream.mkString(Stream.decodeText(after.stdout))).toBe("on-the-new-boot\n")
      expect(yield* after.exitCode).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)

  it.effect("runs nothing when the command's cwd is missing", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const workdir = join(root, "missing-cwd")
      const session = yield* CommandSandbox.make({ spawner, prefix: [], workdir }).acquire("missing-cwd")
      const process = yield* session.spawn("touch ran", { cwd: "no-such-directory" })
      expect(yield* process.exitCode).not.toBe(0)
      expect(existsSync(join(workdir, "ran"))).toBe(false)
      expect(existsSync("ran")).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)

  it.effect("removes the session's pidfile directory when the session closes", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const provider = CommandSandbox.make({ spawner, prefix: [], workdir: join(root, "pids") })
      const pids = `${pidDirectory}/${sessionSlug("pids")}`
      const scope = yield* Scope.make()
      yield* Scope.provide(provider.acquire("pids"), scope)
      expect(existsSync(pids)).toBe(true)
      yield* Scope.close(scope, Exit.void)
      expect(existsSync(pids)).toBe(false)
    }).pipe(Effect.provide(platform)), 30_000)

  it.effect(
    "fails typed and names no argv when the prefix cannot start or cannot be built",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const missing = CommandSandbox.make({
          spawner,
          prefix: [join(root, "no-such", "ssh"), "vm+developer:grant-secret@host"],
          workdir: "/w"
        })
        const unstarted = yield* Effect.flip(Effect.scoped(missing.acquire("missing")))
        expect(unstarted).toBeInstanceOf(ProviderError)
        expect(unstarted.code).toBe("unavailable")
        expect(unstarted.cause).toBeUndefined()
        expect(unstarted.message).not.toContain("grant-secret")
        const refused = new ProviderError({ code: "unavailable", message: "the workspace grant expired" })
        const unbuilt = CommandSandbox.make({ spawner, prefix: Effect.fail(refused), workdir: "/w" })
        expect(yield* Effect.flip(Effect.scoped(unbuilt.acquire("unbuilt")))).toBe(refused)
      }).pipe(Effect.provide(platform)),
    30_000
  )

  it.effect("serves the GNU metadata operations only to a Linux guest", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const kernel = (name: string) => {
        const bin = join(root, `uname-${name}`)
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${name}\n`, { mode: 0o755 })
        return CommandSandbox.make({ spawner, prefix: ["env", `PATH=${bin}:/usr/bin:/bin`], workdir: join(root, name) })
      }
      expect((yield* kernel("Linux").acquire("linux")).files).toBeDefined()
      expect((yield* kernel("Darwin").acquire("darwin")).files).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)
})
