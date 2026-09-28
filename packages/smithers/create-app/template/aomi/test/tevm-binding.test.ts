/** Regression tests for the binding boundary; the SDK is replaced, never the binding or service. */
import * as Cell from "@smthrs/harness/Cell"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Tools } from "../TOOLS.ts"
import { ForkInput, layerTevm, makeMock, MineInput, SimulateInput, Tevm, tevmSource } from "../tools/tevm.ts"

const sdk = vi.hoisted(() => {
  const request = vi.fn()
  const ready = vi.fn()
  const http = vi.fn(() => () => ({ request }))
  return { request, ready, http }
})

vi.mock("tevm", () => ({
  http: sdk.http,
  createMemoryClient: () => ({
    tevmReady: sdk.ready,
    getBalance: async () => 1n,
    getChainId: async () => 1,
    getBlock: async () => ({ number: 20_000_000n, hash: "0x1234" })
  }),
  formatEther: () => "0.000000000000000001",
  decodeErrorResult: vi.fn(),
  parseAbi: vi.fn(),
  // The repository gate aliases tevm/common to the same absent-SDK module.
  createCommon: (value: unknown) => value,
  mainnet: { id: 1 }
}))

const address = "0x1111111111111111111111111111111111111111"
const configured = "https://rpc.example:8443/private-key"
const service = () => Effect.runPromise(Effect.provide(Tevm, layerTevm({ rpcUrl: configured })))

const bindingsOf = (chain = makeMock()) => Effect.runPromise(tevmSource(Context.make(Tevm, chain)).bindings())
const call = async (name: string, input: typeof Schema.Json.Type, chain = makeMock()) => {
  const binding = (await bindingsOf(chain)).find((entry) => entry.descriptor.name === `tevm/${name}`)!
  return Effect.runPromise(binding.run(
    new Cell.Call({
      flowName: binding.descriptor.name,
      input,
      capabilities: binding.descriptor.capabilities,
      effects: binding.descriptor.effects,
      placement: Option.none(),
      identity: new Cell.CallIdentity({
        session: "tevm-regression",
        frame: 0,
        cell: "test",
        ordinal: 0,
        declaration: "test",
        layers: []
      })
    })
  ))
}

beforeEach(() => {
  vi.clearAllMocks()
  sdk.request.mockReset().mockResolvedValue("0x1")
  sdk.ready.mockReset().mockResolvedValue(undefined)
})

afterEach(() => vi.unstubAllEnvs())

describe("connection recovery", () => {
  test.each(["transport", "ready"])("retries a transient %s failure on the same layer", async (stage) => {
    const cause = new Error("temporary RPC failure")
    if (stage === "transport") sdk.request.mockRejectedValueOnce(cause)
    else sdk.ready.mockRejectedValueOnce(cause)
    const chain = await service()
    const failure = await Effect.runPromise(Effect.flip(chain.getBalance({ address })))
    expect(failure._tag).toBe("aomi/tools/TevmError")
    expect(failure.message).toContain("tevm/fork")
    await expect(Effect.runPromise(chain.getBalance({ address }))).resolves.toMatchObject({ wei: "1" })
    expect(sdk.http.mock.calls).toEqual([[configured], [configured]])
    expect(sdk.request).toHaveBeenCalledTimes(2)
    await Effect.runPromise(chain.getBalance({ address }))
    expect(sdk.request).toHaveBeenCalledTimes(2)
  })
})

