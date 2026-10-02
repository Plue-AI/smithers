import { ERROR_REFERENCE_URL } from "@smthrs/errors/ErrorCode"
import { SmithersError } from "@smthrs/errors/SmithersError"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  fromIntegrationError,
  IntegrationFailure,
  MAX_MESSAGE_LENGTH,
  toIntegrationError
} from "../src/core/ActionFailure.ts"
import { buildAuthorizationUrl } from "../src/core/AuthorizationUrl.ts"
import * as ExternalEvent from "../src/core/ExternalEvent.ts"
import {
  IntegrationError,
  isIntegrationError,
  isRetryable,
  toInvalidInput,
  toUnauthorized
} from "../src/core/IntegrationError.ts"
import { readInteger, readJsonPath, readString } from "../src/core/JsonPath.ts"
import { createCodeVerifier, createPkcePair, deriveCodeChallenge } from "../src/core/Pkce.ts"
import * as SignalName from "../src/core/SignalName.ts"
import * as Environment from "../src/Environment.ts"
import * as GitHubConfig from "../src/github/Config.ts"

describe("readJsonPath", () => {
  const payload = { repository: { full_name: "smithersai/smithers" }, issue: { number: 12 }, list: [1, 2] }

  it("reads a dot path", () => {
    expect(readJsonPath(payload, "repository.full_name")).toBe("smithersai/smithers")
    expect(readString(payload, "repository.full_name")).toBe("smithersai/smithers")
    expect(readInteger(payload, "issue.number")).toBe(12)
  })

  it("returns the value itself for an empty path", () => {
    expect(readJsonPath(payload)).toBe(payload)
    expect(readJsonPath(payload, "")).toBe(payload)
    expect(readJsonPath(payload, null)).toBe(payload)
  })

  it("returns undefined when a segment is missing or lands on a non-record", () => {
    expect(readJsonPath(payload, "repository.missing")).toBeUndefined()
    expect(readJsonPath(payload, "repository.full_name.deeper")).toBeUndefined()
    expect(readJsonPath(payload, "list.0")).toBeUndefined()
    expect(readJsonPath(null, "a")).toBeUndefined()
  })

  // A provider that sends the key with no value is saying the same thing as a
  // provider that omits it, and the walk stops either way rather than trying
  // to read a segment off `undefined`.
  it("treats an own property whose value is undefined as missing", () => {
    expect(readJsonPath({ issue: undefined }, "issue")).toBeUndefined()
    expect(readJsonPath({ issue: undefined }, "issue.number")).toBeUndefined()
  })

  // The getter reads attacker-supplied provider payloads at caller-chosen
  // paths, and its contract says a missing segment reads as `undefined`. An
  // inherited member is missing.
  it("reads own properties only, so a prototype member is not data", () => {
    expect(readJsonPath({}, "constructor")).toBeUndefined()
    expect(readJsonPath({}, "toString")).toBeUndefined()
    expect(readJsonPath({}, "__proto__.constructor")).toBeUndefined()
    expect(readJsonPath({ a: {} }, "a.hasOwnProperty")).toBeUndefined()
  })

  // `JSON.parse` produces `__proto__` as an ordinary own key, and a webhook
  // body can contain one. That is data and stays readable.
  it("still reads an own __proto__ key a JSON body carried", () => {
    expect(readJsonPath(JSON.parse("{\"__proto__\":{\"a\":1}}"), "__proto__.a")).toBe(1)
  })

  it("rejects a value of the wrong type", () => {
    expect(readString(payload, "issue.number")).toBeUndefined()
    expect(readString({ a: "" }, "a")).toBeUndefined()
    expect(readInteger(payload, "repository.full_name")).toBeUndefined()
    expect(readInteger({ a: 1.5 }, "a")).toBeUndefined()
  })
})

