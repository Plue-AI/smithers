/**
 * Payload redaction for durable journal writes.
 *
 * The journal is permanent and broadly readable: every entry is replayed to
 * sync subscribers and to time-travel consumers. A secret that reaches
 * `payload_json` is therefore not a transient leak, so redaction happens once,
 * on the journal write path, rather than at each reader.
 *
 * Redaction is an **observability** concern and is confined to journal events
 * and export/display surfaces. It is deliberately not applied to executable
 * state, `flows_runs.state_json`, attempt checkpoints, errors, outcomes, and
 * cache results, because those are decoded and re-entered on resume: a
 * placeholder there resumes the flow with the wrong data, and replacing a
 * non-string value with a placeholder string makes the persisted state fail
 * schema decode outright, leaving the run undrivable (issue #72). A value
 * that must never reach durable executable state is a `Redacted` field in the
 * caller's own schema, not a name-suffix guess made at the storage seam.
 *
 * The rule set is a best-effort textual net over credential shapes seen in
 * real bug reports, plus structural redaction by sensitive field name. It is
 * finite, so a value that must never persist belongs in a `Redacted` field of
 * the caller's own schema. See https://journal.smithers.sh/concepts/redaction/
 * for the rule set and how to replace it.
 *
 * @since 0.1.0
 */

import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * A textual redaction rule.
 *
 * `replace` is the substitution for a matched span; when omitted the whole
 * match is replaced by the placeholder.
 *
 * @since 0.1.0
 * @category models
 */
export interface Rule {
  readonly id: string
  readonly pattern: RegExp
  readonly replace?: string | undefined
}

/**
 * The placeholder written in place of a redacted value.
 *
 * @since 0.1.0
 * @category constants
 */
export const placeholder = "[REDACTED]"