describe("bounded inputs", () => {
  test.each([0, -1, 1.5, 257, 1e10])("mine refuses blocks=%s as invalid_input", async (blocks) => {
    await expect(call("mine", { blocks })).resolves.toMatchObject({ outcome: "failure", code: "invalid_input" })
  })

  test.each([-1, 0.5, 86401, 1e10])("mine refuses intervalSeconds=%s as invalid_input", async (intervalSeconds) => {
    await expect(call("mine", { intervalSeconds })).resolves.toMatchObject({
      outcome: "failure",
      code: "invalid_input"
    })
  })

  test("simulate refuses more than 256 calls before reaching the service", async () => {
    const simulate = vi.fn(makeMock().simulate)
    await expect(
      call(
        "simulate",
        { calls: Array.from({ length: 257 }, () => ({ to: address, data: "0x" })) },
        makeMock({ simulate })
      )
    )
      .resolves.toMatchObject({ outcome: "failure", code: "invalid_input" })
    expect(simulate).not.toHaveBeenCalled()
  })

  test("accepts defaults and inclusive bounds", async () => {
    expect(Schema.decodeUnknownSync(MineInput)({})).toEqual({})
    for (const blocks of [1, 256]) {
      for (const intervalSeconds of [0, 86400]) {
        await expect(call("mine", { blocks, intervalSeconds })).resolves.toMatchObject({ outcome: "success" })
      }
    }
    for (const length of [0, 256]) {
      const calls = Array.from({ length }, () => ({ to: address, data: "0x" }))
      expect(Schema.decodeUnknownSync(SimulateInput)({ calls }).calls).toHaveLength(length)
    }
  })

  test.each([NaN, Infinity, -Infinity])("mine rejects non-finite inputs %s", (value) => {
    for (const input of [{ blocks: value }, { intervalSeconds: value }]) {
      expect(() => Schema.decodeUnknownSync(MineInput)(input)).toThrow()
    }
  })

  test("a residual mock allocation error is a typed TevmError", async () => {
    const effect = makeMock().mine({ blocks: 1e10 })
    await expect(Effect.runPromise(Effect.flip(effect))).resolves.toMatchObject({ _tag: "aomi/tools/TevmError" })
  })
})

describe("host-selected fork endpoint", () => {
  test("the model-facing fork schema has no rpcUrl", () => {
    expect(Object.keys(ForkInput.fields)).toEqual(["blockTag"])
  })

  test("fork ignores a model-supplied URL and uses configuration", async () => {
    const chain = await service()
    await expect(call("fork", { rpcUrl: "http://169.254.169.254/latest/meta-data", blockTag: "latest" }, chain))
      .resolves.toMatchObject({ outcome: "success" })
    expect(sdk.http.mock.calls).toEqual([[configured]])
  })

  test("every real binding declares only the configured origin, including lazy-open mutations", async () => {
    const bindings = await bindingsOf(await service())
    for (const binding of bindings) {
      expect(binding.descriptor.capabilities, binding.descriptor.name).toEqual(["net:post:https://rpc.example:8443/*"])
    }
  })

  test("uses TEVM_FORK_RPC_URL when no option is supplied", async () => {
    vi.stubEnv("TEVM_FORK_RPC_URL", configured)
    const chain = await Effect.runPromise(Effect.provide(Tevm, layerTevm({})))
    await expect(call("fork", {}, chain)).resolves.toMatchObject({ outcome: "success" })
    expect(sdk.http.mock.calls).toEqual([[configured]])
    for (const binding of await bindingsOf(chain)) {
      expect(binding.descriptor.capabilities).toEqual(["net:post:https://rpc.example:8443/*"])
    }
  })

  test("host options take precedence over the environment", async () => {
    vi.stubEnv("TEVM_FORK_RPC_URL", "https://other.example")
    const chain = await service()
    await expect(call("fork", {}, chain)).resolves.toMatchObject({ outcome: "success" })
    expect(sdk.http.mock.calls).toEqual([[configured]])
  })

  test("fork refuses missing configuration even if the model supplies a URL", async () => {
    vi.stubEnv("TEVM_FORK_RPC_URL", undefined)
    const chain = await Effect.runPromise(Effect.provide(Tevm, layerTevm({})))
    await expect(call("fork", { rpcUrl: "http://169.254.169.254" }, chain))
      .resolves.toMatchObject({ outcome: "failure", code: "flow_failed" })
    expect(sdk.http).not.toHaveBeenCalled()
  })

  test("the root mock composition grants only the flow write", () => {
    expect(Tools.grant).toEqual([{ action: "fs:write", resource: "/flows/**" }])
  })

  test("mock bindings need no network grant", async () => {
    for (const binding of await bindingsOf()) expect(binding.descriptor.capabilities).toEqual([])
  })
})
