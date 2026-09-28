/**
 * The QuickJS-WASM script runner — the production interpreter.
 *
 * A script runs inside a QuickJS interpreter compiled to WebAssembly: a
 * genuinely separate realm with no reference to the host's globals,
 * prototypes, or module loader. The prelude deletes `Date` and
 * `Math.random` — time and randomness are the `sys/now` and `sys/random`
 * catalog entries, journaled like any call — and the only bridge out is
 * `ctx.call`. The same single-file variant runs unmodified on Node and in
 * a browser. Adapted from the harness QuickJS binding
 * (packages/smithers/agent/harness/src/QuickJSSandbox.ts;
 * https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */

import variant from "@jitl/quickjs-singlefile-browser-release-sync"
import { Cause, Effect, Layer } from "effect"
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import * as QuickJsJobs from "./internal/QuickJsJobs.ts"
import * as JsonBoundary from "./JsonBoundary.ts"
import type * as Outcome from "./Outcome.ts"
import type * as Script from "./Script.ts"
import * as ScriptRunner from "./ScriptRunner.ts"

/**
 * Optional hard limits on a script evaluation, enforced by the QuickJS
 * runtime itself. Call budgets are the chain's fuel gate, not the
 * runner's.
 *
 * `memoryBytes` is clamped to {@link memoryFloor}: below it the realm
 * cannot even bootstrap and QuickJS aborts natively instead of failing
 * typed. `steps` counts interrupt-handler polls — QuickJS polls roughly
 * every few thousand instructions, so the budget is an order-of-magnitude
 * bound on work, not an instruction count. `stackBytes` bounds in-realm
 * recursion; leaving it unset lets deep recursion exhaust the HOST
 * WebAssembly stack instead, which aborts the module on dispose rather
 * than raising a catchable in-realm error, so opting out is only ever
 * right for a trusted fixture.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Limits {
  readonly memoryBytes?: number | undefined
  readonly steps?: number | undefined
  readonly stackBytes?: number | undefined
}

/**
 * The smallest memory limit the runner will apply: a QuickJS context needs
 * this much to boot without a native abort.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const memoryFloor = 256 * 1024

/**
 * The largest in-realm stack the runner will grant. Measured against
 * quickjs-emscripten-core 0.32.0: at 512 KiB and above, deep recursion
 * exhausts the host WebAssembly stack first — `evalCode` throws a host
 * `RangeError` the realm can neither see nor catch, the realm is left
 * holding live GC objects, and `runtime.dispose()` aborts the module. At
 * 256 KiB QuickJS raises its own catchable `stack overflow` and dispose is
 * clean.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const stackCeiling = 256 * 1024

/**
 * The prefix on every `runtime` failure the realm's defect boundary
 * produced from a HOST-side defect rather than from the script.
 *
 * A script's own throw, interrupt, or memory-limit failure never carries
 * it. Anything that does — a native WebAssembly abort, a host `RangeError`
 * from an exhausted WASM stack, a bug in this bridge — originated outside
 * the realm, so the journaled observation and the model reading it can
 * tell a script defect from a runner defect without consulting stderr.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const hostDefectMarker = "host: "

/**
 * Production-safe runner limits. Passing an explicit `undefined` for any
 * field opts out of that limit.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultLimits: Required<Limits> = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: stackCeiling,
  steps: 10_000
}

/**
 * The `runtime` failure message for a script whose text closed the async
 * wrapper it is spliced into.
 *
 * The wrapper is source concatenation, so a script can end its own body
 * early, run top-level statements, and reopen a body for the suffix to
 * close. The seal compares the body function's source text with the
 * authored text and refuses anything else before the body runs.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const escapedWrapper = "the script escaped its async wrapper"

/**
 * The prelude evaluated before every script. It installs `ctx.call`,
 * the three outcome constructors, and removes the realm's two sources of
 * nondeterminism. The raw bridge is captured in a closure and deleted
 * from the global object.
 */
