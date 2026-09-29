import { Cause, Effect, Exit, Option, Schema } from "effect"
import { badArgument, type PlatformError, systemError } from "effect/PlatformError"
import { describe, expect, it } from "vitest"
import { make as makeCapability, maxResourceLength } from "../src/Capability.ts"
import * as Index from "../src/index.ts"
import { decodePermissionError } from "../src/index.ts"
import {
  formatError,
  fromPlatformError,
  GrantStoreError,
  isPermissionError,
  maxDisplayFieldLength,
  PermissionDenied,
  permissionDenied,
  PermissionError,
  permissionRequired,
  RuleEffect,
  toPlatformError
} from "../src/Permission.ts"

/**
 * The three failures a guarded Host call can add, the one-line rendering an
 * unattended report shows, and the round trip through Effect's `PlatformError`
 * that the `FileSystem` and `ChildProcessSpawner` decorators depend on.
 */

const capability = makeCapability("fs:write", "/workspace/out.txt")

describe("permission failures", () => {
  it("constructs a request for an exact capability and defaults its meta", () => {
    const required = permissionRequired({ requestId: "req-1", capability, tier: "compensable" })
    expect(required).toMatchObject({
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "req-1",
      tier: "compensable",
      meta: {}
    })
    expect(required.runId).toBeUndefined()

    const withContext = permissionRequired({
      requestId: "req-2",
      runId: "run-1",
      capability,
      tier: "irreversible",
      meta: { origin: "test" }
    })
    expect(withContext.runId).toBe("run-1")
    expect(withContext.meta).toEqual({ origin: "test" })
  })

  it("constructs a denial carrying its reason", () => {
    expect(permissionDenied(capability, "outside the workspace")).toMatchObject({
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      reason: "outside the workspace"
    })
  })

  it("refines only the three kernel failures", () => {
    expect(isPermissionError(permissionRequired({ requestId: "r", capability, tier: "sealed" }))).toBe(true)
    expect(isPermissionError(permissionDenied(capability, "no"))).toBe(true)
    expect(isPermissionError(new GrantStoreError({ code: "store_closed" }))).toBe(true)
    expect(isPermissionError(new Error("boom"))).toBe(false)
    expect(isPermissionError({ _tag: "@smthrs/jj/JjError" })).toBe(false)
    expect(isPermissionError(null)).toBe(false)
    expect(isPermissionError("permission_denied")).toBe(false)
  })

  it.each([
    [{
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed"
    }],
    [{ _tag: "@smthrs/capability/PermissionDenied", code: "permission_denied", reason: "no" }],
    [{ _tag: "@smthrs/capability/GrantStoreError" }]
  ])("rejects a forged permission tag with a missing field", (forged) => {
    expect(isPermissionError(forged)).toBe(false)
  })

  it.each([
    [{
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: 1,
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: {}
    }],
    [{ _tag: "@smthrs/capability/GrantStoreError", code: "nope" }]
  ])("rejects a forged permission tag with a wrong-typed field", (forged) => {
    expect(isPermissionError(forged)).toBe(false)
  })

  it("rejects a structurally valid permission request with a numeric runId", () => {
    expect(isPermissionError({
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r1",
      runId: 5,
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: {}
    })).toBe(false)
  })

  it("rejects a structurally valid permission request with non-JSON metadata", () => {
    expect(isPermissionError({
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r1",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: { a: 1n }
    })).toBe(false)
  })

  it.each([
    [{
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r1",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: {}
    }],
    [{
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      capability: { action: "fs:read", resource: "/a" },
      reason: "no"
    }],
    [{ _tag: "@smthrs/capability/GrantStoreError", code: "store_closed" }]
  ])("accepts a valid structural permission failure from another package identity", (structural) => {
    expect(isPermissionError(structural)).toBe(true)
  })

  it.each([
    "@smthrs/capability/PermissionRequired",
    "@smthrs/capability/PermissionDenied",
    "@smthrs/capability/GrantStoreError"
  ])("rejects an excess-field forgery of %s", (tag) => {
    const base = tag === "@smthrs/capability/PermissionRequired"
      ? {
        _tag: tag,
        code: "permission_required",
        requestId: "r1",
        capability: { action: "fs:read", resource: "/a" },
        tier: "sealed",
        meta: {}
      }
      : tag === "@smthrs/capability/PermissionDenied"
      ? {
        _tag: tag,
        code: "permission_denied",
        capability: { action: "fs:read", resource: "/a" },
        reason: "no"
      }
      : { _tag: tag, code: "store_closed" }

    expect(isPermissionError({ ...base, forged: true })).toBe(false)
  })

  it("rejects a denial carrying an overlong exact capability resource", () => {
    const denied = {
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      capability: { action: "proc:spawn", resource: "x".repeat(maxResourceLength + 1) },
      reason: "no"
    }

    expect(isPermissionError(denied)).toBe(false)
  })

  it("accepts absent, undefined, and string grant-store messages", () => {
    expect(isPermissionError({ _tag: "@smthrs/capability/GrantStoreError", code: "store_closed" })).toBe(true)
    expect(isPermissionError({
      _tag: "@smthrs/capability/GrantStoreError",
      code: "store_closed",
      message: undefined
    })).toBe(true)
    expect(isPermissionError({
      _tag: "@smthrs/capability/GrantStoreError",
      code: "journal_failed",
      message: "disk full"
    })).toBe(true)
  })

  const boundaryCases = [
    ["required tag", "required", ["_tag"], "@smthrs/capability/PermissionRequired"],
    ["required requestId", "required", ["requestId"], "r"],
    ["optional runId", "required", ["runId"], "run"],
    ["wrong-typed runId", "required", ["runId"], 42],
    ["optional message", "store", ["message"], "message"],
    ["optional cause", "store", ["cause"], undefined],
    ["capability resource", "required", ["capability", "resource"], "/a"],
    ["metadata root", "required", ["meta"], {}],
    ["nested metadata", "required", ["meta", "nested", "value"], "value"],
    ["array metadata", "required", ["meta", "array", "0"], "value"]
  ] as const

  describe.each(["own", "throwing", "inherited", "inherited data"] as const)("%s boundary fields", (kind) => {
    it.each(boundaryCases)("rejects %s without invoking getters", (_name, variant, path, value) => {
      const input: Record<string, unknown> = variant === "store"
        ? { _tag: "@smthrs/capability/GrantStoreError", code: "store_closed" }
        : {
          _tag: "@smthrs/capability/PermissionRequired",
          code: "permission_required",
          requestId: "r",
          capability: { action: "fs:read", resource: "/a" },
          tier: "sealed",
          meta: { nested: { value: "ok" }, array: ["ok"] }
        }
      let target = input
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>
      const key = path[path.length - 1]!
      let calls = 0
      const getter = {
        enumerable: true,
        get() {
          calls++
          if (kind === "throwing") throw new Error("untrusted getter")
          return value
        }
      }
      if (kind === "inherited" || kind === "inherited data") {
        delete target[key]
        const descriptor = kind === "inherited data" ? { value, enumerable: true } : getter
        Object.setPrototypeOf(target, Object.create(Object.getPrototypeOf(target), { [key]: descriptor }))
      } else {
        Object.defineProperty(target, key, getter)
      }
      const projected = systemError({ _tag: "PermissionDenied", module: "foreign", method: "x", cause: input })
      expect.soft(() => expect(isPermissionError(input)).toBe(false)).not.toThrow()
      expect.soft(calls).toBe(0)
      expect.soft(() => expect(fromPlatformError(projected)).toEqual(Option.none())).not.toThrow()
      expect(decodePermissionError(input)).toEqual(Option.none())
      expect(calls).toBe(0)
    })
  })

  it("rejects an inconsistent inherited message descriptor", () => {
    const input = new Proxy({ _tag: "@smthrs/capability/GrantStoreError", code: "store_closed" }, {
      has: (_target, key) => key === "message",
      getPrototypeOf: () => null
    })
    expect(isPermissionError(input)).toBe(false)
    expect(fromPlatformError(systemError({ _tag: "PermissionDenied", module: "m", method: "x", cause: input })))
      .toEqual(Option.none())
  })

  it("refines wire records without promising yieldable class behavior", () => {
    const wire: unknown = {
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      capability: { action: "fs:read", resource: "/a" },
      reason: "no"
    }
    expect(isPermissionError(wire)).toBe(true)
    expect(Schema.is(PermissionError)(wire)).toBe(false)
    if (isPermissionError(wire)) {
      // @ts-expect-error A structural payload is not a yieldable Effect error.
      const instance: PermissionError = wire
      void instance
      // @ts-expect-error A nested structural capability has no schema brand.
      const branded: typeof capability = wire._tag === "@smthrs/capability/PermissionDenied"
        ? wire.capability
        : capability
      void branded
      expect(formatError(wire)).toBe("permission_denied: fs:read:/a: no")
    }
  })

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => "no" }],
    ["non-finite number", { value: Infinity }],
    ["date", { value: new Date() }],
    ["symbol key", { [Symbol("value")]: "no" }],
    ["array extra property", { value: Object.assign([1], { extra: true }) }],
    ["sparse array", { value: new Array(2) }],
    ["inherited record", Object.create({ inherited: "no" })]
  ])("rejects %s metadata at both boundaries", (_name, meta) => {
    const input = {
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta
    }
    expect(isPermissionError(input)).toBe(false)
    expect(fromPlatformError(systemError({ _tag: "PermissionDenied", module: "m", method: "x", cause: input })))
      .toEqual(Option.none())
    expect(decodePermissionError(input)).toEqual(Option.none())
  })

  it("rejects cyclic metadata and accepts a shared JSON graph", () => {
    const shared = { value: [null, true, 1, "ok"] }
    const input = {
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: { a: shared, b: shared }
    }
    expect(isPermissionError(input)).toBe(true)
    Object.assign(shared, { cycle: input.meta })
    expect(isPermissionError(input)).toBe(false)
    expect(fromPlatformError(systemError({ _tag: "PermissionDenied", module: "m", method: "x", cause: input })))
      .toEqual(Option.none())
  })

  it("rejects non-enumerable metadata getters without reading them", () => {
    let calls = 0
    const meta = {
      nested: Object.defineProperty({}, "hidden", {
        get() {
          calls++
          return "no"
        }
      })
    }
    const input = {
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta
    }
    expect(isPermissionError(input)).toBe(false)
    expect(fromPlatformError(systemError({ _tag: "PermissionDenied", module: "m", method: "x", cause: input })))
      .toEqual(Option.none())
    expect(calls).toBe(0)
  })

  describe("metadata array read traps", () => {
    const request = (array: ReadonlyArray<unknown>) => ({
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: { array }
    })
    const trapped = (throws: boolean) => {
      const reads: Array<string> = []
      const array = new Proxy([1, "two"], {
        get(target, key, receiver) {
          reads.push(String(key))
          if (throws) throw new Error("metadata-read-marker")
          return Reflect.get(target, key, receiver)
        }
      })
      return { reads, input: request(array) }
    }

    it.each([false, true])("refines through descriptors without ordinary reads (throwing: %s)", (throws) => {
      const { input, reads } = trapped(throws)
      expect(isPermissionError(input)).toBe(true)
      expect(reads).toEqual([])
    })

    it("constructs from a transparent trapped array", () => {
      const { input } = trapped(false)
      expect(Option.map(decodePermissionError(input), (error) => error._tag))
        .toEqual(Option.some("@smthrs/capability/PermissionRequired"))
    })

    it("returns None when descriptor inspection throws", () => {
      const array = new Proxy([1], {
        ownKeys() {
          throw new Error("metadata-inspection-marker")
        }
      })
      const input = request(array)
      expect(() => isPermissionError(input)).toThrow("metadata-inspection-marker")
      expect(decodePermissionError(input)).toEqual(Option.none())
    })

    it("still rejects sparse, extra-member, and non-Array-prototype arrays", () => {
      const extra = Object.assign([1], { extra: 2 })
      const foreign = Object.setPrototypeOf([1], Object.create(Array.prototype))
      for (const array of [[1, , 3], extra, foreign]) {
        expect(isPermissionError(request(array))).toBe(false)
        expect(decodePermissionError(request(array))).toEqual(Option.none())
      }
    })
  })

  it.each([
    {
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r",
      runId: "run",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: { value: [null, true, 1] }
    },
    {
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      capability: { action: "fs:read", resource: "/a" },
      reason: "no"
    },
    {
      _tag: "@smthrs/capability/GrantStoreError",
      code: "journal_failed",
      message: "disk full",
      cause: new Error("disk")
    }
  ])("decodes $_tag into a yieldable schema instance", (input) => {
    const decoded = Option.getOrThrow(decodePermissionError(input))
    expect(Schema.is(PermissionError)(decoded)).toBe(true)
    expect(decoded).toMatchObject(input)
    expect(decoded).not.toBe(input)
    const result = Effect.runSyncExit(Effect.gen(function*() {
      yield* decoded
    }))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(decoded)
  })

  it("decodes foreign schema identities and their default Error message", () => {
    class ForeignStoreError extends Schema.TaggedError<ForeignStoreError>()(
      "@smthrs/capability/GrantStoreError",
      GrantStoreError.fields
    ) {}
    const foreign = new ForeignStoreError({ code: "store_closed" })
    expect(foreign instanceof GrantStoreError).toBe(false)
    expect(Schema.is(GrantStoreError)(foreign)).toBe(true)
    expect(isPermissionError(foreign)).toBe(true)
    expect(Option.getOrThrow(fromPlatformError(systemError({
      _tag: "PermissionDenied",
      module: "foreign",
      method: "x",
      cause: foreign
    })))).toBe(foreign)
    expect(Schema.is(PermissionError)(Option.getOrThrow(decodePermissionError(foreign)))).toBe(true)
    expect(Schema.is(PermissionDenied)(Option.getOrThrow(decodePermissionError(permissionDenied(capability, "no")))))
      .toBe(true)
  })

  it("returns None when decoded metadata exceeds constructor limits", () => {
    const input = {
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: { value: "x".repeat(65_536) }
    }
    expect(isPermissionError(input)).toBe(true)
    expect(decodePermissionError(input)).toEqual(Option.none())
  })

  it("exports validators for rule effects and permission failures", () => {
    expect(Schema.is(RuleEffect)("allow")).toBe(true)
    expect(Schema.is(RuleEffect)("maybe")).toBe(false)
    expect(Schema.is(PermissionError)(permissionDenied(capability, "no"))).toBe(true)
    expect(Schema.is(PermissionError)(new Error("no"))).toBe(false)
  })

  it("renders each failure as one line", () => {
    expect(formatError(permissionRequired({ requestId: "req-1", capability, tier: "sealed" })))
      .toBe("permission_required: fs:write:/workspace/out.txt (tier sealed, request req-1)")
    expect(formatError(permissionDenied(capability, "outside the workspace")))
      .toBe("permission_denied: fs:write:/workspace/out.txt: outside the workspace")
    expect(formatError(new GrantStoreError({ code: "journal_failed", message: "disk full" })))
      .toBe("grant store journal_failed: disk full")
    expect(formatError(new GrantStoreError({ code: "store_closed" }))).toBe("grant store store_closed")
  })

  it("escapes controls in a required permission rendering", () => {
    const rendered = formatError(permissionRequired({
      requestId: "req\t\u0001",
      capability: makeCapability("fs:write", "/x\r\nFORGED"),
      tier: "sealed"
    }))

    expect(rendered).toBe(
      "permission_required: fs:write:/x\\r\\nFORGED (tier sealed, request req\\t\\u0001)"
    )
    expect(rendered).not.toMatch(/[\r\n]/)
  })

  it("escapes controls in a denied permission rendering", () => {
    const rendered = formatError(
      permissionDenied(makeCapability("fs:write", "/x\u007f"), "denied\r\nSECOND\u0085")
    )

    expect(rendered).toBe("permission_denied: fs:write:/x\\u007F: denied\\r\\nSECOND\\u0085")
    expect(rendered).not.toMatch(/[\r\n]/)
  })

  it("escapes controls in a grant-store rendering", () => {
    const rendered = formatError(
      new GrantStoreError({ code: "journal_failed", message: "disk\tfull\u0000\r\n" })
    )

    expect(rendered).toBe("grant store journal_failed: disk\\tfull\\u0000\\r\\n")
    expect(rendered).not.toMatch(/[\r\n]/)
  })

  it.each([
    ["\u202E", "\\u202E"],
    ["\u2028", "\\u2028"],
    ["\u2029", "\\u2029"],
    ["\u200B\u200C\u200D\u200E\u200F", "\\u200B\\u200C\\u200D\\u200E\\u200F"],
    ["\u202A\u202B\u202C\u202D", "\\u202A\\u202B\\u202C\\u202D"],
    ["\u2066\u2067\u2068\u2069\uFEFF", "\\u2066\\u2067\\u2068\\u2069\\uFEFF"],
    ["\u00AD\u061C\u{1BCA0}", "\\u00AD\\u061C\\uD82F\\uDCA0"]
  ])("escapes Unicode format characters and separators %j", (raw, escaped) => {
    const error = permissionDenied(makeCapability("fs:write", `/x${raw}`), `no${raw}`)
    expect(formatError(error)).toBe(`permission_denied: fs:write:/x${escaped}: no${escaped}`)
    const projected = toPlatformError({ module: "FileSystem", method: "write", pathOrDescriptor: `/x${raw}`, error })
    expect(projected.message).toBe(
      `PermissionDenied: FileSystem.write (/x${escaped}): permission_denied: fs:write:/x${escaped}: no${escaped}`
    )
    expect(projected.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect(Option.getOrThrow(fromPlatformError(projected))).toBe(error)
    expect(error.capability.resource).toBe(`/x${raw}`)
  })

  it("caps every rendered field with a visible truncation marker", () => {
    const prefix = "permission_denied: fs:write:/workspace/out.txt: "
    const rendered = formatError(permissionDenied(capability, "x".repeat(maxDisplayFieldLength + 20)))

    expect(rendered).toContain("…[truncated]")
    expect(rendered.length).toBe(prefix.length + maxDisplayFieldLength)
  })

  it("preserves ordinary Unicode in rendered fields", () => {
    expect(formatError(permissionDenied(
      makeCapability("fs:write", "/wörk/日本語/🙂"),
      "拒否"
    ))).toBe("permission_denied: fs:write:/wörk/日本語/🙂: 拒否")
  })
})

