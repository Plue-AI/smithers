/**
 * Browser `Jj` layer.
 *
 * jj is a native binary, but jj-lib compiles to wasm32-wasip1: the
 * `flows_jj.wasm` reactor (built by `crates/flows-jj`, shipped in this
 * package's `wasm/` directory) exposes the six `Jj` contract operations over a
 * tiny JSON ABI, and runs against the {@link WasiPreview1} host shim over the
 * same virtual-filesystem slice `BrowserFileSystem` mounts on. {@link layer}
 * wires the two together.
 *
 * The module is an argument, never a fetch: the page decides how the bytes
 * arrive (bundler asset, `fetch` + `WebAssembly.compileStreaming`, cache), the
 * same way it decides which ZenFS backend is mounted. Likewise persistence is
 * the page's concern — with an async-mirror ZenFS mount, call the mount's
 * `sync` after operations that must survive a reload; this layer does not own
 * the mount.
 *
 * Hosts without a wasm module keep {@link layerUnsupported}: the service stays
 * present and every operation fails `not_installed` in the error channel — an
 * absent capability is a capability with an answer, never a missing tag.
 *
 * @since 0.1.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { Jj, JjError, JjErrorCode } from "../Jj.ts"
import type { SyncFsLike } from "./WasiFs.ts"
import * as WasiPreview1 from "./WasiPreview1.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** The `module` every failure this adapter produces names. */
const MODULE = "BrowserJj"

/**
 * How much of an unusable ABI response an error message quotes.
 *
 * The response is guest-supplied and unbounded, and the resulting `JjError` is
 * journaled, so the diagnosis carries a prefix rather than the whole payload.
 */
const excerptLimit = 256

/** The ellipsis is part of the budget, so an excerpt never exceeds the limit it names. */
const excerpt = (text: string): string => text.length > excerptLimit ? `${text.slice(0, excerptLimit - 1)}…` : text

/**
 * The exports the frozen `flows_jj.wasm` ABI guarantees: a reactor
 * initializer, an allocator pair, and one call entrypoint taking UTF-8 JSON
 * and returning `(ptr << 32) | len` packed into a `u64`.
 */
interface AbiExports {
  readonly memory: WebAssembly.Memory
  readonly _initialize: () => void
  readonly flows_jj_alloc: (size: number) => number
  readonly flows_jj_free: (ptr: number, size: number) => void
  readonly flows_jj_call: (ptr: number, len: number) => bigint
}

const REQUIRED_EXPORTS = ["memory", "_initialize", "flows_jj_alloc", "flows_jj_free", "flows_jj_call"] as const

/**
 * One live reactor: the ABI exports and the WASI host they were instantiated
 * over. The two are disposed together, because the host's fd table is the
 * only record of which backend descriptors the guest holds.
 */
interface Reactor {
  readonly abi: AbiExports
  readonly wasi: WasiPreview1.WasiPreview1
}

/**
 * What the browser `Jj` layer needs to run jj in a page: the wasm reactor, and
 * the synchronous filesystem the repository lives on.
 *
 * The layer never fetches the module itself — a page decides when and how to
 * load bytes, and passing an already-compiled `WebAssembly.Module` lets it
 * share one across layers.
 *
 * Read semantics, so a caller knows what it still owns: `root`, `fs`,
 * `onStdout`, and `onStderr` are read once, when `make` is called, and
 * replacing them on the options object afterwards changes nothing. `wasm` is
 * read once too, but LATER — at the first operation, which is what lets a page
 * hand over bytes it is still loading. `fs` itself stays a live service the
 * page continues to own.
 *
 * @category models
 * @since 0.1.0
 */
