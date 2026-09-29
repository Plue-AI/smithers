/**
 * `BrowserJj` against a hand-assembled wasm module speaking the frozen ABI.
 *
 * The real `flows_jj.wasm` cannot be scripted into every response shape, so —
 * exactly like `NodeJjClassification` scripts a fake `jj` binary — these tests
 * bake canned responses into a tiny wasm module and drive the layer end to
 * end through real `WebAssembly` instantiation. The module echoes each request
 * to fd 2, so the shim's stderr sink doubles as the assertion channel for what
 * the layer serialized. The real artifact is exercised by
 * `BrowserJjContract.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { PlatformError } from "effect/PlatformError"
import * as fs from "node:fs"
import { runInNewContext } from "node:vm"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import { isJjError, Jj, type JjError, type JjFailure } from "../src/Jj.ts"
import { emptyWasmModule, fakeFlowsJjWasm } from "./FakeFlowsJjWasm.ts"

/** The fake module sees an empty workspace and existing repository metadata. */
const slice = {
  ...fs,
  statSync: () => fs.statSync(import.meta.filename),
  lstatSync: () => fs.lstatSync(import.meta.dirname),
  readdirSync: () => []
}

/**
 * `Jj`'s error channel is `JjFailure` because the capability kernel decorates
 * the very same tag; an undecorated host layer can only ever produce the
 * `JjError` half, so narrow rather than widen every assertion.
 */
const jjError = (error: JjFailure | PlatformError): JjError => {
  if (!isJjError(error)) throw new Error(`expected a JjError from an undecorated host layer, got ${error._tag}`)
  return error
}

const run = <A>(options: BrowserJj.BrowserJjOptions, effect: (jj: Jj) => Effect.Effect<A, JjFailure>) =>
  Effect.provide(Effect.flatMap(Jj, effect), BrowserJj.layer(options))

const flip = (
  options: BrowserJj.BrowserJjOptions,
  effect: (jj: Jj) => Effect.Effect<unknown, JjFailure>
) => Effect.provide(Effect.map(Effect.flip(Effect.flatMap(Jj, effect)), jjError), BrowserJj.layer(options))

/** Every string field any operation extracts, so one module serves all six. */
const OK_ALL =
  "{\"ok\":{\"commitId\":\"0a1b2c\",\"changeId\":\"qpvuntsm\",\"diff\":\"diff --git\",\"status\":\"clean\"}}"