const prelude = `(function () {
  // Capture every boundary intrinsic before the script can replace a realm
  // global. Otherwise a script that reassigns Number.isFinite can make
  // done(NaN) become a journaled Done(null) in production while every
  // in-process test reports invalid_outcome. Capturing is only half of it:
  // the copies these intrinsics build carry no prototype either, because
  // JSON.stringify reads an inherited "toJSON" and a realm prototype is
  // writable from the script (see copyJson).
  var intrinsicGetPrototypeOf = Object.getPrototypeOf
  var intrinsicObjectKeys = Object.keys
  var intrinsicDefineProperty = Object.defineProperty
  var intrinsicObjectPrototype = Object.prototype
  var intrinsicCreate = Object.create
  var intrinsicSetPrototypeOf = Object.setPrototypeOf
  var intrinsicIsArray = Array.isArray
  var intrinsicIsFinite = Number.isFinite
  var intrinsicStringify = JSON.stringify
  var intrinsicParse = JSON.parse
  var intrinsicFunctionToString = Function.prototype.toString
  var IntrinsicTypeError = TypeError
  var IntrinsicError = Error
  var IntrinsicPromise = Promise
  var intrinsicPromiseReject = IntrinsicPromise.reject.bind(IntrinsicPromise)
  var bridge = globalThis.__call
  // The authored text, set by the host as a string value. It never passes
  // through source concatenation a second time.
  var expectedBody = "async () => {\\n" + globalThis.__source + "\\n}"
  var maxDepth = ${JsonBoundary.maxJsonDepth}
  // The in-realm twin of JsonBoundary.jsonBoundary, and it must stay a
  // twin: whatever the two bindings disagree about is a value that behaves
  // one way in production and another in every in-process test. It BUILDS a
  // copy rather than validating in place, for the reason the host does —
  // stringifying the original would read every accessor a second time, so a
  // getter that changed its answer, or a toJSON hook, would decide what
  // actually crossed. Array holes are read by index and refused; JSON has
  // no hole and rewriting one to null would change an accepted value.
  var copyJson = function (value, depth, seen) {
    if (depth > maxDepth) throw new IntrinsicTypeError("not JSON-serializable")
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") {
      if (!intrinsicIsFinite(value)) throw new IntrinsicTypeError("not JSON-serializable")
      return value === 0 ? 0 : value
    }
    if (typeof value !== "object") throw new IntrinsicTypeError("not JSON-serializable")
    for (var seenIndex = 0; seenIndex < seen.length; seenIndex++) {
      if (seen[seenIndex] === value) throw new IntrinsicTypeError("not JSON-serializable")
    }
    var prototype = intrinsicGetPrototypeOf(value)
    var isArray = intrinsicIsArray(value)
    if (!isArray && prototype !== intrinsicObjectPrototype && prototype !== null) {
      throw new IntrinsicTypeError("not JSON-serializable")
    }
    seen[seen.length] = value
    var copied
    // Every container the copy is built from is detached from its prototype.
    // Capturing JSON.stringify is not enough on its own: stringify consults
    // an INHERITED "toJSON", so a script that assigns one to Object.prototype
    // or Array.prototype would otherwise replace the validated copy with
    // whatever that hook returns — the host handler would receive a payload
    // the boundary never saw, and done([1,2,3]) would journal Done("what the
    // hook said"). A prototype-less copy has no toJSON to find.
    if (isArray) {
      copied = []
      intrinsicSetPrototypeOf(copied, null)
      var length = value.length
      for (var index = 0; index < length; index++) {
        copied[copied.length] = copyJson(value[index], depth + 1, seen)
      }
    } else {
      copied = intrinsicCreate(null)
      var keys = intrinsicObjectKeys(value)
      for (var k = 0; k < keys.length; k++) {
        // Defined, not assigned. The prototype-less copy above already
        // denies "__proto__" its inherited setter, and defining rather than
        // assigning keeps that true of any container this walk ever builds.
        intrinsicDefineProperty(copied, keys[k], {
          configurable: true,
          enumerable: true,
          value: copyJson(value[keys[k]], depth + 1, seen),
          writable: true
        })
      }
    }
    seen.length = seen.length - 1
    return copied
  }
  var encodeInput = function (input) {
    try {
      return intrinsicStringify(copyJson(input, 0, []))
    } catch (error) {
      throw new IntrinsicTypeError(${JSON.stringify(JsonBoundary.unserializableInput)})
    }
  }
  // The outcome crosses the same gate as a call payload, in the realm that
  // produced it. Without this the wrapper's own JSON.stringify would
  // silently rewrite the terminal result — done(NaN) to Done(null), a
  // function or undefined property dropped, a toJSON hook executed — and
  // the two runner bindings would disagree about what a valid outcome is.
  // Returning null (never throwing) keeps the distinction the host draws
  // between "not JSON" and "not an outcome".
  var encodeOutcome = function (value) {
    try {
      return intrinsicStringify(copyJson(value, 0, []))
    } catch (error) {
      return null
    }
  }
  // The seal is the only path from the body to the host. It is an intrinsic
  // async function, so the promise the host reads is native and the value
  // always passes encodeOutcome: no realm Promise.prototype.then, and no
  // reassigned global, can substitute a result. The source check refuses a
  // body that is not exactly the authored text, which is what a wrapper
  // escape leaves behind.
  globalThis.__seal = async function (body) {
    if (intrinsicFunctionToString.call(body) !== expectedBody) {
      throw new IntrinsicError(${JSON.stringify(escapedWrapper)})
    }
    var value = await body()
    return encodeOutcome(value === undefined ? null : value)
  }
  delete globalThis.__source
  delete globalThis.__call
  delete globalThis.Date
  delete Math.random
  globalThis.ctx = Object.freeze({
    call: function (name, input) {
      if (typeof name !== "string") {
        return intrinsicPromiseReject(new IntrinsicTypeError(${JSON.stringify(JsonBoundary.missingCallName)}))
      }
      var encoded
      try {
        encoded = encodeInput(input === undefined ? null : input)
      } catch (error) {
        return intrinsicPromiseReject(error)
      }
      return bridge(name, encoded).then(function (encoded) {
        var settled = intrinsicParse(encoded)
        if (settled.ok) return settled.value
        var error = new IntrinsicError(settled.message)
        error.name = "CallError"
        throw error
      })
    }
  })
  globalThis.done = function (value) {
    return { _tag: "Done", value: value === undefined ? null : value }
  }
  globalThis.to = function (script) {
    return { _tag: "To", script: script }
  }
  globalThis.park = function (code, message) {
    return { _tag: "Park", reason: { code: code, message: message === undefined ? "" : message } }
  }
})()`