/**
 * Best-effort textual rules for credential shapes observed in real reports.
 * Every replacement reaches a fixed point so replaying or exporting an entry
 * cannot mutate it again.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultRules: ReadonlyArray<Rule> = [
  {
    id: "url-credentials",
    // The scheme is bounded rather than open. `-` is not a word character, so
    // `\b[a-z][a-z0-9+.-]*` starts a fresh scan after every hyphen, and on a
    // long run of that shape the rule rescanned the tail from each one: 400 kB
    // of `aaaaaaaa-` cost 11 seconds, on the path every journal write and every
    // log line takes. A scheme longer than 30 characters is not one this net is
    // for, and the cap makes each start position cost a constant.
    pattern: /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]+):(?!\[REDACTED\]@)[^\s:@/]+@/gi,
    replace: "$1:[REDACTED]@"
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{4,}=*/gi,
    replace: "Bearer [REDACTED_TOKEN]"
  },
  {
    id: "basic-authorization",
    pattern: /\bBasic\s+[A-Za-z0-9+/]{4,}={0,2}/gi,
    replace: "Basic [REDACTED_TOKEN]"
  },
  {
    id: "jwt",
    // Check the three segments once per token before looking for a header.
    // Starting at every `-eyJ` would rescan a malformed token's entire tail.
    // Preserve any prefix so a JWT following a hyphen still gets redacted.
    pattern:
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-])([A-Za-z0-9_-]*?)\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: "$1[REDACTED_TOKEN]"
  },
  {
    id: "private-key-block",
    // Stop an unterminated block at the next header so repeated headers cannot
    // each rescan the remaining input. A valid PEM body contains no headers.
    pattern: /-----BEGIN[^-]*PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S])*?-----END[^-]*-----/g
  },
  {
    id: "api-key",
    // Not `\b`, for the reason the assignment rule below gives: an underscore
    // is a word character, so `\bsk` never fires after `ANTHROPIC_` or after
    // Effect's log-span sanitizer folds `token=` into `token_`. The lookbehind
    // excludes only letters and digits, so a key still reads as a key when an
    // underscore or a hyphen runs into it.
    pattern: /(?<![A-Za-z0-9])(?:sk|pk)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}/g,
    replace: "[REDACTED_API_KEY]"
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replace: "[REDACTED]"
  },
  {
    id: "github-fine-grained-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g,
    replace: "[REDACTED]"
  },
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: "[REDACTED]"
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    replace: "[REDACTED]"
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}(?![0-9A-Za-z_-])/g,
    replace: "[REDACTED]"
  },
  {
    id: "assignment",
    // The output drops quotes consistently. Excluding that exact output keeps
    // repeated journal and export passes at a fixed point.
    // Start once per identifier, including leading underscores, so a name
    // containing many underscores cannot force repeated scans of its suffix.
    pattern:
      /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?)(\s*[:=]\s*)(?!\[REDACTED\])("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!["'])\S+)/gi,
    replace: "$1$2[REDACTED]"
  },
  {
    id: "cookie-session-assignment",
    pattern:
      /(?<![A-Za-z0-9-])((?:COOKIE|SESSION)S?)(\s*=\s*)(?!\[REDACTED\])("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!["'])[^\s;,]+)/gi,
    replace: "$1$2[REDACTED]"
  },
  {
    id: "embedded-json-credential",
    pattern:
      /"([A-Za-z0-9_-]*(?:key|token|secret|password|credential)[A-Za-z0-9_-]*)"(\s*:\s*)"(?!\[REDACTED\]")(?:[^"\\]|\\.)*"/gi,
    replace: "\"$1\"$2\"[REDACTED]\""
  }
]

/**
 * Credential names this module refuses to persist, matched as suffixes of the
 * separator-free lowercase form of a key.
 *
 * The list is the union of the names `packages/smithers/src/Bug.ts` redacts
 * structurally, because the journal is the PERMANENT side of that pair: a bug
 * report is one upload an operator reviews before it leaves the machine, while
 * `flows_journal_events.payload_json` is replayed verbatim to every sync
 * subscriber and time-travel consumer forever. The journal redacting less than
 * the report inverts the risk, and it did: `credential`, `credentials`, `dsn`,
 * and `connectionString` all round-tripped through a durable row in clear.
 *
 * Two families are spelled out rather than reduced to a shorter word, because
 * these are SUFFIX tests: `connectionString` does not end in `connection`, and
 * `secretKey` does not end in `secret`. A bare `key` suffix is not on the list
 * for the opposite reason: it would redact `monkey` and `turkey`.
 *
 * `signature` stays, and a field it costs is renamed rather than excused. A
 * name test cannot tell a MAC computed with a secret from a digest over public
 * input, and both are called `signature`: `WorkspaceShare` signs its claims
 * with `ShareSigner.signHmac` and that value IS the share's authorization,
 * `GrantStore` carries envelope signatures, and the GitHub, Linear and
 * Telegram webhook readers all verify a header by that name. Against those, a
 * digest whose whole purpose is to be reconciled costs nothing to rename and
 * everything to leave unreadable -- see
 * `AgentEvent.VacuousVerificationObserved.callDigest`, which was `signature`
 * and reached durable rows as the placeholder.
 */
const sensitiveKeySuffixes = [
  "auth",
  "authorization",
  "cookie",
  "apikey",
  "token",
  "password",
  "passphrase",
  "secret",
  "secretaccesskey",
  "credential",
  "dsn",
  "connection",
  "connectionstring",
  "connectionuri",
  "connectionurl",
  "secretkey",
  "privatekey",
  "sshkey",
  "signingkey",
  "signature",
  "encryptionkey",
  "session",
  "sessionkey"
]

/**
 * A trailing `key` that is a word of its own.
 *
 * Read against the ORIGINAL key, where the separators that make `key` a word
 * still exist: `key`, `api_key`, `x-api-key`, `signing-key`. This is the shape
 * `packages/smithers/src/Bug.ts` matches, and stopping here is deliberate. Treating
 * a camel-case hump as a separator too, `/[a-z0-9]Key$/`, looks equivalent and
 * is not: it redacted `idempotencyKey`, the durable identity an effect boundary
 * replays on, out of `@smthrs/engine-store`'s journal rows. A credential-named
 * key is covered by {@link sensitiveKeySuffixes} instead, where the word before
 * `key` has to be one that names a secret.
 */
const trailingKeyWord = /(?:^|[^A-Za-z0-9])key$/i

const canonicalKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "")

