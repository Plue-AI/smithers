/**
 * The deterministic rendering projection and the exit statuses it drives.
 *
 * Every command prints through this module, so its normalization (stable key
 * order, redaction) and its value-to-status mapping are the CLI's whole
 * observable contract for scripts.
 */
import { Effect, Redacted } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Output from "../src/Output.ts"

const render = (value: unknown, format: Output.Format) => Effect.runSync(Output.make().render(value, format))
const refusal = (value: unknown, format: Output.Format = "json") =>
  Effect.runSync(Effect.flip(Output.make().render(value, format)))

describe("Output.make human rendering", () => {
  it("prints a string value verbatim rather than quoting it", () => {
    expect(render("already rendered\nlines", "human").text).toBe("already rendered\nlines")
  })

  it("makes terminal control sequences inert while keeping line breaks and tabs", () => {
    expect(render("safe\x1b[2J\nnext\tcol\x1b]0;title\x07\r\nend\x00\x9b31m\u202e", "human").text)
      .toBe("safe\nnext\tcol\nend")
    expect(render({ note: "\x9b2J\u202eflip" }, "human").text).toBe("{\n  \"note\": \"flip\"\n}")
  })

  it("prints the empty string as nothing at all", () => {
    expect(render("", "human").text).toBe("")
  })

  it("indents every non-string value, including scalars and the empty object", () => {
    expect(render({ b: 1, a: 2 }, "human").text).toBe("{\n  \"a\": 2,\n  \"b\": 1\n}")
    expect(render({}, "human").text).toBe("{}")
    expect(render([], "human").text).toBe("[]")
    expect(render(7, "human").text).toBe("7")
    expect(render(null, "human").text).toBe("null")
  })

  it("redacts a top-level secret in both formats", () => {
    const secret = Redacted.make("alpha-secret")
    expect(render(secret, "human").text).toBe("<redacted>")
    expect(render(secret, "json").text).toBe("\"<redacted>\"")
  })

  it("redacts secrets nested inside arrays and objects alike", () => {
    const value = { list: [Redacted.make("one"), { token: Redacted.make("two") }] }
    expect(render(value, "json").text).toBe("{\"list\":[\"<redacted>\",{\"token\":\"<redacted>\"}]}")
  })

  it("sorts keys at every depth so two renders of the same value are byte-identical", () => {
    const value = { z: { y: 1, a: [{ d: 1, c: 2 }] }, a: null }
    expect(render(value, "json").text).toBe("{\"a\":null,\"z\":{\"a\":[{\"c\":2,\"d\":1}],\"y\":1}}")
    expect(render(value, "json").text).toBe(render(value, "json").text)
  })

  it("sorts keys by code unit rather than the host locale", () => {
    expect(render({ a: 1, Z: 2 }, "json").text).toBe("{\"Z\":2,\"a\":1}")
  })

  it("refuses a cycle with the repeated path", () => {
    const value: { self?: unknown } = {}
    value.self = value

    expect(refusal(value)).toMatchObject({ code: "cycle", path: "$[\"self\"]" })
  })

  it("accepts the exact depth limit and refuses the next value", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = "leaf"
      for (let index = 0; index < depth; index++) value = { child: value }
      return value
    }

    expect(render(nested(Output.maximumDepth), "json").text).toContain("leaf")
    expect(refusal(nested(Output.maximumDepth + 1))).toMatchObject({ code: "depth_limit" })
  })

  it("defines every non-JSON scalar representation", () => {
    expect(render(17n, "human").text).toBe("17n")
    expect(render(17n, "json").text).toBe("\"17n\"")
    expect(render(undefined, "human").text).toBe("[Undefined]")
    expect(render(undefined, "json").text).toBe("\"[Undefined]\"")
    expect(render(Number.NaN, "json").text).toBe("\"[NaN]\"")
    expect(render(Number.POSITIVE_INFINITY, "json").text).toBe("\"[Infinity]\"")
    expect(render(Number.NEGATIVE_INFINITY, "json").text).toBe("\"[-Infinity]\"")
    expect(render(-0, "json").text).toBe("\"-0\"")
    expect(render(Symbol("named"), "json").text).toBe("\"Symbol(named)\"")
  })

  it("omits undefined object members like JSON while array positions and defined values stay", () => {
    const value = { a: undefined, b: null, c: false, d: 0, e: "", f: [undefined, 1], g: { h: undefined } }
    expect(render(value, "json").text).toBe(
      "{\"b\":null,\"c\":false,\"d\":0,\"e\":\"\",\"f\":[\"[Undefined]\",1],\"g\":{}}"
    )
    expect(render(value, "human").text).not.toMatch(/"a"|"h"/)
  })

  it("never invokes getters or proxy traps", () => {
    let getterReads = 0
    const withGetter: Record<string, unknown> = {}
    Object.defineProperty(withGetter, "secret", {
      enumerable: true,
      get: () => {
        getterReads += 1
        return "must-not-run"
      }
    })
    expect(refusal(withGetter)).toMatchObject({ code: "accessor", path: "$[\"secret\"]" })
    expect(getterReads).toBe(0)

    let traps = 0
    const proxy = new Proxy({}, {
      ownKeys: () => {
        traps += 1
        return []
      }
    })
    expect(refusal(proxy)).toMatchObject({ code: "proxy", path: "$" })
    expect(traps).toBe(0)

    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(refusal(revoked.proxy)).toMatchObject({ code: "proxy", path: "$" })
  })

  it.each(
    [
      ["a function", () => undefined, "callable"],
      ["a toJSON member", { toJSON: () => ({}) }, "to_json"],
      ["a Date", new Date(0), "unsupported"],
      ["a Map", new Map(), "unsupported"]
    ] as const
  )("refuses %s as executable or host-owned data", (_label, value, code) => {
    expect(refusal(value)).toMatchObject({ code })
  })

  it("enforces the exact aggregate member boundary", () => {
    const exact = Object.fromEntries(
      Array.from({ length: Output.maximumMembers }, (_, index) => [`k${index}`, index])
    )
    expect(JSON.parse(render(exact, "json").text)).toHaveProperty("k9999", 9999)
    expect(refusal({ ...exact, overflow: true })).toMatchObject({ code: "member_limit", path: "$" })
  })

  it("enforces the exact UTF-8 output boundary", () => {
    expect(Buffer.byteLength(render("x".repeat(Output.maximumOutputBytes - 2), "json").text)).toBe(
      Output.maximumOutputBytes
    )
    expect(refusal("x".repeat(Output.maximumOutputBytes - 1))).toMatchObject({
      code: "byte_limit",
      path: "$"
    })
    expect(Buffer.byteLength(render("é".repeat(Output.maximumOutputBytes / 2), "human").text)).toBe(
      Output.maximumOutputBytes
    )
    expect(refusal("é".repeat(Output.maximumOutputBytes / 2 + 1))).toMatchObject({
      code: "byte_limit",
      path: "$"
    })
  })

  it("refuses non-data array and object members", () => {
    const extra = [1] as Array<unknown> & { extra?: unknown }
    extra.extra = 2
    expect(refusal(extra)).toMatchObject({ code: "unsupported", path: "$" })

    const sparse = Array<unknown>(1)
    expect(refusal(sparse)).toMatchObject({ code: "unsupported", path: "$[0]" })

    const hiddenIndex = [1]
    Object.defineProperty(hiddenIndex, "0", { value: 1, enumerable: false })
    expect(refusal(hiddenIndex)).toMatchObject({ code: "unsupported", path: "$[0]" })

    expect(refusal({ [Symbol("hidden")]: true })).toMatchObject({ code: "unsupported", path: "$" })

    const hiddenObject = Object.defineProperty({}, "hidden", { value: true, enumerable: false })
    expect(refusal(hiddenObject)).toMatchObject({ code: "unsupported", path: "$[\"hidden\"]" })
  })

  it("clips an executable member's path without reading the member", () => {
    const key = "k".repeat(200)
    const value: Record<string, unknown> = {}
    Object.defineProperty(value, key, { enumerable: true, get: () => "must not run" })

    const error = refusal(value)
    expect(error).toMatchObject({ code: "accessor" })
    expect(error.path).toHaveLength(134)
    expect(error.path.endsWith("…\"]")).toBe(true)
  })

  it("turns an unexpected inspection failure into a stable rendering error", () => {
    const byteLength = vi.spyOn(Buffer, "byteLength").mockImplementationOnce(() => {
      throw new Error("host failure")
    })
    try {
      expect(refusal("value")).toMatchObject({ code: "unreadable", path: "$" })
    } finally {
      byteLength.mockRestore()
    }
  })

  it("uses fixed Unicode code-unit ordering without locale APIs", () => {
    expect(render({ "\ue000": 4, "𐀀": 3, "é": 2, e: 1 }, "json").text).toBe(
      "{\"e\":1,\"é\":2,\"𐀀\":3,\"\":4}"
    )
  })
})