describe("BrowserJj over the fake ABI module", () => {
  it.effect("instantiates lazily, runs _initialize once, and reuses the instance", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}" }),
        fs: slice,
        onStderr: (text) => stderr.push(text)
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      expect(stderr).toEqual([]) // nothing instantiated until the first operation
      expect(yield* (jj.status())).toBe("clean")
      expect(yield* (jj.status())).toBe("clean")
      expect(stderr).toHaveLength(3)
      expect(stderr[0]).toBe("INIT")
      expect(JSON.parse(stderr[1]!)).toEqual({ op: "status", root: "/" }) // root defaults to "/"
      expect(JSON.parse(stderr[2]!)).toEqual({ op: "status", root: "/" })
    }))

  it.effect("serializes the frozen request shape for every operation", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: OK_ALL }),
        fs: slice,
        root: "/repo",
        onStdout: () => {},
        onStderr: (text) => stderr.push(text)
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      expect(yield* (jj.snapshot("checkpoint"))).toEqual({ commitId: "0a1b2c", changeId: "qpvuntsm" })
      expect(yield* (jj.snapshot())).toEqual({ commitId: "0a1b2c", changeId: "qpvuntsm" })
      yield* (jj.restore("qpvuntsm"))
      expect(yield* (jj.diff("qpvuntsm", "zzzzzzzz"))).toBe("diff --git")
      yield* (jj.workspaceAdd("lane", "/lane1"))
      yield* (jj.workspaceForget("lane"))
      expect(yield* (jj.status())).toBe("clean")
      expect(yield* (jj.root!("/repo/nested"))).toBe("/repo")
      expect(yield* (Effect.flip(jj.revert!("qpvuntsm")))).toMatchObject({
        code: "not_installed",
        command: "jj revert"
      })
      expect(yield* (Effect.flip(jj.opRestore!("0a1b2c")))).toMatchObject({
        code: "not_installed",
        command: "jj op restore"
      })
      expect(stderr.slice(1).map((request) => JSON.parse(request))).toEqual([
        { op: "snapshot", root: "/repo", message: "checkpoint" },
        { op: "snapshot", root: "/repo" },
        { op: "restore", root: "/repo", changeId: "qpvuntsm" },
        { op: "diff", root: "/repo", from: "qpvuntsm", to: "zzzzzzzz" },
        { op: "workspaceAdd", root: "/repo", name: "lane", path: "/lane1" },
        { op: "workspaceForget", root: "/repo", name: "lane" },
        { op: "status", root: "/repo" }
      ])
    }))

  it.effect("pins a revisioned workspace add with a restore rooted at the new lane", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: OK_ALL }),
        fs: slice,
        root: "/repo",
        onStderr: (text) => stderr.push(text)
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      yield* (jj.workspaceAdd("lane", "/lane1", "qpvuntsm"))
      // The frozen ABI has no revision field on `workspaceAdd`, so the pin is
      // the add followed by a restore rooted at the NEW lane's path — the
      // parent's tree is never touched.
      expect(stderr.slice(1).map((request) => JSON.parse(request))).toEqual([
        { op: "workspaceAdd", root: "/repo", name: "lane", path: "/lane1" },
        { op: "restore", root: "/lane1", changeId: "qpvuntsm" }
      ])
    }))

  it.effect("serializes concurrent operations through the semaphore", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}" }),
        fs: slice,
        onStderr: (text) => stderr.push(text)
      }
      const results = yield* run(
        options,
        (jj) => Effect.all([jj.status(), jj.status(), jj.status()], { concurrency: "unbounded" })
      )
      expect(results).toEqual(["clean", "clean", "clean"])
      expect(stderr.filter((entry) => entry === "INIT")).toHaveLength(1) // one instance for all fibers
    }))

  it.effect("accepts a precompiled WebAssembly.Module as well as raw bytes", () =>
    Effect.gen(function*() {
      const module = yield* Effect.promise(() =>
        WebAssembly.compile(
          Uint8Array.from(fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"ok\"}}" }))
        )
      )
      expect(yield* run({ wasm: module, fs: slice }, (jj) => jj.status())).toBe("ok")
    }))

  it.effect("retries with the bytes it copied, not with the caller's mutated buffer", () =>
    Effect.gen(function*() {
      // Reading `options.wasm` once is not enough on its own: a `BufferSource`
      // is a live view on memory the page still owns, so the SAME object can
      // carry different bytes by the time a retry compiles it. The bytes are
      // copied at the read, which is what makes the capture final.
      const working = fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"ok\"}}" })
      const bytes = new Uint8Array(working.length) // all zeros: not a module
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer({ wasm: bytes, fs: slice })))

      expect((yield* (Effect.flip(jj.status()))).message).toContain("failed to instantiate flows_jj.wasm")
      bytes.set(working) // the caller's buffer is now a perfectly good module
      expect((yield* (Effect.flip(jj.status()))).message).toContain("failed to instantiate flows_jj.wasm")
    }))

  it.effect("accepts raw ArrayBuffer bytes as well as a view", () =>
    Effect.gen(function*() {
      const buffer = fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"from a buffer\"}}" }).buffer
      expect(yield* run({ wasm: buffer, fs: slice }, (jj) => jj.status())).toBe("from a buffer")
    }))

  it.effect("copies an ArrayBuffer from another realm before the caller can mutate it", () =>
    Effect.gen(function*() {
      const working = fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"ok\"}}" })
      const buffer = runInNewContext("new ArrayBuffer(byteLength)", { byteLength: working.byteLength }) as ArrayBuffer
      expect(buffer instanceof ArrayBuffer).toBe(false)
      const bytes = new Uint8Array(buffer)
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer({ wasm: buffer, fs: slice })))

      expect((yield* (Effect.flip(jj.status()))).message).toContain("failed to instantiate flows_jj.wasm")
      bytes.set(working)
      expect((yield* (Effect.flip(jj.status()))).message).toContain("failed to instantiate flows_jj.wasm")
    }))

  it.effect("decodes err responses onto the frozen JjError codes", () =>
    Effect.gen(function*() {
      const conflicted = fakeFlowsJjWasm({
        response: "{\"err\":{\"code\":\"conflict\",\"message\":\"would conflict\",\"command\":\"jj snapshot\"}}"
      })
      const error = yield* flip({ wasm: conflicted, fs: slice }, (jj) => jj.snapshot("x"))
      expect(error).toMatchObject({
        code: "conflict",
        message: "jj snapshot: would conflict",
        command: "jj snapshot"
      })

      const missing = fakeFlowsJjWasm({
        response: "{\"err\":{\"code\":\"invalid_ref\",\"message\":\"no such revision\"}}"
      })
      const invalid = yield* flip({ wasm: missing, fs: slice }, (jj) => jj.restore("zzz"))
      expect(invalid.code).toBe("invalid_ref")
      expect(invalid.message).toBe("jj restore: no such revision")
      // The guest named no command, so the operation's own command stands: a
      // failure a caller has to act on never arrives without one.
      expect(invalid.command).toBe("jj restore")

      const absent = fakeFlowsJjWasm({ response: "{\"err\":{\"code\":\"not_installed\",\"message\":\"n\"}}" })
      expect((yield* flip({ wasm: absent, fs: slice }, (jj) => jj.status())).code).toBe("not_installed")
    }))

  it.effect("bounds a guest-reported command before putting it on JjError", () =>
    Effect.gen(function*() {
      const reported = `jj ${"x".repeat(700)}`
      const wasm = fakeFlowsJjWasm({
        response: JSON.stringify({ err: { code: "unknown", message: "failed", command: reported } })
      })

      const error = yield* flip({ wasm, fs: slice }, (jj) => jj.status())

      // 256 is the excerpt ceiling, ellipsis included: a bound that quoted 256
      // characters AND an ellipsis would be one past the limit it names.
      expect(error.command).toHaveLength(256)
      expect(error.command).not.toBe(reported)
      expect(error.command?.endsWith("…")).toBe(true)
    }))

  it.effect("degrades err responses outside the frozen vocabulary to unknown", () =>
    Effect.gen(function*() {
      const weird = fakeFlowsJjWasm({ response: "{\"err\":{\"code\":\"weird\",\"message\":\"m\"}}" })
      const error = yield* flip({ wasm: weird, fs: slice }, (jj) => jj.status())
      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: m")

      const bare = fakeFlowsJjWasm({ response: "{\"err\":\"boom\"}" })
      const bareError = yield* flip({ wasm: bare, fs: slice }, (jj) => jj.status())
      expect(bareError.code).toBe("unknown")
      expect(bareError.message).toBe("jj status: \"boom\"")

      const silent = fakeFlowsJjWasm({ response: "{\"err\":{\"code\":\"conflict\"}}" })
      const silentError = yield* flip({ wasm: silent, fs: slice }, (jj) => jj.status())
      expect(silentError.code).toBe("conflict")
      expect(silentError.message).toBe("jj status: {\"code\":\"conflict\"}")
    }))

  it.effect("treats responses outside the {ok}|{err} envelope as unknown failures", () =>
    Effect.gen(function*() {
      for (const response of ["not json", "42", "null", "{\"ok\":\"nope\"}", "{\"neither\":1}"]) {
        const error = yield* flip({ wasm: fakeFlowsJjWasm({ response }), fs: slice }, (jj) => jj.status())
        expect(error.code, response).toBe("unknown")
        expect(error.message, response).toContain("malformed ABI response")
      }
    }))

  it.effect("fails an operation whose ok payload is missing its field", () =>
    Effect.gen(function*() {
      const empty = fakeFlowsJjWasm({ response: "{\"ok\":{}}" })
      const cases: Array<readonly [(jj: Jj) => Effect.Effect<unknown, JjFailure>, string]> = [
        [(jj) => jj.snapshot(), "commitId"],
        [(jj) => jj.diff("a", "b"), "diff"],
        [(jj) => jj.status(), "status"]
      ]
      for (const [operation, field] of cases) {
        const error = yield* flip({ wasm: empty, fs: slice }, operation)
        expect(error.code).toBe("unknown")
        expect(error.message).toContain(`missing the "${field}" field`)
      }
    }))

  it.effect("reports instantiation failure per operation and retries with the SAME module", () =>
    Effect.gen(function*() {
      const options: { wasm: WebAssembly.Module | BufferSource; fs: typeof slice } = {
        wasm: new Uint8Array([1, 2, 3]),
        fs: slice
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      const first = yield* (Effect.flip(jj.status()))
      expect(first.code).toBe("unknown")
      expect(first.message).toContain("failed to instantiate flows_jj.wasm")

      // Instantiation is retried per operation, so re-reading the option would
      // let a caller swap the module in between. It is taken exactly once.
      options.wasm = fakeFlowsJjWasm({ response: "{\"ok\":{\"changeId\":\"zzz\"}}" })
      const second = yield* (Effect.flip(jj.snapshot()))
      expect(second.message).toContain("failed to instantiate flows_jj.wasm")
    }))

  it.effect("reads the wasm option once even when the read itself throws", () =>
    Effect.gen(function*() {
      let reads = 0
      const options: BrowserJj.BrowserJjOptions = {
        fs: slice,
        get wasm(): WebAssembly.Module {
          reads++
          throw "boom" // eslint-disable-line no-throw-literal
        }
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))

      expect((yield* (Effect.flip(jj.status()))).message).toBe("jj status: failed to instantiate flows_jj.wasm: boom")
      expect((yield* (Effect.flip(jj.status()))).message).toBe("jj status: failed to instantiate flows_jj.wasm: boom")
      expect(reads).toBe(1)
    }))

  it.effect("names every missing export of a module that does not speak the ABI", () =>
    Effect.gen(function*() {
      const error = yield* flip({ wasm: emptyWasmModule(), fs: slice }, (jj) => jj.status())
      expect(error.code).toBe("unknown")
      expect(error.message).toContain("missing: memory, _initialize, flows_jj_alloc, flows_jj_free, flows_jj_call")
    }))

  it.effect("names the operation that asked for the module on an instantiation failure", () =>
    Effect.gen(function*() {
      // Instantiation is shared by every operation, so the failure has no
      // method of its own. It is still a failure of the operation the caller
      // made, and `@smthrs/kernel` reads `.method` off it.
      const error = yield* flip({ wasm: new Uint8Array([1, 2, 3]), fs: slice }, (jj) => jj.diff("a", "b"))
      expect(error).toMatchObject({
        code: "unknown",
        module: "BrowserJj",
        method: "diff",
        command: "jj diff"
      })
      expect(error.message).toMatch(/^jj diff: failed to instantiate flows_jj\.wasm: /)
    }))

  it.effect("frees the request and response buffers on the success path", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}", logAllocs: true }),
        fs: slice,
        onStderr: (text) => stderr.push(text)
      }
      expect(yield* run(options, (jj) => jj.status())).toBe("clean")
      expect(stderr.filter((entry) => entry === "ALOC")).toHaveLength(1) // the request buffer
      expect(stderr.filter((entry) => entry === "FREE")).toHaveLength(2) // response, then request
    }))

  it.effect("frees the request buffer even when flows_jj_call traps", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ trap: true, logAllocs: true }),
        fs: slice,
        onStderr: (text) => stderr.push(text)
      }
      const error = yield* flip(options, (jj) => jj.status())
      expect(error.code).toBe("unknown")
      // The error path must free what it allocated before the trapped
      // instance is discarded: exactly one ALOC, exactly one FREE.
      expect(stderr.filter((entry) => entry === "ALOC")).toHaveLength(1)
      expect(stderr.filter((entry) => entry === "FREE")).toHaveLength(1)
    }))

  /**
   * A slice that counts host descriptors: `openSync` hands out fake fds and
   * `closeSync` records them, so a test can see what a trapped guest left
   * open on the backend and whether the host released it.
   */
  const countingSlice = () => {
    const opened: Array<number> = []
    const closed: Array<number> = []
    return {
      opened,
      closed,
      fs: {
        ...slice,
        openSync: () => {
          const fd = 100 + opened.length
          opened.push(fd)
          return fd
        },
        closeSync: (fd: number) => {
          closed.push(fd)
        }
      }
    }
  }

  it.effect("closes the host descriptors a trapped guest left open and retries on a fresh reactor", () =>
    Effect.gen(function*() {
      // flows-jj/robustness/4: the guest opens a file, then traps before its
      // own fd_close. The host must close that descriptor at the trap, and
      // the next operation must run on a NEW instance rather than the one
      // whose state is unknown.
      const counting = countingSlice()
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ trap: true, openBeforeTrap: true }),
        fs: counting.fs,
        onStderr: (text) => stderr.push(text)
      }
      const jj = BrowserJj.make(options)
      for (let call = 1; call <= 3; call++) {
        const error = jjError(yield* Effect.flip(jj.status()))
        expect(error.message).toBe("jj status: wasm module called proc_exit(7)")
        expect(counting.opened).toHaveLength(call)
        expect(counting.closed).toEqual(counting.opened)
        // One INIT per instantiation: every call after a trap starts fresh.
        expect(stderr.filter((entry) => entry === "INIT")).toHaveLength(call)
      }
    }))

  it.effect("keeps the reactor when a host-side guard refuses before the exchange", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const missingRepo = {
        ...slice,
        statSync: (path: string) => {
          if (path.endsWith("/.jj")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
          return slice.statSync()
        }
      }
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}" }),
        fs: missingRepo,
        onStderr: (text) => stderr.push(text)
      }
      const jj = BrowserJj.make(options)
      // `status` refuses a missing repository before entering the reactor.
      expect(jjError(yield* Effect.flip(jj.status())).code).toBe("unknown")
      expect(jjError(yield* Effect.flip(jj.status())).code).toBe("unknown")
      expect(stderr.filter((entry) => entry === "INIT")).toHaveLength(1)
    }))

  it.effect("refuses every operation after scope disposal, including effects constructed before closure", () =>
    Effect.gen(function*() {
      const options: BrowserJj.BrowserJjOptions = { wasm: new Uint8Array(), fs: slice, root: "/repo" }
      for (
        const acquire of [
          BrowserJj.makeScoped(options),
          Effect.flatMap(Effect.provide(Jj, BrowserJj.layerScoped(options)), (jj) => Effect.succeed(jj))
        ]
      ) {
        let operations: ReadonlyArray<readonly [string, string, Effect.Effect<unknown, JjFailure | PlatformError>]> = []
        yield* Effect.scoped(Effect.map(acquire, (jj) => {
          operations = [
            ["snapshot", "jj snapshot", jj.snapshot()],
            ["restore", "jj restore", jj.restore("rev")],
            ["diff", "jj diff", jj.diff("a", "b")],
            ["workspaceAdd", "jj workspace add", jj.workspaceAdd("lane", "/lane")],
            ["workspaceForget", "jj workspace forget", jj.workspaceForget("lane")],
            ["status", "jj status", jj.status()],
            ["root", "jj root", jj.root!("/repo/file")],
            ["root", "jj root", jj.root!("/outside")],
            ["revert", "jj revert", jj.revert!("rev")],
            ["opRestore", "jj op restore", jj.opRestore!("op")]
          ]
        }))
        for (const [method, command, operation] of operations) {
          const error = jjError(yield* Effect.flip(operation))
          expect(error).toMatchObject({
            code: "unknown",
            method,
            command,
            message: `jj ${method}: the browser reactor was disposed`
          })
        }
      }
    }))

  it.effect("layerScoped closes the live reactor's descriptors when the scope closes", () =>
    Effect.gen(function*() {
      const counting = countingSlice()
      const stderr: Array<string> = []
      let escaped: Jj | undefined
      // The fake never closes `/f` and never traps here, so the descriptor is
      // live until something outside the guest releases it.
      const wasm = fakeFlowsJjWasm({ trap: true, openBeforeTrap: true })
      const options: BrowserJj.BrowserJjOptions = { wasm, fs: counting.fs, onStderr: (text) => stderr.push(text) }
      yield* Effect.scoped(
        Effect.gen(function*() {
          const jj = yield* BrowserJj.makeScoped(options)
          escaped = jj
          yield* Effect.flip(jj.status())
        })
      )
      expect(counting.closed).toEqual(counting.opened)
      // A service that escaped its scope answers in the error channel.
      const error = jjError(yield* Effect.flip(escaped!.status()))
      expect(error.message).toBe("jj status: the browser reactor was disposed")
      expect(stderr.filter((entry) => entry === "INIT")).toHaveLength(1)
    }))

  it.effect("layerScoped provides the same service as layer", () =>
    Effect.gen(function*() {
      const status = yield* Effect.provide(
        Effect.flatMap(Jj, (jj) => jj.status()),
        BrowserJj.layerScoped({ wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}" }), fs: slice })
      )
      expect(status).toBe("clean")
    }))

  it.effect("surfaces a proc_exit trap as a failed operation naming the command", () =>
    Effect.gen(function*() {
      const error = yield* flip({ wasm: fakeFlowsJjWasm({ trap: true }), fs: slice }, (jj) => jj.status())
      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: wasm module called proc_exit(7)")
      expect(error.command).toBe("jj status")
    }))

  it.effect("survives a corrupt packed answer pointing outside wasm memory", () =>
    Effect.gen(function*() {
      // ptr far past the module's single memory page: copying the response out
      // throws a RangeError, which must classify as a failed operation.
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ packedResult: { ptr: 0x7FFF_0000, len: 4096 } }),
        fs: slice
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      const first = yield* (Effect.map(Effect.flip(jj.status()), jjError))
      expect(first.code).toBe("unknown")
      expect(first.command).toBe("jj status")
      // The throw released the semaphore permit: the same instance still answers
      // the next operation instead of deadlocking.
      const second = yield* (Effect.map(Effect.flip(jj.diff("a", "b")), jjError))
      expect(second.code).toBe("unknown")
      expect(second.command).toBe("jj diff")
    }))

  it.effect("answers the repository root only for a path inside the slice", () =>
    Effect.gen(function*() {
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: OK_ALL }),
        fs: slice,
        root: "/repo"
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))

      expect(yield* (jj.root!("/repo"))).toBe("/repo")
      expect(yield* (jj.root!("/repo/deep/nest"))).toBe("/repo")
      // "The repository root that CONTAINS `from`" has no answer for a path in
      // an unrelated tree, and `/repository-elsewhere` is not inside `/repo`
      // however much of the prefix it shares.
      const outside = yield* (Effect.map(Effect.flip(jj.root!("/elsewhere")), jjError))
      expect(outside).toMatchObject({ code: "unknown", module: "BrowserJj", method: "root", command: "jj root" })
      expect(outside.message).toContain("is not inside the workspace root /repo")
      expect((yield* (Effect.map(Effect.flip(jj.root!("/repository-elsewhere")), jjError))).code).toBe("unknown")
      // A raw prefix comparison accepted these: `..` climbs out of the slice,
      // and a relative path names nothing in the namespace at all.
      expect((yield* (Effect.map(Effect.flip(jj.root!("/repo/../outside")), jjError))).code).toBe("unknown")
      expect((yield* (Effect.map(Effect.flip(jj.root!("repo/nested")), jjError))).code).toBe("unknown")
      // And these are inside however they are spelled.
      expect(yield* (jj.root!("/repo/"))).toBe("/repo")
      expect(yield* (jj.root!("/repo/./deep/../nest"))).toBe("/repo")
    }))

  it.effect("answers any absolute path when the slice root is the whole namespace", () =>
    Effect.gen(function*() {
      const jj = yield* (
        Effect.provide(Jj, BrowserJj.layer({ wasm: fakeFlowsJjWasm({ response: OK_ALL }), fs: slice }))
      )

      expect(yield* (jj.root!("/anything/at/all"))).toBe("/")
    }))

  it.effect("refuses to write a request at address zero when the guest cannot allocate", () =>
    Effect.gen(function*() {
      // `flows_jj_alloc` answers 0 on failure; writing there would scribble
      // over the module's own low memory and then call with a bogus pointer.
      const starved = fakeFlowsJjWasm({ response: OK_ALL, allocResult: 0, logAllocs: true })
      const stderr: Array<string> = []
      const error = yield* flip(
        { wasm: starved, fs: slice, onStderr: (text) => stderr.push(text) },
        (jj) => jj.status()
      )

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: the wasm module could not allocate a request buffer")
      // Nothing was allocated, so nothing is freed on a pointer that never was.
      expect(stderr.filter((entry) => entry === "FREE")).toHaveLength(0)
    }))

  it.effect("reads a zero packed answer as the guest's response allocation failing", () =>
    Effect.gen(function*() {
      // (0 << 32) | 0 is what `flows_jj_call` returns when it cannot allocate
      // the RESPONSE buffer. Decoding it blamed a "malformed ABI response".
      const starved = fakeFlowsJjWasm({ packedResult: { ptr: 0, len: 0 } })
      const error = yield* flip({ wasm: starved, fs: slice }, (jj) => jj.status())

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: the wasm module could not allocate a response buffer")
      expect(error.command).toBe("jj status")
    }))

  it.effect("bounds the response it quotes back in an error message", () =>
    Effect.gen(function*() {
      // The response is guest-supplied and the error is journaled, so the
      // diagnosis carries a prefix rather than the whole payload.
      const noisy = fakeFlowsJjWasm({ response: `"${"n".repeat(600)}"` })
      const error = yield* flip({ wasm: noisy, fs: slice }, (jj) => jj.status())

      expect(error.message).toContain("malformed ABI response")
      expect(error.message.length).toBeLessThan(340)
      expect(error.message.endsWith("…")).toBe(true)
    }))

  it.effect("names the module, the method, and the command on every failure it produces", () =>
    Effect.gen(function*() {
      // `@smthrs/kernel` reads `.method` off a `JjError`, and a UI that maps a
      // failure to remediation cannot parse English for the operation. Every
      // shape a failure can take is driven here, including the ones that never
      // reach the ABI at all.
      const failing = fakeFlowsJjWasm({ response: "{\"err\":{\"code\":\"conflict\",\"message\":\"m\"}}" })
      expect(yield* flip({ wasm: failing, fs: slice }, (jj) => jj.snapshot("x")))
        .toMatchObject({ module: "BrowserJj", method: "snapshot", command: "jj snapshot" })
      // an ok payload missing its field
      expect(yield* flip({ wasm: fakeFlowsJjWasm({ response: "{\"ok\":{}}" }), fs: slice }, (jj) => jj.diff("a", "b")))
        .toMatchObject({ module: "BrowserJj", method: "diff", command: "jj diff" })
      // a response outside the envelope
      expect(yield* flip({ wasm: fakeFlowsJjWasm({ response: "nope" }), fs: slice }, (jj) => jj.status()))
        .toMatchObject({ module: "BrowserJj", method: "status", command: "jj status" })
      // a trap
      expect(yield* flip({ wasm: fakeFlowsJjWasm({ trap: true }), fs: slice }, (jj) => jj.workspaceForget("l")))
        .toMatchObject({ module: "BrowserJj", method: "workspaceForget", command: "jj workspace forget" })
      // a module that never instantiates: the failure happens before any
      // operation reaches the ABI, and used to arrive with neither field.
      expect(yield* flip({ wasm: new Uint8Array([1, 2, 3]), fs: slice }, (jj) => jj.restore("z")))
        .toMatchObject({ module: "BrowserJj", method: "restore", command: "jj restore" })
    }))

  it.effect("keeps the filesystem and the stdio sinks it was given at construction", () =>
    Effect.gen(function*() {
      // The options object has one owner, but nothing should be re-read after
      // `make` returns: swapping `fs` between construction and the first
      // operation would change which authority crosses the wasm boundary.
      const stderr: Array<string> = []
      const options = {
        wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}" }),
        fs: slice,
        onStderr: (text: string) => stderr.push(text)
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      const swapped: Array<string> = []
      Object.defineProperty(options, "fs", {
        get: () => {
          throw new Error("the filesystem option was read again")
        }
      })
      options.onStderr = (text: string) => swapped.push(text)

      expect(yield* (jj.status())).toBe("clean")
      expect(stderr).toHaveLength(2) // INIT plus the echoed request
      expect(swapped).toEqual([])
    }))

  it.effect("survives a corrupt packed answer whose length overruns wasm memory", () =>
    Effect.gen(function*() {
      const overrun = fakeFlowsJjWasm({ packedResult: { ptr: 0, len: 0x7FFF_FFFF } })
      const error = yield* flip({ wasm: overrun, fs: slice }, (jj) => jj.snapshot())
      expect(error.code).toBe("unknown")
      expect(error.message).toContain("jj snapshot: ")
      expect(error.command).toBe("jj snapshot")
    }))
})

it.effect("reports initialization failures without attempting a snapshot", () =>
  Effect.gen(function*() {
    for (
      const response of [
        "{\"err\":{\"code\":\"unknown\",\"message\":\"init refused\",\"command\":\"jj init\"}}",
        "null",
        "{\"ok\":42}"
      ]
    ) {
      const requests: Array<string> = []
      const error = yield* flip({
        wasm: fakeFlowsJjWasm({ response }),
        fs: {
          ...slice,
          statSync: () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" })
          }
        },
        onStderr: (text) => requests.push(text)
      }, (jj) => jj.snapshot())
      expect(error.code).toBe("unknown")
      expect(requests.slice(1).map((request) => JSON.parse(request).op)).toEqual(["init"])
    }
  }))
