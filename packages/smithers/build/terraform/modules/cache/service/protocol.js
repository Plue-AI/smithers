/*
 * The remote-cache HTTP protocol, with no storage and no listener in it.
 *
 *   GET    /ac/{keyDigest}            -> 200 stored entry JSON | 404
 *   PUT    /ac/{keyDigest}            -> 201 inserted | 200 already identical | 409 different
 *   DELETE /ac/{keyDigest}            -> 200 deleted | 404, fenced by ?recordedRunId&recordedEventSeq
 *   GET    /cas/{digest}              -> 200 octet-stream | 404
 *   PUT    /cas/{digest}              -> 201 stored | 200 already present or repaired
 *   HEAD   /cas/{digest}              -> 200 | 404
 *   POST   /cas/findMissing           -> 200 {"missing":[...]}
 *   GET    /healthz                   -> 200, unauthenticated
 *
 * infra/worker/protocol.ts serves these routes on Cloudflare. This file is a
 * separate implementation of the same routes, written and maintained by hand;
 * it is not generated from that module and nothing in it is imported from
 * there. Both accept the two shapes the two real clients publish: the
 * `CacheEntry` envelope `RemoteCacheStore` sends, and the bare `CachedResult`
 * JSON the smthrs CLI sends, and every exported bound below equals the
 * Worker's (../../../../test/CacheProtocolParity.test.ts pins that). The
 * tiers differ by contract on journal provenance: the Worker refuses it with
 * 422 and this service stores it and fences deletion on it. The black-box
 * corpus in test/conformance_test.js holds every other route to one answer.
 *
 * Storage arrives as `actionCache` and `contentStore`, so the protocol is
 * testable without a database and startup is somebody else's file.
 */

const hexDigest = /^[0-9a-f]{64}$/
const jsonContentType = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/
const decimalDigits = /^[0-9]+$/
const numberLexeme = /[0-9eE+.-]/
const controlCharacters = /[\u0000-\u001f\u007f]/

const isWellFormedText = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** The largest action-cache document the service accepts. */
export const maxActionCacheBodyBytes = 1024 * 1024

/** The largest `findMissing` request the service accepts. */
export const maxFindMissingBodyBytes = 256 * 1024

/** The most digests one `findMissing` request may probe. */
export const maxFindMissingDigests = 1000

/** The longest action-cache key the service stores. */
export const maxKeyDigestLength = 512

/** The most artifact references one publication records. */
export const maxReferencedDigests = 1000

/** The absolute per-artifact ceiling supported by this deployment. */
export const maxArtifactBodyBytes = 16 * 1024 * 1024

/** Structural limits applied to every JSON publication before it is stored. */
export const maxJsonDepth = 64
export const maxJsonMembers = 100_000
export const maxCanonicalJsonBytes = 2 * 1024 * 1024

/** Defends bounded bodies from streams made of unbounded empty/tiny chunks. */
export const maxBodyChunks = 16_384

/** Bounds all cache work and the large buffers held by CAS transfers. */
export const maxConcurrentCacheRequests = 64
export const maxConcurrentActionCachePublications = 4
export const maxConcurrentFindMissingRequests = 8
export const maxConcurrentArtifactTransfers = 2

/** Successful readiness checks are coalesced for this monotonic interval. */
export const healthCacheMilliseconds = 1000

/**
 * Stops waiting on an uncooperative dependency when the request ends. A
 * cancellable operation must settle (including SQL rollback) before its slot
 * can be reused. Plain promises have no underlying cancellation to drain.
 */
export const waitForAbort = (work, signal) => {
  if (signal === undefined) return Promise.resolve(work)
  return new Promise((resolve, reject) => {
    let aborting = false
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => {
      if (aborting) return
      aborting = true
      cleanup()
      void (async () => {
        try {
          if (typeof work?.cancel === "function") {
            try {
              work.cancel()
            } finally {
              await work
            }
          }
        } catch {
          // Cancellation normally rejects the operation being drained.
        }
        reject(signal.reason)
      })()
    }
    Promise.resolve(work).then((value) => {
      if (aborting) return
      cleanup()
      resolve(value)
    }, (cause) => {
      if (aborting) return
      cleanup()
      reject(cause)
    })
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

const requestLifetime = (parent, milliseconds) => {
  const controller = new globalThis.AbortController()
  const abort = () => controller.abort(parent.reason)
  parent?.addEventListener("abort", abort, { once: true })
  if (parent?.aborted) abort()
  const timer = setTimeout(
    () => controller.abort(new globalThis.DOMException("request deadline exceeded", "TimeoutError")),
    milliseconds
  )
  timer.unref?.()
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer)
      parent?.removeEventListener("abort", abort)
    }
  }
}

const requestStorage = (service, signal) =>
  Object.fromEntries(
    Object.entries(service).map(([name, method]) => [name, (...args) => {
      signal.throwIfAborted()
      return waitForAbort(method(...args, signal), signal)
    }])
  )

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
const textEncoder = new TextEncoder()

const utf8Bytes = (value) => textEncoder.encode(value).byteLength

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const empty = (status) => new Response(null, { status })

const unauthorized = () =>
  new Response(null, {
    status: 401,
    headers: { "www-authenticate": "Bearer realm=\"smithers-build-cache\"" }
  })

const forbidden = () =>
  new Response(JSON.stringify({ error: "this credential may read the cache but not publish to it" }), {
    status: 403,
    headers: { "content-type": "application/json" }
  })

const busy = (message) =>
  new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" }
  })

/**
 * Refuses a method on a route that exists.
 *
 * RFC 9110 requires a 405 to name the methods the route does accept, and the
 * two real clients read it when they probe an endpoint they did not configure.
 */
const methodNotAllowed = (allowed) => new Response(null, { status: 405, headers: { allow: allowed } })