// The seal is captured into an eval-lexical `const` and deleted from the
// global object before the script body runs, so it is neither reachable as
// `globalThis.__seal` nor reassignable. The host reads the evaluation's
// completion value, the final statement, which authored text can neither
// follow nor reassign. A script that escapes the async wrapper leaves
// `__body` bound to a shorter function, and the seal refuses it as a
// runtime failure.
const wrap = (text: string): string =>
  `const __seal = globalThis.__seal
delete globalThis.__seal
const __body = async () => {\n${text}\n}
__seal(__body)`

interface BridgeCall {
  readonly name: string
  readonly payload: unknown
  readonly settle: (payload: unknown) => void
  readonly refusal?: string | undefined
}

/**
 * Carries a defect raised by the CALLER'S handler past the realm's own
 * defect boundary.
 *
 * That boundary exists for the WebAssembly module's aborts. A defect from
 * the handler is the host's, not the realm's, and the two must not be
 * confused: `SubChains` deliberately turns a failing child run into a
 * defect so the parent dies un-settled and can resume at the child's
 * settled prefix. Absorbing it into a journaled script failure would break
 * that contract and make the two runner bindings disagree about what kills
 * a run.
 */
class HandlerDefect {
  readonly defect: unknown
  constructor(defect: unknown) {
    this.defect = defect
  }
}