export interface BrowserJjOptions {
  /**
   * The `flows_jj.wasm` reactor, precompiled or as raw bytes. The layer never
   * fetches; hand it the module the page already loaded.
   */
  readonly wasm: WebAssembly.Module | BufferSource
  /**
   * The synchronous filesystem the repository lives on — ZenFS's sync surface
   * in a page, `node:fs` behind a rooted adapter in tests. The slice's
   * namespace is the wasm module's namespace: its `"/"` is preopened as WASI
   * `"/"`.
   */
  readonly fs: SyncFsLike
  /**
   * The jj workspace root inside the slice namespace, defaulting to `"/"`.
   * Prefer a dedicated directory (`"/repo"`) that already exists so the
   * repository's `.jj` does not share the mount root with unrelated state.
   */
  readonly root?: string
  /** Receives anything jj-lib writes to stdout. Unset drops it. */
  readonly onStdout?: (text: string) => void
  /** Receives anything jj-lib writes to stderr — Rust panics arrive here. */
  readonly onStderr?: (text: string) => void
}

const isJjErrorCode = Schema.is(JjErrorCode)

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/** A realm-independent test for raw, non-shared wasm bytes. */
const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === "[object ArrayBuffer]"

type OkPayload = Record<string, unknown>

/**
 * One serialized ABI exchange: encode the request into wasm memory through the
 * module's allocator, call, copy the response out, and free both buffers (the
 * host owns freeing the request buffer too — the module must not).
 */
const exchange = (abi: AbiExports, request: Record<string, unknown>): string => {
  const req = encoder.encode(JSON.stringify(request))
  const reqPtr = abi.flows_jj_alloc(req.length)
  // `flows_jj_alloc` answers 0 when the guest cannot allocate
  // (`crates/flows-jj/src/abi.rs`). Writing the request there would overwrite
  // the module's own low linear memory and then call with a bogus pointer, so
  // the exchange refuses before touching memory — and frees nothing, because
  // nothing was allocated.
  if (reqPtr === 0) throw new Error("the wasm module could not allocate a request buffer")
  try {
    new Uint8Array(abi.memory.buffer, reqPtr, req.length).set(req)
    const packed = BigInt.asUintN(64, abi.flows_jj_call(reqPtr, req.length))
    // A packed answer of exactly 0 is the same allocator failure on the
    // RESPONSE side, which the module reports as a null pointer and a zero
    // length. Decoding it would blame a "malformed response" for an
    // out-of-memory guest.
    if (packed === 0n) throw new Error("the wasm module could not allocate a response buffer")
    const resPtr = Number(packed >> 32n)
    const resLen = Number(packed & 0xFFFF_FFFFn)
    const response = new Uint8Array(abi.memory.buffer, resPtr, resLen).slice()
    abi.flows_jj_free(resPtr, resLen)
    return decoder.decode(response)
  } finally {
    // The request buffer is freed on the error path too. A trapped instance is
    // discarded by the caller, but the free is what keeps the pairing honest
    // when the throw came from the host side (a response outside memory) and
    // the guest allocator is still intact.
    try {
      abi.flows_jj_free(reqPtr, req.length)
    } catch {
      // Freeing after a trap can itself trap; the original failure wins.
    }
  }
}

/**
 * `{"ok":…}` or `{"err":…}` decoded onto the frozen `JjError` codes. An error
 * code outside the frozen set, or a response that is neither shape, degrades
 * to `unknown` — the ABI partner is pinned in-repo, so either is a bug worth
 * surfacing, not worth crashing over.
 */
const decodeResponse = (method: string, command: string, text: string): Effect.Effect<OkPayload, JjError> => {
  const malformed = () =>
    Effect.fail(
      new JjError({
        code: "unknown",
        module: MODULE,
        method,
        command,
        message: `jj ${method}: malformed ABI response: ${excerpt(text)}`
      })
    )
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return malformed()
  }
  if (isRecord(parsed) && "err" in parsed) {
    const err: unknown = parsed.err
    const code = isRecord(err) && isJjErrorCode(err.code) ? err.code : "unknown"
    const message = isRecord(err) && typeof err.message === "string" ? err.message : JSON.stringify(err)
    // The guest names the command when it ran one; otherwise the operation's
    // own command stands, so no failure reaches a caller without it.
    const reported = isRecord(err) && typeof err.command === "string" ? err.command : command
    return Effect.fail(
      new JjError({
        code,
        module: MODULE,
        method,
        command: excerpt(reported),
        message: `jj ${method}: ${excerpt(message)}`
      })
    )
  }
  if (isRecord(parsed) && isRecord(parsed.ok)) {
    return Effect.succeed(parsed.ok)
  }
  return malformed()
}