const mediaType = (request) => (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase()

const sha256 = (data) => new Bun.CryptoHasher("sha256").update(data).digest()

const sha256Hex = (data) => new Bun.CryptoHasher("sha256").update(data).digest("hex")

/**
 * Cancels a body the handler decided not to read.
 *
 * A refusal taken from the headers alone has never acquired a reader, so the
 * stream itself is what has to be cancelled: returning without cancelling
 * leaves the sender uploading into a body nothing will ever drain. The
 * cancellation is best effort. A sender that already went away makes it fail,
 * and that failure must never replace the 400, 413, or 415 the client needs.
 */
const discardBody = async (body) => {
  if (body === null || body === undefined || typeof body.cancel !== "function") return
  try {
    void body.cancel().catch(() => undefined)
  } catch {
    // The sender is gone, which is the outcome cancelling was asking for.
  }
}

/**
 * Reads at most `limit` bytes of a request body, refusing anything longer
 * before it is allocated.
 *
 * `Content-Length` is checked for syntax and for size, and is then not trusted:
 * a chunked upload declares nothing at all, and a declared length is a claim
 * the sender controls. The stream is what the bound is enforced against, so
 * the refusal fires at most one chunk past the limit.
 *
 * Every exit releases the reader lock exactly once, and every exit that leaves
 * bytes unread cancels the stream first. That holds for the header refusals,
 * for the overflow refusal, for normal completion, and for a failed read, whose
 * error is rethrown unchanged: a cancel or a release that fails on the way out
 * is swallowed, because it is a consequence of the failure and never the
 * diagnosis of it.
 */
const readBody = async (request, limit) => {
  const contentLength = request.headers.get("content-length")
  let declaredLength = null
  if (contentLength !== null) {
    if (!decimalDigits.test(contentLength)) {
      await discardBody(request.body)
      return { ok: false, response: json(400, { error: "invalid content-length" }) }
    }
    declaredLength = Number(contentLength)
    if (!Number.isSafeInteger(declaredLength) || declaredLength > limit) {
      await discardBody(request.body)
      return { ok: false, response: json(413, { error: "request body exceeds the configured bound" }) }
    }
  }
  if (request.body === null) {
    return declaredLength === null || declaredLength === 0
      ? { ok: true, bytes: new Uint8Array() }
      : { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
  }

  const reader = request.body.getReader()
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      reader.releaseLock()
    } catch {
      // A reader that cannot be released is already unusable; the answer stands.
    }
  }
  const abandon = async () => {
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      // Same position as discardBody: cancelling is best effort.
    }
    release()
  }

  const bytes = new Uint8Array(declaredLength ?? limit)
  let length = 0
  let chunks = 0
  try {
    while (true) {
      const chunk = await waitForAbort(reader.read(), request.signal)
      if (chunk.done) break
      chunks += 1
      if (chunks > maxBodyChunks) {
        await abandon()
        return { ok: false, response: json(413, { error: "request body has too many chunks" }) }
      }
      if (!(chunk.value instanceof Uint8Array)) {
        await abandon()
        return { ok: false, response: json(400, { error: "request body must be a byte stream" }) }
      }
      if (chunk.value.byteLength === 0) continue
      if (length + chunk.value.byteLength > limit) {
        await abandon()
        return { ok: false, response: json(413, { error: "request body exceeds the configured bound" }) }
      }
      if (length + chunk.value.byteLength > bytes.byteLength) {
        await abandon()
        return { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
      }
      bytes.set(chunk.value, length)
      length += chunk.value.byteLength
    }
  } catch (cause) {
    await abandon()
    throw cause
  }
  release()
  if (declaredLength !== null && length !== declaredLength) {
    return { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
  }
  return { ok: true, bytes: bytes.subarray(0, length) }
}

/**
 * Refuses JSON text whose parse is not reversible.
 *
 * `JSON.parse` collapses information the raw text carried: a duplicate member
 * name keeps only the last value, and a number literal beyond IEEE-754 double
 * precision becomes the nearest double. Conflict classification compares the
 * parsed value, so two mathematically different published results would
 * compare identical and answer `200` where the protocol promises `409`.
 *
 * The scan runs over text `JSON.parse` already accepted, so it may assume
 * well-formed JSON, and it is linear in the body length, which the caller has
 * already bounded. This is the translation of `irreversibleJson` in
 * infra/worker/protocol.ts.
 */
const irreversibleJson = (text) => {
  const scopes = []
  // The member names of the object whose key comes next, or `null` when the
  // next string is a value.
  let keyScope = null
  let index = 0
  while (index < text.length) {
    const character = text.charAt(index)
    if (character === "{") {
      keyScope = new Set()
      scopes.push(keyScope)
      index += 1
    } else if (character === "[") {
      scopes.push(null)
      keyScope = null
      index += 1
    } else if (character === "}" || character === "]") {
      scopes.pop()
      keyScope = null
      index += 1
    } else if (character === ",") {
      const enclosing = scopes.at(-1)
      keyScope = enclosing instanceof Set ? enclosing : null
      index += 1
    } else if (character === ":") {
      keyScope = null
      index += 1
    } else if (character === "\"") {
      let end = index + 1
      while (end < text.length && text.charAt(end) !== "\"") end += text.charAt(end) === "\\" ? 2 : 1
      if (keyScope !== null) {
        // The caller already parsed this text, so every string token in it
        // parses on its own.
        const name = JSON.parse(text.slice(index, end + 1))
        if (keyScope.has(name)) return "body contains a duplicate object member name"
        keyScope.add(name)
      }
      index = end + 1
    } else if (character === "-" || (character >= "0" && character <= "9")) {
      let end = index + 1
      while (end < text.length && numberLexeme.test(text.charAt(end))) end += 1
      const lexeme = text.slice(index, end)
      const value = Number(lexeme)
      if (!Number.isFinite(value) || Object.is(value, -0) || String(value) !== lexeme) {
        return "body contains a JSON number that does not round-trip through a double"
      }
      index = end
    } else index += 1
  }
  return null
}

/** Reads a bounded body and requires it to be a UTF-8 JSON document. */
const readJson = async (request, limit) => {
  if (!jsonContentType.test(mediaType(request))) {
    await discardBody(request.body)
    return { ok: false, response: json(415, { error: "content-type must be application/json" }) }
  }
  const body = await readBody(request, limit)
  if (!body.ok) return body
  let text
  try {
    text = textDecoder.decode(body.bytes)
  } catch {
    return { ok: false, response: json(400, { error: "body must be UTF-8 JSON" }) }
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, response: json(400, { error: "body must be valid JSON" }) }
  }
  const irreversible = irreversibleJson(text)
  if (irreversible !== null) return { ok: false, response: json(400, { error: irreversible }) }
  return { ok: true, text, value }
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Renders an inert JSON value, and the text of one subtree of it, in one pass.
 *
 * Validation precedes rendering, so cycles, accessors, sparse arrays, exotic
 * prototypes, negative zero, and adversarial nesting never reach the recursive
 * renderer. A caller that needs both the whole document and the canonical text
 * of one member of it passes that member as `capture` rather than rendering it
 * a second time; the whole document is still what the depth, member, and byte
 * bounds are measured against.
 */
const renderCanonical = (value, capture) => {
  const ancestors = new Set()
  const chunks = []
  // A UTF-8 encoding is never shorter than the UTF-16 text it came from, so
  // this running length refuses an oversized document without encoding a
  // single fragment. The exact byte count is taken once, from the joined text.
  let length = 0
  let members = 0
  let captured = null
  const append = (fragment) => {
    length += fragment.length
    if (!Number.isSafeInteger(length) || length > maxCanonicalJsonBytes) {
      throw new Error("canonical JSON exceeds its byte bound")
    }
    chunks.push(fragment)
  }
  const appendString = (text) => {
    if (text.length > maxCanonicalJsonBytes) throw new Error("canonical JSON exceeds its byte bound")
    append(JSON.stringify(text))
  }
  const renderValue = (current, depth) => {
    if (depth > maxJsonDepth) throw new Error("JSON is nested too deeply")
    if (current === null) {
      append("null")
      return
    }
    if (typeof current === "string") {
      appendString(current)
      return
    }
    if (typeof current === "boolean") {
      append(current ? "true" : "false")
      return
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new Error("JSON number is outside the supported range")
      }
      append(JSON.stringify(current))
      return
    }
    if (!Array.isArray(current) && !isRecord(current)) throw new Error("unsupported JSON value")
    if (ancestors.has(current)) throw new Error("JSON contains a cycle")
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length")
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) throw new Error("array is not an inert JSON array")
        const length = lengthDescriptor.value
        const keys = Reflect.ownKeys(current).filter((key) => key !== "length")
        if (keys.length !== length) throw new Error("array is not a JSON array")
        if (length > maxJsonMembers - members) throw new Error("JSON has too many members")
        members += length
        append("[")
        for (let index = 0; index < length; index += 1) {
          if (index > 0) append(",")
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            throw new Error("array is not an inert JSON array")
          }
          render(descriptor.value, depth + 1)
        }
        append("]")
        return
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) throw new Error("object is not a JSON object")
      const keys = Reflect.ownKeys(current)
      if (!keys.every((key) => typeof key === "string")) throw new Error("object has symbol keys")
      if (keys.length > maxJsonMembers - members) throw new Error("JSON has too many members")
      members += keys.length
      const stringKeys = keys.sort()
      append("{")
      for (let index = 0; index < stringKeys.length; index += 1) {
        const key = stringKeys[index]
        if (index > 0) append(",")
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("object is not an inert JSON object")
        }
        appendString(key)
        append(":")
        render(descriptor.value, depth + 1)
      }
      append("}")
    } finally {
      ancestors.delete(current)
    }
  }

  /**
   * Renders `current`, keeping the text of the first `capture` occurrence.
   *
   * A parsed JSON document holds exactly one reference to each object it
   * contains, and equal primitives render to equal text, so the first match is
   * the subtree the caller asked for whichever occurrence it is.
   */
  const render = (current, depth) => {
    if (capture === undefined || captured !== null || current !== capture) {
      renderValue(current, depth)
      return
    }
    const start = chunks.length
    renderValue(current, depth)
    captured = chunks.slice(start).join("")
  }

  render(value, 0)
  const text = chunks.join("")
  if (utf8Bytes(text) > maxCanonicalJsonBytes) throw new Error("canonical JSON exceeds its byte bound")
  return { text, captured }
}