/**
 * Applies the host JSON boundary to one call input encoded by the realm.
 *
 * Captured in-realm intrinsics are the first defence, but the host still
 * treats their output as untrusted. Keeping this small gate named also lets
 * the suite exercise malformed text that a hardened realm cannot emit.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const decodeCallInput = (
  encoded: string
): { readonly payload: unknown; readonly refusal?: string | undefined } => {
  try {
    const payload = JsonBoundary.jsonBoundary(JSON.parse(encoded))
    return payload._tag === "Refused"
      ? { payload: null, refusal: JsonBoundary.unserializableInput }
      : { payload: payload.value }
  } catch {
    return { payload: null, refusal: JsonBoundary.unserializableInput }
  }
}

/**
 * Dispatches one queued realm call or settles its host-side input refusal.
 *
 * The refusal path is defence in depth: captured intrinsics prevent authored
 * code from producing it, while the host boundary must still fail closed if
 * the realm bridge ever hands it malformed text.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const dispatchBridgeCall = <E>(
  next: BridgeCall,
  pending: Array<BridgeCall>,
  handler: (request: ScriptRunner.Request) => Effect.Effect<unknown, E>
): Effect.Effect<void, E> => {
  if (next.refusal !== undefined) {
    return Effect.sync(() => next.settle({ message: next.refusal, ok: false }))
  }
  // `Effect.suspend` makes the invocation itself part of the guarded effect.
  // A handler that throws before returning its Effect is still the caller's
  // defect, and both runner bindings must let it kill the run identically.
  return Effect.suspend(() => handler({ name: next.name, payload: next.payload })).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        // A failed handler aborts the run; queued calls settle as aborted so
        // the realm holds no dangling promises when the scope disposes it.
        next.settle({ message: JsonBoundary.abortedLink, ok: false })
        for (const stale of pending.splice(0)) {
          stale.settle({ message: JsonBoundary.abortedLink, ok: false })
        }
      })
    ),
    Effect.catchDefect((defect) => Effect.die(new HandlerDefect(defect))),
    Effect.flatMap((result) =>
      Effect.sync(() => {
        // A handler result crosses the same JSON boundary as the in-process
        // binding; refusing here also keeps the host-side stringify in
        // settle() total.
        const resultBoundary = JsonBoundary.jsonBoundary(result)
        if (resultBoundary._tag === "Refused") {
          next.settle({ message: `the "${next.name}" call result is not JSON-serializable`, ok: false })
        } else {
          next.settle({ ok: true, value: resultBoundary.value })
        }
      })
    )
  )
}

/**
 * Encodes one bridge settlement for the realm.
 *
 * `JsonBoundary.jsonBoundary` bounds the shape and size of what reaches
 * here, but encoding is the last host-side step before a synchronous
 * QuickJS callback, and a `JSON.stringify` that throws there escapes as an
 * untyped defect that kills the whole run. It degrades to a refusal the
 * script can catch instead, so this function is total.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const encodeSettlement = (name: string, settlement: unknown): string => {
  try {
    return JSON.stringify(settlement)
  } catch {
    return JSON.stringify({ message: `the "${name}" call result cannot be encoded`, ok: false })
  }
}

/**
 * Caches a successful load process-wide while letting a rejected load be
 * retried: caching the rejection would turn one transient failure into a
 * permanently broken runner.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const cachedLoad = <A>(load: () => Promise<A>): () => Promise<A> => {
  let cached: Promise<A> | undefined
  return () => {
    cached = cached ?? load().catch((error: unknown) => {
      cached = undefined
      throw error
    })
    return cached
  }
}

/**
 * The loaded WebAssembly module, shared by every runner in the process:
 * compiling QuickJS is expensive and the module holds no per-script state.
 */
const wasmModule = cachedLoad(() => newQuickJSWASMModuleFromVariant(variant))

