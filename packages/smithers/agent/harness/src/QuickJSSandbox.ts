/**
 * The QuickJS-WASM sandbox binding.
 *
 * This is the production `Sandbox`: the cell runs inside a QuickJS interpreter
 * compiled to WebAssembly, which is a genuinely separate JavaScript realm with
 * no reference to the host's globals, prototypes, or module loader. The same
 * single-file variant runs unmodified on Node and in a browser, so a browser
 * host provides this layer and calls the identical harness.
 *
 * What the cell can reach is exactly `ctx`: `ctx.call` bridges to the host's
 * durable flow boundary, `ctx.flows` is a frozen catalog projection. The
 * prelude removes `Date` and `Math.random` from the realm, because a replayed
 * cell must reach the same calls in the same order, and `Proxy`, because a
 * value that answers reflection from a handler cannot be weighed against the
 * run's memory ceiling. There is no filesystem, no network, no process, and no
 * module loader to reach in the first place.
 *
 * Teardown is scope finalization and cancellation is fiber interruption: an
 * interrupted frame disposes the runtime, which is the only thing holding the
 * cell alive.
 *
 * Which QuickJS build is compiled is a seam. The default compiles the
 * single-file build from bytes, which is what Node and a browser want. A host
 * whose runtime forbids compiling WebAssembly from bytes at runtime, such as
 * Cloudflare's workerd, provides {@link Variant} instead and names a build
 * whose module came from its toolchain.
 *
 * @since 0.1.0
 */

import singlefile from "@jitl/quickjs-singlefile-browser-release-sync"
import { Context, Duration, Effect, Layer, Option, Schema, type Scope } from "effect"
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSSyncVariant,
  QuickJSWASMModule
} from "quickjs-emscripten-core"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import * as Cell from "./Cell.ts"
import type { HarnessError } from "./HarnessError.ts"
import * as bytes from "./internal/bytes.ts"
import * as elide from "./internal/elide.ts"
import * as printChannel from "./internal/printChannel.ts"
import { refusal } from "./internal/refusal.ts"
import * as Sandbox from "./Sandbox.ts"
import * as VariablesPanel from "./VariablesPanel.ts"

/**
 * Every intrinsic the host's own realm-side code reads, bound before a cell runs.
 *
 * A global script may rebind `Object`, and under a per-cell realm that cost the
 * cell that did it and nothing else. Under a realm that outlives the cell it
 * costs the run: `encode` reaches `Object.keys` at call time, so one top-level
 * `const Object = {}` in frame 3 makes every `ctx.call` and every
 * `console.log` from frame 4 on die on `TypeError: not a function`, with no
 * name in the failure to connect it to the declaration that caused it. The same
 * holds for `JSON`, `Array`, `Number`, `String`, `TypeError` and `Promise`.
 *
 * Binding them here makes a cell that shadows an intrinsic cost exactly what a
 * REPL should charge for it — its own later code — and nothing the harness runs
 * on the cell's behalf. Nothing is refused, because nothing needs to be.
 */
const preludeIntrinsics = `  var keysOf = Object.keys
  var freezeValue = Object.freeze
  var prototypeOf = Object.getPrototypeOf
  var objectPrototype = Object.prototype
  var define = Object.defineProperty
  var isArray = Array.isArray
  var stringify = JSON.stringify
  var parse = JSON.parse
  var finite = Number.isFinite
  var render = String
  var Fault = TypeError
  var Deferred = Promise
  var argumentsOf = Array.prototype.slice`

/**
 * The realm-side helpers both preludes install.
 *
 * `encode` carries the label of what it is encoding so one validator serves
 * `ctx.call`, `ctx.done`, `ctx.park` and `ctx.justify` without any of them
 * having to describe its own refusal.
 */
const preludeHelpers = `${preludeIntrinsics}
  var freeze = function (value) {
    if (value !== null && typeof value === "object") {
      keysOf(value).forEach(function (key) { freeze(value[key]) })
      freezeValue(value)
    }
    return value
  }
  var encode = function (label, input) {
    var seen = []
    var visit = function (value) {
      if (value === null || typeof value === "string" || typeof value === "boolean") return
      if (typeof value === "number" && finite(value)) return
      if (typeof value !== "object") throw new Fault(label + " must be JSON-serializable")
      if (seen.indexOf(value) >= 0) throw new Fault(label + " must be JSON-serializable")
      var prototype = prototypeOf(value)
      if (!isArray(value) && prototype !== objectPrototype && prototype !== null) {
        throw new Fault(label + " must be JSON-serializable")
      }
      seen.push(value)
      keysOf(value).forEach(function (key) { visit(value[key]) })
      seen.pop()
    }
    visit(input)
    return stringify(input)
  }
  var settleEnvelope = function (settled) {
    // A failed call RESOLVES with the failure envelope; only teardown throws.
    // See Cell.callFailure for why.
    if (settled.ok) return settled.value
    if (settled.aborted) throw new Error(settled.failure.error.message)
    return settled.failure
  }
  var dispatch = function (flow, input, at) { return bridge(flow, input, at).then(settleEnvelope) }
  // The at option is whatever the cell wrote, so it is encoded defensively
  // rather than strictly: a value JSON cannot hold travels as null and the
  // boundary answers it as an ordinary invalid_input, instead of throwing out
  // of a cell that has already paid for the calls before this line.
  var encodeAt = function (value) {
    try { return encode("ctx.call at", value === undefined ? null : value) } catch (error) { return "null" }
  }`

/**
 * The handle `ctx.base` is bound to, rendered into both preludes as data.
 *
 * It is a constant rather than something the host mints, because the run's
 * opening tree is not a thing anybody has to decide to keep: the host either
 * recorded one or it did not, and a call against this id says which by
 * succeeding or by answering `checkpoint_unavailable`.
 */
const baseHandle = Cell.checkpoint(Cell.baseCheckpoint)

/**
 * The name a queued mint carries, so an overrun reads as what it was.
 *
 * Nothing resolves it: a checkpoint is not a flow, it is not in the catalog,
 * and no capability gates it. See `Sandbox` `Minter`.
 */
const checkpointFlow = "checkpoint"

/** Reads the `at` the realm encoded; the empty string is "the cell passed none". */
const decodedAt = (encoded: string): Schema.Json | undefined =>
  encoded === "" ? undefined : Schema.decodeUnknownSync(Schema.Json)(JSON.parse(encoded))

/**
 * The `ctx.call`, `ctx.checkpoint` and `ctx.base` members. `guard` is the one
 * line the REPL mode adds: nothing in the filing mode can end a run part-way
 * through a cell, because there the run ends by returning.
 */
const preludeCall = (guard: string): string =>
  `    call: function (flow, input, options) {
      if (typeof flow !== "string") return Deferred.reject(new Fault("ctx.call expects a flow name as its first argument"))
${guard}      var encoded = encode("ctx.call input", input === undefined ? null : input)
      var at = options === null || typeof options !== "object" ? undefined : options.at
      if (at === undefined) return dispatch(flow, encoded, "")
      // A handle the cell never awaited is a promise, and that spelling is the
      // one the ruling wrote: \`const cp = ctx.checkpoint()\`. The pin lands where
      // that line is, because the queue settles in issue order, so awaiting the
      // handle later cannot move the tree it names. Both spellings are accepted.
      if (at !== null && typeof at === "object" && typeof at.then === "function") {
        return at.then(function (resolved) { return dispatch(flow, encoded, encodeAt(resolved)) })
      }
      return dispatch(flow, encoded, encodeAt(at))
    },
    checkpoint: function () {
${guard}      return pin().then(settleEnvelope)
    },
    base: freeze(parse(${JSON.stringify(JSON.stringify(baseHandle))})),`