/**
 * Renders an inert JSON value with deterministic member order and hard bounds.
 *
 * @category utilities
 */
export const canonicalJson = (value) => renderCanonical(value).text

/**
 * Refuses an action-cache key that cannot be stored or cannot have come from a
 * client.
 *
 * A step key is a `@smthrs/keys` key and the CLI's key is a planner content
 * key, so the shape is deliberately wide: any non-empty, bounded, control-free
 * string, including one whose percent-encoding decoded to slashes. The bound
 * matches the column check in migrations/0001_initial.sql.
 */
const invalidKeyDigest = (keyDigest) => {
  if (keyDigest.length === 0) return "empty keyDigest"
  if (!isWellFormedText(keyDigest)) return "keyDigest must be well-formed Unicode text"
  if (utf8Bytes(keyDigest) > maxKeyDigestLength) {
    return `keyDigest must be at most ${maxKeyDigestLength} UTF-8 bytes`
  }
  if (controlCharacters.test(keyDigest)) return "keyDigest must not contain control characters"
  return null
}

/**
 * Refuses a stored row that cannot have come from this service.
 *
 * The published bytes were rendered and bounded on the way in, and the `body`
 * column carries a `CHECK (octet_length(body) <= ... AND body IS JSON)`, so a
 * hit only repeats the checks that stay cheap next to the size of the row: the
 * type, the byte bound, and the key the row claims. Rendering the document
 * again would make the hottest route the service has pay for the size of every
 * hit twice, to guard against a writer that bypassed both.
 */
