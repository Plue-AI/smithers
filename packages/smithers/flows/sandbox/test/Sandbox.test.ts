import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Path, PlatformError, Stream } from "effect"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"

const decoder = new TextDecoder()

const withSession = <A, E>(
  provider: Sandbox.TestSessionProvider,
  body: (session: Sandbox.Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("probe"), body))

const platformReason = (error: unknown): string =>
  error instanceof PlatformError.PlatformError ? error.reason._tag : `not a PlatformError: ${String(error)}`

describe("Sandbox.TestSession", () => {
  it.effect("round-trips files through an isolated in-memory tree", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ files: { "/sandbox/seed.txt": "seeded" } })
      const written = new Uint8Array([1, 2, 3])
      const result = yield* withSession(provider, (session) =>
        Effect.gen(function*() {
          yield* session.writeFile("/sandbox/out.bin", written)
          const seed = yield* session.readFile("/sandbox/seed.txt")
          const out = yield* session.readFile("/sandbox/out.bin")
          return { seed: decoder.decode(seed), out }
        }))
      // Mutating what was written or read must not reach the stored tree.
      written[0] = 9
      result.out[1] = 9
      expect(result.seed).toBe("seeded")
      expect(Array.from(provider.state.files.get("/sandbox/out.bin")!)).toEqual([1, 2, 3])
      expect(provider.state.acquired).toEqual(["probe"])
      expect(provider.state.released).toBe(1)
    }))

  it.effect("reports an absent file with not_found and an unknown command with exit 127", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ files: { "/sandbox/bytes": new Uint8Array([7]) } })
      const outcome = yield* withSession(provider, (session) =>
        Effect.gen(function*() {
          const absent = yield* Effect.flip(session.readFile("/sandbox/missing"))
          const process = yield* Effect.scoped(session.spawn("unscripted", {}))
          const stderr = yield* Stream.mkString(Stream.decodeText(process.stderr))
          const code = yield* process.exitCode
          return { absent, stderr, code }
        }))
      expect(outcome.absent).toBeInstanceOf(ProviderError)
      expect((outcome.absent as ProviderError).code).toBe("not_found")
      expect(outcome.stderr).toContain("command not found")
      expect(outcome.code).toBe(127)
    }))

  it.effect("resolves scripts through the record, then the resolver, honoring failures and pings", () =>
    Effect.gen(function*() {
      const failure = new ProviderError({ code: "spawn_error", message: "refused" })
      const provider = Sandbox.TestSession.make({
        session: "named",
        remoteId: "vm-1",
        workdir: "/work",
        scripts: { direct: { stdout: "record" } },
        script: (command) => command === "resolved" ? { stdout: "resolver", exitCode: 3 } : { failure },
        ping: Effect.void
      })
      const outcome = yield* withSession(provider, (session) =>
        Effect.gen(function*() {
          const direct = yield* Effect.scoped(
            Effect.flatMap(session.spawn("direct", {}), (process) => Stream.mkString(Stream.decodeText(process.stdout)))
          )
          const resolved = yield* Effect.scoped(
            Effect.flatMap(session.spawn("resolved", {}), (process) => process.exitCode)
          )
          const refused = yield* Effect.flip(Effect.scoped(Effect.asVoid(session.spawn("anything", {}))))
          yield* Effect.scoped(Effect.asVoid(session.spawn("direct", { stdin: new Uint8Array([9, 0, 9]) })))
          yield* session.ping!
          return { direct, resolved, refused, id: session.id, remoteId: session.remoteId, workdir: session.workdir }
        }))
      expect(outcome).toMatchObject({
        direct: "record",
        resolved: 3,
        id: "named",
        remoteId: "vm-1",
        workdir: "/work"
      })
      expect(outcome.refused).toBe(failure)
      expect(provider.state.commands).toEqual(["direct", "resolved", "anything", "direct"])
      // The double records the standard input each spawn received, so
      // projection tests can assert delivery without a real machine.
      expect(provider.state.inputs.slice(0, 3)).toEqual([undefined, undefined, undefined])
      expect(Array.from(provider.state.inputs[3]!)).toEqual([9, 0, 9])
    }))

  it.effect("fails acquisition when scripted to", () =>
    Effect.gen(function*() {
      const refusal = new ProviderError({ code: "unavailable", message: "no capacity" })
      const provider = Sandbox.TestSession.make({ acquireFailure: refusal })
      const outcome = yield* Effect.exit(Effect.scoped(provider.acquire("any")))
      expect(Exit.isFailure(outcome)).toBe(true)
      expect(provider.state.acquired).toEqual([])
    }))
})