/** A string the operation's response payload is required to carry. */
const stringField = (
  method: string,
  command: string,
  payload: OkPayload,
  field: string
): Effect.Effect<string, JjError> => {
  const value = payload[field]
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(
      new JjError({
        code: "unknown",
        module: MODULE,
        method,
        command,
        message: `jj ${method}: ABI response is missing the "${field}" field`
      })
    )
}

/**
 * Compile (when handed bytes), instantiate over a fresh WASI shim, check the
 * frozen export surface, bind memory, and run the reactor initializer —
 * memory must be bound first because `_initialize` may already issue
 * syscalls.
 *
 * A failure after the WASI host exists (a missing export, a trapping
 * `_initialize`) disposes the host before rethrowing: an initializer that
 * opened a file and then panicked would otherwise leave that descriptor on
 * the backend with no instance left to close it.
 */
const instantiate = async (
  host: {
    readonly fs: SyncFsLike
    readonly onStdout?: ((text: string) => void) | undefined
    readonly onStderr?: ((text: string) => void) | undefined
  },
  wasm: WebAssembly.Module | BufferSource
): Promise<Reactor> => {
  const wasi = WasiPreview1.make({
    fs: host.fs,
    ...(host.onStdout === undefined ? {} : { onStdout: host.onStdout }),
    ...(host.onStderr === undefined ? {} : { onStderr: host.onStderr })
  })
  try {
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { ...wasi.imports } }
    // The two `instantiate` overloads return different shapes, and the lib
    // definitions disagree across type environments (lib.dom returns a
    // `WebAssemblyInstantiatedSource` for bytes; workers-types returns the
    // instance for both). Discriminate the value, not the overload.
    const instantiated: unknown = await WebAssembly.instantiate(wasm as never, imports)
    const instance = instantiated instanceof WebAssembly.Instance
      ? instantiated
      : (instantiated as { readonly instance: WebAssembly.Instance }).instance
    const exports = instance.exports as Record<string, unknown>
    const missing = REQUIRED_EXPORTS.filter((name) =>
      name === "memory" ? !(exports[name] instanceof WebAssembly.Memory) : typeof exports[name] !== "function"
    )
    if (missing.length > 0) {
      throw new Error(`the module does not export the flows_jj ABI (missing: ${missing.join(", ")})`)
    }
    const abi = exports as unknown as AbiExports
    wasi.initialize(abi.memory)
    abi._initialize()
    return { abi, wasi }
  } catch (cause) {
    try {
      wasi.dispose()
    } catch {
      // The instantiation failure is the one to report; a backend that also
      // refuses to close what the initializer opened cannot improve on it.
    }
    throw cause
  }
}

/**
 * The shipped WASI reactor reads real symlinks as target bytes. Refuse them
 * before any operation that snapshots, including implicit snapshots on reads.
 * Inspect link metadata only, and include ignored paths: the host does not
 * interpret jj's ignore rules. Repository metadata directories are not working
 * copy inputs, but links at those names must still be rejected.
 */