const validateStoredActionBody = (keyDigest, body) => {
  if (typeof body !== "string" || utf8Bytes(body) > maxActionCacheBodyBytes) {
    throw new Error("action cache returned an invalid stored body")
  }
  let value
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error("action cache returned invalid stored JSON")
  }
  if (isRecord(value) && Object.hasOwn(value, "keyDigest") && value.keyDigest !== keyDigest) {
    throw new Error("action cache returned a row for a different key")
  }
  return body
}

const validatedContentBody = (object) => {
  if (!isRecord(object)) throw new Error("content store returned an invalid object")
  const descriptor = Object.getOwnPropertyDescriptor(object, "body")
  if (
    descriptor === undefined || !("value" in descriptor) || descriptor.value === null || descriptor.value === undefined
  ) {
    throw new Error("content store returned an invalid object body")
  }
  return descriptor.value
}

/** Extracts only artifacts the engine's declared-output boundary references. */
const referencedDigests = (record) => {
  const outputs = record?.meta?.boundary?.declaredOutputs?.outputs
  if (outputs === undefined) return []
  if (!Array.isArray(outputs)) throw new Error("declared outputs must be an array")
  const references = new Set()
  for (const output of outputs) {
    if (!isRecord(output)) throw new Error("declared output must be an object")
    if (!Object.hasOwn(output, "digest") || output.digest === null || Object.hasOwn(output, "content")) continue
    if (typeof output.digest !== "string" || !hexDigest.test(output.digest)) {
      throw new Error("declared output digest is invalid")
    }
    references.add(output.digest)
    if (references.size > maxReferencedDigests) throw new Error("publication references too many artifacts")
  }
  return [...references]
}

/**
 * Validates one action-cache publication in either shape a real client sends.
 *
 * `RemoteCacheStore` publishes a `CacheEntry` envelope with `keyDigest`,
 * `result`, `meta`, and journal provenance. The smthrs CLI publishes that same
 * envelope, and older compatible clients publish the bare `CachedResult`
 * document. The stored bytes are the client's own, so a lookup returns exactly
 * what was published; only the conflict discriminator and the provenance
 * columns are derived.
 */
const readPublication = async (request, keyDigest) => {
  const parsed = await readJson(request, maxActionCacheBodyBytes)
  if (!parsed.ok) return parsed
  const record = isRecord(parsed.value) ? parsed.value : null
  if (record !== null && Object.hasOwn(record, "keyDigest") && record.keyDigest !== keyDigest) {
    return {
      ok: false,
      response: json(400, { error: "keyDigest must match the request path when supplied" })
    }
  }

  // A bare CachedResult may itself have a member named `result`. Require the
  // path-matching cache key as well before interpreting envelope metadata.
  const enveloped = record !== null && Object.hasOwn(record, "keyDigest") && Object.hasOwn(record, "result")
  let resultJson
  let digests
  try {
    // Validate the whole envelope, not just the conflict discriminator. This
    // prevents deeply nested or over-wide metadata from reaching storage. The
    // discriminator is the result subtree of that same rendering, so an
    // envelope is walked once rather than once for each of the two.
    const rendered = renderCanonical(parsed.value, enveloped ? record.result : undefined)
    if (enveloped && rendered.captured === null) throw new Error("envelope result was not rendered")
    resultJson = enveloped ? rendered.captured : rendered.text
    digests = enveloped ? referencedDigests(record) : []
  } catch {
    return { ok: false, response: json(400, { error: "body contains invalid or unsupported cache metadata" }) }
  }

  const metadata = enveloped ? record : null
  const hasCreatedAtMs = metadata !== null && Object.hasOwn(metadata, "createdAtMs")
  const createdAtMs = hasCreatedAtMs ? metadata.createdAtMs : null
  if (hasCreatedAtMs && (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0)) {
    return { ok: false, response: json(400, { error: "createdAtMs must be a non-negative safe integer" }) }
  }

  const hasRecordedRunId = metadata !== null && Object.hasOwn(metadata, "recordedRunId")
  const hasRecordedEventSeq = metadata !== null && Object.hasOwn(metadata, "recordedEventSeq")
  if (hasRecordedRunId !== hasRecordedEventSeq) {
    return {
      ok: false,
      response: json(400, { error: "recordedRunId and recordedEventSeq must be supplied together" })
    }
  }
  const recordedRunId = hasRecordedRunId ? metadata.recordedRunId : null
  const recordedEventSeq = hasRecordedEventSeq ? metadata.recordedEventSeq : null
  if (
    hasRecordedRunId && (
      typeof recordedRunId !== "string" ||
      recordedRunId.length === 0 ||
      !isWellFormedText(recordedRunId) ||
      utf8Bytes(recordedRunId) > maxKeyDigestLength ||
      controlCharacters.test(recordedRunId) ||
      !Number.isSafeInteger(recordedEventSeq) ||
      recordedEventSeq < 0
    )
  ) {
    return { ok: false, response: json(400, { error: "publication provenance is invalid" }) }
  }
  return {
    ok: true,
    publication: {
      body: parsed.text,
      resultJson,
      createdAtMs,
      recordedRunId,
      recordedEventSeq,
      digests
    }
  }
}

/**
 * Splits a credential off an `Authorization` header.
 *
 * RFC 9110 makes the scheme name case-insensitive and allows more than one
 * space before the credential, so a conforming client that sends `bearer` is
 * authenticated rather than refused. The match is anchored and its only
 * quantifier is over a single literal, so a hostile header cannot make it
 * backtrack.
 */
const bearerScheme = /^Bearer +/i