describe("IntegrationError", () => {
  it("routes each adapter failure to its own catchTag handler", () => {
    const recover = (error: IntegrationError | SmithersError<"SmithersError">) =>
      Effect.fail(error).pipe(
        Effect.catchTag("IntegrationError", (caught) => Effect.succeed(`integration:${caught.reason}`)),
        Effect.catchTag("SmithersError", (caught) => Effect.succeed(`base:${caught.code}`))
      )
    expect(Effect.runSync(recover(new IntegrationError("poll-failed", "getUpdates failed")))).toBe(
      "integration:poll-failed"
    )
    expect(Effect.runSync(recover(new SmithersError<"SmithersError">("UNSUPPORTED", "no Ed25519")))).toBe(
      "base:UNSUPPORTED"
    )
  })

  it("carries a reason and provider-safe details", () => {
    const error = new IntegrationError("poll-failed", "getUpdates failed", { sourceId: "telegram" })
    expect(error.reason).toBe("poll-failed")
    expect(error.code).toBe("INTEGRATION_ERROR")
    expect(error.details).toEqual({ reason: "poll-failed", sourceId: "telegram" })
    expect(isIntegrationError(error)).toBe(true)
  })

  it("recognizes an error that crossed a module boundary by name and shape", () => {
    const foreign = Object.assign(new Error("copy"), {
      name: "IntegrationError",
      code: "INTEGRATION_ERROR",
      summary: "copy",
      docsUrl: ERROR_REFERENCE_URL,
      reason: "poll-failed"
    })
    expect(isIntegrationError(foreign)).toBe(true)
    expect(isIntegrationError(new Error("plain"))).toBe(false)
  })

  // The name alone is forgeable, and a copy of this module whose reason list
  // has drifted carries a reason the local schema cannot encode. Trusting
  // either made `fromIntegrationError` throw inside `Effect.mapError`, which
  // turns a typed action failure into a defect.
  it("refuses an error that only claims the name", () => {
    expect(isIntegrationError(Object.assign(new Error("boom"), { name: "IntegrationError" }))).toBe(false)
    expect(isIntegrationError(Object.assign(new Error("boom"), {
      name: "IntegrationError",
      code: "INTEGRATION_ERROR",
      summary: "boom",
      docsUrl: ERROR_REFERENCE_URL,
      reason: "invented-in-a-newer-build"
    }))).toBe(false)
    expect(isIntegrationError(Object.assign(new Error("boom"), {
      name: "IntegrationError",
      code: "INVALID_INPUT",
      summary: "boom",
      docsUrl: ERROR_REFERENCE_URL,
      reason: "poll-failed"
    }))).toBe(false)
  })

  it("marks only the failures the clients tagged retryable", () => {
    expect(isRetryable(new IntegrationError("delivery-failed", "429", { retryable: true }))).toBe(true)
    expect(isRetryable(new IntegrationError("delivery-failed", "404", { retryable: false }))).toBe(false)
    expect(isRetryable(new Error("plain"))).toBe(false)
  })

  it("maps onto the control plane without leaking details", () => {
    const error = new IntegrationError("invalid-signature", "github webhook signature did not verify.", {
      digest: "expected"
    })
    const unauthorized = toUnauthorized(error)
    expect(unauthorized.message).toBe("github webhook signature did not verify.")
    expect(JSON.stringify(unauthorized)).not.toContain("expected")
    expect(toInvalidInput(error).issue).toBe("github webhook signature did not verify.")
  })
})