const assertNoSymlinks = (fs: SyncFsLike, root: string): void => {
  const pending = [root]
  while (pending.length > 0) {
    const path = pending.pop()!
    const stats = fs.lstatSync(path)
    if (stats.isSymbolicLink()) {
      throw new Error("real symlinks are unsupported by the browser reactor; remove them before snapshotting")
    }
    if (!stats.isDirectory()) continue
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const child = `${path}/${entry.name}`
      if (entry.name === ".jj" || entry.name === ".git") {
        if (fs.lstatSync(child).isSymbolicLink()) {
          throw new Error("real symlinks are unsupported by the browser reactor; remove them before snapshotting")
        }
        continue
      }
      pending.push(child)
    }
  }
}

/**
 * Creates a `Jj` backed by a `flows_jj.wasm` module over a synchronous
 * filesystem slice.
 *
 * Instantiation is lazy — the first operation pays for it — and every
 * operation runs under a single-permit semaphore: the wasm instance is
 * single-threaded mutable state, so concurrent fibers serialize rather than
 * interleave inside it.
 *
 * A reactor that traps is discarded, not reused: its host descriptors are
 * closed at once and the next operation instantiates a fresh one. A `Jj` from
 * `make` has no explicit end of life beyond that; {@link layerScoped} closes
 * the live reactor when its scope closes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: BrowserJjOptions): Jj => create(options).jj

/**
 * A `Jj` together with the disposal `make` keeps private: closes the live
 * reactor's host descriptors and refuses every later operation.
 */