const matchesDigest = (supplied, expected) => {
  let difference = 0
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= (supplied[index] ?? 0) ^ (expected[index] ?? 0)
  }
  return difference === 0
}

/**
 * Classifies the presented bearer token against both credential digests.
 *
 * Both comparisons always run and neither short circuits, so the answer costs
 * the same work whichever credential was presented and whichever byte first
 * differs. A deployment that configures one secret for both directions matches
 * both, and the more capable classification wins so publication keeps working.
 *
 * Null digests are the documented development mode: no token is configured,
 * the check is disabled, and the service must only be bound to loopback.
 */
const presentedCredential = (request, expectedWrite, expectedRead) => {
  if (expectedWrite === null && expectedRead === null) return "write"
  const authorization = request.headers.get("authorization") ?? ""
  const scheme = bearerScheme.exec(authorization)
  const bearer = scheme !== null
  const supplied = sha256(textEncoder.encode(bearer ? authorization.slice(scheme[0].length) : ""))
  const isWrite = matchesDigest(supplied, expectedWrite)
  const isRead = matchesDigest(supplied, expectedRead)
  if (!bearer) return "none"
  if (isWrite) return "write"
  return isRead ? "read" : "none"
}

const handleActionCache = async (request, keyDigest, url, actionCache) => {
  const problem = invalidKeyDigest(keyDigest)
  if (problem !== null) {
    await discardBody(request.body)
    return json(400, { error: problem })
  }
  if (request.method === "GET") {
    await discardBody(request.body)
    const body = await actionCache.get(keyDigest)
    return body === null
      ? empty(404)
      : new Response(validateStoredActionBody(keyDigest, body), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  }
  if (request.method === "PUT") {
    const publication = await readPublication(request, keyDigest)
    if (!publication.ok) return publication.response
    const outcome = await actionCache.put(keyDigest, publication.publication)
    if (outcome === "inserted") return json(201, { keyDigest })
    if (outcome === "identical") return empty(200)
    if (outcome === "conflict") return empty(409)
    throw new Error("action cache returned an invalid publication outcome")
  }
  if (request.method === "DELETE") {
    await discardBody(request.body)
    const runIds = url.searchParams.getAll("recordedRunId")
    const eventSeqs = url.searchParams.getAll("recordedEventSeq")
    if (runIds.length > 1 || eventSeqs.length > 1) {
      return json(400, { error: "deletion fence parameters must not be repeated" })
    }
    const runId = runIds[0] ?? null
    const eventSeq = eventSeqs[0] ?? null
    if ((runId === null) !== (eventSeq === null)) {
      return json(400, { error: "recordedRunId and recordedEventSeq must be supplied together" })
    }
    let fence = null
    if (runId !== null && eventSeq !== null) {
      // A malformed fence must not become an unfenced delete, and must not
      // reach Postgres as NaN either. Refusing it is the only safe answer.
      if (
        runId.length === 0 ||
        !isWellFormedText(runId) ||
        utf8Bytes(runId) > maxKeyDigestLength ||
        controlCharacters.test(runId)
      ) {
        return json(400, { error: "recordedRunId must be a non-empty bounded string" })
      }
      const seq = Number(eventSeq)
      if (!decimalDigits.test(eventSeq) || !Number.isSafeInteger(seq)) {
        return json(400, { error: "recordedEventSeq must be a non-negative safe integer" })
      }
      fence = { runId, eventSeq: seq }
    }
    const deleted = await actionCache.delete(keyDigest, fence)
    if (typeof deleted !== "boolean") throw new Error("action cache returned an invalid deletion outcome")
    return empty(deleted ? 200 : 404)
  }
  await discardBody(request.body)
  return methodNotAllowed("GET, PUT, DELETE")
}

const handleArtifact = async (request, digest, contentStore, maxArtifactBytes) => {
  if (!hexDigest.test(digest)) {
    await discardBody(request.body)
    return json(400, { error: "digest must be 64 lowercase hex characters" })
  }
  if (request.method === "HEAD") {
    await discardBody(request.body)
    const present = await contentStore.has(digest)
    if (typeof present !== "boolean") throw new Error("content store returned an invalid presence outcome")
    return empty(present ? 200 : 404)
  }
  if (request.method === "GET") {
    await discardBody(request.body)
    const object = await contentStore.get(digest)
    return object === null
      ? empty(404)
      : new Response(validatedContentBody(object), {
        status: 200,
        headers: { "content-type": "application/octet-stream" }
      })
  }
  if (request.method === "PUT") {
    // This service does not implement the resumable Content-Range/308
    // sequence `RemoteArtifacts.Options.chunkBytes` speaks. RFC 9110 section
    // 14.5 names the answer of a resource that does not support partial PUT:
    // 400, which that client reads as its cue to send the blob whole.
    // Refusing before the body is read makes the refusal deliberate; before,
    // the empty probe fell through to the digest check below and got the same
    // status with a misleading answer.
    if (request.headers.get("content-range") !== null) {
      await discardBody(request.body)
      return json(400, { error: "content-range is not supported; send the whole blob in one request" })
    }
    if (mediaType(request) !== "application/octet-stream") {
      await discardBody(request.body)
      return json(415, { error: "content-type must be application/octet-stream" })
    }
    const body = await readBody(request, maxArtifactBytes)
    if (!body.ok) return body.response
    // The server measures too. A client is the least trusted writer there is,
    // and an address that does not match its bytes would poison every reader.
    const measured = sha256Hex(body.bytes)
    if (measured !== digest) return json(400, { error: `bytes digest to ${measured}` })
    const outcome = await contentStore.put(digest, body.bytes)
    if (outcome === "inserted") return empty(201)
    // `repaired` replaced a stored row that failed its integrity check with
    // these bytes, which is `present` with extra work: the address now holds
    // the content the client published. Answering it as an unexpected outcome
    // reached the outer catch and became a 503, which the client retries
    // rather than treating as a miss, so a successful repair looked like the
    // tier refusing.
    if (outcome === "present" || outcome === "repaired") return empty(200)
    throw new Error("content store returned an invalid publication outcome")
  }
  await discardBody(request.body)
  return methodNotAllowed("GET, HEAD, PUT")
}

/**
 * Returns the same response with its body holding an admission slot.
 *
 * The runtime streams a `GET` body after the handler has returned, so a
 * counter decremented on return bounds the store lookup rather than the
 * transfer, and arbitrarily many long-lived downloads coexist under a cap that
 * says it bounds them. Wrapping the body moves the release to the point the
 * client actually stops consuming it: end of stream, error, or cancellation.
 *
 * This is the translation of `heldWhileStreaming` in infra/worker/protocol.ts.
 */
const heldWhileStreaming = (response, release, signal) => {
  const finish = release
  let streamController
  const abort = () => {
    streamController.error(signal.reason)
    void reader.cancel(signal.reason).catch(() => undefined)
    release()
  }
  release = () => {
    signal.removeEventListener("abort", abort)
    finish()
  }
  const body = response.body
  if (body === null) {
    release()
    return response
  }
  const reader = body.getReader()
  const held = new ReadableStream({
    start(controller) {
      streamController = controller
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          controller.close()
          release()
          return
        }
        controller.enqueue(chunk.value)
      } catch (cause) {
        release()
        controller.error(cause)
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    }
  })
  return new Response(held, { status: response.status, headers: response.headers })
}