/** Numeric accounting fields that contain counts, never bearer material. */
const tokenCounterKeys: ReadonlySet<string> = new Set([
  "inputtoken",
  "outputtoken",
  "cachedinputtoken",
  "reasoningtoken",
  "totaltoken"
])

/**
 * A bare plural `tokens` is a count too: `Envelope.budget.tokens` is the run's
 * token ceiling, and redacting it erased every journaled budget. A singular
 * `token` stays bearer material even when it is numeric.
 */
const isTokenCount = (key: string, value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  (tokenCounterKeys.has(canonicalKey(key)) || key.toLowerCase() === "tokens")

/**
 * Whether a field name names a credential.
 *
 * Case and separators are ignored, so `api_key`, `apiKey`, and `x-api-key` are
 * all recognised, one trailing plural `s` is stripped so `credentials` reads as
 * `credential`, and a trailing `key` counts where it is a word of its own or
 * where the word before it names a secret.
 *
 * The rule is a suffix test, not a substring test. `tokenizer`, `secretary`,
 * `monkey`, and `idempotencyKey` are ordinary field names, and replacing their
 * values would destroy data in a permanent row without protecting anything.
 * That is the one place this rule is deliberately narrower than
 * `packages/smithers/src/Bug.ts`'s substring form, which can afford the false
 * positives because its output is a single report an operator reads once.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isSensitiveKey = (key: string): boolean => {
  if (trailingKeyWord.test(key)) return true
  const canonical = canonicalKey(key)
  return sensitiveKeySuffixes.some((suffix) => canonical.endsWith(suffix))
}

const redactMember = (
  key: string,
  value: unknown,
  walk: (value: unknown) => unknown
): unknown => isSensitiveKey(key) && !isTokenCount(key, value) ? placeholder : walk(value)

/**
 * A field name with a credential in it replaced outright, not rewritten in place.
 *
 * Redacting part of a key changes what the key reads as. `secret=sk-` rewrites
 * to `secret=[REDACTED]`, which now ENDS in a sensitive name, so a second
 * application would replace a value the first one left alone and redaction
 * would stop being a fixed point. Naming the whole key holds the verdict still:
 * `[REDACTED]` matches no rule and names no credential. Two such keys collapse
 * into one and the later member wins, which is the fidelity trade every other
 * marker here makes.
 */
const redactKey = (key: string, rules: ReadonlyArray<Rule>): string => {
  const redacted = redactString(key, rules)
  return redacted === key ? key : placeholder
}

const redactString = (value: string, rules: ReadonlyArray<Rule>): string =>
  rules.reduce((text, rule) => text.replace(rule.pattern, rule.replace ?? placeholder), value)

/**
 * Maximum number of container edges traversed from a redaction root.
 *
 * Journal event schemas never approach 256 nested containers. This bound is
 * far above practical payloads while keeping traversal safely below Node's
 * call-stack limit for hostile input.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxDepth = 256

/**
 * Options for {@link redact}.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly rules?: ReadonlyArray<Rule> | undefined
  /**
   * What a value nested past {@link maxDepth} does.
   *
   * `"throw"`, the default, is the journal's contract: a payload that deep is a
   * caller bug, and a durable row quietly truncated to a marker is worse than a
   * refused write. `"name"` is what a LOGGER wants, because a throw there is
   * caught one frame up and replaces EVERY argument on the line with
   * `[Unrenderable]`, so one deep member would cost the operator the whole line.
   */
  readonly onTooDeep?: "throw" | "name" | undefined
}