const create = (options: BrowserJjOptions): {
  readonly jj: Jj
  readonly dispose: Effect.Effect<void>
} => {
  // The host surface is snapshotted here rather than re-read per operation, so
  // replacing `options.fs` or a stdio sink after `make` returns cannot change
  // which authority crosses the wasm boundary. `wasm` stays a single lazy read
  // at first instantiation, which is what makes a page able to hand over bytes
  // it is still fetching; see `BrowserJjOptions`.
  const root = options.root ?? "/"
  const host = {
    fs: options.fs,
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr })
  }
  const gate = Semaphore.makeUnsafe(1)
  let ready: Reactor | undefined
  let disposed = false

  /**
   * Drops the live reactor and closes every host descriptor its guest still
   * held. Runs after a trap, where the guest's own cleanup never happened, and
   * at disposal. The cache is cleared BEFORE the close so a backend that
   * refuses to close cannot keep a trapped reactor in service.
   */
  const discard = (): void => {
    const reactor = ready
    ready = undefined
    if (reactor === undefined) return
    try {
      reactor.wasi.dispose()
    } catch {
      // The trap that led here is the failure to report; a backend that also
      // refuses to close what the guest opened cannot improve on it.
    }
  }

  /**
   * The module, read from the options object EXACTLY once.
   *
   * Instantiation is retried per operation, so re-reading `options.wasm` on a
   * retry would let a caller swap the module between a failed operation and the
   * next one. The read's outcome is memoized, throw included, so a getter is
   * called once whatever it does.
   *
   * Bytes are COPIED at the read. A `BufferSource` is a live view on memory the
   * page still owns, so holding the caller's view would leave the executable
   * authority mutable after the one-time capture: the same object could carry
   * an unusable module on the first operation and a different, working one on
   * the retry. A `WebAssembly.Module` is already immutable and is kept as is.
   * A direct `SharedArrayBuffer` is outside the declared `BufferSource` option
   * and is not treated as raw module bytes. A view backed by shared memory still
   * takes the view branch and is copied into ordinary, unshared bytes.
   */
  const capture = (wasm: WebAssembly.Module | BufferSource): WebAssembly.Module | BufferSource =>
    ArrayBuffer.isView(wasm)
      ? new Uint8Array(new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength))
      : isArrayBuffer(wasm)
      ? wasm.slice(0)
      : wasm
  let taken: { readonly ok: true; readonly wasm: WebAssembly.Module | BufferSource } | {
    readonly ok: false
    readonly cause: unknown
  } | undefined
  const wasmOnce = (): WebAssembly.Module | BufferSource => {
    if (taken === undefined) {
      try {
        taken = { ok: true, wasm: capture(options.wasm) }
      } catch (cause) {
        taken = { ok: false, cause }
      }
    }
    if (!taken.ok) throw taken.cause
    return taken.wasm
  }

  /**
   * The module, instantiated once and reused.
   *
   * The failure is a DESCRIPTION rather than a `JjError`: the module is shared
   * by every operation, so this step cannot say which one asked, and a failure
   * that reached a caller without a `method` and a `command` is exactly what
   * `jjError` exists to prevent. `invoke` completes it.
   * Instantiation and caching finish under the permit even if the caller is
   * interrupted, so scoped disposal always sees the acquired reactor.
   */
  const ensure: Effect.Effect<Reactor, string> = Effect.suspend(() =>
    disposed
      ? Effect.fail("the browser reactor was disposed")
      : ready === undefined
      ? Effect.map(
        Effect.tryPromise({
          try: () => instantiate(host, wasmOnce()),
          catch: (cause) => `failed to instantiate flows_jj.wasm: ${messageOf(cause)}`
        }),
        (reactor) => {
          ready = reactor
          return reactor
        }
      ).pipe(Effect.uninterruptible)
      : Effect.succeed(ready)
  )

  const invoke = (
    method: string,
    command: string,
    request: Record<string, unknown>
  ): Effect.Effect<OkPayload, JjError> =>
    gate.withPermit(
      // The instantiation failure is completed here, where the operation that
      // asked for the module is known, rather than reaching a caller with no
      // method and no command.
      Effect.flatMap(
        Effect.catch(ensure, (description) =>
          Effect.fail(
            new JjError({ code: "unknown", module: MODULE, method, command, message: `jj ${method}: ${description}` })
          )),
        ({ abi }) =>
          Effect.suspend(() => {
            // A throw out of an ABI exchange (proc_exit, a Rust panic, a
            // response outside memory, an allocator that answers null) leaves
            // the guest's state and its open descriptors unknown, so the
            // reactor is discarded before the failure is reported and the next
            // operation starts fresh. The host-side guards above the exchange
            // throw too, but they never entered the reactor, so it stays.
            const call = (request: Record<string, unknown>): string => {
              try {
                return exchange(abi, request)
              } catch (cause) {
                discard()
                throw cause
              }
            }
            let text: string
            try {
              // Keep the guard and the synchronous ABI call in one turn under
              // the permit, before even auto-init can write repository state.
              if (["snapshot", "status", "diff", "restore", "workspaceAdd"].includes(method)) {
                assertNoSymlinks(host.fs, String(request.root))
              }
              // Older shipped reactors auto-initialize on reads. Refuse missing
              // repositories before entering them, and keep initialization an
              // explicit ABI operation on the compensable snapshot path.
              if (["status", "diff", "restore", "snapshot"].includes(method)) {
                try {
                  host.fs.statSync(`${String(request.root)}/.jj`)
                } catch (cause) {
                  if (method !== "snapshot" || (cause as { code?: string }).code !== "ENOENT") throw cause
                  const initialized = call({ op: "init", root: request.root })
                  const response: unknown = JSON.parse(initialized)
                  if (!isRecord(response) || !isRecord(response.ok)) return decodeResponse(method, command, initialized)
                }
              }
              text = call(request)
            } catch (cause) {
              // A trap (proc_exit, a Rust panic, an out-of-range response) is a
              // failed operation, never a failed fiber.
              return Effect.fail(
                new JjError({
                  code: "unknown",
                  module: MODULE,
                  method,
                  message: `jj ${method}: ${excerpt(messageOf(cause))}`,
                  command
                })
              )
            }
            return decodeResponse(method, command, text)
          })
      )
    )

  // Disposal takes the permit so it never runs between an operation's
  // instantiation and its exchange; an operation that arrives afterwards fails
  // in `ensure` instead of instantiating a reactor nobody will close.
  const dispose: Effect.Effect<void> = gate.withPermit(
    Effect.sync(() => {
      disposed = true
      discard()
    })
  )

  // Operations that never enter the reactor still observe scoped disposal at
  // execution time, under the same permit as reactor calls and finalization.
  const withoutReactor = <A>(
    method: string,
    command: string,
    operation: Effect.Effect<A, JjError>
  ): Effect.Effect<A, JjError> =>
    gate.withPermit(Effect.suspend(() =>
      disposed
        ? Effect.fail(
          new JjError({
            code: "unknown",
            module: MODULE,
            method,
            command,
            message: `jj ${method}: the browser reactor was disposed`
          })
        )
        : operation
    ))

  const jj = Jj.of({
    snapshot: (message) =>
      invoke("snapshot", "jj snapshot", { op: "snapshot", root, ...(message === undefined ? {} : { message }) }).pipe(
        Effect.flatMap((ok) =>
          Effect.all({
            commitId: stringField("snapshot", "jj snapshot", ok, "commitId"),
            changeId: stringField("snapshot", "jj snapshot", ok, "changeId")
          })
        )
      ),
    // The frozen ABI names the restore target `changeId`; it takes any
    // revision, and the engine passes the snapshot's commit id.
    restore: (revision) => Effect.asVoid(invoke("restore", "jj restore", { op: "restore", root, changeId: revision })),
    diff: (from, to) =>
      Effect.flatMap(
        invoke("diff", "jj diff", { op: "diff", root, from, to }),
        (ok) => stringField("diff", "jj diff", ok, "diff")
      ),
    workspaceAdd: (name, path, revision) =>
      Effect.asVoid(
        // The frozen ABI has no revision field on `workspaceAdd`, so a pinned
        // add is the add followed by a workspace-scoped restore: every op
        // carries its own `root`, and rooting the restore at the NEW lane's
        // path pins that workspace's working copy without touching the
        // parent's.
        //
        // The WHOLE sequence is uninterruptible, not just the pin. `NodeJj`
        // promises a failed `workspaceAdd` leaves no lane behind, and a cancel
        // delivered between the add, the pin, and the pin's rollback is exactly
        // what would strand one. Interruptibility buys nothing here anyway:
        // each call runs the wasm module to completion before it yields.
        Effect.uninterruptible(
          Effect.flatMap(
            invoke("workspaceAdd", "jj workspace add", { op: "workspaceAdd", root, name, path }),
            () =>
              revision === undefined
                ? Effect.void
                : Effect.asVoid(
                  invoke("restore", "jj restore", { op: "restore", root: path, changeId: revision })
                ).pipe(
                  // The two calls are not one transaction, so a failed pin has
                  // to undo the add: the lane is already registered. The
                  // directory stays, as it does after any forget.
                  //
                  // A rollback that ITSELF fails is ignored, and that is a
                  // deliberate limit rather than an oversight: the pin failure
                  // is the one a caller can act on, and turning one error into
                  // two hides it. The README records what it costs, which is
                  // that a lane can stay registered when both calls fail. Only
                  // a single ABI operation can close that gap for good.
                  Effect.catch((failure) =>
                    Effect.andThen(
                      Effect.ignore(
                        invoke("workspaceForget", "jj workspace forget", { op: "workspaceForget", root, name })
                      ),
                      Effect.fail(
                        new JjError({
                          code: failure.code,
                          module: MODULE,
                          method: "workspaceAdd",
                          command: "jj workspace add",
                          message: `jj workspaceAdd: pinning the new lane failed: ${failure.message}`
                        })
                      )
                    )
                  )
                )
          )
        )
      ),
    workspaceForget: (name) =>
      Effect.asVoid(invoke("workspaceForget", "jj workspace forget", { op: "workspaceForget", root, name })),
    status: () =>
      Effect.flatMap(
        invoke("status", "jj status", { op: "status", root }),
        (ok) => stringField("status", "jj status", ok, "status")
      ),
    // The layer owns exactly one workspace slice, so the repository root that
    // contains `from` is the configured root — but only when `from` is actually
    // inside it. Answering for a path in an unrelated tree would be a wrong
    // answer rather than a missing one, so it fails instead.
    root: (from) =>
      withoutReactor(
        "root",
        "jj root",
        contains(root, from)
          ? Effect.succeed(root)
          : Effect.fail(
            new JjError({
              code: "unknown",
              module: MODULE,
              method: "root",
              command: "jj root",
              message: `jj root: ${from} is not inside the workspace root ${root}`
            })
          )
      ),
    // The frozen rc.0 wasm ABI has no revert or operation-restore operation,
    // and its snapshot reports no operation id. The methods remain present
    // and fail explicitly so feature detection never depends on an optional
    // property disappearing.
    revert: () => withoutReactor("revert", "jj revert", fail("revert", "jj revert")),
    opRestore: () => withoutReactor("opRestore", "jj op restore", fail("opRestore", "jj op restore"))
  })
  return { jj, dispose }
}