describe("Sandbox.commandProvider", () => {
  it.effect("acquires on open, spawns through the held session, and releases with the scope", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ scripts: { greet: { stdout: "hello" } } })
      const projected = Sandbox.commandProvider(provider, { session: "cmd" })
      const output = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* projected.open("cmd")
          return yield* Effect.scoped(
            Effect.flatMap(
              projected.spawn("greet", {}),
              (process) => Stream.mkString(Stream.decodeText(process.stdout))
            )
          )
        })
      )
      expect(output).toBe("hello")
      expect(provider.state.acquired).toEqual(["cmd"])
      expect(provider.state.released).toBe(1)
    }))

  it.effect("runs a spawn composed before the session opens", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ scripts: { greet: { stdout: "hello" } } })
      const projected = Sandbox.commandProvider(provider, { session: "cmd" })
      const program = Effect.andThen(projected.open("cmd"), projected.spawn("greet", {}))
      const output = yield* Effect.scoped(
        Effect.flatMap(program, (process) => Stream.mkString(Stream.decodeText(process.stdout)))
      )
      expect(output).toBe("hello")
      expect(provider.state.commands).toEqual(["greet"])
      expect(provider.state.released).toBe(1)
    }))

  it.effect("runs a kill composed before the session opens", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make()
      const delivered: Array<unknown> = []
      const projected = Sandbox.commandProvider({
        acquire: (key) =>
          Effect.map(provider.acquire(key), (session): Sandbox.Session => ({
            ...session,
            kill: (process, signal) =>
              Effect.sync(() => {
                delivered.push([process, signal])
              })
          }))
      }, { session: "cmd", provides: { kill: true } })
      const process = { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) }
      const program = Effect.andThen(projected.open("cmd"), projected.kill!(process, "SIGTERM"))
      yield* Effect.scoped(program)
      expect(delivered).toEqual([[process, "SIGTERM"]])
      expect(provider.state.released).toBe(1)
    }))

  it.effect("rechecks the session for effects built during an earlier generation", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make()
      const delivered: Array<string> = []
      const projected = Sandbox.commandProvider({
        acquire: (key) =>
          Effect.map(provider.acquire(key), (session): Sandbox.Session => ({
            ...session,
            spawn: () =>
              Effect.sync(() => {
                delivered.push(`spawn:${key}`)
                return { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) }
              }),
            kill: () =>
              Effect.sync(() => {
                delivered.push(`kill:${key}`)
              })
          }))
      }, { session: "cmd", provides: { kill: true } })
      const pending = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* projected.open("first")
          return {
            spawn: projected.spawn("greet", {}),
            kill: projected.kill!(
              { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) },
              "SIGTERM"
            )
          }
        })
      )
      expect((yield* Effect.flip(Effect.scoped(pending.spawn))).code).toBe("unavailable")
      expect((yield* Effect.flip(pending.kill)).code).toBe("unavailable")
      expect(delivered).toEqual([])
      yield* Effect.scoped(
        Effect.andThen(projected.open("second"), Effect.andThen(pending.spawn, pending.kill))
      )
      expect(delivered).toEqual(["spawn:second", "kill:second"])
      expect(provider.state.released).toBe(2)
    }))

  it.effect("refuses to spawn, signal, or ping with no open session", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ ping: Effect.void })
      const projected = Sandbox.commandProvider(provider, {
        session: "cmd",
        provides: { kill: true, ping: true }
      })
      const spawn = yield* Effect.flip(Effect.scoped(Effect.asVoid(projected.spawn("greet", {}))))
      const kill = yield* Effect.flip(
        projected.kill!({ stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) }, "SIGTERM")
      )
      const ping = yield* Effect.flip(projected.ping!)
      for (const error of [spawn, kill, ping]) {
        expect(error).toBeInstanceOf(ProviderError)
        expect((error as ProviderError).code).toBe("unavailable")
      }
    }))

  it.effect("fails a declared capability the acquired session does not provide", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make()
      const projected = Sandbox.commandProvider(provider, {
        session: "cmd",
        provides: { kill: true, ping: true }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* projected.open("cmd")
          const kill = yield* Effect.flip(
            projected.kill!(
              { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) },
              "SIGTERM"
            )
          )
          const ping = yield* Effect.flip(projected.ping!)
          return { kill, ping }
        })
      )
      expect((outcome.kill as ProviderError).message).toContain("does not provide kill")
      expect((outcome.ping as ProviderError).message).toContain("does not provide ping")
    }))

  it.effect("declares no capability it was not told about", () =>
    Effect.gen(function*() {
      const projected = Sandbox.commandProvider(Sandbox.TestSession.make(), { session: "cmd" })
      expect(projected.kill).toBeUndefined()
      expect(projected.ping).toBeUndefined()
    }))

  it.effect("lets a stale generation's finalizer leave a newer session in place", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ scripts: { greet: { stdout: "still here" } } })
      const projected = Sandbox.commandProvider(provider, { session: "cmd" })
      const output = yield* Effect.gen(function*() {
        const first = yield* Scope.make()
        yield* Effect.provideService(projected.open("cmd"), Scope.Scope, first)
        const second = yield* Scope.make()
        yield* Effect.provideService(projected.open("cmd"), Scope.Scope, second)
        // Closing the FIRST generation must not clear the second's session.
        yield* Scope.close(first, Exit.void)
        const output = yield* Effect.scoped(
          Effect.flatMap(projected.spawn("greet", {}), (process) => Stream.mkString(Stream.decodeText(process.stdout)))
        )
        yield* Scope.close(second, Exit.void)
        return output
      })
      expect(output).toBe("still here")
      expect(provider.state.released).toBe(2)
    }))
})

