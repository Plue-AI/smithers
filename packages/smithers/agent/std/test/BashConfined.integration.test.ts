/** Real public shell handlers over the attended grant store and Node host. */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Fiber, Layer, type Path } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ProcessConfinement from "../../../flows/platform-node/src/ProcessConfinement.ts"
import * as ProcessSandbox from "../../../flows/platform-node/src/ProcessSandbox.ts"
import * as Bash from "../src/Bash.ts"
import * as ShellCommand from "../src/ShellCommand.ts"
import type * as StdError from "../src/StdError.ts"

const scratch = process.env.SMITHERS_CONFINEMENT_TEST_SCRATCH ?? join(process.cwd(), ".cache", "process-confinement")
const directories = new Set<string>()
const hostFacts = ProcessSandbox.host()
const available = !ProcessSandbox.isUnenforceable(ProcessSandbox.select({ network: "none" }, hostFacts))
const fixture = () => {
  mkdirSync(scratch, { recursive: true })
  const base = realpathSync(mkdtempSync(join(scratch, "public-shell-")))
  directories.add(base)
  const workspace = join(base, "workspace")
  mkdirSync(join(workspace, "out"), { recursive: true })
  mkdirSync(join(workspace, "sibling"))
  return { base, workspace }
}
afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

const handlers: ReadonlyArray<{
  readonly name: string
  readonly run: (command: string, cwd: string) => Effect.Effect<
    { readonly exitCode: number },
    StdError.StdError,
    KernelChildProcessSpawner.ChildProcessSpawner | Path.Path
  >
}> = [
  { name: "Bash.run", run: (command: string, cwd: string) => Bash.run({ mode: "unhermetic", command, cwd }) },
  { name: "ShellCommand.run", run: (command: string, cwd: string) => ShellCommand.run({ command, workdir: cwd }) }
]

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending[0] === undefined
        ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
        : Effect.succeed(pending[0]))
  )

const rule = (action: CapabilityPattern["action"], resource: string) =>
  new Permission.Rule({ effect: "allow", pattern: new CapabilityPattern({ action, resource }) })
const spawnAny = rule("proc:spawn", "**")