/**
 * What a `ctx.call` issued after `ctx.done` or `ctx.park` resolves with.
 *
 * A completion takes effect where it is called, so the calls a cell would have
 * made after it do not run. They fail the way every other refused call fails —
 * soft, with a code and a hint — because rule 3 promises a cell that a call
 * resolves rather than throws, and a completion is not the place to break that
 * promise: the guard shape the contract teaches puts `ctx.done` in the middle of
 * a cell, and a throw there would discard the rest of a frame that had already
 * finished the run.
 */
const sealedCall = Cell.callFailure(
  refusal(
    "run_completed",
    "This run was already completed: an earlier line of this cell called ctx.done or ctx.park, which takes effect where it is called, so no further flow call is dispatched."
  )
)

/**
 * The prelude a persistent realm is opened with.
 *
 * It removes the two sources of nondeterminism QuickJS ships with, `Date` and
 * `Math.random`. The raw host bridge is captured in a closure and then deleted
 * from the global object, so a cell cannot reach the unwrapped boundary and
 * hand it unencoded values.
 *
 * It differs from the per-cell prelude the filing surface used in exactly the
 * two ways the persistent realm
 * differs: `ctx.state` is gone, because the realm is the memory, and three new
 * members plus `console` are installed, because a script cannot `return`.
 *
 * `console.log` renders each argument on the host side — a string as itself,
 * structures through the print channel — so a structured value reaches the next model
 * turn as the value it is rather than as `[object Object]`. A value JSON cannot
 * walk at all, a cycle above all, is the one case where that promise cannot be
 * kept, so it is named instead: the kind, the reason, and the fact that the
 * value is still bound. `String(value)` there would print the exact bytes this
 * channel exists to abolish.
 *
 * Both are installed as non-writable, non-configurable own properties, which the
 * per-cell prelude never needed to do. There, a cell that declared `ctx` shadowed
 * the name inside its own async wrapper and the next cell was handed a fresh
 * realm. Here the wrapper is gone and `CellValidation.normalize` rewrites a
 * top-level `const` to `var`, so the same declaration would assign over the run's
 * only host binding and every later cell would die on
 * `TypeError: not a function` — with `ctx` inside the panel's baseline, so
 * nothing would even name what went missing. A `var` declaration over a
 * non-writable global is a silent no-op in sloppy mode, which is a failure the
 * run survives. `CellValidation` refuses the declaration in-frame as well, so
 * the model is told rather than left to wonder.
 */
const replPrelude = (catalog: string): string =>
  `(function () {
  var bridge = globalThis.__call
  var pin = globalThis.__checkpoint
  var print = globalThis.__print
  var intent = globalThis.__intent
${preludeHelpers}
  delete globalThis.__call
  delete globalThis.__checkpoint
  delete globalThis.__print
  delete globalThis.__intent
  delete globalThis.Date
  delete Math.random
  // Removed for the same reason as the two above: it makes the realm answer a
  // question dishonestly. Every reading the panel probe takes goes through the
  // intrinsics captured before any cell ran, and every property comes off its
  // own descriptor, so a cell can neither rebind reflection nor hide weight
  // behind a getter. Neither defence survives a value that IS the trap: a proxy
  // answers \`getOwnPropertyNames\` from its handler, so one wrapping a
  // megabyte-wide target weighs as an empty object while the realm holds the
  // target alive, and the run's only ceiling over string data reads zero for it.
  // No reading of a proxy can be trusted — any number it reports is a number the
  // handler chose — and nothing else in this realm can construct one, so the
  // constructor goes rather than the accounting. \`Reflect\` stays: it offers no
  // way to make a proxy and the probe does not read through it.
  delete globalThis.Proxy
  // The seal: once this frame has said how the run ends, it has ended, and the
  // calls a cell would have made after that line are not dispatched. It lives
  // here rather than on the host because ctx.call has to answer synchronously,
  // and it is cleared per frame by the function this prelude returns — a park
  // whose reason is refused is asked again inside the same frame, and a realm
  // still sealed from the refused attempt would answer that retry with nothing.
  var catalog = freeze(${catalog})
  var sealed = null
  var sealedEnvelope = freeze(parse(${JSON.stringify(JSON.stringify(sealedCall))}))
  var unprintable = function (value, error) {
    var kind = isArray(value) ? "array" : typeof value
    var why = error !== null && typeof error === "object" && error.message ? error.message : render(error)
    return "[unprintable " + kind + ": " + why + " — the value is still bound, so print the part of it you need]"
  }
  var show = function (values) {
    var parts = []
    for (var index = 0; index < values.length; index++) {
      var value = values[index]
      if (typeof value === "string") parts.push({ text: value })
      else if (value === undefined) parts.push({ text: "undefined" })
      else {
        var encoded = null
        var refused = false
        try { encoded = stringify(value) } catch (error) { refused = true; parts.push({ text: unprintable(value, error) }) }
        // JSON answers \`undefined\` rather than throwing for a value it has no
        // notation for at all — a function, a symbol — and those read best as
        // themselves. It throws only for a value it cannot walk, and that is
        // the one case where naming the reason beats printing "[object Object]".
        if (!refused) parts.push(encoded === undefined ? { text: render(value) } : { json: parse(encoded) })
      }
    }
    print(stringify(parts))
  }
  var line = function () { show(argumentsOf.call(arguments)) }
  var host = function (name, value) {
    define(globalThis, name, { value: value, writable: false, enumerable: true, configurable: false })
  }
  host("console", freezeValue({ log: line, info: line, warn: line, error: line }))
  host("ctx", freezeValue({
${preludeCall(`      if (sealed !== null) return Deferred.resolve(sealed)\n`)}
    get flows() { return catalog },
    done: function (output) {
      if (sealed !== null) return
      if (arguments.length === 0) {
        throw new Fault("ctx.done(output) takes the run's answer; call it with the value the task asked for")
      }
      var encoded = encode("ctx.done output", output === undefined ? null : output)
      sealed = sealedEnvelope
      intent("done", encoded)
    },
    park: function (reason, message) {
      if (sealed !== null) return
      var encoded = encode("ctx.park message", { reason: reason === undefined ? null : reason, message: message === undefined ? "" : message })
      sealed = sealedEnvelope
      intent("park", encoded)
    },
    justify: function (text) { intent("justify", encode("ctx.justify text", text === undefined ? "" : text)) }
  }))
  // Handed back to the host, which calls it as each frame opens. See the seal
  // above for why the clearing is per frame rather than per run.
  return function (nextCatalog) {
    sealed = null
    if (nextCatalog !== undefined) catalog = freeze(parse(nextCatalog))
  }
})()`

const Catalog = Schema.Record(Schema.String, Cell.FlowProjection)

const catalogOf = (flows: Readonly<Record<string, Cell.FlowProjection>>): string => {
  const encoded = Schema.encodeSync(Catalog)(flows)
  const normalized = Object.fromEntries(
    Object.entries(encoded).map(([name, projection]) => [
      name,
      Object.fromEntries(
        Object.entries(projection).flatMap(([field, value]) =>
          Option.isOption(value)
            ? Option.isSome(value) ? [[field, value.value]] : []
            : [[field, value]]
        )
      )
    ])
  )
  return JSON.stringify(normalized)
}