describe("Output.exitCode", () => {
  it.each(
    [
      [
        "a parked receipt",
        { _tag: "Parked", receiptId: "receipt-1", planId: "plan-1", status: "waiting-approval" },
        3
      ],
      ["a cancelled terminal receipt", { _tag: "Terminal", runId: "run-1", status: "cancelled" }, 130],
      ["a failed terminal receipt", { _tag: "Terminal", runId: "run-1", status: "failed" }, 1],
      ["a conflicting receipt", { _tag: "Conflict", message: "changed" }, 1],
      ["an accepted receipt", { _tag: "Accepted", receiptId: "receipt-1", runId: "run-1" }, 0],
      ["caller data tagged Parked", { _tag: "Parked" }, 0],
      ["caller data waiting for approval", { status: "waiting-approval" }, 0],
      ["caller data tagged Interrupted", { _tag: "Interrupted" }, 0],
      ["caller data carrying SIGINT", { signal: "SIGINT" }, 0],
      ["caller data carrying SIGTERM", { signal: "SIGTERM" }, 0],
      ["caller data tagged Error", { _tag: "Error" }, 0],
      ["an empty object", {}, 0],
      ["an empty array", [], 0],
      ["null", null, 0],
      ["a string", "waiting-approval", 0],
      ["a number", 3, 0],
      ["undefined", undefined, 0]
    ] as const
  )("maps %s to %i", (_label, value, expected) => {
    expect(Output.exitCode(value)).toBe(expected)
  })

  it("ignores even several receipt-shaped markers on caller data", () => {
    expect(Output.exitCode({ _tag: "Error", status: "waiting-approval", signal: "SIGTERM" })).toBe(0)
  })

  it("stamps the same status onto the rendered value in either format", () => {
    const receipt = { _tag: "Parked", receiptId: "receipt-1", planId: "plan-1", status: "waiting-approval" }
    expect(render(receipt, "json").exitCode).toBe(3)
    expect(render(receipt, "human").exitCode).toBe(3)
  })

  it.each([
    { _tag: "Error" },
    { status: "waiting-approval" },
    { signal: "SIGINT" }
  ])("keeps receipt-like memory data successful: %j", (value) => {
    const rendered = render(Output.renderValue(value), "json")

    expect(JSON.parse(rendered.text)).toEqual(value)
    expect(rendered.exitCode).toBe(0)
  })

  it("keeps even a complete control-receipt shape successful when it is caller data", () => {
    const receipt = { _tag: "Terminal", runId: "run-1", status: "failed" }
    const rendered = render(Output.renderValue(receipt), "json")

    expect(rendered.text).toBe("{\"_tag\":\"Terminal\",\"runId\":\"run-1\",\"status\":\"failed\"}")
    expect(rendered.exitCode).toBe(0)
    expect(Output.exitCode(Output.renderValue(receipt))).toBe(0)
  })

  it("treats a schema value that throws while inspected as ordinary data", () => {
    const hostile = new Proxy({}, {
      get: () => {
        throw new Error("must stay inside exitCode")
      }
    })

    expect(Output.exitCode(hostile)).toBe(0)
  })
})

describe("CliError.exitCode", () => {
  it("separates a malformed invocation from an unsupported one", () => {
    expect(CliError.exitCode(new CliError.UsageError({ message: "bad" }))).toBe(2)
    expect(CliError.exitCode(new CliError.UnsupportedError({ message: "no" }))).toBe(1)
    expect(CliError.exitCode(
      new CliError.ResourceLimitError({
        operation: "read",
        subject: "run r",
        limit: 1,
        unit: "events"
      })
    )).toBe(1)
    expect(CliError.exitCode(
      new CliError.RenderingError({ code: "proxy", path: "$", message: "cannot render" })
    )).toBe(1)
  })

  it("keeps the tag each failure is matched on", () => {
    expect(new CliError.UsageError({ message: "bad" })._tag).toBe("/cli/UsageError")
    expect(new CliError.UnsupportedError({ message: "no" })._tag).toBe("/cli/UnsupportedError")
  })
})
