/**
 * Content identity for a plan-time function: a SHA-256 digest of its exact
 * source and of the inert values it declares it closes over.
 *
 * JavaScript cannot inspect an ordinary closure, so source alone is not an
 * identity: two functions with identical text can capture different values and
 * compute different results. {@link capture} is how an author declares those
 * values, and {@link functionIdentity} is the digest the declaration makes
 * possible. Without a declaration the digest folds in process-local entropy, so
 * an unannotated function fails closed — never a cache hit it did not earn.
 *
 * It lives here, in the digest package, because its product is a digest and its
 * only dependency is {@link digestSync}. The node ASTs that embed it
 * (`@smthrs/plan`, `@smthrs/core`) are both above this package, so neither owns
 * it and neither copies it.
 *
 * Output changes are identity changes: every algorithm tag is versioned, so a
 * change to these semantics re-keys what is derived from one rather than
 * colliding with it.
 *
 * @since 1.0.0
 */

import { digestSync } from "./Sha256.ts"

/**
 * The algorithms {@link functionIdentity} names.
 *
 * `sha256-source-captures/v5` digests exact source and declared inert
 * captures. `sha256-source-ephemeral/v4` digests exact source and
 * process-local entropy, because nothing was declared.
 *
 * @since 1.0.0
 * @category models
 */
export type Algorithm = "sha256-source-ephemeral/v4" | "sha256-source-captures/v5"

/**
 * The serializable stand-in for a function.
 *
 * @since 1.0.0
 * @category models
 */
export interface FunctionIdentity {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: Algorithm
  readonly digest: string
}

/** @private */
interface CapturedMetadata {
  readonly source: string
  readonly captures: string
}

/** A key no caller holds, for side-effect-free brand probes. @private */
const brandToken = {}

/** @private */
// Bundled hosts and dynamically imported flows can load separate compatible
// copies. Identity belongs to the function, not to whichever copy inspects it.
const stateKey = Symbol.for("@smthrs/crypto/Identity/state/v5")
interface IdentityState {
  readonly captured: WeakMap<object, CapturedMetadata>
  readonly ephemeral: WeakMap<object, string>
  ordinal: number
  nonce: string | undefined
}

/** @private */
const isWeakMap = (value: unknown): value is WeakMap<object, never> => {
  try {
    WeakMap.prototype.has.call(value, brandToken)
    return true
  } catch {
    return false
  }
}

/**
 * Adopts the realm's shared state only when every field has the shape this
 * package writes. A malformed value was not written by a compatible copy, so
 * it is refused rather than trusted: a forged map could assign chosen capture
 * identities and a forged nonce could make ephemeral identities predictable.
 * Code that runs before this module with a well-formed value is outside what
 * a check can detect, because it already runs in this realm.
 *
 * @private
 */
const adoptState = (): IdentityState => {
  const existing: unknown = Reflect.get(globalThis, stateKey)
  if (existing === undefined) {
    const created: IdentityState = { captured: new WeakMap(), ephemeral: new WeakMap(), ordinal: 0, nonce: undefined }
    // Non-writable: a stray assignment cannot replace the state a later copy
    // adopts. Configurable only so a test can evaluate a fresh copy.
    Object.defineProperty(globalThis, stateKey, {
      value: created,
      writable: false,
      enumerable: false,
      configurable: true
    })
    return created
  }
  const candidate = existing as Partial<Record<keyof IdentityState, unknown>>
  if (
    typeof existing !== "object" || existing === null ||
    !isWeakMap(candidate.captured) || !isWeakMap(candidate.ephemeral) ||
    !Number.isSafeInteger(candidate.ordinal) || (candidate.ordinal as number) < 0 ||
    !(candidate.nonce === undefined || (typeof candidate.nonce === "string" && /^[0-9a-f]{32}$/.test(candidate.nonce)))
  ) {
    throw new TypeError("@smthrs/crypto: malformed shared Identity state; refusing to adopt it")
  }
  return existing as IdentityState
}
const state = adoptState()

// Intrinsic methods read once, so an adopted map's own or inherited overrides
// never run on an identity lookup.
const weakMapGet = WeakMap.prototype.get
const weakMapSet = WeakMap.prototype.set
/** @private */
const capturedMetadataOf = (operation: object): CapturedMetadata | undefined =>
  Reflect.apply(weakMapGet, state.captured, [operation])