/**
 * Provides the `Jj` service backed by a `flows_jj.wasm` module.
 *
 * The service outlives whatever consumed the layer: a reactor that is still
 * live when the program ends keeps its host descriptors until the page does.
 * {@link layerScoped} is the layer to use when that matters.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: BrowserJjOptions): Layer.Layer<Jj> => Layer.succeed(Jj)(make(options))

/**
 * Provides the `Jj` service backed by a `flows_jj.wasm` module, and closes
 * the live reactor's host descriptors when the layer's scope closes. Every
 * operation after that fails in the error channel, so a service that escaped
 * its scope answers rather than reviving a reactor nobody will close.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerScoped = (options: BrowserJjOptions): Layer.Layer<Jj> => Layer.effect(Jj)(makeScoped(options))

/**
 * The scoped form of {@link make}: the `Jj` is released, closing the live
 * reactor's host descriptors, when the scope it was acquired in closes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeScoped = (options: BrowserJjOptions): Effect.Effect<Jj, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(Effect.sync(() => create(options)), (created) => created.dispose),
    (created) => created.jj
  )

/**
 * A namespace path reduced to its meaning: `.` and empty segments drop, `..`
 * pops, and `..` of the root is the root. Comparing raw strings accepted
 * `/repo/../outside` as inside `/repo`.
 */