const evaluate = <E>(
  module: QuickJSWASMModule,
  limits: Limits,
  script: Script.Script,
  handler: (request: ScriptRunner.Request) => Effect.Effect<unknown, E>
): Effect.Effect<Outcome.Outcome, ScriptRunner.ScriptFailure | E> =>
  Effect.gen(function*() {
    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const runtime: QuickJSRuntime = module.newRuntime()
        if (limits.memoryBytes !== undefined) {
          runtime.setMemoryLimit(Math.max(limits.memoryBytes, memoryFloor))
        }
        if (limits.stackBytes !== undefined) {
          runtime.setMaxStackSize(Math.min(limits.stackBytes, stackCeiling))
        }
        if (limits.steps !== undefined) {
          const budget = limits.steps
          let steps = 0
          runtime.setInterruptHandler(() => ++steps > budget)
        }
        const context: QuickJSContext = runtime.newContext()
        return { context, runtime }
      }),
      ({ context, runtime }) =>
        Effect.sync(() => {
          // Disposal is best-effort. A realm that exhausted the host WASM
          // stack still holds live GC objects, and QuickJS asserts on that
          // during teardown; letting the assertion out would make cleanup
          // the run's outcome and lose whatever the script actually did.
          try {
            context.dispose()
          } catch {
            // The module is already aborted; there is nothing left to free.
          }
          try {
            runtime.dispose()
          } catch {
            // As above.
          }
        })
    )
    const { context, runtime } = acquired

    const pending: Array<BridgeCall> = []
    const deferreds = new Set<QuickJSDeferredPromise>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const deferred of deferreds) deferred.dispose()
        deferreds.clear()
      })
    )

    const bridge = context.newFunction("__call", (nameHandle, inputHandle) => {
      const name = context.getString(nameHandle)
      const encoded = context.getString(inputHandle)
      const deferred = context.newPromise()
      deferreds.add(deferred)
      const settle = (payload: unknown): void => {
        try {
          const handle = context.newString(encodeSettlement(name, payload))
          deferred.resolve(handle)
          handle.dispose()
        } finally {
          deferred.dispose()
          deferreds.delete(deferred)
        }
      }
      const input = decodeCallInput(encoded)
      pending.push({ name, payload: input.payload, refusal: input.refusal, settle })
      return deferred.handle
    })
    context.setProp(context.global, "__call", bridge)
    bridge.dispose()
    const source = context.newString(script.text)
    context.setProp(context.global, "__source", source)
    source.dispose()

    // The prelude is a fixed string over an empty realm; a failure here is
    // a defect in this module, never a property of the script.
    context.unwrapResult(context.evalCode(prelude)).dispose()

    // Parse first, without executing: a compile-only evaluation of the
    // wrapped source distinguishes a genuine parse failure from any runtime
    // error — including a script that throws an error merely *named*
    // SyntaxError — without trusting error names. An in-realm Function
    // construction is not a parse check: QuickJS builds the function by
    // concatenating its source, so text that closes that wrapper runs.
    const wrapped = wrap(script.text)
    const parsed = context.evalCode(wrapped, "script.js", { compileOnly: true })
    if (parsed.error !== undefined) {
      const failure = context.dump(parsed.error)
      parsed.error.dispose()
      return yield* new ScriptRunner.ScriptFailure({
        code: "compile",
        message: JsonBoundary.failureMessage(failure)
      })
    }
    parsed.value.dispose()

    const started = context.evalCode(wrapped)
    if (started.error !== undefined) {
      const failure = context.dump(started.error)
      started.error.dispose()
      // The source parsed, so anything here — an interrupt from the step
      // budget, a memory-limit throw, a wrapper escape — is runtime.
      return yield* new ScriptRunner.ScriptFailure({
        code: "runtime",
        message: JsonBoundary.failureMessage(failure)
      })
    }
    const scriptHandle = started.value
    yield* Effect.addFinalizer(() => Effect.sync(() => scriptHandle.dispose()))

    while (true) {
      const jobs = runtime.executePendingJobs()
      yield* QuickJsJobs.check(jobs)
      // Drain issued calls before consulting the script's promise: a call
      // that was issued settles durably even when the script no longer
      // awaits it (a race loser), and its bridge handle is disposed.
      const next = pending.shift()
      if (next !== undefined) {
        yield* dispatchBridgeCall(next, pending, handler)
        continue
      }
      const state = context.getPromiseState(scriptHandle)
      if (state.type === "fulfilled") {
        const value = context.dump(state.value)
        state.value.dispose()
        // The in-realm encoder answers null for a value JSON.stringify would
        // rewrite. A non-string or malformed result is the same refusal the
        // in-process binding makes.
        //
        // The parsed text then crosses the HOST boundary as well, exactly
        // as the in-process binding's returned value does. The two checks
        // are not redundant: the in-realm copy is what stops the realm's own
        // stringify from rewriting the value, and the host walk is the one
        // that bounds size — the shared gate both bindings answer to.
        let decoded: ReturnType<typeof JsonBoundary.jsonBoundary>
        try {
          if (typeof value !== "string") throw new TypeError(JsonBoundary.unserializableOutcome)
          decoded = JsonBoundary.jsonBoundary(JSON.parse(value))
        } catch {
          decoded = { _tag: "Refused" }
        }
        if (decoded._tag === "Refused") {
          return yield* new ScriptRunner.ScriptFailure({
            code: "invalid_outcome",
            message: JsonBoundary.unserializableOutcome
          })
        }
        const outcome = JsonBoundary.decodeOutcome(decoded.value)
        if (outcome._tag === "None") {
          return yield* new ScriptRunner.ScriptFailure({
            code: "invalid_outcome",
            message: JsonBoundary.notAnOutcome
          })
        }
        return outcome.value
      }
      if (state.type === "rejected") {
        const failure = context.dump(state.error)
        state.error.dispose()
        return yield* new ScriptRunner.ScriptFailure({
          code: "runtime",
          message: JsonBoundary.failureMessage(failure)
        })
      }
      // Nothing is queued and no VM job can advance the script: it
      // awaited something the sealed realm can never settle.
      return yield* new ScriptRunner.ScriptFailure({
        code: "runtime",
        message: JsonBoundary.neverSettles
      })
    }
  }).pipe(
    Effect.scoped,
    // Last line of defence for the sealed realm's own machinery, and ONLY
    // for it. A native WebAssembly abort — the shape a host-stack
    // exhaustion takes — is a defect, and a defect escapes `Chain.run`
    // entirely: nothing is journaled, so the resumed link replays the same
    // script and dies the same way forever. Degrading it to a `runtime`
    // ScriptFailure makes it a journaled observation the model can route
    // around, which is the contract this module states. The catch is
    // unconditional by design, so the message carries `hostDefectMarker`
    // and the defect is logged with its cause here: a bridge bug or a
    // disposed-handle use lands in the journal labelled as the host's, not
    // the script's, and the log keeps the stack the observation cannot. A
    // defect the CALLER'S handler raised is re-raised unchanged: it is the
    // host's failure, not the script's, and must kill the run.
    Effect.catchDefect((defect) =>
      defect instanceof HandlerDefect
        ? Effect.die(defect.defect)
        : Effect.flatMap(
          Effect.logWarning("QuickJsRunner degraded a host defect to a runtime script failure", Cause.die(defect)),
          () =>
            new ScriptRunner.ScriptFailure({
              code: "runtime",
              message: hostDefectMarker + JsonBoundary.failureMessage(defect)
            })
        )
    )
  )

/**
 * Constructs the QuickJS runner, compiling the WebAssembly module once per
 * process.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  limits: Limits = {},
  load: () => Promise<QuickJSWASMModule> = wasmModule
): Effect.Effect<ScriptRunner.Service, ScriptRunner.ScriptFailure> =>
  Effect.map(
    // A failed load is a typed, retryable unavailability — never a defect,
    // and never cached (see cachedLoad).
    Effect.tryPromise({
      catch: (error) =>
        new ScriptRunner.ScriptFailure({
          code: "runner_unavailable",
          message: JsonBoundary.failureMessage(error)
        }),
      try: () => load()
    }),
    (module) =>
      ScriptRunner.make({
        run: (script, handler) => evaluate(module, { ...defaultLimits, ...limits }, script, handler)
      })
  )

/**
 * The production script-runner layer: a sealed QuickJS realm per link.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (limits: Limits = {}): Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure> =>
  Layer.effect(ScriptRunner.ScriptRunner)(make(limits))