const handleFindMissing = async (request, contentStore) => {
  if (request.method !== "POST") {
    await discardBody(request.body)
    return methodNotAllowed("POST")
  }
  const parsed = await readJson(request, maxFindMissingBodyBytes)
  if (!parsed.ok) return parsed.response
  if (
    !isRecord(parsed.value) ||
    Reflect.ownKeys(parsed.value).length !== 1 ||
    !Object.hasOwn(parsed.value, "digests")
  ) return json(400, { error: "body must be exactly {\"digests\":[...]}" })
  const digests = parsed.value.digests
  if (!Array.isArray(digests)) return json(400, { error: "body must be {\"digests\":[...]}" })
  if (digests.length > maxFindMissingDigests) {
    return json(413, { error: `at most ${maxFindMissingDigests} digests may be probed at once` })
  }
  // Deduplication keeps first-occurrence order, so the answer is in request
  // order the way Bazel's MissingDigestsFinder expects.
  const unique = [...new Set(digests)]
  if (!unique.every((digest) => typeof digest === "string" && hexDigest.test(digest))) {
    return json(400, { error: "every digest must be 64 lowercase hex characters" })
  }
  if (unique.length === 0) return json(200, { missing: [] })
  const present = await contentStore.presentDigests(unique)
  if (!(present instanceof Set)) throw new Error("content store returned an invalid digest set")
  const requested = new Set(unique)
  for (const digest of present) {
    if (typeof digest !== "string" || !requested.has(digest)) {
      throw new Error("content store returned a digest outside the request")
    }
  }
  return json(200, { missing: unique.filter((digest) => !present.has(digest)) })
}

/** The shapes a diagnostic tag may have. Anything else is dropped, not truncated. */
const diagnosticName = /^[A-Za-z][A-Za-z0-9_$]{0,39}$/
const diagnosticCode = /^[A-Za-z0-9_.-]{1,32}$/

/**
 * Reads one allowlisted field off a failure, or nothing.
 *
 * The read is guarded because a hostile or half-constructed error can define
 * the field as a throwing getter, and a diagnostic that throws would replace
 * the 503 the client has to receive.
 */
const diagnosticTag = (cause, field, shape) => {
  let current = cause
  let value
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, field)
      if (descriptor !== undefined) {
        if (!("value" in descriptor)) return null
        value = descriptor.value
        break
      }
      current = Object.getPrototypeOf(current)
    } catch {
      return null
    }
  }
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null
  return typeof value === "string" && shape.test(value) ? value : null
}

/**
 * Renders a failure as a diagnostic that cannot carry a secret.
 *
 * Bun, its Postgres client, and the socket layer all attach request-derived
 * material to their errors: the failing statement, its bound parameters, the
 * connection string, and whatever header or body produced the call. Logging
 * the error object, its message, or its stack publishes that material to
 * whatever collects container output, so none of it is read here.
 *
 * What is read is a fixed four-field allowlist, each value admitted only if it
 * already has the shape of an identifier or a SQLSTATE. `message`, `stack`,
 * `query`, `parameters`, `headers`, `cause`, and every other field are never
 * touched, so no amount of nesting exposes them. An error that carries none of
 * the four is reported as unattributed rather than described.
 *
 * @category utilities
 */
export const describeFailure = (cause) => {
  const kind = typeof cause
  if (kind !== "object" || cause === null) {
    return `smithers build cache: request failed (kind=${cause === null ? "null" : kind})`
  }
  const tags = [
    ["name", diagnosticTag(cause, "name", diagnosticName)],
    ["code", diagnosticTag(cause, "code", diagnosticCode)],
    ["errno", diagnosticTag(cause, "errno", diagnosticCode)],
    ["syscall", diagnosticTag(cause, "syscall", diagnosticCode)]
  ].filter((tag) => tag[1] !== null)
  const attribution = tags.length === 0 ? "unattributed" : tags.map((tag) => `${tag[0]}=${tag[1]}`).join(" ")
  return `smithers build cache: request failed (${attribution})`
}