describe("Sandbox.fileSystem", () => {
  const probeSession = (
    provider: Sandbox.TestSessionProvider
  ): Effect.Effect<FileSystem.FileSystem, ProviderError, Scope.Scope> =>
    Effect.map(provider.acquire("probe"), Sandbox.fileSystem)

  it.effect("serves reads and writes natively from the session", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ files: { "/sandbox/in.txt": "from the machine" } })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          const text = yield* files.readFileString("/sandbox/in.txt")
          yield* files.writeFileString("/sandbox/out.txt", "to the machine")
          yield* files.writeFile("/sandbox/out.bin", new Uint8Array([9, 8]))
          const bytes = yield* files.readFile("/sandbox/out.bin")
          const missing = yield* Effect.flip(files.readFile("/sandbox/none"))
          return { text, bytes: Array.from(bytes), missing: platformReason(missing) }
        })
      )
      expect(outcome).toEqual({ text: "from the machine", bytes: [9, 8], missing: "NotFound" })
      expect(decoder.decode(provider.state.files.get("/sandbox/out.txt"))).toBe("to the machine")
      expect(provider.state.commands).toEqual([])
    }))

  it.effect.each(
    [
      { code: "aborted", reason: "Unknown" },
      { code: "timeout", reason: "TimedOut" },
      { code: "unavailable", reason: "Unknown" },
      { code: "not_found", reason: "NotFound" },
      { code: "spawn_error", reason: "Unknown" },
      { code: "unknown", reason: "Unknown" }
    ] as const
  )("maps provider code $code to $reason at the filesystem seam", ({ code, reason }) =>
    Effect.gen(function*() {
      // `unavailable` is the shared table's one filesystem exception: a
      // broken session must not be mistaken for an absent path.
      const failure = new ProviderError({ code, message: `${code} while reading` })
      const provider = Sandbox.TestSession.make()
      const error = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("probe")
          const files = Sandbox.fileSystem({
            ...session,
            readFile: () => Effect.fail(failure)
          })
          return yield* Effect.flip(files.readFile("report.bin"))
        })
      )

      expect(error).toBeInstanceOf(PlatformError.PlatformError)
      expect(error.reason).toMatchObject({
        _tag: reason,
        pathOrDescriptor: "/sandbox/report.bin",
        cause: failure
      })
    }))

  it.effect("answers exists from the probe's exit code, restating denial, and surfaces probe breakage", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command.includes(" /there ")
            ? { exitCode: 0 }
            : command.includes(" /absent ")
            ? { exitCode: 1 }
            : command.includes(" /denied ")
            ? { exitCode: 12 }
            : command.includes(" /under-file ")
            ? { exitCode: 11 }
            : { exitCode: 2, stderr: "sh: test: broken" }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          return {
            there: yield* files.exists("/there"),
            absent: yield* files.exists("/absent"),
            // The platform `exists` converts only `NotFound` into `false`;
            // a path an unsearchable ancestor hides or a non-directory
            // ancestor blocks fails the way `access(2)` does.
            denied: platformReason(yield* Effect.flip(files.exists("/denied"))),
            underFile: platformReason(yield* Effect.flip(files.exists("/under-file"))),
            broken: platformReason(yield* Effect.flip(files.exists("/broken")))
          }
        })
      )
      expect(outcome).toEqual({
        there: true,
        absent: false,
        denied: "PermissionDenied",
        underFile: "BadResource",
        broken: "Unknown"
      })
      expect(provider.state.commands[0]).toBe(
        `if [ -e /there ]; then exit 0; fi; p=/there; ` +
          `while [ "$p" != / ]; do p=$(dirname "$p"); if [ -e "$p" ]; then ` +
          `if [ ! -d "$p" ]; then exit 11; elif [ ! -x "$p" ]; then exit 12; else exit 1; fi; fi; done; exit 1`
      )
    }))

  it.effect("derives stat from the compound probe, in every shape", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command.includes(" /file ")
            ? { stdout: "File 42" }
            : command.includes(" /dir ")
            ? { stdout: "Directory 0" }
            : command.includes(" /dangling ")
            ? { stdout: "SymbolicLink 0" }
            : command.includes(" /odd ")
            ? { stdout: "Fifo 0" }
            : command.includes(" /absent")
            ? { exitCode: 9 }
            : { exitCode: 2, stderr: "stat probe broke" }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          const file = yield* files.stat("/file")
          const dir = yield* files.stat("/dir")
          const dangling = yield* files.stat("/dangling")
          const odd = yield* files.stat("/odd")
          const absent = platformReason(yield* Effect.flip(files.stat("/absent")))
          const broken = platformReason(yield* Effect.flip(files.stat("/broken")))
          return { file, dir, dangling, odd, absent, broken }
        })
      )
      expect(outcome.file.type).toBe("File")
      expect(outcome.file.size).toBe(42n)
      expect(outcome.dir.type).toBe("Directory")
      expect(outcome.dangling.type).toBe("SymbolicLink")
      expect(outcome.odd.type).toBe("Unknown")
      expect(outcome.absent).toBe("NotFound")
      expect(outcome.broken).toBe("Unknown")
    }))

  it.effect("lists directories flat and recursively, tolerating outlier entries", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command.startsWith("if [ -d /tree/ ]")
            ? {
              stdout: command.includes("-maxdepth 1")
                ? "/tree/a\0/tree/z.txt\0"
                : "/tree/a\0/tree/a/b.txt\0/elsewhere/x\0"
            }
            : command.includes(" /gone ")
            ? { exitCode: 9 }
            : command.includes(" /plain ")
            ? { exitCode: 11 }
            : { exitCode: 2, stderr: "ls: exploded" }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          return {
            flat: yield* files.readDirectory("/tree/"),
            deep: yield* files.readDirectory("/tree/", { recursive: true }),
            gone: platformReason(yield* Effect.flip(files.readDirectory("/gone"))),
            // Listing a present non-directory is the `ENOTDIR` the platform
            // reports as `BadResource`, not a `NotFound`.
            plain: platformReason(yield* Effect.flip(files.readDirectory("/plain"))),
            broken: platformReason(yield* Effect.flip(files.readDirectory("/broken")))
          }
        })
      )
      expect(outcome.flat).toEqual(["a", "z.txt"])
      expect(outcome.deep).toEqual(["/elsewhere/x", "a", "a/b.txt"])
      expect(outcome.gone).toBe("NotFound")
      expect(outcome.plain).toBe("BadResource")
      expect(outcome.broken).toBe("Unknown")
      expect(provider.state.commands[0]).toBe(
        "if [ -d /tree/ ]; then find -H /tree -mindepth 1 -maxdepth 1 -print0; elif [ -e /tree/ ]; then exit 11; else exit 9; fi"
      )
      expect(provider.state.commands[1]).toBe(
        "if [ -d /tree/ ]; then find -H /tree -mindepth 1 -print0; elif [ -e /tree/ ]; then exit 11; else exit 9; fi"
      )
    }))

  it.effect("shapes directory making, removal, and renames as their POSIX lines", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command.includes("refused")
            ? { exitCode: 1, stderr: "refused" }
            : command.includes("/occupied")
            ? { exitCode: 10 }
            : command.includes("/orphan")
            ? { exitCode: 9 }
            : command.includes("/missing-src")
            ? { exitCode: 9 }
            : command.includes("/into-dir")
            ? { exitCode: 11 }
            : command.includes("/absent") && command.startsWith("if [ -e")
            ? { exitCode: 9 }
            : { exitCode: 0 }
      })
      yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          yield* files.makeDirectory("/deep/tree", { recursive: true })
          yield* files.makeDirectory("/flat")
          yield* files.remove("/old", { recursive: true, force: true })
          yield* files.remove("/single")
          yield* files.rename("/from", "/to")
          const failed = yield* Effect.flip(files.makeDirectory("/refused"))
          // An occupied `mkdir` target is AlreadyExists in both modes (the
          // recursive form refuses only a non-directory occupant), and a
          // missing parent is NotFound — the reasons the platform
          // implementations report for `EEXIST` and `ENOENT`.
          const occupied = yield* Effect.flip(files.makeDirectory("/occupied"))
          const occupiedByFile = yield* Effect.flip(files.makeDirectory("/occupied", { recursive: true }))
          const orphan = yield* Effect.flip(files.makeDirectory("/orphan/child"))
          const unremoved = yield* Effect.flip(files.remove("/refused"))
          // An unforced removal of a missing path is NotFound, the reason the
          // platform implementations report and an idempotent caller catches;
          // a forced one is a success, as it is on every other host.
          const absent = yield* Effect.flip(files.remove("/absent"))
          expect(platformReason(absent)).toBe("NotFound")
          yield* files.remove("/absent", { force: true })
          const unrenamed = yield* Effect.flip(files.rename("/refused", "/nowhere"))
          // A rename's missing source is NotFound, and an existing directory
          // destination is the `EISDIR` refusal (`mv` would silently move the
          // source *into* it instead).
          const missingSource = yield* Effect.flip(files.rename("/missing-src", "/anywhere"))
          const ontoDirectory = yield* Effect.flip(files.rename("/from", "/into-dir"))
          expect(platformReason(failed)).toBe("Unknown")
          expect(platformReason(occupied)).toBe("AlreadyExists")
          expect(platformReason(occupiedByFile)).toBe("AlreadyExists")
          expect(platformReason(orphan)).toBe("NotFound")
          expect(platformReason(unremoved)).toBe("Unknown")
          expect(platformReason(unrenamed)).toBe("Unknown")
          expect(platformReason(missingSource)).toBe("NotFound")
          expect(platformReason(ontoDirectory)).toBe("BadResource")
        })
      )
      expect(provider.state.commands.slice(0, 5)).toEqual([
        "if [ -d /deep/tree ]; then exit 0; elif [ -e /deep/tree ]; then exit 10; else mkdir -p /deep/tree; fi",
        `if [ -e /flat ] || [ -h /flat ]; then exit 10; elif [ ! -e "$(dirname /flat)" ]; then exit 9; else mkdir /flat; fi`,
        "rm -r -f /old",
        "if [ -e /single ] || [ -h /single ]; then rm /single; else exit 9; fi",
        "if [ ! -e /from ] && [ ! -h /from ]; then exit 9; elif [ -d /to ]; then " +
        "if [ -h /to ] || [ ! -d /from ] || [ -h /from ]; then exit 11; elif [ /from -ef /to ]; then :; " +
        "else mv -T /from /to; c=$?; if [ \"$c\" -eq 64 ]; then exit 13; fi; exit \"$c\"; fi; else mv /from /to; fi"
      ])
    }))

  it.effect("resolves real paths and link targets, refusing what the probe refuses", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command === "if [ -e /link ]; then readlink -f /link; else exit 9; fi"
            ? { stdout: "/real/target\n" }
            : command === "if [ -e /link ] || [ -h /link ]; then readlink /link; else exit 9; fi"
            ? { stdout: "/real/target\n" }
            : command.includes(" /missing ")
            ? { exitCode: 9 }
            : command.includes(" /fried ")
            ? { exitCode: 1, stderr: "readlink: fried" }
            : { exitCode: 1, stderr: "readlink: no" }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          return {
            real: yield* files.realPath("/link"),
            target: yield* files.readLink("/link"),
            // Presence is probed before `readlink` runs, so absence is
            // NotFound on both operations (`readlink -f` would happily exit 0
            // for a missing path, and bare `readlink` cannot tell "missing"
            // from "not a link"); a readlink that breaks on a present path is
            // the probe's own failure; and a present non-link stays the
            // caller's BadArgument.
            missing: platformReason(yield* Effect.flip(files.realPath("/missing"))),
            missingLink: platformReason(yield* Effect.flip(files.readLink("/missing"))),
            fried: platformReason(yield* Effect.flip(files.realPath("/fried"))),
            notLink: platformReason(yield* Effect.flip(files.readLink("/plain")))
          }
        })
      )
      expect(outcome).toEqual({
        real: "/real/target",
        target: "/real/target",
        missing: "NotFound",
        missingLink: "NotFound",
        fried: "Unknown",
        notLink: "BadArgument"
      })
    }))

  it.effect("roots relative paths at the session workdir", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        workdir: "/work",
        script: (command) => command.startsWith("if [ -e /work/probed.txt ]") ? { exitCode: 0 } : { exitCode: 1 }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          yield* files.writeFileString("rel.txt", "rooted")
          yield* files.writeFileString("./dotted.txt", "rooted too")
          return {
            probed: yield* files.exists("probed.txt"),
            written: yield* files.readFileString("rel.txt")
          }
        })
      )
      expect(outcome).toEqual({ probed: true, written: "rooted" })
      expect(provider.state.files.has("/work/rel.txt")).toBe(true)
      expect(provider.state.files.has("/work/dotted.txt")).toBe(true)
    }))

  it.effect("reports a silent probe failure by its exit code and refuses garbled stat output", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command.startsWith("if [ -e /broken ]")
            ? { exitCode: 2 }
            : command.includes("'/garbled'") || command.includes(" /garbled ")
            ? { stdout: "" }
            : { exitCode: 0 }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          const silent = yield* Effect.flip(files.exists("/broken"))
          // A stat probe that answers nothing is a failure, never a zero-byte
          // file: the size contract is exact or absent.
          const garbled = yield* Effect.flip(files.stat("/garbled"))
          // "" and "." both resolve to the workdir itself.
          yield* files.makeDirectory(".")
          yield* files.makeDirectory("")
          return { silent, garbled }
        })
      )
      expect(String(outcome.silent)).toContain("probe exited 2")
      expect(platformReason(outcome.garbled)).toBe("Unknown")
      expect(String(outcome.garbled)).toContain("instead of a type and a size")
      expect(provider.state.commands).toContain(
        `if [ -e /sandbox ] || [ -h /sandbox ]; then exit 10; elif [ ! -e "$(dirname /sandbox)" ]; then exit 9; else mkdir /sandbox; fi`
      )
    }))

  it.effect("lists the filesystem root by its one slash", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ script: () => ({ stdout: "/etc\0/tmp\0" }) })
      const listed = yield* Effect.scoped(
        Effect.flatMap(probeSession(provider), (files) => files.readDirectory("//"))
      )
      expect(listed).toEqual(["etc", "tmp"])
      expect(provider.state.commands[0]).toContain("find -H / -mindepth 1 -maxdepth 1 -print0")
    }))

  it.effect("frames the listing with NUL, so a pseudo-terminal cannot columnize it", () =>
    Effect.gen(function*() {
      // POSIX `ls` columnizes when its output is a terminal, and `AwsSandbox`
      // runs every command through a Session Manager pseudo-terminal: a bare
      // `ls -A` came back as one space-padded line. The listing is `find
      // -print0`, which no terminal reframes; this session is that terminal
      // and columnizes any `ls` it is asked for.
      const pty = Sandbox.TestSession.make({
        script: (command) =>
          command.includes("-print0")
            ? { stdout: "/tree/a.txt\0/tree/b.txt\0/tree/c.txt\0" }
            : command.includes("ls")
            ? { stdout: "a.txt      b.txt      c.txt\n" }
            : { exitCode: 0 }
      })
      const listed = yield* Effect.scoped(
        Effect.flatMap(probeSession(pty), (files) => files.readDirectory("/tree"))
      )
      expect(listed).toEqual(["a.txt", "b.txt", "c.txt"])
    }))

  it.effect("roots every probe path at the session workdir, the root included", () =>
    Effect.gen(function*() {
      // The rule's cases live in test/RootedPath.test.ts; this proves the probe
      // paths go through it with the session's own workdir.
      const provider = Sandbox.TestSession.make({ workdir: "/work//", script: () => ({ exitCode: 0 }) })
      const rooted = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          for (const path of [".", ".//y", "/absolute"]) {
            yield* files.makeDirectory(path)
          }
        })
      )
      expect(rooted).toBeUndefined()
      const targets = provider.state.commands.map((command) => /mkdir (.*); fi$/.exec(command)?.[1])
      expect(targets).toEqual(["/work", "/work/y", "/absolute"])

      // A session whose workspace IS the root still names the root, not the
      // empty string the host shell would read as its own directory.
      const atRoot = Sandbox.TestSession.make({ workdir: "/", script: () => ({ exitCode: 0 }) })
      yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(atRoot)
          yield* files.makeDirectory(".")
          yield* files.makeDirectory("etc")
        })
      )
      expect(atRoot.state.commands.map((command) => /mkdir (.*); fi$/.exec(command)?.[1])).toEqual(["/", "/etc"])
    }))

  it.effect("hands a native override the rooted path, and reports its failure as its own", () =>
    Effect.gen(function*() {
      const seen: Array<ReadonlyArray<string>> = []
      const gone = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "exists",
        description: "the override gave up"
      })
      const provider = Sandbox.TestSession.make({ workdir: "/work", script: () => ({ exitCode: 0 }) })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("probe")
          // A partial override: two operations native, everything else probed.
          const files = Sandbox.fileSystem({
            ...session,
            files: {
              exists: (path) =>
                Effect.suspend(() => {
                  seen.push(["exists", path])
                  return Effect.fail(gone)
                }),
              rename: (from, to) =>
                Effect.sync(() => {
                  seen.push(["rename", from, to])
                })
            }
          })
          const failed = yield* Effect.flip(files.exists("notes.txt"))
          yield* files.rename("./from.txt", "to.txt")
          // An operation the override does not supply still runs as a probe,
          // and it is rooted the same way.
          yield* files.makeDirectory("build")
          return failed
        })
      )
      // The override never re-implements the rooting rule and never sees a
      // relative path: the resolver is in front of it, not beside it.
      expect(seen).toEqual([
        ["exists", "/work/notes.txt"],
        ["rename", "/work/from.txt", "/work/to.txt"]
      ])
      expect(provider.state.commands).toHaveLength(1)
      expect(provider.state.commands[0]).toContain("mkdir /work/build")
      // A failing override is reported as an override failure, not swallowed
      // into `false` the way an absent path would be.
      expect(platformReason(outcome)).toBe("Unknown")
      expect(String(outcome)).toContain("the override gave up")
    }))

  // `symlink(fromPath, toPath)` is the one operation whose leading argument is
  // not a path to reach: it is the text stored inside the link, and POSIX
  // resolves a relative one against the LINK's directory rather than any
  // working directory. Rooting it moved the link's meaning — `../shared` from
  // `/work/sub/link` names `/work/shared`, while the rooted `/shared` names
  // something else entirely, one directory outside the workspace.
  it.effect("roots where a symlink is made without rewriting what it points at", () =>
    Effect.gen(function*() {
      const seen: Array<ReadonlyArray<string>> = []
      const provider = Sandbox.TestSession.make({ workdir: "/work", script: () => ({ exitCode: 0 }) })
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("probe")
          const files = Sandbox.fileSystem({
            ...session,
            files: {
              symlink: (from, to) =>
                Effect.sync(() => {
                  seen.push(["symlink", from, to])
                }),
              // A hard link is two real paths, so both of its arguments are
              // rooted: the contrast is the point.
              link: (from, to) =>
                Effect.sync(() => {
                  seen.push(["link", from, to])
                })
            }
          })
          yield* files.symlink("../shared", "sub/link")
          yield* files.symlink("/absolute/target", "./other")
          yield* files.link("existing.txt", "hard.txt")
        })
      )

      expect(seen).toEqual([
        ["symlink", "../shared", "/work/sub/link"],
        ["symlink", "/absolute/target", "/work/other"],
        ["link", "/work/existing.txt", "/work/hard.txt"]
      ])
    }))

  it.effect("prefers a session's native override to the probe", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make()
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("probe")
          const files = Sandbox.fileSystem({ ...session, files: { exists: () => Effect.succeed(true) } })
          return yield* files.exists("/never-probed")
        })
      )
      expect(outcome).toBe(true)
      expect(provider.state.commands).toEqual([])
    }))

  it.effect("restates a probe transport failure in the platform vocabulary", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: () => ({ failure: new ProviderError({ code: "timeout", message: "the machine went away" }) })
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          return platformReason(yield* Effect.flip(files.exists("/anywhere")))
        })
      )
      expect(outcome).toBe("TimedOut")
    }))
})