const raisedFrom = (dumped: unknown): Cell.Raised => {
  if (typeof dumped === "object" && dumped !== null) {
    const record = dumped as { readonly name?: unknown; readonly message?: unknown }
    return new Cell.Raised({
      name: typeof record.name === "string" ? record.name : "Error",
      // Never `String(object)`: a cell that threw a structured value is told
      // what it threw. See `Sandbox` `describe`.
      message: typeof record.message === "string" ? record.message : Sandbox.raisedOutcome(dumped).message
    })
  }
  return new Cell.Raised({ name: "Error", message: String(dumped) })
}

/**
 * Builds one owned QuickJS handle from the already-validated JSON result.
 *
 * Materializing the value directly also avoids parsing a multi-megabyte JSON
 * string inside a promise job, which leaves QuickJS 0.32's runtime heap in an
 * uncollectable state during disposal.
 */
const handleFromJson = (
  context: QuickJSContext,
  defineDataProperty: QuickJSHandle,
  value: Schema.Json,
  depth = 0
): QuickJSHandle => {
  if (value === null) return context.null
  switch (typeof value) {
    case "boolean":
      return value ? context.true : context.false
    case "number":
      return context.newNumber(value)
    case "string":
      return context.newString(value)
  }

  // Leave enough host stack to release every ancestor handle on refusal.
  if (depth >= 128) throw new Error("The flow result exceeds 128 levels of JSON nesting")
  const container = Array.isArray(value) ? context.newArray() : context.newObject()
  try {
    for (const [key, item] of Object.entries(value)) {
      const child = handleFromJson(context, defineDataProperty, item, depth + 1)
      try {
        const property = context.newString(key)
        try {
          context.unwrapResult(
            context.callFunction(defineDataProperty, context.undefined, container, property, child)
          ).dispose()
        } finally {
          property.dispose()
        }
      } finally {
        child.dispose()
      }
    }
    return container
  } catch (error) {
    container.dispose()
    throw error
  }
}

/**
 * Caches only a successful asynchronous load; a rejection may be retried.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheSuccessful = <A>(load: () => Promise<A>): () => Promise<A> => {
  let loaded: Promise<A> | undefined
  return () => {
    if (loaded === undefined) {
      const pending = load()
      loaded = pending
      void pending.catch(() => {
        loaded = undefined
      })
    }
    return loaded
  }
}

/**
 * The QuickJS build the sandbox compiles.
 *
 * @category models
 * @since 0.1.0
 */
export interface VariantService {
  readonly variant: QuickJSSyncVariant
}

/**
 * The QuickJS build the sandbox compiles.
 *
 * @category services
 * @since 0.1.0
 */
export class Variant extends Context.Service<Variant, VariantService>()(
  "@smthrs/harness/QuickJSSandbox/Variant"
) {}

/**
 * Provides the single-file build, which Node and a browser both compile.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerVariantLive: Layer.Layer<Variant> = Layer.succeed(Variant)({ variant: singlefile })

/**
 * Provides a build the host names.
 *
 * A workerd host builds one with `newVariant(baseVariant, { wasmModule })` from
 * a `.wasm` module import, because that runtime instantiates a module the
 * toolchain compiled and refuses to compile one from bytes.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerVariant = (variant: QuickJSSyncVariant): Layer.Layer<Variant> => Layer.succeed(Variant)({ variant })

/**
 * One compiled module per build, so two sandboxes over one variant share it.
 *
 * Keyed weakly: a variant a host builds per request is collectable with the
 * module it produced.
 */
const compiled = new WeakMap<QuickJSSyncVariant, () => Promise<QuickJSWASMModule>>()

const loaderFor = (variant: QuickJSSyncVariant): () => Promise<QuickJSWASMModule> => {
  const known = compiled.get(variant)
  if (known !== undefined) return known
  const loader = cacheSuccessful(() => newQuickJSWASMModuleFromVariant(variant))
  compiled.set(variant, loader)
  return loader
}

/**
 * Synchronous monotonic-enough clock required by QuickJS's interrupt callback.
 *
 * @category models
 * @since 0.1.0
 */
export interface ComputeClockService {
  readonly now: () => number
}

/**
 * Synchronous monotonic-enough clock required by QuickJS's interrupt callback.
 *
 * @category services
 * @since 0.1.0
 */
export class ComputeClock extends Context.Service<ComputeClock, ComputeClockService>()(
  "@smthrs/harness/QuickJSSandbox/ComputeClock"
) {}

/**
 * Provides the browser-safe host clock behind the QuickJS clock seam.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerClockLive: Layer.Layer<ComputeClock> = Layer.succeed(ComputeClock)({ now: () => Date.now() })

const capabilities: Sandbox.Capabilities = {
  calls: true,
  memoryBytes: true,
  steps: true,
  timeMs: true
}

const timeLimitExceeded = (timeMs: number): Cell.Rejected =>
  new Cell.Rejected({
    code: "limit_exceeded",
    message: `This cell exceeded its wall-clock limit of ${timeMs} milliseconds`
  })

/**
 * The reasons `ctx.park` may name, as the transition schema declares them.
 *
 * Checked on the host rather than inside the realm so a wrong one settles the
 * frame as an `invalid_transition` the next frame is asked to fix, instead of as
 * a throw that reads like a bug in the cell's own logic.
 */
const parkReasons = ["waiting-input", "waiting-event", "waiting-quota"] as const

/** What `ctx.done` or `ctx.park` recorded, before the reason is judged. */
type Recorded =
  | { readonly kind: "done"; readonly output: string; readonly value: Schema.Json }
  | { readonly kind: "park"; readonly reason: Schema.Json; readonly message: string }

const parkPayload = Schema.decodeUnknownSync(
  Schema.Struct({ reason: Schema.Json, message: Schema.Json })
)

const printParts = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Union([
      Schema.Struct({ text: Schema.String }),
      Schema.Struct({ json: Schema.Json })
    ])
  )
)

/**
 * Renders one `console.log` call as the statement it contributes.
 *
 * The statement is *not* bounded here beyond what the host is willing to hold:
 * a frame's statements share one budget and the share each one gets is not known
 * until the frame closes, so the reduction happens there. What happens here is
 * the reduction the host needs for itself — a value larger than a whole frame's
 * budget can never be shown whole, so only its two ends are kept, and the size
 * it had is carried beside them so the notice at frame close names the original.
 *
 * The two ends are cut through `elide`, which will not split a surrogate pair.
 * They are joined with nothing between them, so a head ending in the first half
 * of a pair and a tail starting with the second half would fuse into a character
 * the cell never printed.
 */
const printed = (encoded: string): printChannel.Statement => {
  const parts = printParts(JSON.parse(encoded))
  const rendered = parts.map((part) => "text" in part ? part.text : printChannel.render(part.json))
  // A multi-line argument gets its own lines; short neighbours stay space-joined.
  const whole = rendered.reduce(
    (joined, part, index) =>
      index === 0 ? part : joined + (part.includes("\n") || rendered[index - 1]!.includes("\n") ? "\n" : " ") + part,
    ""
  )
  const wholeBytes = bytes.size(whole)
  if (wholeBytes <= Sandbox.printFrameBytes) return { text: whole, bytes: wholeBytes }
  const edge = Math.floor(Sandbox.printFrameBytes / 2)
  return {
    text: `${elide.headSlice(whole, edge)}${elide.tailSlice(whole, edge)}`,
    bytes: wholeBytes
  }
}

/**
 * The transition a REPL frame settled, or the reason it settled none.
 */
