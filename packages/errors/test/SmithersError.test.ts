import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { inspect } from "node:util"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  isSmithersErrorCode,
  type SmithersErrorCode,
  smithersErrorCodes,
  type SmithersErrorDefinition,
  smithersErrorDefinitions
} from "../src/ErrorCode.ts"
import { hasSmithersErrorShape, isSmithersError, SmithersError } from "../src/SmithersError.ts"

describe("SmithersError", () => {
  it("keeps its public fields readonly", () => {
    const pin = (error: SmithersError): void => {
      // @ts-expect-error SmithersError.name must remain readonly.
      error.name = "mutated"
      // @ts-expect-error SmithersError.details must remain readonly.
      error.details = undefined
    }

    expect(typeof pin).toBe("function")
  })

  it("uses the default name", () => {
    expect(new SmithersError("INVALID_INPUT", "x").name).toBe("SmithersError")
  })

  it("is an Error", () => {
    expect(new SmithersError("INVALID_INPUT", "x")).toBeInstanceOf(Error)
  })

  it("appends the documentation URL once", () => {
    const error = new SmithersError("INVALID_INPUT", "no bot token")
    expect(error.message).toBe(`no bot token See ${ERROR_REFERENCE_URL}`)
    expect(error.summary).toBe("no bot token")
    expect(error.docsUrl).toBe(ERROR_REFERENCE_URL)
    const rewrapped = new SmithersError("INVALID_INPUT", error.message)
    expect(rewrapped.message).toBe(error.message)
    expect(rewrapped.summary).toBe("no bot token")
  })

  // Spelled out rather than interpolated on purpose: this is the string a user
  // reads in a log, so a change to ERROR_REFERENCE_URL has to be deliberate
  // enough to edit a test. The URL moved under /docs/ because the bare
  // /reference/errors path 404s on the live site.
  it("freezes the wire-visible message format", () => {
    expect(new SmithersError("INVALID_INPUT", "no bot token").message).toBe(
      "no bot token See https://smithers.sh/docs/reference/errors"
    )
  })

  it("collapses duplicate documentation URL suffixes", () => {
    const suffix = ` See ${ERROR_REFERENCE_URL}`
    const error = new SmithersError("INVALID_INPUT", `x${suffix}${suffix}`)
    expect(error.summary).toBe("x")
    expect(error.message).toBe(`x${suffix}`)
  })

  it("ignores trailing whitespace when removing the documentation URL suffix", () => {
    const suffix = ` See ${ERROR_REFERENCE_URL}`
    const error = new SmithersError("INVALID_INPUT", `no token${suffix} `)
    expect(error.summary).toBe("no token")
    expect(error.message).toBe(`no token${suffix}`)
  })

  it("collapses documentation URL suffixes separated by whitespace", () => {
    const suffix = ` See ${ERROR_REFERENCE_URL}`
    const error = new SmithersError("INVALID_INPUT", `no token${suffix}   ${suffix}`)
    expect(error.summary).toBe("no token")
    expect(error.message).toBe(`no token${suffix}`)
  })

  it("keeps a summary's own trailing whitespace across a rewrap", () => {
    for (const summary of ["x ", "no token  ", "no token\n", "no token\t "]) {
      const first = new SmithersError("INVALID_INPUT", summary)
      expect(first.summary).toBe(summary)
      expect(first.message).toBe(`${summary} See ${ERROR_REFERENCE_URL}`)
      const rewrapped = new SmithersError("INVALID_INPUT", first.message)
      expect(rewrapped.message).toBe(first.message)
      expect(rewrapped.summary).toBe(first.summary)
      const twice = new SmithersError("INVALID_INPUT", rewrapped.message)
      expect(twice.message).toBe(first.message)
      expect(twice.summary).toBe(first.summary)
    }
  })

  it("rewraps a blank summary to the same blank message", () => {
    for (const summary of ["", "   "]) {
      const first = new SmithersError("UNSUPPORTED", summary)
      const rewrapped = new SmithersError("UNSUPPORTED", first.message)
      expect(rewrapped.message).toBe(summary)
      expect(rewrapped.summary).toBe(summary)
    }
  })

  it("appends the pointer when the URL is only embedded in the summary", () => {
    const summary = `see ${ERROR_REFERENCE_URL} for more; token bad`
    const error = new SmithersError("INVALID_INPUT", summary)
    expect(error.message).toBe(`${summary} See ${ERROR_REFERENCE_URL}`)
    expect(error.summary).toBe(summary)
  })

  it("does not append the documentation URL to blank summaries", () => {
    expect(new SmithersError("UNSUPPORTED", "").message).toBe("")
    expect(new SmithersError("UNSUPPORTED", "").summary).toBe("")
    expect(new SmithersError("UNSUPPORTED", "   ").message).toBe("   ")
  })

  it("suppresses the documentation URL on request", () => {
    const error = new SmithersError("UNSUPPORTED", "no Ed25519", undefined, { includeDocsUrl: false })
    expect(error.message).toBe("no Ed25519")
    expect(error.details).toBeUndefined()
    const suffix = ` See ${ERROR_REFERENCE_URL}`
    const stripped = new SmithersError("UNSUPPORTED", `no Ed25519${suffix}`, undefined, {
      includeDocsUrl: false
    })
    expect(stripped.message).toBe("no Ed25519")
    expect(stripped.summary).toBe("no Ed25519")
  })

  it("treats an explicit includeDocsUrl true like the default", () => {
    expect(new SmithersError("INVALID_INPUT", "x", undefined, { includeDocsUrl: true }).message)
      .toBe(`x See ${ERROR_REFERENCE_URL}`)
  })

  it("starts the stack with its name and message", () => {
    const error = new SmithersError("INVALID_INPUT", "x")
    expect(error.stack?.startsWith(`${error.name}: ${error.message}`)).toBe(true)
  })

  it("carries a cause, a name, and caller-supplied details", () => {
    const cause = new Error("socket hang up")
    const error = new SmithersError("INTEGRATION_ERROR", "poll failed", { reason: "poll-failed" }, {
      cause,
      name: "IntegrationError"
    })
    expect(error.name).toBe("IntegrationError")
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ reason: "poll-failed" })
  })

  it("enumerates details only when the caller supplies them", () => {
    const withoutDetails = new SmithersError("INVALID_INPUT", "x")
    const withDetails = new SmithersError("INVALID_INPUT", "x", { reason: "r" })

    expect(Object.keys(withoutDetails)).toEqual(["code", "summary", "docsUrl"])
    expect(Object.keys(withDetails)).toEqual(["code", "summary", "docsUrl", "details"])
    expect(Object.hasOwn(withoutDetails, "details")).toBe(false)
    expect(Object.hasOwn(withDetails, "details")).toBe(true)
  })

  it("installs name as a non-enumerable own property", () => {
    const descriptor = {
      enumerable: false,
      writable: true,
      configurable: true
    }
    const error = new SmithersError("INVALID_INPUT", "x")
    const renamed = new SmithersError("INVALID_INPUT", "x", undefined, { name: "IntegrationError" })

    expect(Object.getOwnPropertyDescriptor(error, "name")).toEqual({ value: "SmithersError", ...descriptor })
    expect(Object.getOwnPropertyDescriptor(renamed, "name")).toEqual({ value: "IntegrationError", ...descriptor })
    expect(Object.keys(renamed)).not.toContain("name")
  })

  it("keeps absent details and the error name out of inspection and JSON", () => {
    const withoutDetails = new SmithersError("INVALID_INPUT", "x")
    const withDetails = new SmithersError("INVALID_INPUT", "x", { reason: "r" })

    expect(inspect(withoutDetails)).not.toContain("details: undefined")
    expect(inspect(withDetails)).toContain("details:")
    expect(JSON.parse(JSON.stringify(withoutDetails))).toEqual({
      code: "INVALID_INPUT",
      summary: "x",
      docsUrl: ERROR_REFERENCE_URL
    })
  })

  it("limits JSON to the enumerable fields while inspection prints the stack and a supplied cause", () => {
    const error = new SmithersError("INTEGRATION_ERROR", "poll failed", { reason: "poll-failed" }, {
      cause: new Error("cause marker")
    })

    expect(Object.keys(JSON.parse(JSON.stringify(error)))).toEqual(["code", "summary", "docsUrl", "details"])
    const rendered = inspect(error)
    expect(rendered.startsWith(`SmithersError: ${error.message}`)).toBe(true)
    expect(rendered).toMatch(/\n\s+at /)
    expect(rendered).toContain("code: 'INTEGRATION_ERROR'")
    expect(rendered).toContain("[cause]: Error: cause marker")
  })

  it("keeps subclass names out of enumerable fields and at the start of the stack", () => {
    class Sub extends SmithersError {
      constructor() {
        super("UNSUPPORTED", "x", undefined, { name: "Sub" })
      }
    }

    const error = new Sub()
    expect(error.name).toBe("Sub")
    expect(Object.keys(error)).not.toContain("name")
    expect(error.stack?.startsWith("Sub: ")).toBe(true)
  })

  it("only installs an own cause property when cause is supplied", () => {
    expect(Object.hasOwn(new SmithersError("INVALID_INPUT", "x"), "cause")).toBe(false)
    expect(Object.hasOwn(new SmithersError("INVALID_INPUT", "x", undefined, { name: "X" }), "cause")).toBe(false)
    expect(Object.hasOwn(new SmithersError("INVALID_INPUT", "x", undefined, { cause: new Error("root") }), "cause"))
      .toBe(true)
    expect(Object.hasOwn(new SmithersError("INVALID_INPUT", "x", undefined, { cause: undefined }), "cause")).toBe(false)
  })

  it("lets subclasses always spell the optional cause key", () => {
    class IntegrationError extends SmithersError {
      constructor(options?: { readonly cause?: unknown }) {
        super("INTEGRATION_ERROR", "poll failed", undefined, {
          cause: options?.cause,
          name: "IntegrationError"
        })
      }
    }

    const withoutCause = new IntegrationError()
    expect(Object.hasOwn(withoutCause, "cause")).toBe(false)
    expect(inspect(withoutCause)).not.toContain("[cause]")

    const cause = new Error("root")
    const withCause = new IntegrationError({ cause })
    expect(Object.hasOwn(withCause, "cause")).toBe(true)
    expect(withCause.cause).toBe(cause)
  })

  it("preserves a cause chain", () => {
    const cause = new Error("middle", { cause: new Error("root") })
    expect((new SmithersError("INTEGRATION_ERROR", "x", undefined, { cause }).cause as Error).cause).toBe(cause.cause)
  })

  // The falsy rows pin the `!== undefined` check: a truthiness check would
  // drop null, false, 0 and "" while every truthy row still passed.
  it("stores non-Error causes verbatim, including defined falsy ones", () => {
    for (const cause of ["provider failure", { provider: "telegram" }, null, false, 0, ""]) {
      const error = new SmithersError("INTEGRATION_ERROR", "x", undefined, { cause })
      expect(Object.hasOwn(error, "cause")).toBe(true)
      expect(error.cause).toBe(cause)
    }
  })

  it("copies and freezes only the top-level details record", () => {
    const nested = { token: "SECRET" }
    const details = { reason: "poll-failed", context: nested }
    const error = new SmithersError("INTEGRATION_ERROR", "poll failed", details)
    details.reason = "changed"
    details.context = { token: "REPLACEMENT" }
    nested.token = "MUTATED"
    expect(error.details).toEqual({ reason: "poll-failed", context: { token: "MUTATED" } })
    expect(error.details?.context).toBe(nested)
    expect(error.details).not.toBe(details)
    expect(Object.isFrozen(error.details)).toBe(true)
  })

  it("keeps the subclass prototype so instanceof works", () => {
    class Subclass extends SmithersError {
      constructor() {
        super("TELEGRAM_API_ERROR", "bad request")
      }
    }
    const error = new Subclass()
    expect(error).toBeInstanceOf(Subclass)
    expect(isSmithersError(error)).toBe(true)
    expect(isSmithersError(new Error("plain"))).toBe(false)
  })
})

