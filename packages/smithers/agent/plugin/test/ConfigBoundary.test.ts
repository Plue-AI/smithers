import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as Config from "../src/Config.ts"
import * as Boundary from "../src/internal/Boundary.ts"
import * as Kernel from "../src/Kernel.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("plugin configuration snapshots", () => {
  it.each([Config.FlowsConfig, Config.ResolvedConfig])(
    "schemas enforce admission and construct frozen snapshots",
    (schema) => {
      const source = { feature: { enabled: true } }
      const decoded = Schema.decodeUnknownSync(schema)(source)
      expect(decoded).not.toBe(source)
      expect(decoded["feature"]).not.toBe(source.feature)
      expect(Object.isFrozen(decoded)).toBe(true)
      expect(Object.isFrozen(decoded["feature"])).toBe(true)
      expect(Schema.encodeSync(schema)(decoded)).toBe(decoded)
      expect(Schema.is(schema)(decoded)).toBe(true)
      for (const raw of [source, Object.freeze({}), null, false]) expect(Schema.is(schema)(raw)).toBe(false)
      for (
        const input of [{ engine: { retry: 3 } }, { feature: undefined }, {
          big: "x".repeat(Config.maximumConfigBytes)
        }]
      ) {
        expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow()
      }
    }
  )

  it("admits only patch data and retains unchanged frozen subtrees", async () => {
    // 4,002 nodes: the aggregate member bound precludes a valid 10k-node tree.
    const base = await run(Config.resolve({
      extension: Object.fromEntries(
        Array.from({ length: 2_000 }, (_, index) => [`key${index}`, { value: "x".repeat(240) }])
      )
    }))
    const encode = vi.spyOn(TextEncoder.prototype, "encode")
    const record = vi.spyOn(Boundary, "record")
    const patch = { enabled: true }
    let inputs: Array<unknown>
    let merged: Config.FlowsConfig
    let calls: number
    try {
      merged = Config.merge(base, patch)
      calls = encode.mock.calls.length
      inputs = record.mock.calls.map(([input]) => input)
    } finally {
      encode.mockRestore()
      record.mockRestore()
    }
    expect(inputs).toEqual([patch])
    expect(calls).toBeLessThanOrEqual(2)
    expect(merged["extension"]).toBe(base["extension"])
    expect(Object.isFrozen(merged)).toBe(true)
    expect(await run(Config.resolve(merged))).toBe(merged)
  })

  it("uses the same descriptor-only refusal contract through both schemas", () => {
    const getter = vi.fn(() => true)
    const shared = { value: 1 }
    const cycle: Record<string, unknown> = {}
    cycle["self"] = cycle
    for (const schema of [Config.FlowsConfig, Config.ResolvedConfig]) {
      for (
        const input of [
          null,
          [],
          { value: Number.NaN },
          { value: "\ud800" },
          { a: shared, b: shared },
          cycle,
          Object.defineProperty({}, "secret", { get: getter, enumerable: true }),
          JSON.parse("{\"extension\":{\"__proto__\":true}}"),
          Object.fromEntries(Array.from({ length: Config.maximumConfigMembers + 1 }, (_, i) => [`key${i}`, 0]))
        ]
      ) expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it("keeps admission work linear in the initial config plus constant hook patches", async () => {
    // Port of performance-1.ts: assert admission work instead of wall time.
    const input = {
      extension: Object.fromEntries(Array.from({ length: 2_048 }, (_, i) => [`key${i}`, "x".repeat(240)]))
    }
    const patches = Array.from({ length: 32 }, () => ({ enabled: true }))
    const record = vi.spyOn(Boundary, "record")
    let inputs: Array<unknown>
    try {
      const kernel = await run(Kernel.make(
        patches.map((patch, i) => ({
          name: `p${i}`,
          hooks: { config: () => Effect.succeed(patch) }
        })),
        input
      ))
      expect(kernel.config["extension"]).toEqual(input.extension)
      inputs = record.mock.calls.map(([value]) => value)
    } finally {
      record.mockRestore()
    }
    expect(inputs).toEqual([input, ...patches])
  })

  it("copies snapshot references in patches and still refuses repeated patch references", async () => {
    const base = await run(Config.resolve({ stable: { inner: { value: 1 } }, list: [{ value: 2 }] }))
    const patch = { moved: base["stable"], list: base["list"] }
    const merged = Config.merge(base, patch)
    expect(merged["stable"]).toBe(base["stable"])
    expect(merged["moved"]).toEqual(base["stable"])
    expect(merged["moved"]).not.toBe(base["stable"])
    expect(merged["list"]).not.toBe(base["list"])
    expect(Boundary.record(merged).ok).toBe(true)
    expect(() => Config.merge(base, { first: base["stable"], second: base["stable"] })).toThrow(/repeated/)
    expect(() => Config.merge({ first: base["stable"]!, second: base["stable"]! }, {})).toThrow(/repeated/)
    const nested = await run(Config.resolve({ copy: { stable: { inner: { value: 1 } } } }))
    expect(Boundary.record(Config.merge(base, nested)).ok).toBe(true)
    expect(Boundary.record(Config.merge(base, base)).ok).toBe(true)
    expect(Config.merge(base, undefined)).toBe(base)
    expect(Config.merge(Config.defaults, {})).toEqual({})
  })

  it("rechecks promoted snapshot namespaces and never trusts caller freezing", async () => {
    const base = await run(Config.resolve({ extension: { engine: { retry: 3 } } }))
    expect(() => Config.merge(base["extension"] as Config.FlowsConfig, {})).toThrow(/runtime-policy/)
    const input = Object.freeze({ nested: { enabled: true } })
    const copy = Config.merge(input, {})
    input.nested.enabled = false
    expect(copy["nested"]).toEqual({ enabled: true })
    expect(Object.isFrozen(copy["nested"])).toBe(true)
  })

  it("enforces the merged byte bound across cached arrays and record subtrees", async () => {
    const base = await run(Config.resolve({ extension: Array.from({ length: 16 }, () => "x".repeat(65_000)) }))
    expect(() => Config.merge(base, { extra: "x".repeat(10_000) })).toThrow(/byte limit/)
    const replaced = Config.merge(base, { extension: [], extra: "x".repeat(10_000) })
    expect(Boundary.record(replaced).ok).toBe(true)
    expect(Object.isFrozen(replaced["extension"])).toBe(true)
  })

  it("detaches caller data before apply and config hooks observe it", async () => {
    const source = { feature: { enabled: true }, values: [{ count: 1 }] }
    const patches = { contributed: { value: 1 } }
    const kernel = await run(Kernel.make([
      {
        name: "snapshot",
        apply: (config) => {
          source.feature.enabled = false
          source.values[0]!.count = 2
          expect(config["feature"]).toEqual({ enabled: true })
          expect(config["values"]).toEqual([{ count: 1 }])
          return true
        },
        hooks: { config: () => Effect.succeed(patches) }
      }
    ], source))
    patches.contributed.value = 2
    expect(kernel.config).toEqual({ feature: { enabled: true }, values: [{ count: 1 }], contributed: { value: 1 } })
    expect(Object.isFrozen(kernel.config)).toBe(true)
    expect(Object.isFrozen((kernel.config["values"] as ReadonlyArray<unknown>)[0])).toBe(true)
  })

  it("refuses prototype-control keys without changing any prototype", async () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const input = JSON.parse(`{"safe":{"${key}":{"enabled":true}}}`)
      const error = await run(Config.resolve(input).pipe(Effect.flip))
      expect(error).toMatchObject({ code: "config_invalid", path: `$.safe.${key}` })
      expect(({} as { enabled?: boolean }).enabled).toBeUndefined()
    }
  })

  it("never executes accessors and sanitizes reflection failures", async () => {
    const getter = vi.fn(() => "secret")
    const input = Object.defineProperty({}, "secret", { get: getter, enumerable: true })
    const error = await run(Config.resolve(input).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "config_invalid", path: "$.secret" })
    expect(error.message).not.toContain("secret")
    expect(getter).not.toHaveBeenCalled()

    const proxy = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("private trap")
      }
    })
    const proxyError = await run(Config.resolve(proxy).pipe(Effect.flip))
    expect(proxyError.code).toBe("config_invalid")
    expect(proxyError.message).not.toContain("private")
  })

  it("refuses cycles, exotic values, undefined members, and non-finite numbers", async () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (
      const value of [
        cycle,
        { value: new Date() },
        { value: new Map() },
        { value: new Set() },
        { value: new Uint8Array([1]) },
        { value: undefined },
        { value: Number.NaN }
      ]
    ) {
      expect((await run(Config.resolve(value as never).pipe(Effect.flip))).code).toBe("config_invalid")
    }
  })

  it("enforces the published depth and byte ceilings", async () => {
    let deep: unknown = 1
    for (let index = 0; index <= Config.maximumConfigDepth; index++) deep = { next: deep }
    expect(await run(Config.resolve({ deep } as never).pipe(Effect.flip))).toMatchObject({ code: "config_invalid" })
    expect(await run(Config.resolve({ large: "x".repeat(Config.maximumConfigBytes) }).pipe(Effect.flip))).toMatchObject(
      {
        code: "config_invalid"
      }
    )
  })

  it("re-admits a merged config so aggregate member bounds cannot be bypassed", () => {
    const base = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`base${index}`, index]))
    const patch = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`patch${index}`, index]))
    let error: unknown

    try {
      Config.merge(base, patch)
    } catch (cause) {
      error = cause
    }

    expect(error).toMatchObject({ code: "config_invalid", path: "$" })
  })

  it("still returns a deeply merged and frozen config after result admission", () => {
    const merged = Config.merge(
      { feature: { enabled: true, nested: { left: 1 } }, stable: [1, 2] },
      { feature: { label: "ready", nested: { right: 2 } } }
    )

    expect(merged).toEqual({
      feature: { enabled: true, label: "ready", nested: { left: 1, right: 2 } },
      stable: [1, 2]
    })
    expect(Object.isFrozen(merged)).toBe(true)
    expect(Object.isFrozen(merged["feature"])).toBe(true)
    expect(Object.isFrozen((merged["feature"] as { readonly nested: unknown }).nested)).toBe(true)
  })

  it("stops the config waterfall before a later hook can observe an over-limit merge", async () => {
    const initial = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`base${index}`, index]))
    const patch = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`patch${index}`, index]))
    const observedMembers: Array<number> = []
    const error = await run(
      Kernel.make([
        {
          name: "expander",
          hooks: { config: () => Effect.succeed(patch) }
        },
        {
          name: "observer",
          hooks: {
            config: (config) =>
              Effect.sync(() => {
                observedMembers.push(Object.keys(config).length)
                return {}
              })
          }
        }
      ], initial).pipe(Effect.flip)
    )

    // The refusal is attributed to the handler whose patch crossed the bound,
    // and the next handler never runs, so nothing observes the oversized value.
    expect(error).toMatchObject({ code: "config_invalid", path: "$", plugin: "expander", hook: "config" })
    expect(observedMembers).toEqual([])
  })

  it("keeps post-waterfall config failures small, located, and value-free for journalling", async () => {
    const offendingValue = "journal-secret-value"
    const invalid = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, {
      token: offendingValue
    })
    const error = await run(
      Kernel.make([{
        name: "invalid-config",
        hooks: { config: () => Effect.succeed({ invalid } as never) }
      }]).pipe(Effect.flip)
    )
    const encoded = JSON.stringify(error)

    expect(error).toMatchObject({ code: "config_invalid", path: "$.invalid" })
    expect(error.path?.length).toBeGreaterThan(0)
    expect(error.message).toContain("ordinary record")
    // Plugin failures are journalled, so one refusal must not retain a schema
    // tree or other kilobyte-scale diagnostic payload.
    expect(encoded.length).toBeLessThan(512)
    expect(encoded).not.toContain(offendingValue)
  })

  it("deepFreeze is a detached JSON snapshot rather than a shallow caller freeze", () => {
    const source = [{ nested: { value: 1 } }]
    const frozen = Config.deepFreeze(source)
    expect(frozen).not.toBe(source)
    expect(frozen[0]).not.toBe(source[0])
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen[0]?.nested)).toBe(true)
    source[0]!.nested.value = 2
    expect(frozen[0]?.nested.value).toBe(1)
    expect(() => Config.deepFreeze(new Date() as never)).toThrow()
  })
})