/**
 * How many bytes a view may hold, and how many own members {@link redact} reads
 * off it, before it stops reading them.
 *
 * Enumerating a view's own properties materialises one pair per byte, so the
 * walk costs the buffer's size even though the rendering does not. Both halves
 * of the bound carry load, and neither is a bound on its own. A size alone is
 * not, because `byteLength` was read as an ordinary property and an ordinary
 * property can be shadowed: a pooled chunk that reports the bytes it has used
 * rather than the bytes it holds is a plain pattern, not an adversarial one,
 * and a 4 MB chunk reporting 12 walked one property per byte anyway. A count
 * alone is not, because a caller can hang a million properties on a ten-byte
 * view. So the size is read from the value's own internal slot, where nothing
 * a caller writes can answer for it, and the members are counted as they are
 * walked.
 *
 * @since 0.1.0
 * @category redaction
 */
export const binaryWalkLimit = 65_536

/**
 * The byte-length getters, taken from the prototypes rather than from a value.
 *
 * `%TypedArray%.prototype`, `DataView.prototype` and `ArrayBuffer.prototype`
 * each define `byteLength` as an accessor over an internal slot, and applying
 * one to a value that has no such slot throws. Reading the size this way is
 * therefore a brand check as well as a measurement: a caller's own `byteLength`
 * property, accessor or not, never answers it.
 */
const byteLengthGetters = [
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, "byteLength")!.get!,
  Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!,
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!
] as ReadonlyArray<() => number>

/** A value's byte length from its own internal slot, or `undefined` when it has none. */
const byteLength = (node: object): number | undefined => {
  for (const getter of byteLengthGetters) {
    try {
      return Reflect.apply(getter, node, [])
    } catch {
      // Not that kind of view. Another getter answers, or none does and the
      // bytes are named without the members being read.
    }
  }
  return undefined
}

/** The prototypes every binary view inherits from. */
const binaryPrototypes: ReadonlySet<unknown> = new Set([
  Object.getPrototypeOf(Uint8Array.prototype),
  DataView.prototype,
  ArrayBuffer.prototype
])

/** How many prototypes {@link isBinary} climbs before it stops asking. */
const prototypeWalkLimit = 64

/**
 * Whether `node` is a binary view, including one held behind a proxy.
 *
 * `ArrayBuffer.isView` reads an internal slot, and a proxy has none of its own,
 * so it answers `false` for a proxy over a view. That sent a proxied 2 MB
 * buffer to the object branch, which rebuilt it one key per byte: 2,000 ms and
 * 22.9 million characters for one logged value. A proxy forwards
 * `getPrototypeOf` to its target, so the prototype chain answers where the
 * brand check cannot. The climb is capped because a proxy is free to hand back
 * a fresh object every time it is asked, which is an endless chain.
 */
const isBinary = (node: object): boolean => {
  if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return true
  try {
    let prototype = Object.getPrototypeOf(node) as object | null
    for (let step = 0; prototype !== null && step < prototypeWalkLimit; step++) {
      if (binaryPrototypes.has(prototype)) return true
      prototype = Object.getPrototypeOf(prototype) as object | null
    }
  } catch {
    // A revoked proxy refuses to be asked. It is not a view, and the object
    // branch names it.
  }
  return false
}

/** Own keys of a binary view that name one of its bytes rather than a property. */
const indexKey = /^(?:0|[1-9][0-9]*)$/

/** `Uint8Array 1024 bytes`, or the bare marker when the value will not say. */
const describeBinary = (node: object, size: number | undefined): string => {
  if (size === undefined) return binaryMarker
  try {
    return `${node.constructor.name} ${size} bytes`
  } catch {
    return binaryMarker
  }
}

/**
 * The key {@link redact} files a binary view's size under.
 *
 * @since 0.1.0
 * @category redaction
 */