describe("error refinements", () => {
  class Subclass extends SmithersError {}

  it("accepts real and subclass instances", () => {
    for (const error of [new SmithersError("INVALID_INPUT", "x"), new Subclass("INVALID_INPUT", "x")]) {
      expect(isSmithersError(error)).toBe(true)
      expect(hasSmithersErrorShape(error)).toBe(true)
    }
  })

  it("rejects plain errors, forged names, non-errors, and plain shaped objects", () => {
    const forged = new Error("forged")
    forged.name = "SmithersError"
    const values = [new Error("plain"), forged, null, undefined, {
      code: "INVALID_INPUT",
      summary: "x",
      docsUrl: ERROR_REFERENCE_URL
    }]
    for (const value of values) {
      expect(isSmithersError(value)).toBe(false)
      expect(hasSmithersErrorShape(value)).toBe(false)
    }
  })

  it("structurally accepts an instance detached from the package prototype", () => {
    for (const code of smithersErrorCodes) {
      const error = new SmithersError(code, "x")
      Object.setPrototypeOf(error, Object.getPrototypeOf(new Error()))
      expect(isSmithersError(error)).toBe(false)
      expect(hasSmithersErrorShape(error)).toBe(true)
    }
  })

  it("refuses to construct with a code outside the closed vocabulary", () => {
    for (const code of ["NOT_A_CODE", "toString", "__proto__", "", 42, undefined]) {
      expect(() => new SmithersError(code as SmithersErrorCode, "x")).toThrow(TypeError)
    }
    class Subclass extends SmithersError {}
    expect(() => new Subclass("NOT_A_CODE" as SmithersErrorCode, "x")).toThrow(TypeError)
  })

  it("rejects an Error carrying an unknown code", () => {
    const error = Object.assign(new Error("f"), {
      code: "NOT_A_CODE",
      summary: "s",
      docsUrl: "bogus"
    })
    expect(hasSmithersErrorShape(error)).toBe(false)
  })

  it("narrows a structurally accepted code to the known vocabulary", () => {
    const value: unknown = Object.assign(new Error("f"), {
      code: "INVALID_INPUT",
      summary: "s",
      docsUrl: "from-another-package-version"
    })
    if (!hasSmithersErrorShape(value)) expect.fail("expected a structurally compatible error")
    expectTypeOf(value.code).toEqualTypeOf<SmithersErrorCode>()
  })

  it("rejects errors with incomplete structural fields", () => {
    expect(hasSmithersErrorShape(Object.assign(new Error("partial"), { code: "INVALID_INPUT" }))).toBe(false)
    expect(hasSmithersErrorShape(Object.assign(new Error("partial"), {
      code: "INVALID_INPUT",
      summary: "x"
    }))).toBe(false)
  })

  it("rejects structurally invalid details", () => {
    for (const details of ["x", null, 7, [1]]) {
      const error = Object.assign(new Error("f"), {
        code: "INVALID_INPUT",
        summary: "s",
        docsUrl: "d",
        details
      })
      expect(hasSmithersErrorShape(error)).toBe(false)
    }
  })

  it("accepts missing and structurally valid details", () => {
    const base = {
      code: "INVALID_INPUT",
      summary: "s",
      docsUrl: "d"
    }
    class Context {
      retryable = true
    }
    for (
      const error of [
        Object.assign(new Error("f"), base),
        Object.assign(new Error("f"), base, { details: {} }),
        Object.assign(new Error("f"), base, { details: { retryable: true } }),
        Object.assign(new Error("f"), base, { details: new Date(0) }),
        Object.assign(new Error("f"), base, { details: new Map([["retryable", true]]) }),
        Object.assign(new Error("f"), base, { details: new Context() })
      ]
    ) {
      expect(hasSmithersErrorShape(error)).toBe(true)
    }
  })

  it("answers false when an inspected property getter throws", () => {
    for (const field of ["code", "summary", "docsUrl", "details"]) {
      const error = Object.assign(new Error("original provider failure"), {
        code: "INVALID_INPUT",
        summary: "original provider failure",
        docsUrl: ERROR_REFERENCE_URL,
        details: {}
      })
      Object.defineProperty(error, field, {
        get(): never {
          throw new Error(`${field} getter failed`)
        }
      })
      expect(() => hasSmithersErrorShape(error)).not.toThrow()
      expect(hasSmithersErrorShape(error)).toBe(false)
    }
  })

  it("answers false for a revoked proxy", () => {
    const { proxy, revoke } = Proxy.revocable(
      Object.assign(new Error("f"), {
        code: "INVALID_INPUT",
        summary: "s",
        docsUrl: ERROR_REFERENCE_URL
      }),
      {}
    )
    revoke()
    expect(() => hasSmithersErrorShape(proxy)).not.toThrow()
    expect(hasSmithersErrorShape(proxy)).toBe(false)
  })

  it("answers false when the prototype lookup throws", () => {
    const hostile = new Proxy({}, {
      getPrototypeOf(): never {
        throw new Error("prototype lookup failed")
      }
    })
    expect(() => hasSmithersErrorShape(hostile)).not.toThrow()
    expect(hasSmithersErrorShape(hostile)).toBe(false)
  })
})