const confined = <A, E>(
  workspace: string,
  options: GrantStore.MakeOptions,
  use: (store: GrantStore.Service) => Effect.Effect<A, E, KernelChildProcessSpawner.ChildProcessSpawner | Path.Path>,
  confinement: ProcessConfinement.Options = {}
) =>
  Effect.scoped(Effect.gen(function*() {
    const store = yield* GrantStore.make(options)
    return yield* use(store).pipe(
      Effect.provide(KernelChildProcessSpawner.layer.pipe(
        Layer.provide(ProcessConfinement.layer({
          host: hostFacts,
          temporaryDirectory: join(workspace, ".."),
          ...confinement
        }))
      )),
      Effect.provide(NodeChildProcessSpawner.layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provideService(GrantStore.GrantStore, store)
    )
  })).pipe(Effect.provide(Workspace.layer(workspace)))

describe.each(handlers)("$name process confinement", ({ run }) => {
  describe.skipIf(!available)("native mechanism (skipped when seatbelt/bubblewrap is unavailable)", () => {
    it.each(["../outside", "inside"])(
      "a once-approved shell cannot write %s without fs:write authority",
      async (target) => {
        const { base, workspace } = fixture()
        const result = await Effect.runPromise(
          confined(workspace, { runId: "public-shell-once" }, (store) =>
            Effect.gen(function*() {
              const execution = yield* run(`printf escaped > ${target}`, workspace).pipe(
                Effect.forkChild({ startImmediately: true })
              )
              const pending = yield* awaitPending(store)
              expect(pending.capability.action).toBe("proc:spawn")
              yield* store.reply(pending.requestId, "once")
              return yield* Fiber.join(execution)
            }))
        )
        expect({ refused: result.exitCode !== 0, markerExists: existsSync(join(workspace, target)) }).toEqual({
          refused: true,
          markerExists: false
        })
        expect(existsSync(join(base, "outside"))).toBe(false)
      }
    )

    it("permits its writable tree while blocking sibling and outside trees", async () => {
      const { base, workspace } = fixture()
      const rules = [
        spawnAny,
        rule("fs:read", `${workspace}/out/**`),
        rule("fs:write", `${workspace}/out`),
        rule("fs:write", `${workspace}/out/**`)
      ]
      const [allowed, sibling, outside] = await Effect.runPromise(
        confined(workspace, { attended: false, rules }, () =>
          Effect.gen(function*() {
            return [
              yield* run("printf granted > out/file", workspace),
              yield* run("printf escaped > sibling/file", workspace),
              yield* run("printf escaped > ../outside", workspace)
            ] as const
          }))
      )
      expect(allowed.exitCode).toBe(0)
      expect(readFileSync(join(workspace, "out", "file"), "utf8")).toBe("granted")
      expect(sibling.exitCode).not.toBe(0)
      expect(outside.exitCode).not.toBe(0)
      expect(existsSync(join(workspace, "sibling", "file"))).toBe(false)
      expect(existsSync(join(base, "outside"))).toBe(false)
    })

    it("requires explicit write authority for the directory inode as well as its descendants", async () => {
      const { workspace } = fixture()
      const out = join(workspace, "out")
      chmodSync(out, 0o755)
      const descendantRules = [spawnAny, rule("fs:read", `${out}/**`), rule("fs:write", `${out}/**`)]
      const denied = await Effect.runPromise(confined(workspace, {
        attended: false,
        rules: descendantRules
      }, () => run("chmod 750 out", workspace)))
      expect(denied.exitCode).not.toBe(0)
      expect(statSync(out).mode & 0o777).toBe(0o755)
      const allowed = await Effect.runPromise(confined(workspace, {
        attended: false,
        rules: [...descendantRules, rule("fs:write", out)]
      }, () => run("chmod 750 out && printf granted > out/file", workspace)))
      expect(allowed.exitCode).toBe(0)
      expect(statSync(out).mode & 0o777).toBe(0o750)
      expect(readFileSync(join(out, "file"), "utf8")).toBe("granted")
    })

    it("does not expose existing data or mount a writable tree under write-only authority", async () => {
      const { workspace } = fixture()
      const secret = "write-only tree synthetic secret"
      const seed = join(workspace, "out", "seed")
      writeFileSync(seed, secret)
      const result = await Effect.runPromise(confined(workspace, {
        attended: false,
        rules: [spawnAny, rule("fs:write", `${workspace}/out`), rule("fs:write", `${workspace}/out/**`)]
      }, () => run("cat out/seed; printf changed > out/seed; printf escaped > out/created", workspace)))
      expect(result.exitCode).not.toBe(0)
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(readFileSync(seed, "utf8")).toBe(secret)
      expect(existsSync(join(workspace, "out", "created"))).toBe(false)
    })

    it.each(["out/only", "out/*.txt", "out/file?"])(
      "a %s write grant cannot widen to an unrelated sibling",
      async (pattern) => {
        const { workspace } = fixture()
        writeFileSync(join(workspace, "out", "only"), "seed")
        const result = await Effect.runPromise(confined(workspace, {
          attended: false,
          rules: [
            spawnAny,
            rule("fs:read", `${workspace}/out/**`),
            rule("fs:write", `${workspace}/out`),
            rule("fs:write", `${workspace}/${pattern}`)
          ]
        }, () => run("printf escaped > out/unrelated.bin", workspace)))
        expect(result.exitCode).not.toBe(0)
        expect(existsSync(join(workspace, "out", "unrelated.bin"))).toBe(false)
        expect(readFileSync(join(workspace, "out", "only"), "utf8")).toBe("seed")
      }
    )

    it("keeps redirection in a subprocess confined", async () => {
      const { base, workspace } = fixture()
      const result = await Effect.runPromise(
        confined(
          workspace,
          { attended: false, rules: [spawnAny] },
          () => run("/bin/sh -c 'printf escaped > ../outside-subprocess'", workspace)
        )
      )
      expect(result.exitCode).not.toBe(0)
      expect(existsSync(join(base, "outside-subprocess"))).toBe(false)
    })

    it("cancels a running shell before its delayed write", async () => {
      const { workspace } = fixture()
      await Effect.runPromise(confined(workspace, {
        attended: false,
        rules: [
          spawnAny,
          rule("fs:read", `${workspace}/out/**`),
          rule("fs:write", `${workspace}/out`),
          rule("fs:write", `${workspace}/out/**`)
        ]
      }, () =>
        Effect.gen(function*() {
          const execution = yield* run("printf started > out/started; sleep 1; printf late > out/late", workspace).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          const started: Effect.Effect<void> = Effect.suspend(() =>
            existsSync(join(workspace, "out", "started"))
              ? Effect.void
              : Effect.sleep("5 millis").pipe(Effect.andThen(started))
          )
          yield* started.pipe(Effect.timeout("5 seconds"))
          yield* Fiber.interrupt(execution)
        })))
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      expect(readFileSync(join(workspace, "out", "started"), "utf8")).toBe("started")
      expect(existsSync(join(workspace, "out", "late"))).toBe(false)
    })

    it("reaches a real listener only with full network authority", async () => {
      const { workspace } = fixture()
      let requests = 0
      const server = createServer((_request, response) => {
        requests++
        response.end("ok")
      })
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const port = (server.address() as { port: number }).port
      const command =
        `"${process.execPath}" -e 'fetch("http://127.0.0.1:${port}",{signal:AbortSignal.timeout(2000)}).then(r=>r.text()).then(x=>process.exit(x==="ok"?0:4),()=>process.exit(3))'`
      try {
        const closed = await Effect.runPromise(
          confined(workspace, { attended: false, rules: [spawnAny] }, () => run(command, workspace))
        )
        expect(closed.exitCode).toBe(3)
        expect(requests).toBe(0)
        const partial = await Effect.runPromise(confined(workspace, {
          attended: false,
          rules: [spawnAny, rule("net:get", "**")]
        }, () => run(command, workspace)))
        expect(partial.exitCode).toBe(3)
        expect(requests).toBe(0)
        const open = await Effect.runPromise(confined(workspace, {
          attended: false,
          rules: [spawnAny, rule("net:get", "**"), rule("net:post", "**"), rule("net:private", "**")]
        }, () => run(command, workspace)))
        expect(open.exitCode).toBe(0)
        expect(requests).toBe(1)
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      }
    })
  })

  it.each([undefined, "refuse"] as const)(
    "refuses a missing mechanism with unavailable=%s before any side effect",
    async (unavailable) => {
      const { base, workspace } = fixture()
      const failure = await Effect.runPromise(
        confined(
          workspace,
          { attended: false, rules: [spawnAny] },
          () => Effect.flip(run("printf escaped > ../unconfined", workspace)),
          {
            ...(unavailable === undefined ? {} : { unavailable }),
            host: {
              ...hostFacts,
              platform: "win32",
              executable: () => undefined
            }
          }
        )
      )
      expect(failure).toMatchObject({ code: "command_failed" })
      expect(failure.message).toMatch(/refuses to spawn unconfined/)
      expect(existsSync(join(base, "unconfined"))).toBe(false)
    }
  )

  it.skipIf(process.platform === "win32")(
    "runs unconfined only under the explicit host opt-in (POSIX shell)",
    async () => {
      const { base, workspace } = fixture()
      const result = await Effect.runPromise(
        confined(
          workspace,
          { attended: false, rules: [spawnAny] },
          () => run("printf explicit > ../opt-in", workspace),
          {
            unavailable: "unconfined",
            host: {
              ...hostFacts,
              platform: "win32",
              executable: () => undefined
            }
          }
        )
      )
      expect(result.exitCode).toBe(0)
      expect(readFileSync(join(base, "opt-in"), "utf8")).toBe("explicit")
    }
  )
})

describe.skipIf(!available)("Bash.run stdin-fed interpreter confinement", () => {
  it("confines script subprocesses and their redirections", async () => {
    const { base, workspace } = fixture()
    const result = await Effect.runPromise(confined(workspace, { attended: false, rules: [spawnAny] }, () =>
      Bash.run({
        mode: "unhermetic",
        script: "/bin/sh -c 'printf escaped > ../outside-script'",
        interpreter: "bash",
        cwd: workspace
      })))
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(join(base, "outside-script"))).toBe(false)
  })

  it("preserves approved environment data and private bootstrap directories without evaluating values", async () => {
    const { base, workspace } = fixture()
    const value = "a'b\" $(printf escaped > ../environment-escape)\nlast"
    const result = await Effect.runPromise(confined(workspace, { attended: false, rules: [spawnAny] }, () =>
      Bash.run({
        mode: "unhermetic",
        command:
          "printf '%s' \"$SMITHERS_CONFINEMENT_TEST_VALUE\"; test -n \"$PATH\" && test -d \"$HOME\" && test -d \"$TMPDIR\"",
        cwd: workspace,
        env: { SMITHERS_CONFINEMENT_TEST_VALUE: value }
      })))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(value)
    expect(existsSync(join(base, "environment-escape"))).toBe(false)
  })

  it("keeps approved environment values out of the host launcher environment and arguments", async () => {
    const { base, workspace } = fixture()
    const value = "private-value-'\"-$(printf escaped > ../launcher-escape)"
    const stdout = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const wrapped = yield* ProcessConfinement.make({ temporaryDirectory: base }).confine(
          ChildProcess.make("/bin/sh", ["-c", "printf '%s' \"$SMITHERS_CONFINEMENT_TEST_VALUE\""], {
            cwd: workspace,
            env: { SMITHERS_CONFINEMENT_TEST_VALUE: value, LD_PRELOAD: "/nonexistent-confinement-test.so" },
            extendEnv: false
          }),
          { workspaceRoot: workspace, reads: [], writes: [], readOnly: [], network: "none" }
        )
        expect(wrapped.options.extendEnv).toBe(false)
        expect(wrapped.options.env).not.toHaveProperty("SMITHERS_CONFINEMENT_TEST_VALUE")
        expect(wrapped.options.env).not.toHaveProperty("LD_PRELOAD")
        expect(JSON.stringify(wrapped.args)).not.toContain(value)
        expect(JSON.stringify(wrapped.args)).not.toContain("/nonexistent-confinement-test.so")
        const spawner = yield* KernelChildProcessSpawner.ChildProcessSpawner
        return yield* spawner.string(wrapped)
      })).pipe(
        Effect.provide(NodeChildProcessSpawner.layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer)
      )
    )
    expect(stdout).toBe(value)
    expect(existsSync(join(base, "launcher-escape"))).toBe(false)
  })
})