export const binaryMarker = "[Binary]"

/**
 * What {@link redact} writes in place of a function or a class object.
 *
 * @since 0.1.0
 * @category redaction
 */
export const functionMarker = "[Function]"

/**
 * What {@link redact} writes in place of a symbol.
 *
 * @since 0.1.0
 * @category redaction
 */
export const symbolMarker = "[Symbol]"

/**
 * What {@link redact} writes past {@link maxDepth} under `onTooDeep: "name"`.
 *
 * @since 0.1.0
 * @category redaction
 */
export const depthMarker = "[Deep]"

/**
 * Returns `value` with credentials removed.
 *
 * Objects and arrays are rebuilt: a field whose name {@link isSensitiveKey}
 * is replaced wholesale, every other string is run through the textual rules,
 * and a cycle is collapsed to `"[Circular]"` so the result always encodes.
 * A number, a boolean, `null` and `undefined` are returned untouched, because
 * redacting one destroys data without protecting anything. A function and a
 * symbol are NAMED, {@link functionMarker} and {@link symbolMarker}: a body, an
 * own property and a description are all text a renderer prints, and none of it
 * can be rewritten in place.
 *
 * Traversal accepts at most {@link maxDepth} container edges. A deeper value
 * throws by default, so the journal boundary can report a typed `invalid_event`
 * instead of overflowing the runtime stack. {@link Options.onTooDeep} set to
 * `"name"` writes {@link depthMarker} in its place instead, which is what a
 * logger wants.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redact = (value: unknown, options?: Options): unknown => {
  const onTooDeep = options?.onTooDeep ?? "throw"
  const rules = (options?.rules ?? defaultRules).map((rule) =>
    rule.pattern.flags.includes("g")
      ? rule
      : { ...rule, pattern: new RegExp(rule.pattern.source, `${rule.pattern.flags}g`) }
  )
  /**
   * A binary view named by its type and size, with its own properties walked.
   *
   * Its bytes are not text the rules can read, and rebuilding it from its
   * entries wrote one key per byte: a 100 kB buffer rendered 1.4 MB. Handing
   * the view back untouched is not the answer either, because `redact` is the
   * journal's own write path, so a caller's `apiKey` property hung on a buffer
   * went into a durable row in clear. Name the bytes, keep walking the text.
   */
  const binary = (node: object, ancestors: WeakSet<object>, depth: number): unknown => {
    const size = byteLength(node)
    // The description is text read off the value, so it meets the rules like
    // any other text: a class name is caller data, and a view whose
    // constructor is named after a credential wrote it into a durable row.
    const entries: Array<[string, unknown]> = [[binaryMarker, redactString(describeBinary(node, size), rules)]]
    // `Object.entries` on a view materialises one pair per byte before the
    // index filter can discard them, which cost 312 ms for 1 MB on the journal
    // write path. Past the bound the bytes are named and nothing else is read,
    // so a member a caller hung on a large view is dropped rather than shown.
    // A value that will not answer from its internal slot, such as a proxy over
    // a view, is named and never enumerated at all.
    if (size !== undefined && size <= binaryWalkLimit) {
      let walked = 0
      for (const [key, field] of Object.entries(node as Record<string, unknown>)) {
        // An index is one of the bytes just named, not a property a caller set.
        if (indexKey.test(key)) continue
        // The size bounds the bytes, not the properties: a caller can hang a
        // million members on a ten-byte view, and each one costs three rule
        // scans over its name and a walk of its value.
        if (walked >= binaryWalkLimit) break
        walked++
        entries.push([
          redactKey(key, rules),
          redactMember(key, field, (value) => walk(value, ancestors, depth + 1))
        ])
      }
    }
    // `Object.fromEntries`, not `named[key] = …`, for the reason the object
    // branch below gives: a literal `__proto__` key would route through the
    // inherited setter and the member would vanish from the row.
    return Object.fromEntries(entries)
  }

  const walk = (node: unknown, ancestors: WeakSet<object>, depth: number): unknown => {
    if (depth > maxDepth) {
      if (onTooDeep === "name") return depthMarker
      throw new Error(`redaction depth exceeds ${maxDepth}`)
    }
    if (typeof node === "string") return redactString(node, rules)
    // A function, a class object or a symbol carries text a walk never reaches
    // (own properties, a description, a body), and the renderer prints it. None
    // of it can be redacted in place, so the value is named instead.
    if (typeof node === "function") return functionMarker
    if (typeof node === "symbol") return symbolMarker
    if (node === null || typeof node !== "object") return node
    if (isBinary(node)) return binary(node, ancestors, depth)
    if (ancestors.has(node)) return "[Circular]"
    // A journal row is bounded by its schema, but a LOGGED value is arbitrary:
    // the logger sends every non-Error value here, and a chain deep enough to
    // exhaust the stack would throw while the line is rendering, killing the
    // run the line describes. Past the cap the value is named, the way a cycle
    // is named.
    ancestors.add(node)
    try {
      const toJSON = (node as { toJSON?: unknown }).toJSON
      if (typeof toJSON === "function") return walk(toJSON.call(node), ancestors, depth)
      if (Array.isArray(node)) {
        // `map` invokes the input's species constructor, which can restore
        // credential fields and inspection hooks after the elements are walked.
        // Rebuild a plain array, preserving the original length and holes.
        const length = node.length
        const result = new Array<unknown>(length)
        for (let index = 0; index < length; index++) {
          if (index in node) result[index] = walk(node[index], ancestors, depth + 1)
        }
        return result
      }
      // `result[key] = …` routes a literal `__proto__` key through the
      // inherited setter, so the field would silently become the result's
      // prototype instead of a member: the payload loses data and redaction
      // stops being a fixed point. `Object.fromEntries` defines own data
      // properties and has no such hole.
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map((
          [key, field]
        ) => [
          // The KEY is text too. Rewriting only values let a credential used as
          // a log annotation key reach the operator, since Effect renders an
          // annotation as `key=value`, and become an OTLP span attribute name.
          redactKey(key, rules),
          redactMember(key, field, (value) => walk(value, ancestors, depth + 1))
        ])
      )
    } finally {
      ancestors.delete(node)
    }
  }
  return walk(value, new WeakSet(), 0)
}