/** @private */
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Returns the process-local nonce, seeding it on first use.
 *
 * The seed is deliberately lazy. Cloudflare Workers rejects any script that
 * calls `crypto.getRandomValues` while the module evaluates, with upload error
 * 10021, so reading entropy at module scope would stop every bundle containing
 * this package from deploying.
 *
 * @private
 */
const nonce = (): string => {
  if (state.nonce === undefined) {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    state.nonce = hex(bytes)
  }
  return state.nonce
}

/**
 * Returns the process-local nonce shared by every ephemeral identity.
 *
 * Exposed so a second ephemeral encoding, such as the projection of an
 * unregistered symbol, folds in the same per-process value and can never
 * collide with a different value observed by another process.
 *
 * @since 1.0.0
 * @category accessors
 */
export const processNonce = (): string => nonce()

/**
 * The refusal {@link capture} throws.
 *
 * The message names `Node.capture`, the authoring surface both node models
 * expose this function as, because that is the call the author wrote.
 *
 * @private
 */
const captureError = (path: string, reason: string): TypeError =>
  new TypeError(`Node.capture: capture at ${path} ${reason}; captures must be finite, inert data`)

/**
 * The NativeFunction body grammar: `{ [ native code ] }` with optional
 * whitespace between tokens, ending the source. `[native code]` is not a
 * JavaScript expression, so ordinary source ends this way only when a trailing
 * comment spells it, and refusing that contrived case fails closed.
 *
 * @private
 */
const nativeSource = /\{\s*\[\s*native\s+code\s*\]\s*\}\s*$/

/** @private */
const maximumCaptureDepth = 256

/** @private */
interface CaptureSnapshot {
  readonly path: string
  readonly copy: object
  readonly members: Record<string, PropertyDescriptor>
}

// These intrinsics inspect brands without reading caller properties, iterating
// collections, invoking coercion, or consulting Symbol.toStringTag. A plain
// prototype is insufficient: callers can replace a built-in's prototype.
const slotProbes: ReadonlyArray<(input: object) => unknown> = [
  (input) => Map.prototype.has.call(input, brandToken),
  (input) => Set.prototype.has.call(input, brandToken),
  (input) => WeakMap.prototype.has.call(input, brandToken),
  (input) => WeakSet.prototype.has.call(input, brandToken),
  (input) => Date.prototype.getTime.call(input),
  (input) => Object.getOwnPropertyDescriptor(RegExp.prototype, "source")!.get!.call(input),
  (input) => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(input),
  (input) => Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!.call(input),
  (input) => Number.prototype.valueOf.call(input),
  (input) => String.prototype.valueOf.call(input),
  (input) => Boolean.prototype.valueOf.call(input),
  (input) => BigInt.prototype.valueOf.call(input),
  (input) => Symbol.prototype.valueOf.call(input),
  (input) => WeakRef.prototype.deref.call(input),
  (input) => FinalizationRegistry.prototype.unregister.call(input, brandToken)
]

/** @private */
const hasBuiltinSlots = (input: object): boolean =>
  ArrayBuffer.isView(input) || slotProbes.some((probe) => {
    try {
      probe(input)
      return true
    } catch {
      return false
    }
  })