const replOutcome = (recorded: Recorded | undefined, justification: string | undefined): Cell.Outcome => {
  if (recorded !== undefined && recorded.kind === "park") {
    const reason = parkReasons.find((candidate) => candidate === recorded.reason)
    if (reason === undefined) {
      return new Cell.Rejected({
        code: "invalid_transition",
        message: `ctx.park was called with reason ${
          JSON.stringify(recorded.reason)
        }. Call it as ctx.park(reason, message) with reason one of "waiting-input", "waiting-event" or "waiting-quota".`
      })
    }
    return new Cell.Settled({
      transition: Sandbox.replTransition({ _tag: "Park", reason, message: recorded.message }, justification)
    })
  }
  return new Cell.Settled({
    transition: Sandbox.replTransition(
      recorded === undefined ? undefined : { _tag: "Done", output: recorded.output, value: recorded.value },
      justification
    )
  })
}

/**
 * How many values one probe walks before it stops counting.
 *
 * The walk exists to find the string bytes a realm is holding, and strings are
 * few and large where they matter — a file a cell read, a suite's output. The
 * bound is what keeps a realm holding a million small objects from paying for a
 * traversal of all of them, and it doubles as the cycle guard: a graph that
 * points at itself spends the budget instead of the stack.
 */
const weighNodes = 200_000

/**
 * How deep one probe descends before it stops counting.
 *
 * A cell can bind a linked list, and the walk runs inside the realm on the
 * realm's own stack.
 */
const weighDepth = 32

/**
 * Builds the in-realm probe that reads the variables panel and the realm's weight.
 *
 * The source is evaluated **once**, when the realm opens, and answers the
 * function every later frame calls. That is the whole reason it is a factory:
 * the intrinsics the walk needs are read here, before any cell has run, and held
 * in the closure, so a cell that binds `Object` at its top level loses its own
 * reflection and not the panel that would have named the binding for it. Called
 * fresh each frame instead, the probe would read whatever `Object` a cell had
 * left behind, and the frame after the shadowing would report an empty realm.
 *
 * Captured intrinsics stop a cell rebinding reflection, and reading every named
 * property off its own descriptor stops a getter running. Neither stops a value
 * that IS the trap, which is why `replPrelude` deletes `Proxy`: a proxy answers
 * `getOwnPropertyNames` from its handler, so every number this walk could report
 * for one is a number the cell chose. The constructor goes rather than the
 * accounting, because there is no reading of a proxy the realm can be trusted to
 * take.
 *
 * The estimate covers array indices, enumerable own string-keyed properties,
 * Map keys and values, and Set values. It cannot see closure state, weak
 * collection entries, or other storage unreachable by those paths. Functions
 * have a fixed weight of 8 regardless of their scope. This supplements the
 * native allocator limit; it is not a hard bound on all retained memory.
 *
 * The returned function declares nothing on the global object and adds no name
 * of its own to the set it reports, because the host holds it as a handle rather
 * than as a global. Every value's *panel* line is measured cheaply — a string's
 * length, an array's length, an object's key count, a function's arity, a number
 * or boolean by value — because a panel that serialized every global would cost
 * the heap every frame, and the whole point of a realm is that the value is
 * still there under the name the panel prints.
 *
 * `bytes` is a second, separate reading and it exists because QuickJS's own
 * ceiling cannot supply it. Measured on the shipped variant: `str_count` and
 * `str_size` stay at zero for every construction a cell can reach — `repeat`,
 * `join`, and a string handed in by the host bridge alike — so
 * `runtime.setMemoryLimit` refuses one allocation larger than the whole ceiling
 * and never sees accumulation. A realm under a 128 MiB ceiling held 400 MiB of
 * live strings across forty frames and raised nothing while the host's resident
 * set grew by 385 MB. Under a per-cell realm that hole was bounded by one cell;
 * under a per-run realm it compounds for the life of the run, so the run budget
 * is measured here instead. See {@link openRealm}.
 */
const panelProbe = (baseline: string): string =>
  `(function (ownNames, descriptorOf, keysOf, isArray, stringify, String, mapSize, mapEntries, mapNext, setSize, setValues, setNext, skip) {
  return function () {
    var names = ownNames(globalThis)
    var out = []
    var total = 0
    var budget = ${weighNodes}
    var partial = false
    var partialRoot = null
    var partialBytes = 0
    // The ancestors of the value being weighed, and the whole of this walk's
    // repeat detection. A cycle is the one repeat that MUST be cut, because it
    // never ends, and an ancestor list cuts it at the cost of the depth ceiling
    // rather than of the whole graph. Two siblings that share one object are
    // counted twice, which over-states such a realm: a ceiling that errs toward
    // refusing is the safe direction, and the refusal is spent on the frame it
    // lands in, so the next cell runs and can restructure. A Set or a WeakSet
    // would dedupe them properly and cannot be used here: allocating either
    // inside a realm that is at its heap ceiling, which is the realm this probe
    // exists to weigh, leaves the runtime unable to assert itself empty at
    // teardown and aborts the host process.
    var path = []
    var weigh = function (value, depth) {
      var kind = typeof value
      if (depth > ${weighDepth}) {
        partial = true
        return 0
      }
      if (budget <= 0) {
        partial = true
        return 0
      }
      budget = budget - 1
      // Code units, not UTF-8 bytes, and deliberately: this walk answers "how
      // much of the host's memory is this realm holding", and QuickJS stores a
      // string as one or two bytes per code unit, so a unit count is the honest
      // reading of the thing being bounded. It is also the only O(1) one, and
      // that is load-bearing: the probe runs at frame close under the cell's own
      // interrupt budget, so a scan of a two-hundred-megabyte realm is killed
      // part way and a realm that cannot be weighed at all reads as weighing
      // nothing. UTF-8 bytes are the unit of what the model is SHOWN, which is
      // the print channel and the call ledger, not of what the realm holds.
      if (kind === "string") return value.length
      if (value === null || kind !== "object") return 8
      for (var up = 0; up < path.length; up++) if (path[up] === value) return 8
      path.push(value)
      var sum = 8
      // An array is walked by index so keysOf never allocates a second array as
      // long as the first. Each transient descriptor dies with its iteration,
      // and the same node budget that bounds the walk bounds that pressure.
      // Reading through the descriptor is load-bearing: an index accessor is
      // cell code, not data the memory probe may execute.
      if (isArray(value)) {
        var count = value.length
        for (var item = 0; item < count && !partial; item++) {
          var property = descriptorOf(value, String(item))
          if (property === undefined || !("value" in property)) sum = sum + 8
          else sum = sum + weigh(property.value, depth + 1)
        }
        path.pop()
        return sum
      }
      // Collection entries live in internal slots, not own properties. Use
      // captured native methods for both branding and iteration: instanceof,
      // Symbol.iterator, and methods read from the value are cell-controlled.
      // Catch only a failed brand check, never an incomplete entry traversal.
      var isMap = false
      var isSet = false
      try {
        mapSize(value)
        isMap = true
      } catch (error) {
        try { setSize(value); isSet = true } catch (error) {}
      }
      if (isMap || isSet) {
        // Iterator allocation can exhaust the heap too. Let that failure reach
        // the outer catch so the reading is partial rather than empty.
        var iterator = isMap ? mapEntries(value) : setValues(value)
        while (!partial) {
          var entry = isMap ? mapNext(iterator) : setNext(iterator)
          if (entry.done) break
          if (isMap) {
            sum = sum + weigh(entry.value[0], depth + 1)
            sum = sum + weigh(entry.value[1], depth + 1)
          } else sum = sum + weigh(entry.value, depth + 1)
        }
      }
      var keys = keysOf(value)
      for (var key = 0; key < keys.length && !partial; key++) {
        var property = descriptorOf(value, keys[key])
        sum = sum + keys[key].length
        if (property === undefined || !("value" in property)) sum = sum + 8
        else sum = sum + weigh(property.value, depth + 1)
      }
      path.pop()
      return sum
    }
    var dataProperty = function (value, name, fallbackValue) {
      var descriptor = descriptorOf(value, name)
      return descriptor !== undefined && "value" in descriptor ? descriptor.value : fallbackValue
    }
    for (var index = 0; index < names.length; index++) {
      var name = names[index]
      if (skip.indexOf(name) >= 0) continue
      var before = total
      try {
        var descriptor = descriptorOf(globalThis, name)
        if (descriptor === undefined || !("value" in descriptor)) {
          total = total + 8
          out.push({ name: name, type: descriptor === undefined ? "unreadable" : "accessor", size: "", bytes: 8 })
          continue
        }
        var value = descriptor.value
        var kind = typeof value
        var bytes = weigh(value, 0)
        total = total + bytes
        if (value === null) out.push({ name: name, type: "null", size: "", bytes: bytes })
        else if (kind === "undefined") out.push({ name: name, type: "unset", size: "", bytes: bytes })
        else if (kind === "string") out.push({ name: name, type: "string", size: value.length + " chars", bytes: bytes })
        else if (kind === "function") out.push({ name: name, type: "function", size: "arity " + dataProperty(value, "length", 0), bytes: bytes })
        else if (isArray(value)) out.push({ name: name, type: "array", size: dataProperty(value, "length", 0) + " items", bytes: bytes })
        else if (kind === "object") out.push({ name: name, type: "object", size: keysOf(value).length + " keys", bytes: bytes })
        else out.push({ name: name, type: kind, size: String(value), bytes: bytes })
        if (partial) {
          partialRoot = name
          partialBytes = bytes
          break
        }
      } catch (error) {
        // A name the probe cannot read at all: a proxy that refuses reflection,
        // or a realm so large that walking it is itself what runs out of heap.
        // Either way this reading is a floor and not a total, so it is reported
        // as partial rather than weighed at nothing. No accessor is invoked to
        // get here: every property read above goes through its own descriptor.
        total = before + 8
        out.push({ name: name, type: "unreadable", size: "", bytes: 8 })
        partial = true
        partialRoot = name
        partialBytes = 8
        break
      }
    }
    return stringify(partialRoot === null
      ? { names: out, bytes: total, partial: false }
      : { names: out, bytes: total, partial: true, partialRoot: partialRoot, partialBytes: partialBytes })
  }
})(
  Object.getOwnPropertyNames,
  Object.getOwnPropertyDescriptor,
  Object.keys,
  Array.isArray,
  JSON.stringify,
  String,
  Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Map.prototype, "size").get),
  Function.prototype.call.bind(Map.prototype.entries),
  Function.prototype.call.bind(Object.getPrototypeOf(new Map().entries()).next),
  Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Set.prototype, "size").get),
  Function.prototype.call.bind(Set.prototype.values),
  Function.prototype.call.bind(Object.getPrototypeOf(new Set().values()).next),
  JSON.parse(${baseline})
)`