describe("error codes", () => {
  it("keeps the error code set closed", () => {
    expectTypeOf<ConstructorParameters<typeof SmithersError>[0]>().toEqualTypeOf<SmithersErrorCode>()
    expectTypeOf<SmithersError["code"]>().toEqualTypeOf<SmithersErrorCode>()
  })

  it("freezes the definitions and code table", () => {
    expect(Object.isFrozen(smithersErrorDefinitions)).toBe(true)
    expect(Object.isFrozen(smithersErrorDefinitions.INVALID_INPUT)).toBe(true)
    expect(Object.isFrozen(smithersErrorCodes)).toBe(true)
  })

  it("documents exactly the codes the integration adapters raise", () => {
    expect([...smithersErrorCodes].sort()).toEqual([
      "INTEGRATION_ERROR",
      "INVALID_INPUT",
      "TELEGRAM_API_ERROR",
      "TELEGRAM_INIT_DATA_INVALID",
      "UNSUPPORTED"
    ])
  })

  it("gives every code a trigger description", () => {
    expectTypeOf<SmithersErrorDefinition>().toEqualTypeOf<{
      readonly when: string
      readonly details?: string
    }>()
    for (const code of smithersErrorCodes) {
      const definition = smithersErrorDefinitions[code]
      expect(definition.when.length).toBeGreaterThan(0)
    }
  })

  it("resolves definitions and refuses unknown codes", () => {
    expect(getSmithersErrorDefinition("INVALID_INPUT")).toBeDefined()
    expect(getSmithersErrorDefinition("INVALID_INPUT")).toBe(smithersErrorDefinitions.INVALID_INPUT)
    expect(getSmithersErrorDefinition("NOT_A_CODE")).toBeUndefined()
    expect(isSmithersErrorCode("INVALID_INPUT")).toBe(true)
    expect(isSmithersErrorCode("toString")).toBe(false)
    expect(isSmithersErrorCode(7)).toBe(false)
  })

  it("rejects adversarial unknown codes and accepts every known code", () => {
    const adversaries: unknown[] = [
      "hasOwnProperty",
      "__proto__",
      "constructor",
      "",
      null,
      undefined,
      Symbol("INVALID_INPUT"),
      { toString: () => "INVALID_INPUT" }
    ]
    for (const value of adversaries) expect(isSmithersErrorCode(value)).toBe(false)
    for (const code of smithersErrorCodes) expect(isSmithersErrorCode(code)).toBe(true)
  })

  it("keeps definition details meaningful and code membership exact", () => {
    for (const definition of Object.values(smithersErrorDefinitions)) {
      if ("details" in definition) expect(definition.details.length).toBeGreaterThan(0)
    }
    expect(new Set(smithersErrorCodes)).toEqual(new Set(Object.keys(smithersErrorDefinitions)))
  })

  it("documents details carried by input and init-data failures", () => {
    expect(smithersErrorDefinitions.INVALID_INPUT.details)
      .toBe(
        "`{ [field]: value }` on the signal-name failures, `{ maxLength }` on the chunk-size failure, `{ length }` on the malformed `publicKeyHex` failure, `{ maxAgeSeconds }` or `{ nowMs }` on the init-data policy failures, otherwise none"
      )
    expect(smithersErrorDefinitions.TELEGRAM_INIT_DATA_INVALID.details)
      .toBe("`{ authDate }` on the expiry failures, otherwise none")
  })
})

