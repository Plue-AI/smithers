/** Fake platform facts exercise foreign argv; all preparation uses a real filesystem. */
import * as KernelConfinement from "@smthrs/kernel/ProcessConfinement"
import { Deferred, Effect, Fiber, Logger, type Scope, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import NodeFs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const fixtures: Array<string> = []
const fixture = () => {
  const parent = process.env.SMITHERS_TEST_SCRATCH ?? NodeOs.tmpdir()
  NodeFs.mkdirSync(parent, { recursive: true })
  const base = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(parent, "native-confinement-")))
  fixtures.push(base)
  const workspaceRoot = NodePath.join(base, "workspace")
  const temporaryDirectory = NodePath.join(base, "temporary")
  NodeFs.mkdirSync(workspaceRoot)
  NodeFs.mkdirSync(temporaryDirectory)
  const host: ProcessSandbox.Host = {
    ...ProcessSandbox.host(),
    platform: "darwin",
    developerDirectory: undefined,
    executable: (name) => name === "/usr/bin/sandbox-exec" ? name : undefined
  }
  const profile: KernelConfinement.Profile = { workspaceRoot, reads: [], writes: [], readOnly: [], network: "none" }
  return { base, workspaceRoot, temporaryDirectory, host, profile }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  syncBuiltinESMExports()
  for (const base of fixtures.splice(0)) NodeFs.rmSync(base, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

describe("native ProcessConfinement", () => {
  it.each([undefined, "refuse"] as const)(
    "refuses missing mechanisms with unavailable=%s before any spawn",
    async (unavailable) => {
      const f = fixture()
      const command = ChildProcess.make("fixture", [], { cwd: f.workspaceRoot })
      const spawn = vi.fn(() => Effect.void)
      const service = ProcessConfinement.make({ ...f, unavailable, host: { ...f.host, executable: () => undefined } })
      const failure = await run(Effect.flip(service.confine(command, f.profile).pipe(Effect.flatMap(spawn))))
      expect(failure).toMatchObject({
        reason: { _tag: "NotFound", description: expect.stringContaining("refuses to spawn unconfined") }
      })
      expect(spawn).not.toHaveBeenCalled()
      expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
    }
  )

  it("warns and preserves the original command only for explicit unconfined fallback", async () => {
    const f = fixture()
    const command = ChildProcess.make("fixture", [], { shell: true, cwd: f.workspaceRoot })
    const logs: Array<unknown> = []
    const logger = Logger.make((event) => logs.push(event.message))
    const service = ProcessConfinement.make({
      ...f,
      unavailable: "unconfined",
      host: { ...f.host, executable: () => undefined }
    })
    const result = await run(
      service.confine(command, f.profile).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
    )
    expect(result).toBe(command)
    expect(JSON.stringify(logs)).toContain("Running unconfined")
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it.each([true, "/bin/bash", false, undefined] as const)("confines shell=%s inside the mechanism", async (shell) => {
    const f = fixture()
    const command = ChildProcess.make("printf", ["hello", ">", "out.txt"], { cwd: f.workspaceRoot, shell })
    const wrapped = await run(ProcessConfinement.make(f).confine(command, f.profile))
    expect(wrapped.command).toBe("/usr/bin/sandbox-exec")
    expect(wrapped.options.shell).toBe(false)
    const target = shell === true || typeof shell === "string"
      ? [shell === true ? "/bin/sh" : shell, "-c", "printf hello > out.txt"]
      : ["printf", "hello", ">", "out.txt"]
    expect(wrapped.args.slice(-target.length)).toEqual(target)
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("preserves streams and process options while adding its private environment", async () => {
    const f = fixture()
    const stdin = Stream.succeed(new TextEncoder().encode("input"))
    const additionalFds = { fd3: { type: "output" as const } }
    const command = ChildProcess.make("fixture", ["--arg"], {
      cwd: f.workspaceRoot,
      stdin,
      stdout: "pipe",
      stderr: "inherit",
      additionalFds,
      detached: true,
      killSignal: "SIGINT",
      env: { KEEP: "value", OMIT: undefined },
      extendEnv: false
    })
    const wrapped = await run(ProcessConfinement.make(f).confine(command, f.profile))
    for (const key of ["cwd", "stdin", "stdout", "stderr", "additionalFds", "detached", "killSignal"] as const) {
      expect(wrapped.options[key]).toBe(command.options[key])
    }
    expect(wrapped.options.env?.["KEEP"]).toBeUndefined()
    expect(wrapped.options.env?.["OMIT"]).toBeUndefined()
    expect(wrapped.options.env?.["HOME"]).toContain("smithers-confinement-")
    expect(wrapped.options.env?.["HOME"]).not.toBe(process.env.HOME)
  })

  it("inherits the host environment only inside the sandbox", async () => {
    const f = fixture()
    vi.stubEnv("SMITHERS_ENV_TEST", "inherited fixture")
    await run(Effect.gen(function*() {
      const wrapped = yield* ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile)
      expect(wrapped.options.extendEnv).toBe(false)
      expect(wrapped.options.env?.["SMITHERS_ENV_TEST"]).toBeUndefined()
      const script = wrapped.args.find((arg) => arg.endsWith("/environment.sh"))!
      const lines = NodeFs.readFileSync(script, "utf8").split("\n")
      expect(lines.some((line) => line === "export SMITHERS_ENV_TEST='inherited fixture'")).toBe(true)
    }))
  })

  it.each(["outside", "symlink"] as const)("refuses a %s cwd outside the workspace", async (kind) => {
    const f = fixture()
    const outside = NodePath.join(f.base, "outside")
    NodeFs.mkdirSync(outside)
    const link = NodePath.join(f.workspaceRoot, "link")
    NodeFs.symlinkSync(outside, link, "dir")
    const command = ChildProcess.make("fixture", [], { cwd: kind === "outside" ? outside : link })
    const failure = await run(Effect.flip(ProcessConfinement.make(f).confine(command, f.profile)))
    expect(failure).toMatchObject({
      reason: { _tag: "PermissionDenied", description: expect.stringContaining("outside the workspace") }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("admits an internal cwd alias and refuses an unavailable directory", async () => {
    const f = fixture()
    const internal = NodePath.join(f.workspaceRoot, "internal")
    const alias = NodePath.join(f.workspaceRoot, "alias")
    NodeFs.mkdirSync(internal)
    NodeFs.symlinkSync(internal, alias, "dir")
    const wrapped = await run(
      ProcessConfinement.make(f).confine(ChildProcess.make("fixture", [], { cwd: alias }), f.profile)
    )
    expect(wrapped.options.cwd).toBe(internal)
    const failure = await run(Effect.flip(
      ProcessConfinement.make(f).confine(
        ChildProcess.make("fixture", [], { cwd: NodePath.join(f.workspaceRoot, "missing") }),
        f.profile
      )
    ))
    expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("drops missing and escaped reads while keeping a direct read", async () => {
    const f = fixture()
    NodeFs.writeFileSync(NodePath.join(f.workspaceRoot, "readable.txt"), "fixture")
    const wrapped = await run(
      ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), {
        ...f.profile,
        reads: ["../outside", "missing", "readable.txt"]
      })
    )
    expect(wrapped.args[1]).toContain(NodePath.join(f.workspaceRoot, "readable.txt"))
    expect(wrapped.args[1]).not.toContain(NodePath.join(f.base, "outside"))
  })

  it("refuses an internal read alias without exposing the target", async () => {
    const f = fixture()
    const secret = NodePath.join(f.workspaceRoot, "secret")
    NodeFs.mkdirSync(secret)
    NodeFs.writeFileSync(NodePath.join(secret, "private.txt"), "synthetic secret")
    NodeFs.symlinkSync(secret, NodePath.join(f.workspaceRoot, "alias"), "dir")
    const spawn = vi.fn(() => Effect.void)
    const error = await run(Effect.flip(
      ProcessConfinement.make(f).confine(ChildProcess.make("/bin/cat", ["alias/private.txt"]), {
        ...f.profile,
        reads: ["alias"]
      }).pipe(Effect.flatMap(spawn))
    ))
    expect(error).toMatchObject({ reason: { _tag: "PermissionDenied", description: "read grant is a symbolic link" } })
    expect(spawn).not.toHaveBeenCalled()
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("canonicalizes an aliased temporary parent before generating grants", async () => {
    const f = fixture()
    const alias = NodePath.join(f.base, "tmp-alias")
    NodeFs.symlinkSync(f.temporaryDirectory, alias, "dir")
    await run(Effect.gen(function*() {
      const wrapped = yield* ProcessConfinement.make({ ...f, temporaryDirectory: alias }).confine(
        ChildProcess.make("fixture"),
        f.profile
      )
      const home = wrapped.options.env?.["HOME"]!
      expect(home.startsWith(f.temporaryDirectory + NodePath.sep)).toBe(true)
      expect(wrapped.args[1]).not.toContain(alias)
      expect(NodeFs.statSync(home).isDirectory()).toBe(true)
    }))
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("cleans the allocated temporary directory if canonicalization fails", async () => {
    const f = fixture()
    const realpath = NodeFs.realpathSync
    vi.spyOn(NodeFs, "realpathSync").mockImplementation(
      ((path: NodeFs.PathLike, ...args: Array<unknown>) => {
        if (String(path).includes("smithers-confinement-")) throw new Error("temporary realpath denied")
        return Reflect.apply(realpath, NodeFs, [path, ...args])
      }) as typeof NodeFs.realpathSync
    )
    syncBuiltinESMExports()
    const error = await run(Effect.flip(ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile)))
    expect(error).toMatchObject({
      reason: { _tag: "Unknown", description: expect.stringContaining("temporary realpath denied") }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("creates precisely a missing writable tree and retains temporary files until scope closes", async () => {
    const f = fixture()
    const path = NodePath.join(f.workspaceRoot, "out", "deep")
    await run(Effect.gen(function*() {
      const wrapped = yield* ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), {
        ...f.profile,
        writes: ["out/deep"]
      })
      expect(NodeFs.statSync(path).isDirectory()).toBe(true)
      const home = wrapped.options.env?.["HOME"]!
      expect(NodeFs.statSync(home).isDirectory()).toBe(true)
      expect(NodeFs.readdirSync(f.temporaryDirectory)).toHaveLength(1)
      expect(wrapped.args[1]).toContain(`(subpath "${path}")`)
    }))
    expect(NodeFs.readdirSync(f.workspaceRoot)).toEqual(["out"])
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("refuses an existing file tree without granting its parent", async () => {
    const f = fixture()
    NodeFs.writeFileSync(NodePath.join(f.workspaceRoot, "result.txt"), "original")
    const failure = await run(Effect.flip(
      ProcessConfinement.make(f).confine(
        ChildProcess.make("fixture"),
        { ...f.profile, writes: ["result.txt"] }
      )
    ))
    expect(failure).toMatchObject({
      reason: { _tag: "PermissionDenied", description: expect.stringContaining("not a directory tree") }
    })
    expect(NodeFs.readFileSync(NodePath.join(f.workspaceRoot, "result.txt"), "utf8")).toBe("original")
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("refuses symlink writes even when missing mechanisms may fall back", async () => {
    const f = fixture()
    const outside = NodePath.join(f.base, "outside")
    NodeFs.mkdirSync(outside)
    NodeFs.symlinkSync(outside, NodePath.join(f.workspaceRoot, "out"), "dir")
    const failure = await run(Effect.flip(
      ProcessConfinement.make({ ...f, unavailable: "unconfined" }).confine(
        ChildProcess.make("fixture"),
        { ...f.profile, writes: ["out/missing"] }
      )
    ))
    expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    expect(NodeFs.readdirSync(outside)).toEqual([])
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("cleans preparation when planning or rendering fails", async () => {
    const f = fixture()
    for (const method of ["plan", "wrap"] as const) {
      const failure = vi.spyOn(ProcessSandbox, method).mockImplementation(() => {
        throw new Error("host refused")
      })
      const error = await run(Effect.flip(ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile)))
      expect(error).toMatchObject({ reason: { _tag: "Unknown", description: expect.stringContaining("host refused") } })
      expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
      failure.mockRestore()
    }
  })

  it("cleans temporary directories when the calling fiber is interrupted", async () => {
    const f = fixture()
    await run(Effect.gen(function*() {
      const prepared = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.gen(function*() {
        yield* ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile)
        yield* Deferred.succeed(prepared, undefined)
        return yield* Effect.never
      })))
      yield* Deferred.await(prepared)
      expect(NodeFs.readdirSync(f.temporaryDirectory)).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
    }))
  })

  it("reports directory preparation failures and cleans the private directory", async () => {
    const f = fixture()
    const mkdir = NodeFs.mkdirSync
    vi.spyOn(NodeFs, "mkdirSync").mockImplementation(
      ((path: NodeFs.PathLike, ...args: Array<unknown>) => {
        if (String(path).endsWith("/home")) throw new Error("home preparation denied")
        return Reflect.apply(mkdir, NodeFs, [path, ...args])
      }) as typeof NodeFs.mkdirSync
    )
    syncBuiltinESMExports()
    const failure = await run(Effect.flip(ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile)))
    expect(failure).toMatchObject({
      reason: { _tag: "Unknown", description: expect.stringContaining("home preparation denied") }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("retains a successful preparation result if best-effort cleanup is refused", async () => {
    const f = fixture()
    vi.spyOn(NodeFs, "rmSync").mockImplementation(() => {
      throw new Error("removal denied")
    })
    syncBuiltinESMExports()
    const wrapped = await run(ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile))
    expect(wrapped.command).toBe("/usr/bin/sandbox-exec")
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toHaveLength(1)
  })

  it("renders non-Error host failures without losing their cause", async () => {
    const f = fixture()
    vi.spyOn(ProcessSandbox, "wrap").mockImplementation(() => {
      throw "host render failed"
    })
    const error = await run(Effect.flip(ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile)))
    expect(error).toMatchObject({
      reason: { _tag: "Unknown", description: expect.stringContaining("host render failed") }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("reports an unavailable temporary directory without changing the workspace", async () => {
    const f = fixture()
    const service = ProcessConfinement.make({ ...f, temporaryDirectory: NodePath.join(f.base, "missing") })
    const error = await run(Effect.flip(service.confine(ChildProcess.make("fixture"), f.profile)))
    expect(error).toMatchObject({
      reason: { _tag: "Unknown", description: expect.stringContaining("could not prepare") }
    })
    expect(NodeFs.readdirSync(f.workspaceRoot)).toEqual([])
  })

  it("does not turn a linked workspace read into an external host grant", async () => {
    const f = fixture()
    const external = NodePath.join(f.base, "private.txt")
    NodeFs.writeFileSync(external, "private")
    NodeFs.symlinkSync(external, NodePath.join(f.workspaceRoot, "linked.txt"))
    const failure = await run(
      Effect.flip(
        ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), { ...f.profile, reads: ["linked.txt"] })
      )
    )
    expect(failure).toMatchObject({
      reason: { _tag: "PermissionDenied", description: expect.stringContaining("read grant resolves outside") }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("preserves sandbox refusals thrown during preparation", async () => {
    const f = fixture()
    const refusal = ProcessSandbox.unenforceable("darwin", "seatbelt", "runtime", "runtime unavailable")
    vi.spyOn(ProcessSandbox, "wrap").mockImplementation(() => {
      throw refusal
    })
    const error = await run(Effect.flip(ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile)))
    expect(error).toMatchObject({
      reason: { _tag: "Unknown", description: expect.stringContaining("runtime unavailable") }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("supports default construction through its public layer", async () => {
    const service = await Effect.runPromise(KernelConfinement.ProcessConfinement.pipe(
      Effect.provide(ProcessConfinement.layer())
    ))
    expect(typeof service.confine).toBe("function")
  })

  it("provides the same refusal through the public layer", async () => {
    const f = fixture()
    const error = await run(
      Effect.gen(function*() {
        const service = yield* KernelConfinement.ProcessConfinement
        return yield* Effect.flip(service.confine(ChildProcess.make("fixture"), f.profile))
      }).pipe(Effect.provide(ProcessConfinement.layer({ ...f, host: { ...f.host, executable: () => undefined } })))
    )
    expect(error).toMatchObject({ reason: { _tag: "NotFound" } })
  })
})

/** Executes the emitted classic BPF independently of its generator. */
const evaluateFilter = (bytes: Uint8Array, arch: number, syscall: number, domain: number, type = 1): number => {
  const program = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let accumulator = 0
  for (let instruction = 0; instruction * 8 < bytes.byteLength; instruction++) {
    const offset = instruction * 8
    const code = program.getUint16(offset, true)
    const value = program.getUint32(offset + 4, true)
    if (code === 0x20) accumulator = value === 4 ? arch : value === 0 ? syscall : value === 24 ? type : domain
    else if (code === 0x54) accumulator &= value
    else if (code === 0x15 || code === 0x35) {
      const matches = code === 0x15 ? accumulator === value : accumulator >= value
      instruction += program.getUint8(offset + (matches ? 2 : 3))
    } else if (code === 0x06) return value
    else throw new Error(`unexpected BPF opcode ${code}`)
  }
  throw new Error("filter did not return a verdict")
}

describe("Linux native network seccomp", () => {
  it.each(
    [
      ["x64", 0xc000003e, 41],
      ["arm64", 0xc00000b7, 198]
    ] as const
  )(
    "blocks Unix sockets in both IP postures on %s while preserving socketpair",
    async (architecture, audit, syscall) => {
      const f = fixture()
      const descriptor = Object.getOwnPropertyDescriptor(process, "arch")!
      const originalInput = Stream.succeed(new Uint8Array([1]))
      const fd3 = { type: "output" as const }
      const fd4 = { type: "input" as const, stream: originalInput }
      try {
        Object.defineProperty(process, "arch", { ...descriptor, value: architecture })
        const service = ProcessConfinement.make({
          ...f,
          host: { ...f.host, platform: "linux", executable: (name) => name === "bwrap" ? "/usr/bin/bwrap" : undefined }
        })
        await run(Effect.gen(function*() {
          const command = ChildProcess.make("fixture", [], { additionalFds: { fd3, fd4 } })
          const wrapped = yield* service.confine(command, f.profile)
          expect(wrapped.command).toBe("/bin/sh")
          const seccomp = wrapped.args.indexOf("--seccomp")
          expect(wrapped.args.slice(seccomp, seccomp + 2)).toEqual(["--seccomp", "5"])
          expect(wrapped.options.additionalFds?.fd3).toBe(fd3)
          expect(wrapped.options.additionalFds?.fd4).toBe(fd4)
          expect(wrapped.options.additionalFds?.fd5).toBeUndefined()
          const filter = wrapped.args[3]!
          const bytes = NodeFs.readFileSync(filter)
          expect(NodeFs.statSync(filter).mode & 0o777).toBe(0o600)
          expect(evaluateFilter(bytes, audit, syscall, 1)).toBe(0x00050001)
          for (const domain of [2, 10, 40]) expect(evaluateFilter(bytes, audit, syscall, domain)).toBe(0x00050001)
          const socketpair = architecture === "x64" ? 53 : 199
          expect(evaluateFilter(bytes, audit, socketpair, 1)).toBe(0x7fff0000)
          for (const type of [3, 3 | 0x800, 3 | 0x80000, 3 | 0x80800, 2, 2 | 0x800, 2 | 0x80000, 2 | 0x80800, 5, 0]) {
            expect(evaluateFilter(bytes, audit, socketpair, 1, type)).toBe(0x00050001)
          }
          expect(evaluateFilter(bytes, audit, socketpair, 1, 1 | 0x80800)).toBe(0x7fff0000)
          expect(evaluateFilter(bytes, audit, socketpair, 2, 2)).toBe(0x7fff0000)
          expect(evaluateFilter(bytes, audit, 425, 1)).toBe(0x00050001)
          expect(evaluateFilter(bytes, audit, 426, 1)).toBe(0x7fff0000)
          expect(evaluateFilter(bytes, audit ^ 1, syscall, 1)).toBe(0x80000000)
          expect(evaluateFilter(bytes, audit, syscall + 0x40000000, 1)).toBe(0x80000000)
          const open = yield* service.confine(command, { ...f.profile, network: "open" })
          expect(open.args).toContain("--seccomp")
          const openBytes = NodeFs.readFileSync(open.args[3]!)
          expect(evaluateFilter(openBytes, audit, syscall, 1)).toBe(0x00050001)
          for (const domain of [2, 10]) expect(evaluateFilter(openBytes, audit, syscall, domain)).toBe(0x7fff0000)
          expect(evaluateFilter(openBytes, audit, socketpair, 1)).toBe(0x7fff0000)
          for (const type of [3, 3 | 0x800, 3 | 0x80000, 3 | 0x80800, 2, 2 | 0x800, 2 | 0x80000, 2 | 0x80800, 5, 0]) {
            expect(evaluateFilter(openBytes, audit, socketpair, 1, type)).toBe(0x00050001)
          }
          expect(evaluateFilter(openBytes, audit, socketpair, 1, 1 | 0x80800)).toBe(0x7fff0000)
          expect(evaluateFilter(openBytes, audit, socketpair, 2, 2)).toBe(0x7fff0000)
          expect(evaluateFilter(openBytes, audit, 425, 1)).toBe(0x00050001)
          expect(evaluateFilter(openBytes, audit, 426, 1)).toBe(0x7fff0000)
          expect(evaluateFilter(openBytes, audit ^ 1, syscall, 1)).toBe(0x80000000)
          expect(evaluateFilter(openBytes, audit, syscall + 0x40000000, 1)).toBe(0x80000000)
          expect(open.options.additionalFds).toBe(command.options.additionalFds)
        }))
        expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
      } finally {
        Object.defineProperty(process, "arch", descriptor)
      }
    }
  )

  it.each(["none", "open"] as const)("refuses unsupported architectures under %s networking", async (network) => {
    const f = fixture()
    const descriptor = Object.getOwnPropertyDescriptor(process, "arch")!
    try {
      Object.defineProperty(process, "arch", { ...descriptor, value: "riscv64" })
      const service = ProcessConfinement.make({
        ...f,
        host: { ...f.host, platform: "linux", executable: (name) => name === "bwrap" ? "/usr/bin/bwrap" : undefined }
      })
      const error = await run(Effect.flip(service.confine(ChildProcess.make("fixture"), { ...f.profile, network })))
      expect(error).toMatchObject({
        reason: { _tag: "PermissionDenied", description: expect.stringContaining("seccomp is unavailable on riscv64") }
      })
      expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
    } finally {
      Object.defineProperty(process, "arch", descriptor)
    }
  })
})

describe("target environment isolation", () => {
  it.each(
    [
      ["absent env", undefined, undefined, true],
      ["absent env with extendEnv false", undefined, false, true],
      ["replacement env with omitted extendEnv", { CALLER: "named value" }, undefined, false],
      ["replacement env with extendEnv true", { CALLER: "named value" }, true, true],
      ["replacement env with extendEnv false", { CALLER: "named value" }, false, false]
    ] as const
  )("matches the native inheritance contract for %s", async (_, env, extendEnv, inherits) => {
    const f = fixture()
    vi.stubEnv("SMITHERS_HOST_SECRET", "inherited private fixture")
    await run(Effect.gen(function*() {
      const wrapped = yield* ProcessConfinement.make(f).confine(
        ChildProcess.make("fixture", [], { env, extendEnv }),
        f.profile
      )
      const script = wrapped.args.find((arg) => arg.endsWith("/environment.sh"))!
      const contents = NodeFs.readFileSync(script, "utf8")
      expect(contents.includes("export SMITHERS_HOST_SECRET='inherited private fixture'")).toBe(inherits)
      expect(contents.includes("export CALLER='named value'")).toBe(env !== undefined)
      expect(wrapped.options.env?.SMITHERS_HOST_SECRET).toBeUndefined()
    }))
  })

  it("retains explicit removal of an otherwise inherited environment value", async () => {
    const f = fixture()
    vi.stubEnv("SMITHERS_ENV_TEST", "inherited fixture")
    await run(Effect.gen(function*() {
      const wrapped = yield* ProcessConfinement.make(f).confine(
        ChildProcess.make("fixture", [], { env: { SMITHERS_ENV_TEST: undefined }, extendEnv: true }),
        f.profile
      )
      const script = wrapped.args.find((arg) => arg.endsWith("/environment.sh"))!
      expect(NodeFs.readFileSync(script, "utf8")).not.toContain("export SMITHERS_ENV_TEST=")
    }))
  })

  it("skips nonportable inherited Bash function names while retaining ordinary inherited values", async () => {
    const f = fixture()
    vi.stubEnv("BASH_FUNC_which%%", "() { printf inherited; }")
    vi.stubEnv("SMITHERS_ENV_TEST", "ordinary inherited value")
    await run(Effect.gen(function*() {
      const wrapped = yield* ProcessConfinement.make(f).confine(ChildProcess.make("fixture"), f.profile)
      const script = wrapped.args.find((arg) => arg.endsWith("/environment.sh"))!
      const contents = NodeFs.readFileSync(script, "utf8")
      expect(contents).not.toContain("BASH_FUNC_which")
      expect(contents).toContain("export SMITHERS_ENV_TEST='ordinary inherited value'")
    }))
  })

  it("keeps approved loader variables and values private and inside confinement", async () => {
    const f = fixture()
    const env = {
      LD_PRELOAD: "/synthetic/fixture.so",
      LD_LIBRARY_PATH: "/synthetic/libs",
      DYLD_INSERT_LIBRARIES: "/synthetic/fixture.dylib",
      DYLD_LIBRARY_PATH: "/synthetic/dylibs",
      NODE_OPTIONS: "--require /synthetic/fixture.js",
      KEEP: "quoted ' value\n$(touch /synthetic/marker) `id`"
    }
    await run(Effect.gen(function*() {
      const wrapped = yield* ProcessConfinement.make(f).confine(
        ChildProcess.make("fixture", [], { env, extendEnv: false }),
        f.profile
      )
      expect(wrapped.options.extendEnv).toBe(false)
      for (const [name, value] of Object.entries(env)) {
        expect(wrapped.options.env?.[name]).toBeUndefined()
        expect(wrapped.args.some((arg) => arg.includes(value))).toBe(false)
      }
      const script = wrapped.args.find((arg) => arg.endsWith("/environment.sh"))!
      expect(NodeFs.statSync(script).mode & 0o777).toBe(0o600)
      const contents = NodeFs.readFileSync(script, "utf8")
      expect(contents).toContain("export LD_PRELOAD='/synthetic/fixture.so'")
      expect(contents).toContain("export KEEP='quoted '\\'' value")
      expect(contents).toContain("exec \"$@\"")
      expect(wrapped.args[1]).toContain(script)
    }))
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("refuses null bytes instead of changing the requested environment", async () => {
    const f = fixture()
    const error = await run(Effect.flip(
      ProcessConfinement.make(f).confine(
        ChildProcess.make("fixture", [], { env: { VALUE: "first\0second" }, extendEnv: false }),
        f.profile
      )
    ))
    expect(error).toMatchObject({
      reason: { _tag: "PermissionDenied", description: "environment variable contains a null byte" }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("refuses environment names that cannot be exported portably", async () => {
    const f = fixture()
    const error = await run(Effect.flip(
      ProcessConfinement.make(f).confine(
        ChildProcess.make("fixture", [], { env: { "bad-name": "private fixture" }, extendEnv: false }),
        f.profile
      )
    ))
    expect(error).toMatchObject({
      reason: { _tag: "PermissionDenied", description: "environment variable name is not portable" }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })
})