describe("SignalName", () => {
  it("builds names in the reserved namespace", () => {
    expect(SignalName.eventName("github", "pull_request.opened")).toBe("integration:github:pull_request.opened")
    expect(SignalName.receivedBy("telegram")).toBe("integration:telegram")
  })

  it("trims segments and refuses empty or colon-bearing ones", () => {
    expect(SignalName.eventName(" github ", " push ")).toBe("integration:github:push")
    expect(() => SignalName.eventName("", "push")).toThrow(/service must be a non-empty string/)
    expect(() => SignalName.eventName("github", "  ")).toThrow(/event must be a non-empty string/)
    expect(() => SignalName.eventName("git:hub", "push")).toThrow(/must not contain/)
    expect(() => SignalName.eventName("github", "pu:sh")).toThrow(/must not contain/)
    expect(() => SignalName.receivedBy("")).toThrow(/non-empty/)
  })

  // `eventName` is reachable from JavaScript, where the parameter type is not
  // enforced. Reading `.trim()` off a number would raise a bare `TypeError`
  // naming a property, which tells the caller nothing about which argument was
  // wrong; the documented `INVALID_INPUT` does.
  it("reports a non-string segment as invalid input rather than a TypeError", () => {
    expect(() => SignalName.eventName(7 as never, "push")).toThrow(/service must be a non-empty string/)
    expect(() => SignalName.eventName("github", null as never)).toThrow(/event must be a non-empty string/)
    expect(() => SignalName.receivedBy(undefined as never)).toThrow(/service must be a non-empty string/)
  })

  it("round-trips a name", () => {
    const name = SignalName.eventName("linear", "issue.update")
    expect(SignalName.isIntegrationSignalName(name)).toBe(true)
    expect(SignalName.parse(name)).toEqual({ service: "linear", event: "issue.update" })
  })

  it("refuses to parse anything outside the namespace or malformed", () => {
    expect(SignalName.isIntegrationSignalName("my-signal")).toBe(false)
    expect(SignalName.isIntegrationSignalName(7)).toBe(false)
    expect(SignalName.parse("my-signal")).toBeNull()
    expect(SignalName.parse("integration::event")).toBeNull()
    expect(SignalName.parse("integration:service:")).toBeNull()
  })

  // The parser used to accept names the constructor refuses to build, which
  // let a routing identity into persistence that nothing could reproduce.
  it("refuses a name the constructor could not have produced", () => {
    expect(() => SignalName.eventName("github", "a:b")).toThrow(/must not contain/)
    expect(SignalName.parse("integration:github:a:b")).toBeNull()
    expect(SignalName.parse("integration: gh :ev")).toBeNull()
    expect(SignalName.parse("integration:gh: ev ")).toBeNull()
    expect(SignalName.isSegment("gh")).toBe(true)
    expect(SignalName.isSegment(" gh")).toBe(false)
    expect(SignalName.isSegment("")).toBe(false)
  })
})

const event: ExternalEvent.ExternalEvent = {
  source: "github",
  eventName: "integration:github:issues.opened",
  correlationId: "smithersai/smithers#12",
  payload: { action: "opened" },
  dedupeKey: "delivery-1",
  receivedAtMs: 1_700_000_000_000
}

describe("ExternalEvent", () => {
  it("decodes a well-formed event", async () => {
    expect(await Effect.runPromise(ExternalEvent.decode(event))).toEqual(event)
  })

  it("refuses an event a decoder bug produced", async () => {
    const exit = await Effect.runPromise(Effect.exit(ExternalEvent.decode({ ...event, dedupeKey: "" })))
    expect(exit._tag).toBe("Failure")
  })
})

describe("SignalName conversions", () => {
  it("becomes a control-plane signal", () => {
    expect(SignalName.toSignalPayload(event)).toEqual({
      name: "integration:github:issues.opened",
      payload: { action: "opened" }
    })
  })

  it("becomes a queued system-event notification that coalesces per subject", () => {
    const provenance = {
      sourceRunId: "run-1",
      sourceLineageId: "lineage-1",
      sourceTurn: 0,
      sourceActor: "integration:github"
    }
    const notification = SignalName.toNotification(event, { targetLineageId: "lineage-1", provenance })
    expect(notification._tag).toBe("system-event")
    // Machine events queue: they reach the model when the run would idle,
    // rather than interrupting the turn in flight.
    expect(notification.delivery).toBe("queue")
    expect(notification.id).toBe("delivery-1")
    expect(notification).toHaveProperty("coalescingKey", "integration:github:issues.opened:smithersai/smithers#12")
  })

  it("coalesces an uncorrelated event under an empty subject and takes an explicit id", () => {
    const provenance = {
      sourceRunId: "run-1",
      sourceLineageId: "lineage-1",
      sourceTurn: 0,
      sourceActor: "integration:github"
    }
    const notification = SignalName.toNotification({ ...event, correlationId: null }, {
      id: "explicit",
      targetLineageId: "lineage-1",
      provenance
    })
    expect(notification.id).toBe("explicit")
    expect(notification).toHaveProperty("coalescingKey", "integration:github:issues.opened:")
  })
})