/** @private */
const snapshotCapture = (
  input: unknown,
  path: string,
  ancestors: WeakSet<object>,
  depth: number,
  snapshots: globalThis.Map<object, CaptureSnapshot>
): void => {
  if (depth > maximumCaptureDepth) {
    throw captureError(path, `exceeds the maximum capture depth of ${maximumCaptureDepth}`)
  }
  if (input === null) return
  switch (typeof input) {
    case "boolean":
    case "string":
      return
    case "number":
      if (!Number.isFinite(input)) throw captureError(path, "is not finite")
      return
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw captureError(path, `has unsupported type ${typeof input}`)
  }

  if (ancestors.has(input)) throw captureError(path, "is cyclic")
  let snapshot = snapshots.get(input)
  if (snapshot === undefined) {
    if (hasBuiltinSlots(input)) throw captureError(path, "has built-in internal slots")
    let prototype: object | null
    let array: boolean
    let members: Record<string, PropertyDescriptor>
    try {
      prototype = Object.getPrototypeOf(input)
      array = Array.isArray(input)
    } catch {
      throw captureError(path, "could not inspect its own data (for example, a revoked Proxy)")
    }
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw captureError(path, "has a non-plain prototype")
    }
    try {
      members = Object.create(null)
      for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (descriptor === undefined) throw new TypeError()
        Object.defineProperty(members, key, { value: descriptor, enumerable: true })
      }
    } catch {
      throw captureError(path, "could not inspect its own data descriptors")
    }
    snapshot = { path, copy: array ? [] : {}, members }
    snapshots.set(input, snapshot)
  }
  const { copy, members } = snapshot
  ancestors.add(input)
  try {
    if (Array.isArray(copy)) {
      const length: number = members.length!.value
      if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
        throw captureError(path, "has an invalid array length")
      }
      for (const key of Reflect.ownKeys(members)) {
        if (key === "length") continue
        if (typeof key === "symbol" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
          throw captureError(path, `has unsupported array key ${String(key)}`)
        }
      }
      for (let index = 0; index < length; index++) {
        const descriptor = members[String(index)]
        if (descriptor === undefined) throw captureError(`${path}[${index}]`, "is an array hole")
        if (!("value" in descriptor)) throw captureError(`${path}[${index}]`, "is an accessor")
        if (!descriptor.enumerable) throw captureError(`${path}[${index}]`, "is non-enumerable")
        snapshotCapture(descriptor.value, `${path}[${index}]`, ancestors, depth + 1, snapshots)
      }
    } else {
      for (const key of Reflect.ownKeys(members)) {
        if (typeof key === "symbol") throw captureError(path, `has symbol key ${String(key)}`)
        const descriptor = members[key]!
        if (!("value" in descriptor)) throw captureError(`${path}.${key}`, "is an accessor")
        if (!descriptor.enumerable) throw captureError(`${path}.${key}`, "is non-enumerable")
        snapshotCapture(descriptor.value, `${path}.${key}`, ancestors, depth + 1, snapshots)
      }
    }
  } finally {
    ancestors.delete(input)
  }
}

/**
 * Probe originals only after structural admission. Reverse discovery order
 * probes children before parents and rejects a Proxy before cloning an earlier
 * object that its traps could have changed. Never retain the host's clone.
 *
 * @private
 */
const refuseExotic = (
  snapshots: globalThis.Map<object, CaptureSnapshot>,
  clone: typeof globalThis.structuredClone
): void => {
  if (typeof clone !== "function") throw captureError("$", "requires structuredClone to refuse Proxies")
  for (const [input, { path }] of [...snapshots].reverse()) {
    let cloned: object
    try {
      cloned = clone(input)
    } catch {
      throw captureError(path, "cannot be structured-cloned (for example, a Proxy)")
    }
    // Some brands, such as Error, have no side-effect-free JavaScript brand
    // check. The host reveals them on its clone, never on caller input.
    if (!Array.isArray(cloned) && Object.getPrototypeOf(cloned) !== Object.prototype) {
      throw captureError(path, "clones as a built-in object")
    }
  }
}

/** @private */
const freezeCapture = (snapshots: globalThis.Map<object, CaptureSnapshot>): void => {
  for (const { copy, members } of snapshots.values()) {
    // Canonical key insertion order also makes enumeration of equal copies
    // agree, even when callers inserted their record keys in different orders.
    for (const key of Object.keys(members).sort()) {
      const descriptor = members[key]!
      Object.defineProperty(copy, key, {
        value: snapshots.get(descriptor.value)?.copy ?? descriptor.value,
        enumerable: descriptor.enumerable!,
        configurable: false,
        writable: false
      })
    }
    Object.freeze(copy)
  }
}