const serviceMethod = (service, name, what) => {
  if ((typeof service !== "object" || service === null) && typeof service !== "function") {
    throw new TypeError(`${what} must be an object`)
  }
  let current = service
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, name)
    } catch {
      throw new TypeError(`${what}.${name} could not be inspected safely`)
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${what}.${name} must be a data method`)
      }
      const implementation = descriptor.value
      return (...args) => Reflect.apply(implementation, service, args)
    }
    try {
      current = Object.getPrototypeOf(current)
    } catch {
      throw new TypeError(`${what}.${name} could not be inspected safely`)
    }
  }
  throw new TypeError(`${what}.${name} must be a method`)
}

const normalizeDependencies = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("protocol dependencies must be a plain object")
  }
  let prototype
  let keys
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError("protocol dependencies could not be inspected safely")
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("protocol dependencies must be a plain object")
  }
  const allowed = new Set([
    "actionCache",
    "contentStore",
    "health",
    "maxArtifactBytes",
    "readTokenHash",
    "readNamespacePrefix",
    "writeTokenHash"
  ])
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`protocol dependencies contain an unknown property: ${String(key)}`)
    }
  }
  const read = (name) => {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name)
    } catch {
      throw new TypeError(`protocol dependency ${name} could not be inspected safely`)
    }
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`protocol dependency ${name} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const action = read("actionCache")
  const content = read("contentStore")
  const configuredHealth = read("health")
  const health = configuredHealth ?? (async () => true)
  const readTokenHash = read("readTokenHash")
  const readNamespacePrefix = read("readNamespacePrefix") ?? ""
  if (
    typeof readNamespacePrefix !== "string" ||
    (readNamespacePrefix !== "" && !/^[A-Za-z0-9_-]+\/$/.test(readNamespacePrefix))
  ) {
    throw new TypeError("readNamespacePrefix must be one namespace ending in /")
  }
  const writeTokenHash = read("writeTokenHash")
  const maxArtifactBytes = read("maxArtifactBytes")
  if (typeof health !== "function") throw new TypeError("health must be a function")
  for (const [name, hash] of [["readTokenHash", readTokenHash], ["writeTokenHash", writeTokenHash]]) {
    if (hash !== null && (typeof hash !== "string" || !hexDigest.test(hash))) {
      throw new TypeError(`${name} must be a lowercase SHA-256 digest or null`)
    }
  }
  // One credential configured and the other not is a deployment that either
  // grants nobody the direction it forgot, or grants write access to whoever
  // holds the only token there is. Neither is a state to start in.
  if ((readTokenHash === null) !== (writeTokenHash === null)) {
    throw new TypeError("readTokenHash and writeTokenHash must both be digests or both be null")
  }
  // Equal digests are one credential under two names. The classifier below
  // answers `write` for it, so admitting the pair would hand publication to
  // every holder of the nominal read credential.
  if (readTokenHash !== null && readTokenHash === writeTokenHash) {
    throw new TypeError("readTokenHash and writeTokenHash must differ, or the read credential can publish")
  }
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1 || maxArtifactBytes > maxArtifactBodyBytes) {
    throw new TypeError(`maxArtifactBytes must be an integer from 1 through ${maxArtifactBodyBytes}`)
  }
  return Object.freeze({
    actionCache: Object.freeze({
      get: serviceMethod(action, "get", "actionCache"),
      put: serviceMethod(action, "put", "actionCache"),
      delete: serviceMethod(action, "delete", "actionCache")
    }),
    contentStore: Object.freeze({
      get: serviceMethod(content, "get", "contentStore"),
      has: serviceMethod(content, "has", "contentStore"),
      put: serviceMethod(content, "put", "contentStore"),
      presentDigests: serviceMethod(content, "presentDigests", "contentStore")
    }),
    health,
    maxArtifactBytes,
    readTokenHash,
    readNamespacePrefix,
    writeTokenHash
  })
}

/**
 * Creates the request handler for the remote-cache protocol.
 *
 * `readTokenHash` and `writeTokenHash` are the lowercase hex SHA-256 of the two
 * bearer tokens, or both null for the documented unauthenticated development
 * mode. A credential that matches only the read digest may read the cache and
 * never publish to it. `maxArtifactBytes` bounds one `PUT /cas` body.
 *
 * @category constructors
 */