/**
 * A redaction function, as the journal consumes it.
 *
 * @since 0.1.0
 * @category models
 */
export type Redactor = (value: unknown) => unknown

/**
 * Builds a redactor over a rule set.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options?: Options): Redactor => (value) => redact(value, options)

/**
 * Applies a redactor to an already-encoded JSON string, returning the
 * re-encoded result.
 *
 * For export and display surfaces that hold a column verbatim, a rendered
 * `state_json`, a support bundle, where the value is already encoded and must
 * not be decoded into the executable path. A string that does not parse is
 * returned untouched: validation is the caller's, and rejecting here would
 * turn a redaction concern into a schema error. Once parsing succeeds, a
 * throwing redactor or an encoding failure returns the valid JSON string
 * `"[REDACTED]"`; the original parsed text is never returned.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redactJsonString = (json: string, redactor: Redactor): string => {
  const decoded = Schema.decodeUnknownResult(UnknownFromJsonString)(json)
  if (Result.isFailure(decoded)) return json
  const attempted = Result.try(() => Schema.encodeUnknownResult(UnknownFromJsonString)(redactor(decoded.success)))
  if (Result.isFailure(attempted)) return JSON.stringify(placeholder)
  return Result.isSuccess(attempted.success) ? attempted.success.success : JSON.stringify(placeholder)
}

/**
 * The identity redactor, for a caller that persists payloads verbatim by
 * choice: a trusted single-tenant store, or a suite asserting on raw input.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (): Redactor => (value) => value
