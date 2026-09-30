import { expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { FlowEngine, FlowProxy, FlowProxyServer, Hosts } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const flow = Flow.make("resume-poll/flow", { payload: {}, body: () => Node.succeed(undefined) })
const options = [undefined, {}, { poll: false }, { poll: true }] as const
type ResumeOptions = { readonly poll?: boolean | undefined } | undefined

// Observe only the encoded admission boundary: no execution is launched by a
// resume-options test. Real runtime quarantine is covered by the native-host
// process regression; these tests isolate local and served transport fidelity.
const observer = (calls: Array<readonly [string, ResumeOptions]>) =>
  FlowEngine.makeUnsafe({
    resume: (_flow, id, request) =>
      Effect.sync(() => {
        calls.push([id, request])
      })
  } as FlowEngine.Encoded)

it.effect("forwards omitted, default, explicit false and poll resumes to the local encoded runtime", () =>
  Effect.gen(function*() {
    const calls: Array<readonly [string, ResumeOptions]> = []
    const runtime = observer(calls)
    for (const request of options) yield* runtime.resume(flow, "local", request)
    expect(calls).toEqual(options.map((request) => ["local", request]))
  }))

it.effect("forwards placed poll resumes through the served remote RPC boundary", () =>
  withCrypto(Effect.scoped(Effect.gen(function*() {
    const calls: Array<readonly [string, ResumeOptions]> = []
    const recordedRuntime = observer(calls)
    const remoteRuntime = {
      ...recordedRuntime,
      resume: (flow: Flow.Any, id: string, request?: ResumeOptions) =>
        recordedRuntime.resume(flow, id, request).pipe(
          Effect.provideService(Hosts.Hosts, { resolve: () => ({ _tag: "Here" as const }) })
        )
    }
    const group = FlowProxy.toRpcGroup([flow])
    const served = FlowProxyServer.layerRpcHandlers([flow]).pipe(
      Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime)(remoteRuntime))
    )
    const client = yield* RpcTest.makeClient(group).pipe(Effect.provide(served))
    const localCalls: Array<readonly [string, ResumeOptions]> = []
    const runtime = observer(localCalls)
    const hosts = { resolve: () => ({ _tag: "Proxy" as const, connect: () => Effect.succeed(client) }) }
    for (const request of options) {
      yield* runtime.resume(flow, "remote", request).pipe(Effect.provideService(Hosts.Hosts, hosts))
    }
    expect(localCalls).toHaveLength(0)
    expect(calls.map(([id, request]) => [id, request?.poll])).toEqual([
      ["remote", undefined],
      ["remote", undefined],
      ["remote", false],
      ["remote", true]
    ])
  }))))

it("carries the poll flag through RPC and HTTP resume schemas and rejects malformed flags", () => {
  const rpc = FlowProxy.toRpcGroup([flow])
  const http = FlowProxy.toHttpApiGroup("flows", [flow])
  const schemas = [
    rpc.requests.get(`${flow._tag}Resume`)!.payloadSchema,
    http.endpoints[`${flow._tag}Resume`]!.payload.get("application/json")!.schemas[0]
  ]
  for (const schema of schemas) {
    const decode = Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)
    for (const poll of [false, true]) expect(decode({ executionId: "remote", poll })).toMatchObject({ poll })
    expect(decode({ executionId: "remote" })).toMatchObject({ executionId: "remote" })
    for (const poll of [null, "true", 1]) expect(() => decode({ executionId: "remote", poll })).toThrow()
  }
})