describe("PKCE", () => {
  const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
  const BASE64URL = /^[A-Za-z0-9\-_]+$/

  it("draws a 43-character verifier by default", () => {
    const verifier = createCodeVerifier()
    expect(verifier).toHaveLength(43)
    expect(verifier).toMatch(VERIFIER)
  })

  it("enforces the byte-length bounds", () => {
    expect(createCodeVerifier(32)).toHaveLength(43)
    expect(createCodeVerifier(96)).toHaveLength(128)
    expect(() => createCodeVerifier(31)).toThrow(/32\.\.96/)
    expect(() => createCodeVerifier(97)).toThrow(/32\.\.96/)
    expect(() => createCodeVerifier(32.5)).toThrow(/integer/)
  })

  it("matches RFC 7636 Appendix B", () => {
    expect(deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  it("derives an unpadded base64url challenge", () => {
    const challenge = deriveCodeChallenge(createCodeVerifier())
    expect(challenge).toHaveLength(43)
    expect(challenge).toMatch(BASE64URL)
    expect(challenge).not.toContain("=")
  })

  it("validates the verifier length and character set", () => {
    expect(() => deriveCodeChallenge("a".repeat(42))).toThrow(/43\.\.128/)
    expect(() => deriveCodeChallenge("a".repeat(129))).toThrow(/43\.\.128/)
    expect(() => deriveCodeChallenge(`${"a".repeat(42)}!`)).toThrow(/unreserved/)
    expect(() => deriveCodeChallenge(7 as unknown as string)).toThrow(/must be a string/)
    expect(deriveCodeChallenge(`${"a".repeat(41)}.~`)).toMatch(BASE64URL)
    expect(deriveCodeChallenge("a".repeat(128))).toMatch(BASE64URL)
  })

  it("returns a consistent S256 pair", () => {
    const pair = createPkcePair(96)
    expect(pair.codeChallengeMethod).toBe("S256")
    expect(pair.codeVerifier).toHaveLength(128)
    expect(pair.codeChallenge).toBe(deriveCodeChallenge(pair.codeVerifier))
  })
})

describe("buildAuthorizationUrl", () => {
  const BASE = {
    authorizationEndpoint: "https://provider.example/oauth/authorize",
    clientId: "smithers-client",
    redirectUri: "https://app.example/oauth/callback",
    state: "state-123",
    codeChallenge: "challenge-123"
  }

  it("builds an authorization-code URL with PKCE parameters", () => {
    const url = new URL(buildAuthorizationUrl(BASE))
    expect(url.origin).toBe("https://provider.example")
    expect(url.pathname).toBe("/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe(BASE.clientId)
    expect(url.searchParams.get("redirect_uri")).toBe(BASE.redirectUri)
    expect(url.searchParams.get("state")).toBe(BASE.state)
    expect(url.searchParams.get("code_challenge")).toBe(BASE.codeChallenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })

  it("space-joins array scopes and uses string scopes verbatim", () => {
    expect(new URL(buildAuthorizationUrl({ ...BASE, scope: ["openid", "profile"] })).searchParams.get("scope"))
      .toBe("openid profile")
    expect(new URL(buildAuthorizationUrl({ ...BASE, scope: "openid offline_access" })).searchParams.get("scope"))
      .toBe("openid offline_access")
  })

  it("omits an absent or empty scope", () => {
    expect(new URL(buildAuthorizationUrl(BASE)).searchParams.has("scope")).toBe(false)
    expect(new URL(buildAuthorizationUrl({ ...BASE, scope: "" })).searchParams.has("scope")).toBe(false)
    expect(new URL(buildAuthorizationUrl({ ...BASE, scope: [] })).searchParams.has("scope")).toBe(false)
  })

  it("honors an explicit plain challenge method", () => {
    expect(
      new URL(buildAuthorizationUrl({ ...BASE, codeChallengeMethod: "plain" })).searchParams
        .get("code_challenge_method")
    ).toBe("plain")
  })

  it("preserves endpoint query parameters and applies extras last", () => {
    const url = new URL(buildAuthorizationUrl({
      ...BASE,
      authorizationEndpoint: "https://login.example/tenant/authorize?tenant=acme&prompt=consent",
      extraParams: { audience: "https://api.example", response_type: "custom-code" }
    }))
    expect(url.searchParams.get("tenant")).toBe("acme")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("audience")).toBe("https://api.example")
    // `response_type` is the one override the parameter exists for.
    expect(url.searchParams.get("response_type")).toBe("custom-code")
    expect(url.searchParams.get("redirect_uri")).toBe(BASE.redirectUri)
  })

  // `extraParams` used to be able to replace `state`, `code_challenge`, and
  // its method, which disables exactly the CSRF and PKCE protections the
  // validation above exists to guarantee.
  // Keep these cases independent of the implementation's reserved list so
  // removing a protected name cannot silently remove its rejection test.
  it.each(["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"])(
    "refuses an extra parameter overriding %s",
    (key) => {
      expect(() => buildAuthorizationUrl({ ...BASE, extraParams: { [key]: "attacker" } }))
        .toThrow(new RegExp(`reserved parameter "${key}"`))
    }
  )

  it("preserves the validated bindings with a permitted extra parameter", () => {
    const url = new URL(buildAuthorizationUrl({ ...BASE, extraParams: { audience: "a" } }))
    expect(url.searchParams.get("state")).toBe(BASE.state)
    expect(url.searchParams.get("code_challenge")).toBe(BASE.codeChallenge)
  })

  it("takes the challenge a PKCE pair produced", () => {
    const pair = createPkcePair()
    expect(new URL(buildAuthorizationUrl({ ...BASE, codeChallenge: pair.codeChallenge })).searchParams
      .get("code_challenge")).toBe(pair.codeChallenge)
  })

  it("refuses a relative or non-http endpoint", () => {
    for (
      const authorizationEndpoint of [
        "/oauth/authorize",
        "provider.example/oauth/authorize",
        "ftp://provider.example/oauth/authorize",
        "mailto:admin@example.com"
      ]
    ) {
      expect(() => buildAuthorizationUrl({ ...BASE, authorizationEndpoint })).toThrow(TypeError)
    }
    expect(() => buildAuthorizationUrl({ ...BASE, authorizationEndpoint: 7 as unknown as string })).toThrow(TypeError)
  })

  it("refuses an empty required field", () => {
    for (const field of ["clientId", "redirectUri", "state", "codeChallenge"] as const) {
      expect(() => buildAuthorizationUrl({ ...BASE, [field]: "" })).toThrow(TypeError)
    }
  })
})

describe("ActionFailure conversion is total", () => {
  // The guard used to trust a bare `name`, and `Schema.TaggedError` validates
  // at construction, so `Effect.mapError(fromIntegrationError)` threw and the
  // typed action failure became a defect.
  it("converts a forged IntegrationError to an unclassified failure instead of throwing", () => {
    const forged = Object.assign(new Error("boom"), { name: "IntegrationError" })
    expect(fromIntegrationError(forged)).toMatchObject({ reason: "delivery-failed", retryable: false })
    const drifted = Object.assign(new Error("boom"), {
      name: "IntegrationError",
      summary: "boom",
      reason: "a-reason-this-build-cannot-encode"
    })
    expect(fromIntegrationError(drifted)).toMatchObject({ reason: "delivery-failed", message: "boom" })
  })

  // `SmithersError.message` carries " See https://…" and `summary` does not,
  // so reading `message` made one provider's failures look different from the
  // others' for no reason.
  it("journals the summary of a SmithersError, not its documentation URL", () => {
    const failure = fromIntegrationError(new SmithersError("INVALID_INPUT", "chat not found"))
    expect(failure.message).toBe("chat not found")
    expect(failure.message).not.toContain("smithers.sh/reference/errors")
  })

  it("prefers the summary of any error that carries one", () => {
    // Not only a `SmithersError`: an error from another module instance with
    // the same shape journals the same way.
    const foreign = Object.assign(new Error("message with a docs URL"), { summary: "just the summary" })
    expect(fromIntegrationError(foreign).message).toBe("just the summary")
  })

  // Carrying the field is not the same as carrying a string in it. A forged or
  // drifted error whose `summary` is a number would put that value straight
  // into a `Schema.String` journal column, so the shape has to be checked
  // rather than the field's presence.
  it("falls back to the message when the summary is not a string", () => {
    const wrongType = Object.assign(new Error("boom"), { summary: 42 })
    expect(fromIntegrationError(wrongType).message).toBe("boom")
    expect(fromIntegrationError({ summary: null })).toMatchObject({ message: "[object Object]" })
  })

  // The name branch rejects a reason this build cannot encode, but `instanceof`
  // returned early and trusted it. `reason` is only typed, never validated, so
  // a JavaScript caller or a widened cast produced a real `IntegrationError`
  // that `IntegrationFailure`'s `Schema.Literals` then refused at construction
  // — a throw inside `Effect.mapError`, which is a defect the caller's
  // `catchAll` never sees.
  it("converts a real IntegrationError carrying an unencodable reason", () => {
    const invented = new IntegrationError("invented" as never, "boom")
    expect(isIntegrationError(invented)).toBe(false)
    expect(fromIntegrationError(invented)).toMatchObject({
      reason: "delivery-failed",
      message: "boom",
      retryable: false
    })
  })

  // `String(value)` is not total. A null-prototype object has no `toString`,
  // and a `summary` getter runs caller code. Either one threw where the
  // conversion promises it classifies.
  it("classifies a value that cannot be stringified", () => {
    expect(() => fromIntegrationError(Object.create(null))).not.toThrow()
    expect(fromIntegrationError(Object.create(null))).toMatchObject({ reason: "delivery-failed" })
    const throwingSummary = Object.defineProperty({}, "summary", {
      get: () => {
        throw new Error("getter")
      }
    })
    expect(() => fromIntegrationError(throwingSummary)).not.toThrow()
    expect(fromIntegrationError(throwingSummary).reason).toBe("delivery-failed")
    const throwingToString = {
      toString: () => {
        throw new Error("toString")
      }
    }
    expect(fromIntegrationError(throwingToString).reason).toBe("delivery-failed")
  })

  it("classifies Error subclasses whose integration-shape getters throw", () => {
    class ThrowingGetterError extends Error {}

    for (const property of ["name", "code", "summary", "details"] as const) {
      const hostile = Object.assign(new ThrowingGetterError("boom"), {
        name: "IntegrationError",
        code: "INTEGRATION_ERROR",
        summary: "boom",
        docsUrl: ERROR_REFERENCE_URL,
        reason: "delivery-failed",
        details: { retryable: true }
      })
      Object.defineProperty(hostile, property, {
        configurable: true,
        get: () => {
          throw new Error(`${property} getter`)
        }
      })
      expect(() => fromIntegrationError(hostile), property).not.toThrow()
      expect(fromIntegrationError(hostile), property).toMatchObject({
        reason: "delivery-failed",
        retryable: false
      })
    }
  })

  it("takes the unclassified branch when a validated field throws on the conversion read", () => {
    for (const property of ["summary", "details"] as const) {
      const hostile = new IntegrationError("delivery-failed", "boom", { retryable: true })
      let reads = 0
      Object.defineProperty(hostile, property, {
        configurable: true,
        get: () => {
          reads += 1
          if (reads === 1) return property === "summary" ? "boom" : { retryable: true }
          throw new Error(`${property} getter`)
        }
      })
      expect(fromIntegrationError(hostile), property).toMatchObject({
        reason: "delivery-failed",
        retryable: false
      })
    }
  })

  it("takes the unclassified branch when a validated summary changes type", () => {
    const hostile = new IntegrationError("delivery-failed", "boom", { retryable: true })
    let reads = 0
    Object.defineProperty(hostile, "summary", {
      configurable: true,
      get: () => reads++ === 0 ? "boom" : 42
    })
    expect(fromIntegrationError(hostile)).toMatchObject({
      reason: "delivery-failed",
      retryable: false
    })
  })

  // `Error.message` is writable, so an error built by a JavaScript caller or by
  // another module instance can carry a non-string in it. Passing that value
  // through would hand a `Schema.String` journal column something it refuses,
  // which is the throw inside `Effect.mapError` this conversion exists to
  // avoid.
  it("classifies an Error whose message is not a string", () => {
    const wrongType = Object.assign(new Error("ignored"), { message: 42 })
    const failure = fromIntegrationError(wrongType)
    expect(failure.reason).toBe("delivery-failed")
    expect(typeof failure.message).toBe("string")
    expect(failure.message).toBe("an integration failure that cannot be described")
  })

  it("caps the provider text it persists", () => {
    const failure = fromIntegrationError(new Error("x".repeat(5000)))
    expect(failure.message.length).toBe(MAX_MESSAGE_LENGTH)
    expect(failure.message.endsWith("…")).toBe(true)
  })

  it("still reports a value that is not an Error", () => {
    expect(fromIntegrationError("not an error")).toMatchObject({ message: "not an error" })
  })

  // `deliveredMessageIds` is read off an arbitrary error's details, and
  // `Schema.Number` encodes a non-finite member as the string "NaN". A journal
  // row that claims a message id of NaN is worse than one that claims none, so
  // a list that is not entirely message ids is dropped rather than persisted.
  it("journals delivered ids only when every member is one", () => {
    const withIds = (deliveredMessageIds: unknown) =>
      fromIntegrationError(
        new IntegrationError("delivery-failed", "boom", { deliveredMessageIds })
      ).deliveredMessageIds
    expect(withIds([7, 8])).toEqual([7, 8])
    expect(withIds([])).toBeUndefined()
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, "9", null]) {
      expect(withIds([7, bad])).toBeUndefined()
    }
    expect(withIds("7,8")).toBeUndefined()
  })

  // The converter filters, but a journal row is data on disk that a later
  // process decodes. A corrupt or hand-edited row must fail to decode rather
  // than hand a caller a "message id" of NaN under the field's documented type.
  it("refuses to decode a persisted row whose delivered ids are not message ids", async () => {
    const row = (deliveredMessageIds: unknown) => ({
      _tag: "/integrations/IntegrationFailure",
      reason: "delivery-failed",
      message: "x",
      retryable: false,
      deliveredMessageIds
    })
    const decode = (value: unknown) =>
      Effect.runPromise(
        Effect.exit(Schema.decodeUnknownEffect(IntegrationFailure)(value) as Effect.Effect<unknown, unknown>)
      )
    expect((await decode(row([7, 8])))._tag).toBe("Success")
    for (const bad of [[-1], [0], [1.5], ["NaN"], ["7"]]) {
      expect((await decode(row(bad)))._tag).toBe("Failure")
    }
  })

  // The round trip has to survive the journal: an action reads its own failure
  // back after a restart and hands it to a caller as the class again.
  it("carries an ambiguous outcome and the delivered ids back out of the schema", () => {
    const failure = fromIntegrationError(
      new IntegrationError("delivery-failed", "boom", { outcomeUnknown: true, deliveredMessageIds: [7] })
    )
    expect(failure.outcomeUnknown).toBe(true)
    const back = toIntegrationError(failure)
    expect(back.details).toMatchObject({ outcomeUnknown: true, deliveredMessageIds: [7] })
    // A failure with neither detail leaves both off rather than writing nulls.
    expect(toIntegrationError(fromIntegrationError(new Error("boom"))).details)
      .not.toHaveProperty("outcomeUnknown")
  })
})

describe("Environment", () => {
  // Both ambient reads are spelled once, in this module, rather than appearing
  // as a bare `process.env` or `process.cwd()` in the middle of an API that
  // takes its environment as an argument. What has to hold is that omitting
  // the argument really does reach the host.
  it("is what a client omitting its env argument reads", () => {
    const previous = process.env["SMITHERS_GITHUB_TOKEN"]
    process.env["SMITHERS_GITHUB_TOKEN"] = "ambient-for-this-test"
    try {
      expect(GitHubConfig.resolve({}).token).toBe("ambient-for-this-test")
      expect(GitHubConfig.resolve({}, {}).token).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env["SMITHERS_GITHUB_TOKEN"]
      else process.env["SMITHERS_GITHUB_TOKEN"] = previous
    }
  })
})

describe("ExternalEvent names are the ones SignalName can build", () => {
  // A name that reaches persistence but that nothing can rebuild is a routing
  // identity with no owner, and the ingress validation would have waved it
  // through while `SignalName.parse` returned null for it.
  it("refuses a name the constructor could not have produced", async () => {
    for (const eventName of ["integration:github:a:b", "integration:github:", "integration::x", "github.issues"]) {
      const exit = await Effect.runPromise(Effect.exit(ExternalEvent.decode({ ...event, eventName })))
      expect(exit._tag).toBe("Failure")
    }
  })

  it("still accepts every name the providers build", async () => {
    for (
      const eventName of [
        SignalName.eventName("github", "pull_request.opened"),
        SignalName.eventName("linear", "issue.update"),
        SignalName.eventName("telegram", "callback_query")
      ]
    ) {
      const exit = await Effect.runPromise(Effect.exit(ExternalEvent.decode({ ...event, eventName })))
      expect(exit._tag).toBe("Success")
    }
    expect(SignalName.isEventName("integration:github:issues")).toBe(true)
    expect(SignalName.isEventName("integration:github:a:b")).toBe(false)
  })
})