describe("Sandbox.layerHost", () => {
  it.effect("serves the spawner, the filesystem, and the path from one held machine", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        files: { "/sandbox/config.json": `{"ok":true}` },
        scripts: { "uname": { stdout: "ScriptedOS\n" } }
      })
      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const files = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const uname = yield* spawner.string(ChildProcess.make("uname"))
        const config = yield* files.readFileString("/sandbox/config.json")
        return { uname, config, joined: path.join("/sandbox", "config.json") }
      }).pipe(Effect.provide(Sandbox.layerHost(provider, { session: "host" })))
      expect(outcome).toEqual({
        uname: "ScriptedOS\n",
        config: `{"ok":true}`,
        joined: "/sandbox/config.json"
      })
      expect(provider.state.acquired).toEqual(["host"])
      expect(provider.state.released).toBe(1)
    }))

  it.effect("resolves relative paths under the guest workdir, never this process's directory", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ workdir: "/guest/work" })
      const outcome = yield* Effect.gen(function*() {
        const path = yield* Path.Path
        return {
          relative: path.resolve("note.txt"),
          nested: path.resolve("src", "../note.txt"),
          absolute: path.resolve("note.txt", "/etc/hosts"),
          between: path.relative("src", "/guest/work/note.txt"),
          sep: path.sep
        }
      }).pipe(Effect.provide(Sandbox.layerHost(provider, { session: "rooted" })))
      expect(outcome).toEqual({
        relative: "/guest/work/note.txt",
        nested: "/guest/work/note.txt",
        absolute: "/etc/hosts",
        between: "../note.txt",
        sep: "/"
      })
    }))

  it.effect("resolves relative paths under a Windows guest workdir, and names its file URLs there", () =>
    Effect.gen(function*() {
      const windows = Sandbox.TestSession.make({ workdir: "C:\\work" })
      const posix = Sandbox.TestSession.make({ workdir: "/guest/work" })
      const onWindows = yield* Effect.gen(function*() {
        const path = yield* Path.Path
        return {
          relative: path.resolve("note.txt"),
          nested: path.resolve("src", "..", "note.txt"),
          drive: path.resolve("note.txt", "D:/other/x"),
          root: path.resolve()
        }
      }).pipe(Effect.provide(Sandbox.layerHost(windows, { session: "windows" })))
      expect(onWindows).toEqual({
        relative: "C:/work/note.txt",
        nested: "C:/work/note.txt",
        drive: "D:/other/x",
        root: "C:/work"
      })
      const url = yield* Effect.flatMap(Path.Path, (path) => path.toFileUrl("note.txt")).pipe(
        Effect.provide(Sandbox.layerHost(posix, { session: "url" }))
      )
      expect(url.href).toBe("file:///guest/work/note.txt")
    }))

  it.effect("serves a health probe over the machine it holds", () =>
    Effect.gen(function*() {
      const failing = new ProviderError({ code: "unavailable", message: "the vm is gone" })
      const healthy = Sandbox.TestSession.make({ ping: Effect.void })
      const dead = Sandbox.TestSession.make({ ping: Effect.fail(failing) })
      const probe = (provider: Sandbox.TestSessionProvider) =>
        Effect.flatMap(SandboxHealth.SandboxHealth, (health) => health.check).pipe(
          Effect.provide(Sandbox.layerHost(provider, { session: "watched" }))
        )
      expect((yield* probe(healthy))._tag).toBe("Healthy")
      const unhealthy = yield* probe(dead)
      expect(unhealthy._tag).toBe("Unhealthy")
      // A session with no ping cannot be asked, so nothing is watching it and
      // the probe says healthy rather than pretending to have checked.
      expect((yield* probe(Sandbox.TestSession.make()))._tag).toBe("Healthy")
    }))

  it.effect("forwards the configured health deadline to the held machine's probe", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ ping: Effect.never })
      yield* Effect.gen(function*() {
        const health = yield* SandboxHealth.SandboxHealth
        const check = yield* health.check.pipe(Effect.forkChild)
        yield* TestClock.adjust("9 millis")
        expect(check.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 milli")
        expect(check.pollUnsafe()).toBeDefined()
        expect(yield* Fiber.join(check)).toMatchObject({
          _tag: "Unhealthy",
          component: "sandbox",
          reason: "unresponsive"
        })
      }).pipe(
        Effect.provide(Sandbox.layerHost(provider, { session: "watched", health: { deadline: "10 millis" } })),
        Effect.provide(TestClock.layer())
      )
      expect(provider.state.released).toBe(1)
    }))

  it.effect("fails to build when the machine cannot be acquired", () =>
    Effect.gen(function*() {
      const refusal = new ProviderError({ code: "unavailable", message: "no capacity" })
      const provider = Sandbox.TestSession.make({ acquireFailure: refusal })
      const outcome = yield* Effect.exit(
        Effect.provide(
          Effect.asVoid(Effect.flatMap(ChildProcessSpawner, () => Effect.void)),
          Sandbox.layerHost(provider, { session: "host" })
        )
      )
      expect(Exit.isFailure(outcome)).toBe(true)
    }))
})