/** One name as the probe reports it, before the panel drops the weight. */
const Weighed = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  size: Schema.String,
  bytes: Schema.Number
})

const ProbeReading = {
  names: Schema.Array(Weighed),
  bytes: Schema.Number
} as const

const decodeProbe = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ ...ProbeReading, partial: Schema.Literal(false) }),
    Schema.Struct({
      ...ProbeReading,
      partial: Schema.Literal(true),
      partialRoot: Schema.String,
      partialBytes: Schema.Number
    })
  ])
)

/**
 * States the run's memory ceiling in the terms the realm can act on.
 *
 * Written for the model, because the model is who reads it: the total, the
 * ceiling, and the three names to reassign. A `var`-created global is
 * non-configurable, so `delete` cannot remove one and assignment is the whole of
 * the recovery — which is also why the refusal has to be spent where it lands.
 * Freeing is done by a cell, and a cell that is refused cannot free anything, so
 * a ceiling that stayed shut would ask for the one act it had just made
 * impossible. See {@link openRealm}.
 */
const overBudget = (
  held: number,
  ceiling: number,
  weighed: ReadonlyArray<typeof Weighed.Type>
): Cell.Rejected => {
  const heaviest = [...weighed]
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 3)
    .map((entry) => `${entry.name} (${entry.bytes})`)
  return new Cell.Rejected({
    code: "limit_exceeded",
    message: `The names this realm holds weigh ${held} bytes, over this run's ceiling of ${ceiling}. ` +
      `Nothing ran this frame, and your next cell does run: spend it freeing the largest by assigning over them — ${
        heaviest.join(", ")
      } — ` +
      "because a name a cell bound can be reassigned but never deleted. Every other name is still bound, " +
      "and a realm still over the ceiling after that cell is refused again."
  })
}

/**
 * States a reading the probe could not finish, in the same terms as one it could.
 *
 * A walk that ran out of node budget, out of depth, or out of heap stopped
 * somewhere inside one name, so what it counted is a floor and not a total. The
 * honest reading of a floor is "at least this much", and a ceiling that cannot
 * be shown to be respected is a ceiling that is spent: the frame is refused
 * exactly as an over-budget one is, and for the same recovery. Failing the other
 * way is what let a realm holding eleven megabytes of string sit under a four
 * megabyte ceiling, because the budget ran out before the string was reached.
 *
 * The name is rendered the way {@link overBudget} renders one, so a model that
 * has read one refusal can act on the other without learning a second shape.
 */
const tooLargeToWeigh = (held: number, ceiling: number, root: string, bytes: number): Cell.Rejected =>
  new Cell.Rejected({
    code: "limit_exceeded",
    message: `This realm is too large to measure: weighing it stopped inside ${root} (${bytes}) before it finished, ` +
      `so the ${held} bytes counted are a floor and not a total, and this run's ceiling of ${ceiling} is treated as spent. ` +
      "Nothing ran this frame, and your next cell does run: spend it freeing that name by assigning over it, " +
      "because a name a cell bound can be reassigned but never deleted. Every other name is still bound, " +
      "and a realm still too large to weigh after that cell is refused again."
  })

/**
 * Opens one QuickJS realm that lives for a whole run.
 *
 * The acquire/release is the pair the per-cell binding uses, moved up to the
 * caller's scope: teardown is still scope finalization and cancellation is still
 * fiber interruption, so nothing threads an abort signal. What changes is
 * lifetime — every cell is evaluated against the same context, so a top-level
 * declaration made in frame 3 is still bound in frame 9.
 *
 * Each cell is evaluated as `evalCode(text, "cell-<frame>.js", 128)`:
 * `JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC`. That combination, measured on the
 * shipped variant, does three things at once — top-level `await` compiles, the
 * result is a promise the existing drive loop already knows how to poll, and
 * top-level declarations land in the realm rather than in an async wrapper that
 * dies with the frame. The raw numeric flag is passed because
 * `quickjs-emscripten-core`'s options object does not spell the async flag but
 * hands a numeric `options` straight through.
 *
 * The per-frame budgets survive the move unchanged, because they are counters
 * the interrupt handler reads rather than properties of the runtime: `timeMs`
 * and `steps` reset at each frame's start and the compute clock keeps refunding
 * host-call duration.
 *
 * `memoryBytes` becomes a **run** budget, and it is enforced in two places
 * because one of them cannot see half the heap. `runtime.setMemoryLimit` covers
 * the object graph and refuses any single allocation larger than the whole
 * ceiling; it does not count string data at all on the shipped variant, so
 * accumulation across frames escapes it entirely. The panel probe supplies that
 * half: it weighs what the realm's own names hold and a frame that opens over
 * the ceiling is refused before it runs, with the heaviest names stated, so the
 * next cell frees by assignment and the realm survives.
 *
 * The refusal is spent where it lands, and that is the load-bearing half of it.
 * Freeing is done by a cell, so a ceiling that stayed shut once it had fired
 * would refuse the freeing cell too, and the run would spend every remaining
 * frame being told to do the one thing it was being prevented from doing. So
 * the reading is cleared with the refusal: the next frame runs, the probe weighs
 * the realm again at its close, and a realm still over the ceiling is refused
 * again. The bound is therefore a pair of frames — a cell may allocate past the
 * ceiling and is told at the next frame, and a run that never frees alternates
 * between refusal and cell rather than growing every frame — which is what "the
 * names a run accumulates" can honestly mean when the harness never drops a
 * value behind the model's back.
 */
