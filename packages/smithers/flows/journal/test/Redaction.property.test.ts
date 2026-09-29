import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import * as Redaction from "../src/Redaction.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

/**
 * Strings biased toward the credential shapes the default rules match, so the
 * properties actually exercise rule interactions instead of skating over
 * text no rule fires on. Fragments deliberately include rule outputs
 * ("[REDACTED_API_KEY]", "Bearer [REDACTED_TOKEN]") so a second application
 * meets first-application results.
 */
const credentialFragment = FastCheck.constantFrom(
  "sk-",
  "pk_",
  "sk_live_",
  "ghp_",
  "github_pat_",
  "AKIA",
  "xoxb-",
  "AIza",
  "postgres://admin:",
  "@db.internal/app",
  "Bearer ",
  "bearer\t",
  "BEARER  ",
  "token=",
  "TOKEN=",
  "api_key=",
  "api-key=",
  "apikey",
  "password=",
  "secret=",
  "authorization",
  "abcdefgh0123",
  "aB3",
  "_",
  "-",
  ".",
  "=",
  " ",
  "'",
  "\"",
  "[REDACTED]",
  "[REDACTED_API_KEY]",
  "Bearer [REDACTED_TOKEN]",
  "\n",
  "x-api-key",
  "ANTHROPIC_API_KEY=shhh",
  // util.inspect and argv spellings: each opens a value the grammar reads
  // across quotes, lines, containers or argv elements.
  "`",
  "\\\"",
  " +\n  '",
  "<ref *1> ",
  "<Buffer 73 6b>",
  "{ ",
  " }",
  "[ ",
  " ]",
  "Uint8Array(2) ",
  "private key: ",
  "API key = ",
  "key=",
  "--password ",
  "\", \"",
  "-p ",
  "-p",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----END RSA PRIVATE KEY-----",
  "Authorization: Token ",
  "https://tok@host/",
  "?sig="
)

const credentialText = FastCheck.array(credentialFragment, { maxLength: 12 }).map((parts) => parts.join(""))

const hostileString = FastCheck.oneof(
  FastCheck.string({ unit: "grapheme" }),
  FastCheck.string({ unit: "binary" }),
  credentialText
)

const toJsonBearingValue = FastCheck.tuple(
  FastCheck.jsonValue({ stringUnit: hostileString }),
  FastCheck.constantFrom("own", "prototype", "nested")
).map(([json, shape]) => {
  if (shape === "own") return { ignored: true, toJSON: () => json }
  const prototype = { toJSON: () => json }
  const value = Object.assign(Object.create(prototype) as Record<string, unknown>, { ignored: true })
  return shape === "prototype" ? value : { nested: value }
})

/**
 * Inputs fuzzing once found to break a property, kept so every run replays
 * them whatever the seed.
 */
const diagnosticCounterexamples: ReadonlyArray<string> = []