/** Encodes only the owned frozen copy, including its sharing topology. @private */
const canonicalCapture = (input: unknown, references = new Map<object, number>()): string => {
  if (input === null) return "null"
  switch (typeof input) {
    case "boolean":
      return input ? "true" : "false"
    case "number":
      return Object.is(input, -0) ? "[\"number\",\"-0\"]" : `["number",${JSON.stringify(input)}]`
    case "string":
      return `["string",${JSON.stringify(input)}]`
    default: {
      const object = input as object
      const reference = references.get(object)
      if (reference !== undefined) return `["reference",${reference}]`
      // Assign ordinals in canonical traversal order, never allocation or
      // caller insertion order. Equal values can still be distinct objects.
      const ordinal = references.size
      references.set(object, ordinal)
      return Array.isArray(input)
        ? `["array",${ordinal},[${input.map((value) => canonicalCapture(value, references)).join(",")}]]`
        : `["object",${ordinal},{${
          Object.keys(input as object).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalCapture((input as Record<string, unknown>)[key], references)}`
          ).join(",")
        }}]`
    }
  }
}

/**
 * A separate scope keeps the wrapper free of admission maps and originals.
 * The callback receives only the frozen copy as its explicit this receiver.
 *
 * @private
 */
const capturedOperation = <Args extends ReadonlyArray<unknown>, A>(
  operation: (...args: Args) => A,
  copy: object,
  metadata: CapturedMetadata
): (...args: Args) => A => {
  const wrapped = (...args: Args): A => Reflect.apply(operation, copy, args)
  Reflect.apply(weakMapSet, state.captured, [wrapped, metadata])
  return wrapped
}

/**
 * Brands an operation with every inert value it closes over.
 *
 * @since 1.0.0
 * @category constructors
 */
export const capture = <C extends Readonly<Record<string, unknown>>, Args extends ReadonlyArray<unknown>, A>(
  captures: C,
  operation: (this: Readonly<C>, ...args: Args) => A
): (...args: Args) => A => {
  if (typeof operation !== "function") throw new TypeError("Node.capture requires a function operation")
  if (captures === null || typeof captures !== "object") throw captureError("$", "must be a record")
  const metadata = capturedMetadataOf(operation)
  const source = metadata?.source ?? Function.prototype.toString.call(operation)
  // Bound functions, built-ins, and function Proxies all print a native body
  // such as `function () { [native code] }`, so their source names no
  // behavior and two different ones would share one digest.
  if (nativeSource.test(source)) {
    throw captureError("operation", "has native source (for example, a bound function); capture the unbound function")
  }
  const clone = globalThis.structuredClone
  const snapshots = new Map<object, CaptureSnapshot>()
  snapshotCapture(captures, "$", new WeakSet(), 0, snapshots)
  refuseExotic(snapshots, clone)
  freezeCapture(snapshots)
  const copy = snapshots.get(captures)!.copy
  const outerCanonical = canonicalCapture(copy)
  const canonical = metadata === undefined
    ? outerCanonical
    : `["nested",${outerCanonical},${metadata.captures}]`
  return capturedOperation(operation, copy, { source, captures: canonical })
}

/**
 * Digests a function's exact source as UTF-8 with SHA-256.
 *
 * Exact source matters: whitespace inside a string literal is behavior, and
 * normalizing it before hashing can make different functions share an identity.
 * Unless its inert captures were declared with {@link capture}, the digest also
 * includes process-local, per-function entropy, because source-only identity
 * would permit incorrect cache hits.
 *
 * @since 1.0.0
 * @category constructors
 */
export const functionIdentity = (operation: unknown): FunctionIdentity => {
  if (typeof operation !== "function") throw new TypeError("function identity requires a function")
  const metadata = capturedMetadataOf(operation)
  const source = metadata?.source ?? Function.prototype.toString.call(operation)
  let ephemeral: string | undefined = Reflect.apply(weakMapGet, state.ephemeral, [operation])
  if (metadata === undefined && ephemeral === undefined) {
    ephemeral = `${nonce()}:${state.ordinal++}`
    Reflect.apply(weakMapSet, state.ephemeral, [operation, ephemeral])
  }
  return {
    _tag: "FunctionIdentity",
    algorithm: metadata === undefined ? "sha256-source-ephemeral/v4" : "sha256-source-captures/v5",
    digest: digestSync(metadata === undefined ? `${source}\0${ephemeral}` : `${source}\0${metadata.captures}`)
  }
}