const openRealm = (
  module: QuickJSWASMModule,
  options: Sandbox.RealmOptions,
  clock: ComputeClockService
): Effect.Effect<Sandbox.Realm, Sandbox.SandboxError, Scope.Scope> =>
  Effect.gen(function*() {
    const realmLimits = Sandbox.withDefaults(capabilities, options.limits)
    /* v8 ignore next -- `withDefaults` fills `timeMs` from `defaultLimits` whenever the `timeMs` capability is declared, and this binding declares it, so the coalesce never reaches its fallback; it only discharges the optional type on `Sandbox.Limits` */
    let timeMs = realmLimits.timeMs ?? Sandbox.defaultLimits.timeMs
    /* v8 ignore next -- `withDefaults` fills `memoryBytes` whenever the `memoryBytes` capability is declared, and this binding declares it, so the coalesce only discharges the optional type */
    const memoryBytes = realmLimits.memoryBytes ?? Sandbox.defaultLimits.memoryBytes
    let stepBudget = realmLimits.steps

    let clockBase = clock.now()
    let steps = 0
    let exhausted: Cell.Rejected | undefined
    let pending: Array<Sandbox.PendingCall> = []
    let closing = true
    let ordinal = 0
    let boundary: typeof Sandbox.FrameBoundary.Type = { terminal: "timeout", dispatched: -1, settled: -1 }
    let lines: Array<printChannel.Statement> = []
    let retained = 0
    let unread = 0
    let recorded: Recorded | undefined
    let justification: string | undefined

    const acquired = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const runtime: QuickJSRuntime = module.newRuntime()
        /* v8 ignore else -- `withDefaults` fills `memoryBytes` whenever the `memoryBytes` capability is declared, and this binding declares it, so the heap ceiling is always set */
        if (realmLimits.memoryBytes !== undefined) {
          runtime.setMemoryLimit(realmLimits.memoryBytes)
        }
        runtime.setInterruptHandler(() => {
          if (clock.now() - clockBase >= timeMs) {
            exhausted = exhausted ?? timeLimitExceeded(timeMs)
            return true
          }
          if (stepBudget !== undefined && ++steps > stepBudget) {
            exhausted = exhausted ?? new Cell.Rejected({
              code: "limit_exceeded",
              message: `This cell exceeded its limit of ${stepBudget} interpreter steps`
            })
            return true
          }
          return false
        })
        const context: QuickJSContext = runtime.newContext()
        return { runtime, context }
      }),
      ({ context, runtime }) =>
        Effect.sync(() => {
          context.dispose()
          runtime.dispose()
        })
    )
    const { context, runtime } = acquired

    // Its own scoped resource rather than part of the acquire above, and that
    // is the whole point: a helper the realm cannot evaluate used to be caught
    // by hand, which meant a hand-written teardown and a branch no test could
    // reach once a zero budget stopped being accepted. Registered as a second
    // resource, the failure is ordinary: the scope closes, the finalizer above
    // disposes the context and the runtime, and nothing leaks. Finalizers run
    // in reverse, so this handle is still released before them.
    const defineDataProperty = yield* Effect.acquireRelease(
      Effect.sync(() =>
        context.unwrapResult(context.evalCode(
          `(function (defineProperty) {
  return function (object, key, value) {
    defineProperty(object, key, {
      value: value,
      writable: true,
      enumerable: true,
      configurable: true
    })
  }
})(Object.defineProperty)`
        ))
      ),
      (handle) => Effect.sync(() => handle.dispose())
    )

    const install = (name: string, implementation: Parameters<QuickJSContext["newFunction"]>[1]): void => {
      const handle = context.newFunction(name, implementation)
      context.setProp(context.global, name, handle)
      handle.dispose()
    }

    const heapUsed = (): number => {
      const snapshot = runtime.computeMemoryUsage()
      try {
        const usage = context.dump(snapshot) as { readonly memory_used_size: number }
        return usage.memory_used_size
      } finally {
        snapshot.dispose()
      }
    }

    const abort = (message: string): void => {
      closing = true
      for (const call of pending.splice(0)) call.abort(message)
    }

    const queue = (
      kind: "call" | "checkpoint",
      flow: string,
      input: Schema.Json,
      at: Schema.Json | undefined
    ): QuickJSHandle => {
      if (closing) throw new Error("The cell is closing; no further host calls are accepted")
      const deferred = context.newPromise()
      const reply = (payload: Schema.Json): void => {
        const remaining = Math.max(0, memoryBytes - heapUsed())
        // JSON byte length misses the storage for values, properties and array
        // slots. Reserve scratch space for the bridge and conservatively price
        // each allocation before any handle can poison the realm on failure.
        let payloadBytes = 64 * 1024
        const values: Array<Schema.Json> = [payload]
        while (values.length > 0 && payloadBytes < remaining) {
          const value = values.pop()!
          payloadBytes += 64
          if (typeof value === "string") payloadBytes += bytes.size(value) * 2
          else if (value !== null && typeof value === "object") {
            for (const [key, child] of Object.entries(value)) {
              payloadBytes += 128 + bytes.size(key) * 2
              values.push(child)
            }
          }
        }
        if (payloadBytes >= remaining) {
          exhausted = exhausted ?? new Cell.Rejected({
            code: "limit_exceeded",
            reason: "heap",
            message:
              `The flow result is estimated to need ${payloadBytes} bytes of QuickJS heap, but only ${remaining} bytes remain ` +
              `under this run's ceiling of ${memoryBytes}. The result was not materialized.`
          })
          deferred.resolve(context.undefined)
          deferred.dispose()
          return
        }
        let handle: QuickJSHandle | undefined
        try {
          handle = handleFromJson(context, defineDataProperty, payload)
          deferred.resolve(handle)
        } catch {
          // Deep JSON can exhaust the host stack while building handles even
          // when its allocation fits. Settle the bridge after cleanup so the
          // rejected frame remains recordable and realm disposal stays safe.
          exhausted = new Cell.Rejected({
            code: "limit_exceeded",
            reason: "heap",
            message: "Materializing the flow result exceeded the realm's limits."
          })
          deferred.resolve(context.undefined)
        } finally {
          handle?.dispose()
          deferred.dispose()
        }
      }
      pending.push({
        ordinal: ordinal++,
        flow,
        input,
        kind,
        ...(at === undefined ? {} : { at }),
        settle: (result) =>
          reply(
            result.outcome === "success"
              ? { ok: true, value: result.value ?? null }
              : { ok: false, aborted: false, failure: Cell.callFailure(result) }
          ),
        abort: (message) =>
          reply({
            ok: false,
            aborted: true,
            failure: Cell.callFailure(refusal(undefined, message))
          })
      })
      return deferred.handle
    }
    install("__call", (flowHandle, inputHandle, atHandle) =>
      queue(
        "call",
        context.getString(flowHandle),
        Schema.decodeUnknownSync(Schema.Json)(JSON.parse(context.getString(inputHandle))),
        decodedAt(context.getString(atHandle))
      ))
    install("__checkpoint", () => queue("checkpoint", checkpointFlow, null, undefined))
    install("__print", (partsHandle) => {
      // What the model reads is bounded at frame close; what the host holds
      // while the cell is still running is bounded here, and it has to be a
      // different number because the two are answers to different questions.
      // A cell that prints in a loop hands over one payload per statement, and
      // every one of them is copied out of the WASM heap, parsed and decoded
      // before anything can decide it is surplus. Measured on this variant, a
      // print loop inside the default step budget took the host's resident set
      // from 288 MB to 746 MB, and two hundred prints of one 3 MiB string took
      // it to 1.4 GB — while the model, both times, was shown 16 KiB. Past the
      // retention ceiling the payload is not read at all: the handle belongs to
      // the caller, so ignoring it costs nothing, and the count of what was
      // ignored is stated at frame close rather than dropped in silence.
      if (retained >= Sandbox.printRetainedBytes) {
        unread = unread + 1
        return context.undefined
      }
      const line = printed(context.getString(partsHandle))
      retained = retained + bytes.size(line.text) + 1
      lines.push(line)
      return context.undefined
    })
    install("__intent", (kindHandle, payloadHandle) => {
      const kind = context.getString(kindHandle)
      const payload = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(context.getString(payloadHandle)))
      if (kind === "done") recorded = { kind: "done", output: Cell.renderText(payload), value: payload }
      else if (kind === "park") {
        const park = parkPayload(payload)
        recorded = { kind: "park", reason: park.reason, message: Cell.renderText(park.message) }
      } else justification = Cell.renderText(payload)
      return context.undefined
    })

    const installed = context.evalCode(replPrelude(catalogOf(options.flows)))
    if (installed.error !== undefined) {
      const failure = context.dump(installed.error)
      installed.error.dispose()
      return yield* new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "The sandbox prelude failed to install",
        cause: failure
      })
    }
    // What the prelude evaluated to: the function that clears the completion
    // seal. The host holds it as a handle rather than as a global, so no cell
    // can reach it and no cell can shadow it.
    const openFrame = installed.value
    yield* Effect.addFinalizer(() => Effect.sync(() => openFrame.dispose()))

    // The names a fresh realm already holds, snapshotted after the prelude so
    // `ctx` and `console` are part of the baseline rather than part of the
    // panel. Doubly encoded so no name — `__proto__` included — can reach the
    // probe's source as anything but data.
    const snapshot = context.unwrapResult(
      context.evalCode("JSON.stringify(Object.getOwnPropertyNames(globalThis))")
    )
    const baseline = context.getString(snapshot)
    snapshot.dispose()

    // Built once, called every frame. The handle lives on this scope beside the
    // context that made it, which is what keeps the probe's intrinsics the ones
    // a fresh realm had rather than the ones a cell left behind.
    const probe = context.unwrapResult(context.evalCode(panelProbe(JSON.stringify(baseline))))
    yield* Effect.addFinalizer(() => Effect.sync(() => probe.dispose()))

    let bindings: ReadonlyArray<VariablesPanel.Binding> = []
    let weighed: ReadonlyArray<typeof Weighed.Type> = []
    let held = 0
    let unweighed: { readonly root: string; readonly bytes: number } | undefined

    const evaluateFrame = (
      evaluation: Sandbox.RealmEvaluation,
      limits: Sandbox.EvaluationLimits
    ): Effect.Effect<Sandbox.RealmFrame, Sandbox.SandboxError | HarnessError> => {
      /* v8 ignore next -- the validated frame inherits the opening totalMs default */
      const totalMs = limits.totalMs ?? Sandbox.defaultLimits.totalMs
      const frameStarted = clock.now()
      let pausedAtForFrame: number | undefined
      let pausedMs = 0
      return Effect.gen(function*() {
        /* v8 ignore next -- the validated frame inherits the opening timeMs default */
        timeMs = limits.timeMs ?? Sandbox.defaultLimits.timeMs
        stepBudget = limits.steps
        // Per-frame budgets and per-frame buffers, reset before anything can
        // settle the frame. They are counters, not properties of the runtime, so
        // a realm that outlives one cell still charges each cell its own — and
        // resetting them first is what keeps a frame that ends before its cell
        // runs from being handed the previous frame's print buffer.
        clockBase = clock.now()
        steps = 0
        exhausted = undefined
        pending = []
        closing = false
        ordinal = 0
        boundary = { terminal: "timeout", dispatched: -1, settled: -1 }
        lines = []
        retained = 0
        unread = 0
        recorded = undefined
        justification = undefined
        // The realm's own per-frame state: the seal a completion set. A frame
        // whose transition the harness refused is asked again inside the same
        // frame, so the retry has to open on an unsealed realm.
        if (evaluation.flows === undefined) {
          context.unwrapResult(context.callFunction(openFrame, context.undefined)).dispose()
        } else {
          const catalog = context.newString(catalogOf(evaluation.flows))
          try {
            context.unwrapResult(context.callFunction(openFrame, context.undefined, catalog)).dispose()
          } finally {
            catalog.dispose()
          }
        }

        // Whatever the frame produced, the prints are delivered with it and the
        // panel is read after it, so the answer is assembled in one place. A
        // frame that printed past the retention ceiling says so as its last
        // line, because a buffer that simply stopped would read as a cell that
        // simply stopped printing.
        const frameOf = (outcome: Cell.Outcome): Sandbox.RealmFrame => ({
          outcome,
          ...(outcome._tag === "rejected" && outcome.code === "limit_exceeded"
            ? { boundary: { ...boundary, terminal: "settled" as const } }
            : {}),
          prints: printChannel.buffer(lines, unread),
          bindings
        })

        // The run's memory budget, judged against what the realm's own names
        // weigh rather than against a heap counter that cannot see them. A
        // frame that opens over the ceiling runs nothing, so nothing is lost
        // and the recovery is one assignment — and the reading is cleared with
        // the refusal, because the cell that frees is a cell and has to run.
        // Left standing, the ceiling would refuse that cell too, and every one
        // after it, so the run would spend the rest of its frames being told to
        // do the one thing it was being prevented from doing. Cleared, the next
        // frame runs, the probe weighs the realm again at its close, and a realm
        // still over the ceiling is refused again.
        if (unweighed !== undefined) {
          const refusal = tooLargeToWeigh(held, memoryBytes, unweighed.root, unweighed.bytes)
          unweighed = undefined
          held = 0
          return frameOf(refusal)
        }
        if (held > memoryBytes) {
          const refusal = overBudget(held, memoryBytes, weighed)
          held = 0
          return frameOf(refusal)
        }

        // The boundary's own parse when it has one; see `RealmEvaluation.program`.
        const compiled = evaluation.program ?? Sandbox.compile(evaluation.cell)
        if (compiled instanceof Cell.Rejected) return frameOf(compiled)

        const started = context.evalCode(compiled, `cell-${evaluation.frame}.js`, 128)
        if (started.error !== undefined) {
          const failure = context.dump(started.error)
          started.error.dispose()
          return frameOf(
            new Cell.Rejected({
              code: "compile_failed",
              /* v8 ignore next -- QuickJS reports a compile failure as an Error object, so the `message` arm is what a parser disagreement takes; `String(failure)` only discharges the `unknown` `context.dump` is typed as */
              message: `The cell did not compile: ${
                typeof failure === "object" && failure !== null && "message" in failure
                  ? String((failure as { readonly message: unknown }).message)
                  : String(failure)
              }`
            })
          )
        }
        const cellHandle = started.value

        let settled: Cell.Outcome | undefined
        const poll = (): void => {
          // Teardown alone runs jobs once admission closes, under its own budget.
          if (closing) return
          runtime.executePendingJobs()
          if (exhausted !== undefined) {
            settled = exhausted
            return
          }
          const state = context.getPromiseState(cellHandle)
          if (state.type === "pending") return
          if (state.type === "fulfilled") {
            // A script's completion value is not a transition and is never read:
            // a REPL cell says what it wants by calling `ctx.done` or `ctx.park`,
            // and saying nothing asks for another frame.
            state.value.dispose()
            settled = replOutcome(recorded, justification)
            return
          }
          const error = context.dump(state.error)
          state.error.dispose()
          settled = raisedFrom(error)
        }

        const outcome = yield* Sandbox.driveCell({
          pending,
          replay: evaluation.replay,
          progress: (dispatched, settled) => {
            boundary = { terminal: "timeout", dispatched, settled }
          },
          ...(evaluation.mint === undefined
            ? {}
            : {
              mint: (mint: Sandbox.Mint) =>
                Effect.suspend(() => {
                  const pausedAt = clock.now()
                  return evaluation.mint!(mint).pipe(
                    Effect.onExit(() =>
                      Effect.sync(() => {
                        clockBase += clock.now() - pausedAt
                      })
                    )
                  )
                })
            }),
          ...(evaluation.bounded === undefined ? {} : { bounded: evaluation.bounded }),
          flush: () => poll(),
          finished: () => {
            poll()
            if (settled !== undefined) return settled
            if (pending.length > 0) return undefined
            return new Cell.Rejected({
              code: "stalled",
              message:
                "The cell awaited something that never settles. Inside a cell the only thing worth awaiting is ctx.call."
            })
          },
          abort,
          handler: (call) =>
            Effect.suspend(() => {
              const pausedAt = clock.now()
              const pausesFrame = limits.pauseTotalMsFor?.includes(call.flow) === true
              if (pausesFrame) pausedAtForFrame = pausedAt
              return evaluation.call(call).pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    clockBase += clock.now() - pausedAt
                    if (pausesFrame) {
                      pausedMs += clock.now() - pausedAt
                      pausedAtForFrame = undefined
                    }
                  })
                )
              )
            }),
          limits
        }).pipe(
          // Closing is irreversible within this frame. Rejecting a bridge
          // resumes user catch/finally blocks, so admission must close before
          // any of those jobs can allocate another host-owned promise handle.
          Effect.ensuring(
            Effect.sync(() => {
              closing = true
              try {
                // A cleanup may keep scheduling promise jobs even without host
                // calls. Bound that work independently of the compute clock.
                for (let jobs = 0;; jobs++) {
                  abort("The cell was interrupted")
                  if (jobs >= 1024 || !runtime.hasPendingJob()) break
                  runtime.executePendingJobs(1).dispose()
                }
              } finally {
                cellHandle.dispose()
              }
            })
          )
        )

        if (evaluation.replay !== undefined) {
          // A timed-out attempt never reached the probe below. Keep its realm
          // accounting too, so the next frame sees the same memory admission.
          return { outcome: evaluation.replay.outcome, prints: "", bindings, boundary: evaluation.replay.boundary }
        }

        // The panel, read from the realm the cell just ran in. It shares the
        // frame's remaining budget, so a cell that spent all of its own leaves
        // the previous reading standing rather than an empty one. What a cell
        // cannot do is take the reading away: the probe holds its own
        // intrinsics from before any cell ran, so a realm whose `Object` a cell
        // has rebound is still weighed and still named.
        const read = context.callFunction(probe, context.undefined)
        if (read.error === undefined) {
          const measured = decodeProbe(JSON.parse(context.getString(read.value)))
          read.value.dispose()
          weighed = measured.names
          held = measured.bytes
          unweighed = measured.partial ? { root: measured.partialRoot, bytes: measured.partialBytes } : undefined
          bindings = measured.names.map((entry) =>
            new VariablesPanel.Binding({ name: entry.name, type: entry.type, size: entry.size })
          )
        } else {
          read.error.dispose()
        }
        return frameOf(outcome)
      }).pipe(
        limits.pauseTotalMsFor?.length && evaluation.replay === undefined
          ? Effect.raceFirst(Effect.gen(function*() {
            for (;;) {
              const now = clock.now()
              const elapsed = now - frameStarted - pausedMs -
                (pausedAtForFrame === undefined ? 0 : now - pausedAtForFrame)
              const remaining = totalMs - elapsed
              if (remaining <= 0) {
                return {
                  outcome: timeLimitExceeded(totalMs),
                  boundary,
                  prints: "",
                  bindings
                } satisfies Sandbox.RealmFrame
              }
              yield* Effect.sleep(Duration.millis(Math.max(1, remaining)))
            }
          }))
          : Effect.timeoutOrElse({
            // Replay is stopped by its recorded boundary, not a second clock.
            duration: evaluation.replay === undefined ? totalMs : Infinity,
            orElse: () =>
              Effect.succeed<Sandbox.RealmFrame>({
                outcome: timeLimitExceeded(totalMs),
                boundary,
                prints: "",
                bindings
              })
          })
      )
    }

    const evaluate = (evaluation: Sandbox.RealmEvaluation) =>
      Sandbox.evaluationLimits(realmLimits, evaluation.limits).pipe(
        Effect.flatMap((limits) => evaluateFrame(evaluation, limits))
      )

    return { evaluate }
  })

