import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GuardedSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as ProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Exit, Layer, Scope, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll } from "vitest"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import { pidDirectory } from "../src/internal/pidDirectory.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import { platform } from "./helpers/containedPlatform.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-transport-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const ssh = join(root, "ssh")
// This executable models SSH's remote shell reparse, using real local processes.
writeFileSync(ssh, "#!/bin/sh\nexec /bin/sh -c \"$*\"\n", { mode: 0o755 })

// This local SSH reparse fixture tests transport bytes and permission refusals;
// real OS confinement is exercised independently by the kernel platform suites.
const guardedPlatform = GuardedSpawner.layer.pipe(
  Layer.provide(ProcessConfinement.layerNoop),
  Layer.provide(GrantStore.layer({
    attended: false,
    rules: [new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "*" }) })]
  })),
  Layer.provide(Workspace.layer(root)),
  Layer.provide(platform)
)

const bytes = new Uint8Array([0, 255, 10, 13, 128, 39, 36, 92, 0, 65])
const text = (stdout: Stream.Stream<Uint8Array, unknown>) => Stream.mkString(Stream.decodeText(stdout))

describe("CommandSandbox stdin transport", () => {
  for (const joins of [false, true]) {
    it.effect(
      `preserves shell syntax, stdin EOF, secrets, and files with joinsArguments=${joins}`,
      () =>
        Effect.gen(function*() {
          const local = yield* ChildProcessSpawner
          const resources: Array<string> = []
          const spawner = makeSpawner((command) => {
            resources.push(CommandLine.render(command))
            return local.spawn(command)
          })
          const id = `transport-${joins}-${root}`
          const workdir = join(root, id)
          const environment = [
            "env",
            "smthrs_script=inherited-script",
            "smthrs_env=inherited-env",
            "SMTHRS_INHERITED=ordinary"
          ]
          const session = yield* CommandSandbox.make({
            spawner,
            prefix: joins ? [ssh, ...environment] : environment,
            workdir
          }).acquire(id)
          const sentinel = "script-payload-sentinel"
          const script = `# ${sentinel}\n${
            "# 'quoted' \\ $HOME λ ; ".repeat(400)
          }\nprintf '%s|' "a b" 'c'"'"'d' 'λ'\n\n`
          expect(script.length).toBeGreaterThan(4096)
          const quoted = yield* session.spawn(script, {})
          expect(yield* text(quoted.stdout)).toBe("a b|c'd|λ|")
          expect(yield* quoted.exitCode).toBe(0)
          const inherited = yield* session.spawn(
            "printf \"%s|%s|%s\" \"$smthrs_script\" \"$smthrs_env\" \"$SMTHRS_INHERITED\"",
            {
              env: { TOKEN: "envelope-present" }
            }
          )
          expect(yield* text(inherited.stdout)).toBe("inherited-script|inherited-env|ordinary")
          expect(yield* inherited.exitCode).toBe(0)
          // No input must close after the script frame rather than leaving cat waiting.
          const eof = yield* session.spawn("cat", {})
          expect(yield* text(eof.stdout)).toBe("")
          expect(yield* eof.exitCode).toBe(0)
          const empty = yield* session.spawn("", {})
          expect(yield* text(empty.stdout)).toBe("")
          expect(yield* empty.exitCode).toBe(0)
          const secret = "env-secret-sentinel '$HOME;\nnext line"
          const credentials = yield* session.spawn("printf %s \"$TOKEN\"; cat", {
            env: { TOKEN: secret },
            stdin: bytes
          })
          const chunks = yield* Stream.runCollect(credentials.stdout)
          expect(Buffer.concat(Array.from(chunks, (part) => Buffer.from(part)))).toEqual(
            Buffer.concat([Buffer.from(secret), Buffer.from(bytes)])
          )
          expect(yield* credentials.exitCode).toBe(0)
          const path = join(workdir, "directory 'quoted'", "binary")
          yield* session.writeFile(path, bytes)
          expect(yield* session.readFile(path)).toEqual(bytes)
          yield* session.ping!
          expect(resources.every((resource) => resource.length <= GrantStore.maximumCapabilityResourceLength)).toBe(
            true
          )
          for (const resource of resources) {
            expect(resource).not.toContain(sentinel)
            expect(resource).not.toContain(secret)
            expect(resource).not.toContain(Buffer.from(bytes).toString("base64"))
          }
        }).pipe(Effect.scoped, Effect.provide(guardedPlatform)),
      30_000
    )

    it.effect(
      `cancels the guest and removes session pidfiles with joinsArguments=${joins}`,
      () =>
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const id = `transport-cancel-${joins}-${root}`
          const scope = yield* Scope.make()
          const workdir = join(root, id)
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          const session = yield* Scope.provide(
            CommandSandbox.make({ spawner, prefix: joins ? [ssh] : [], workdir }).acquire(id),
            scope
          )
          const child = yield* Scope.provide(session.spawn("printf ready; exec sleep 30", {}), scope)
          expect(yield* text(Stream.take(child.stdout, 1))).toBe("ready")
          const pids = join(pidDirectory, sessionSlug(id))
          const pid = Number(readFileSync(join(pids, "0.pid"), "utf8").trim())
          expect(pid).toBeGreaterThan(0)
          yield* Scope.close(scope, Exit.void)
          expect(existsSync(pids)).toBe(false)
          expect(() => process.kill(pid, 0)).toThrow()
        }).pipe(Effect.scoped, Effect.provide(platform)),
      30_000
    )
  }

  for (const refusal of ["denied", "oversized-prefix"] as const) {
    it.effect(`retains kernel refusal for ${refusal}`, () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const error = yield* Effect.flip(
          CommandSandbox.make({
            spawner,
            prefix: refusal === "denied" ? [ssh] : [ssh, "x".repeat(4097)],
            workdir: join(root, refusal)
          }).acquire(`transport-${refusal}`)
        )
        expect(error).toMatchObject({ code: "unavailable", message: expect.stringContaining("PermissionDenied") })
        expect(error.cause).toBeUndefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(GuardedSpawner.layer.pipe(
          Layer.provide(GrantStore.layer({
            attended: false,
            rules: refusal === "denied" ? [] : [
              new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "*" }) })
            ]
          })),
          Layer.provide(Workspace.layer(root)),
          Layer.provide(platform)
        ))
      ), 30_000)
  }

  for (const frame of ["!\n", "\n", "AAAA\n", Buffer.from("touch malformed-ran").toString("base64")] as const) {
    it.effect(
      `refuses a ${frame.includes("\n") ? "malformed" : "truncated"} script frame`,
      () =>
        Effect.gen(function*() {
          const local = yield* ChildProcessSpawner
          let corrupt = false
          // A fault adapter is necessary to model corruption before the remote
          // shell reads stdin; execution and decoding remain real OS operations.
          const spawner = makeSpawner((command) => {
            if (!corrupt || command._tag !== "StandardCommand") return local.spawn(command)
            corrupt = false
            return local.spawn(ChildProcess.make(command.command, command.args, {
              ...command.options,
              stdin: Stream.make(new TextEncoder().encode(frame))
            }))
          })
          const id = `${basename(root)}-frame-${Buffer.from(frame).toString("hex")}`
          const workdir = join(root, id)
          const session = yield* CommandSandbox.make({ spawner, prefix: [ssh], workdir }).acquire(id)
          corrupt = true
          const child = yield* session.spawn("touch malformed-ran", {})
          expect(yield* child.exitCode).not.toBe(0)
          expect(existsSync(join(workdir, "malformed-ran"))).toBe(false)
        }).pipe(Effect.scoped, Effect.provide(platform)),
      30_000
    )
  }

  it.effect("refuses NUL in shell source before invoking the transport", () =>
    Effect.gen(function*() {
      const local = yield* ChildProcessSpawner
      let calls = 0
      const spawner = makeSpawner((command) => {
        calls++
        return local.spawn(command)
      })
      const workdir = join(root, "nul")
      const session = yield* CommandSandbox.make({ spawner, prefix: [ssh], workdir }).acquire("nul")
      const before = calls
      expect(yield* Effect.flip(session.spawn("touch nul-ran\0; touch after-nul", {}))).toMatchObject({
        code: "spawn_error"
      })
      expect(calls).toBe(before)
      expect(existsSync(join(workdir, "nul-ran"))).toBe(false)
      expect(existsSync(join(workdir, "after-nul"))).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(platform)), 30_000)
})