describe("the PlatformError projection", () => {
  it("normalizes every kernel failure to a `PermissionDenied` system error", () => {
    const error = permissionDenied(capability, "outside the workspace")
    const projected = toPlatformError({
      module: "FileSystem",
      method: "write",
      pathOrDescriptor: "/workspace/out.txt",
      error
    })
    expect(projected).toMatchObject({
      _tag: "PlatformError",
      reason: {
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "write",
        pathOrDescriptor: "/workspace/out.txt"
      }
    })
    expect(projected.message).toContain("outside the workspace")
    expect(Option.getOrThrow(fromPlatformError(projected))).toBe(error)
  })

  it("escapes a filename in the complete platform message and retains its raw resource", () => {
    const resource = "/workspace/out\nFORGED LOG ENTRY\u001b[2J"
    const error = permissionDenied(makeCapability("fs:write", resource), "denied")
    const projected = toPlatformError({ module: "FileSystem", method: "writeFile", pathOrDescriptor: resource, error })
    expect(projected.message).toBe(
      "PermissionDenied: FileSystem.writeFile (/workspace/out\\nFORGED LOG ENTRY\\u001B[2J): " +
        "permission_denied: fs:write:/workspace/out\\nFORGED LOG ENTRY\\u001B[2J: denied"
    )
    expect(projected.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect(Option.getOrThrow(fromPlatformError(projected))).toBe(error)
    expect(error.capability.resource).toBe(resource)
  })

  it.each(["module", "method", "pathOrDescriptor"] as const)("escapes and bounds the projected %s", (field) => {
    const error = permissionDenied(capability, "no")
    const unsafe = Array.from({ length: 0xa0 }, (_, code) => String.fromCharCode(code))
      .join("") + "\u2028\u2029\u202E\u2066\uFEFF"
    for (const character of unsafe) {
      const projected = toPlatformError({ module: "FileSystem", method: "write", error, [field]: character })
      expect(projected.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    }
    for (const unit of ["x", "\u202E", "\u{1BCA0}"]) {
      const projected = toPlatformError({
        module: "FileSystem",
        method: "write",
        error,
        [field]: unit.repeat(10_000)
      })
      if (projected.reason._tag !== "PermissionDenied") throw new Error("expected PermissionDenied")
      expect(projected.reason[field]).toMatch(/…\[truncated\]$/)
      expect(String(projected.reason[field]).length).toBeLessThanOrEqual(maxDisplayFieldLength)
      expect(projected.message.length).toBeLessThanOrEqual(maxDisplayFieldLength + 100)
      expect(projected.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    }
  })

  it("preserves numeric file descriptors", () => {
    const projected = toPlatformError({
      module: "FileSystem",
      method: "write",
      pathOrDescriptor: 0,
      error: permissionDenied(capability, "no")
    })
    expect(projected.reason).toHaveProperty("pathOrDescriptor", 0)
    expect(projected.message).toContain("FileSystem.write (0)")
  })

  it("omits `pathOrDescriptor` when the operation names no path", () => {
    const error = new GrantStoreError({ code: "store_closed" })
    const projected = toPlatformError({ module: "ChildProcessSpawner", method: "spawn", error })
    expect(projected.reason).not.toHaveProperty("pathOrDescriptor")
    expect(Option.getOrThrow(fromPlatformError(projected))).toBe(error)
  })

  it("recovers nothing from unrelated platform reason tags", () => {
    const system: PlatformError = systemError({ _tag: "NotFound", module: "FileSystem", method: "readFile" })
    expect(fromPlatformError(system)).toStrictEqual(Option.none())
    expect(fromPlatformError(badArgument({ module: "FileSystem", method: "readFile" })))
      .toStrictEqual(Option.none())
  })

  it("recovers a complete foreign cause without establishing provenance", () => {
    const cause = { _tag: "@smthrs/capability/GrantStoreError", code: "store_closed" }
    const foreign = systemError({ _tag: "PermissionDenied", module: "foreign", method: "x", cause })
    expect(Option.getOrThrow(fromPlatformError(foreign))).toBe(cause)
  })

  it("does not inspect the cause of a foreign system-error reason", () => {
    const foreign = systemError({
      _tag: "Unknown",
      module: "m",
      method: "x",
      cause: { _tag: "@smthrs/capability/PermissionDenied" }
    })

    expect(fromPlatformError(foreign)).toStrictEqual(Option.none())
  })

  it("does not unwrap a forged permission request whose meta field is missing", () => {
    const forged = systemError({
      _tag: "PermissionDenied",
      module: "m",
      method: "x",
      cause: {
        _tag: "@smthrs/capability/PermissionRequired",
        code: "permission_required",
        requestId: "r1",
        capability: { action: "fs:read", resource: "/a" },
        tier: "sealed"
      }
    })

    expect(fromPlatformError(forged)).toStrictEqual(Option.none())
  })
})

describe("the package barrel", () => {
  it("exposes both namespaces", () => {
    expect(Index.Capability.format(capability)).toBe("fs:write:/workspace/out.txt")
    expect(Index.Permission.permissionDenied(capability, "no").code).toBe("permission_denied")
  })
})