/**
 * Loads a QuickJS module through the sandbox's typed failure boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loadModule = (
  loader: () => Promise<QuickJSWASMModule>
): Effect.Effect<QuickJSWASMModule, Sandbox.SandboxError> =>
  Effect.tryPromise({
    try: loader,
    catch: (cause) =>
      new Sandbox.SandboxError({
        code: "runtime_failed",
        message: "QuickJS WebAssembly module could not be loaded",
        cause
      })
  })

/**
 * Constructs the QuickJS sandbox over the build the host names, compiling the
 * WebAssembly module once.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeWithVariant: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock | Variant> = Effect
  .gen(function*() {
    const clock = yield* ComputeClock
    const { variant } = yield* Variant
    const module = yield* loadModule(loaderFor(variant))
    return Sandbox.make({
      capabilities,
      openRealm: (options) => openRealm(module, options, clock)
    })
  })

/**
 * Constructs the QuickJS sandbox over the single-file build.
 *
 * The build is fixed here rather than left in the requirements, so the clock
 * stays the only seam this constructor asks its caller to fill. A host that
 * names its own build uses {@link makeWithVariant}.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeWithClock: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock> = makeWithVariant.pipe(
  Effect.provide(layerVariantLive)
)

/**
 * Constructs the QuickJS sandbox with the live clock layer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Sandbox.Sandbox, Sandbox.SandboxError> = makeWithClock.pipe(
  Effect.provide(layerClockLive)
)

/**
 * Provides the QuickJS sandbox over the build the host names.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithVariant: Layer.Layer<Sandbox.Sandbox, Sandbox.SandboxError, Variant> = Layer.effect(
  Sandbox.Sandbox
)(makeWithVariant.pipe(Effect.provide(layerClockLive)))

/**
 * Provides the QuickJS sandbox over the single-file build.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<Sandbox.Sandbox, Sandbox.SandboxError> = Layer.effect(Sandbox.Sandbox)(make)