describe("Redaction properties", () => {
  it("redacting a string twice yields the first result", () => {
    // Idempotence: one pass must reach a fixed point, or a payload that is
    // exported and re-imported through the journal would keep mutating.
    FastCheck.assert(
      FastCheck.property(hostileString, (text) => {
        const once = Redaction.redact(text)
        expect(Redaction.redact(once)).toBe(once)
      }),
      {
        ...params,
        examples: [
          ["token=abc def"],
          ["Bearer sk_abcdefghij"],
          ["sk-aaaaaaaatoken=abc"],
          ["token=sk_abcdefghij"],
          ["Bearer tokenabcd=efgh"],
          ["api_key=x=y"],
          ["TOKEN='dummy secret'"],
          ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
          ["github_pat_11ABCDEFG0abcdefghijklmnop"],
          ["AKIAIOSFODNN7EXAMPLE"],
          ["xoxb-123456789012-123456789012-abcdefghijkl"],
          ["AIzaSyA1234567890abcdefghijklmnopqrstuvw"],
          ["postgres://admin:hunter2@db.internal/app"],
          [`log line: {"apiToken":"abcd1234efgh5678"}`],
          // Fuzz counterexample: a key block inside URL userinfo, once
          // replaced, turned into userinfo the URL rule rewrote on pass two.
          ["postgres://admin:sk------BEGIN RSA PRIVATE KEY----------END RSA PRIVATE KEY-----@db.internal/app"],
          // Fuzz counterexamples: an assignment value with a space, redacted
          // inside URL userinfo, left userinfo the URL rule matched on pass two.
          ["postgres://admin:key=\", \"@db.internal/app"],
          ["postgres://admin:TOKEN=<Buffer 73 6b>@db.internal/app"]
        ]
      }
    )
  })

  it("diagnostic redaction of a string twice yields the first result", () => {
    FastCheck.assert(
      FastCheck.property(hostileString, (text) => {
        const once = Redaction.redactDiagnostic(text)
        expect(Redaction.redactDiagnostic(once)).toBe(once)
      }),
      { ...params, examples: diagnosticCounterexamples.map((text) => [text] as [string]) }
    )
  })

  it("redaction is a fixed point after one application over hostile payloads", () => {
    // Structural idempotence: sensitive members already replaced by the
    // placeholder stay replaced, and every rewritten string leaf is stable.
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue({ stringUnit: hostileString }), (value) => {
        const once = Redaction.redact(value)
        expect(Redaction.redact(once)).toStrictEqual(once)
      }),
      {
        ...params,
        examples: [
          [{ apiKey: "sk-abcdefghij", nested: { token: 1, note: "Bearer abcdefghij" } }],
          // A literal `__proto__` member: rebuilding the object by assignment
          // moved it onto the prototype, so the second pass saw a different
          // object than the first produced.
          [{ ["__proto__"]: null }]
        ]
      }
    )
  })

  it("matches a JSON round trip for values carrying toJSON", () => {
    FastCheck.assert(
      FastCheck.property(toJsonBearingValue, (value) => {
        const encoded = JSON.stringify(value)
        const reparsed = JSON.parse(encoded) as unknown
        expect(JSON.stringify(Redaction.redact(value))).toBe(JSON.stringify(Redaction.redact(reparsed)))
      }),
      { ...params }
    )
  })

  it("a shared custom rule set carries no state between calls", () => {
    // Every rule holds a `g`-flagged RegExp with a mutable `lastIndex`. A
    // redactor built over one shared rule set must give each call the result
    // a fresh rule set would give, in any call order, and must leave the
    // shared patterns rewound.
    const makeRules = (): ReadonlyArray<Redaction.Rule> => [
      { id: "wide", pattern: /token-[a-z0-9]+/g, replace: "[WIDE]" },
      { id: "narrow", pattern: /[a-z0-9]{6,}/g, replace: "[NARROW]" }
    ]
    const sharedRules = makeRules()
    const shared = Redaction.make({ rules: sharedRules })
    const fragment = FastCheck.constantFrom("token-", "abc123", "zzzzzz", " ", "'", "A", "-", "token")
    const text = FastCheck.array(fragment, { maxLength: 10 }).map((parts) => parts.join(""))
    FastCheck.assert(
      FastCheck.property(text, text, (first, second) => {
        const firstExpected = Redaction.redact(first, { rules: makeRules() })
        const secondExpected = Redaction.redact(second, { rules: makeRules() })
        expect(shared(first)).toBe(firstExpected)
        expect(shared(second)).toBe(secondExpected)
        // Repeating the second call still matches: no state leaked from the
        // call before it.
        expect(shared(second)).toBe(secondExpected)
        expect(sharedRules.map((rule) => rule.pattern.lastIndex)).toEqual([0, 0])
      }),
      { ...params, examples: [["token-abc123 and token-def456", "token-abc123"]] }
    )
  })
})