export const createHandler = (dependencies, {
  requestTimeoutMilliseconds = 15_000,
  transferTimeoutMilliseconds = 60_000,
  healthTimeoutMilliseconds = 5_000
} = {}) => {
  const { actionCache, contentStore, health, maxArtifactBytes, readTokenHash, readNamespacePrefix, writeTokenHash } =
    normalizeDependencies(
      dependencies
    )
  const digestBytes = (hash) =>
    hash === null ? null : Uint8Array.from(hash.match(/.{2}/g), (pair) => Number.parseInt(pair, 16))
  const expectedReadTokenHash = digestBytes(readTokenHash)
  const expectedWriteTokenHash = digestBytes(writeTokenHash)
  let activeCacheRequests = 0
  let activeActionCachePublications = 0
  let activeArtifactTransfers = 0
  let activeFindMissingRequests = 0
  let healthInFlight = null
  let lastHealthyAt = Number.NEGATIVE_INFINITY
  const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now()
  const ready = () => {
    const now = monotonicNow()
    if (now >= lastHealthyAt && now - lastHealthyAt < healthCacheMilliseconds) return Promise.resolve()
    if (healthInFlight !== null) return healthInFlight
    const lifetime = requestLifetime(undefined, healthTimeoutMilliseconds)
    let current
    current = Promise.resolve()
      .then(() => waitForAbort(health(lifetime.signal), lifetime.signal))
      .then(() => {
        lastHealthyAt = monotonicNow()
      })
      .finally(() => {
        lifetime.close()
        if (healthInFlight === current) healthInFlight = null
      })
    healthInFlight = current
    return current
  }

  return async (request) => {
    // Set when a response leaves holding both permits until its body ends, so
    // the outer release below does not hand back a slot that is still in use.
    let streaming = false
    let lifetime
    try {
      const url = new URL(request.url)
      const milliseconds = url.pathname === "/healthz" ?
        healthTimeoutMilliseconds
        : url.pathname.startsWith("/cas/") && (request.method === "GET" || request.method === "PUT")
        ? transferTimeoutMilliseconds :
        requestTimeoutMilliseconds
      lifetime = requestLifetime(request.signal, milliseconds)
      request = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: lifetime.signal
      }
      const requestActionCache = requestStorage(actionCache, lifetime.signal)
      const requestContentStore = requestStorage(contentStore, lifetime.signal)
      lifetime.signal.throwIfAborted()
      if (activeCacheRequests >= maxConcurrentCacheRequests) {
        await discardBody(request.body)
        return busy("too many simultaneous cache requests")
      }
      activeCacheRequests += 1
      try {
        // The container healthcheck runs before any token is in play, and a
        // readiness answer reveals no cache state. It still consumes an
        // admission slot so a stalled health dependency cannot accumulate an
        // unbounded number of waiting requests.
        if (url.pathname === "/healthz") {
          if (request.method !== "GET" && request.method !== "HEAD") {
            await discardBody(request.body)
            return methodNotAllowed("GET, HEAD")
          }
          await discardBody(request.body)
          await waitForAbort(ready(), lifetime.signal)
          return request.method === "HEAD" ? empty(200) : json(200, { ok: true })
        }
        const credential = presentedCredential(request, expectedWriteTokenHash, expectedReadTokenHash)
        if (credential === "none") {
          await discardBody(request.body)
          return unauthorized()
        }
        // Authorization is decided by method before the route is even parsed,
        // so a publication presented on the read credential is refused without
        // reading its body. Every route below this line either reads state or
        // probes it; `findMissing` is a POST that mutates nothing, so it is not
        // in the mutating set.
        if ((request.method === "PUT" || request.method === "DELETE") && credential !== "write") {
          await discardBody(request.body)
          return forbidden()
        }
        const segments = url.pathname.split("/")
        if (credential === "read" && readNamespacePrefix !== "" && segments.length === 3 && segments[1] === "cas") {
          await discardBody(request.body)
          return forbidden()
        }
        if (segments.length === 3 && segments[0] === "" && segments[1] === "cas" && segments[2] === "findMissing") {
          if (activeFindMissingRequests >= maxConcurrentFindMissingRequests) {
            await discardBody(request.body)
            return busy("too many simultaneous findMissing requests")
          }
          activeFindMissingRequests += 1
          try {
            return await handleFindMissing(request, requestContentStore)
          } finally {
            activeFindMissingRequests -= 1
          }
        }
        if (segments.length === 3 && segments[0] === "" && segments[1] === "ac") {
          let keyDigest
          try {
            keyDigest = decodeURIComponent(segments[2])
          } catch {
            await discardBody(request.body)
            return json(400, { error: "keyDigest must be valid URL encoding" })
          }
          if (credential === "read" && readNamespacePrefix !== "" && !keyDigest.startsWith(readNamespacePrefix)) {
            await discardBody(request.body)
            return forbidden()
          }
          if (request.method === "PUT") {
            if (activeActionCachePublications >= maxConcurrentActionCachePublications) {
              await discardBody(request.body)
              return busy("too many simultaneous action-cache publications")
            }
            activeActionCachePublications += 1
            try {
              return await handleActionCache(request, keyDigest, url, requestActionCache)
            } finally {
              activeActionCachePublications -= 1
            }
          }
          const response = await handleActionCache(request, keyDigest, url, requestActionCache)
          // A hit streams its stored body after the handler returns, so the
          // request slot has to outlive the return and end with the stream.
          if (request.method !== "GET" || response.status !== 200 || response.body === null) {
            return response
          }
          streaming = true
          let released = false
          return heldWhileStreaming(response, () => {
            if (released) return
            released = true
            activeCacheRequests -= 1
            lifetime.close()
          }, lifetime.signal)
        }
        if (segments.length === 3 && segments[0] === "" && segments[1] === "cas") {
          let digest
          try {
            digest = decodeURIComponent(segments[2])
          } catch {
            await discardBody(request.body)
            return json(400, { error: "digest must be valid URL encoding" })
          }
          if (request.method === "GET" || request.method === "PUT") {
            if (activeArtifactTransfers >= maxConcurrentArtifactTransfers) {
              await discardBody(request.body)
              return busy("too many simultaneous artifact transfers")
            }
            activeArtifactTransfers += 1
            let transferred = false
            try {
              const response = await handleArtifact(request, digest, requestContentStore, maxArtifactBytes)
              // A `PUT` body is buffered inside the slot, so the transfer is
              // over when the handler returns. A `GET` body streams after it,
              // so the slot that bounds artifact transfers has to outlive the
              // return and end with the stream.
              if (request.method !== "GET" || response.status !== 200 || response.body === null) {
                return response
              }
              transferred = true
              streaming = true
              let released = false
              return heldWhileStreaming(response, () => {
                if (released) return
                released = true
                activeArtifactTransfers -= 1
                activeCacheRequests -= 1
                lifetime.close()
              }, lifetime.signal)
            } finally {
              if (!transferred) activeArtifactTransfers -= 1
            }
          }
          return await handleArtifact(request, digest, requestContentStore, maxArtifactBytes)
        }
        await discardBody(request.body)
        return empty(404)
      } finally {
        if (!streaming) activeCacheRequests -= 1
      }
    } catch (cause) {
      // A failure here is the tier refusing, which the client treats as
      // retryable and never as a miss. Saying so with a 503 keeps that
      // distinction intact. Only the allowlisted attribution is logged: the cause
      // itself may embed the connection string, the statement, its parameters, or
      // the request that produced it, and the request carries the bearer token.
      console.error(describeFailure(cause))
      return json(503, { error: "the cache tier failed to answer" })
    } finally {
      if (!streaming) lifetime?.close()
    }
  }
}