const normalize = (path: string): string => {
  const segments: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join("/")}`
}

/** Whether a namespace path lies inside the slice the layer was given. */
const contains = (root: string, from: string): boolean => {
  if (!from.startsWith("/")) return false
  const base = normalize(root)
  const target = normalize(from)
  return target === base || target.startsWith(base === "/" ? "/" : `${base}/`)
}

const fail = (method: string, command: string) =>
  Effect.fail(
    new JjError({
      code: "not_installed",
      module: MODULE,
      method,
      message: "jj is not available in the browser",
      command
    })
  )

/**
 * Provides a `Jj` service whose every operation fails with `not_installed`:
 * the layer for hosts that have no `flows_jj.wasm` to hand to {@link layer}.
 * It is the same code the node implementation reports when the binary is
 * absent, which keeps callers from needing a browser-specific branch.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerUnsupported: Layer.Layer<Jj> = Layer.succeed(Jj)({
  // The commands named are the ones `layer` reports for the same operation,
  // so a refused operation journals the same command with or without wasm.
  snapshot: () => fail("snapshot", "jj snapshot"),
  restore: () => fail("restore", "jj restore"),
  diff: () => fail("diff", "jj diff"),
  workspaceAdd: () => fail("workspaceAdd", "jj workspace add"),
  workspaceForget: () => fail("workspaceForget", "jj workspace forget"),
  status: () => fail("status", "jj status"),
  root: () => fail("root", "jj root"),
  revert: () => fail("revert", "jj revert"),
  opRestore: () => fail("opRestore", "jj op restore")
})