describe("API reference", () => {
  it("limits the enumerable-fields guarantee to Object.keys and JSON.stringify", () => {
    const api = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8").replaceAll(/\s+/g, " ")
    expect(api).not.toContain("`JSON.stringify` and `util.inspect` therefore show")
    expect(api).toContain("`Object.keys` and `JSON.stringify` therefore show those and nothing else.")
    expect(api).toContain("and a `[cause]` entry when a cause is supplied.")
  })
})

describe("published module formats", () => {
  it("documents distinct ESM and CommonJS constructor identities", () => {
    const installation = readFileSync(new URL("../docs/installation.md", import.meta.url), "utf8")
    expect(installation).not.toContain("both resolve to the same class")
    expect(installation).toContain("distinct constructor identities")
  })

  // Run `pnpm build` first to exercise the published artifacts. Source-only
  // checkouts can still run the rest of the suite without generated files.
  it.skipIf(
    !existsSync(new URL("../dist/esm/index.js", import.meta.url))
      || !existsSync(new URL("../dist/cjs/index.js", import.meta.url))
  )("recognizes mixed-loader errors structurally across the module-copy boundary", () => {
    // Native Node loaders avoid Vitest transforming or deduplicating the modules.
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict"
        import { createRequire } from "node:module"
        import * as esm from "./dist/esm/index.js"
        const cjs = createRequire(import.meta.url)("./dist/cjs/index.js")
        assert.notEqual(esm.SmithersError, cjs.SmithersError)
        for (const [producer, consumer] of [[cjs, esm], [esm, cjs]]) {
          const error = new producer.SmithersError("INVALID_INPUT", "bad input")
          assert.equal(producer.isSmithersError(error), true)
          assert.equal(consumer.isSmithersError(error), false)
          assert.equal(consumer.hasSmithersErrorShape(error), true)
        }
      `
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 20_000 })
  })
})
