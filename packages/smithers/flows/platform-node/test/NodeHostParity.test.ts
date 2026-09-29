import { expect, it } from "@effect/vitest"
import { HostServiceIds } from "@smthrs/kernel/HostServices"
import { Effect, Path } from "effect"
import * as NativePath from "node:path"
import * as NodeHost from "../src/NodeHost.ts"

it("identifies every host implementation", () => {
  expect(Object.keys(NodeHost.implementationIds).sort()).toEqual([...HostServiceIds].sort())
  // Every bundle installs the proxy-aware egress client, not the raw Undici pool.
  expect(NodeHost.implementationIds["effect/HttpClient"]).toBe("@smthrs/platform-node/EgressHttpClient")
})
it.effect("uses native path semantics for absolute filesystem paths", () =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const root = process.cwd()
    expect(path.sep).toBe(NativePath.sep)
    expect(path.isAbsolute(root)).toBe(true)
    expect(path.resolve(root, "..", "next")).toBe(NativePath.resolve(root, "..", "next"))
    expect(path.join(root, "nested", "file.ts")).toBe(NativePath.join(root, "nested", "file.ts"))
  }).pipe(Effect.provide(NodeHost.layerAt(process.cwd()))))

it("refuses invalid roots with the NodeHost error before composition", () => {
  for (const factory of [NodeHost.layerAt, NodeHost.layerContainedAt]) {
    for (const root of ["", "relative", "x".repeat(1000)]) {
      expect(() => factory(root)).toThrow(NodeHost.NodeHostError)
      try {
        factory(root)
      } catch (error) {
        expect(error).toMatchObject({
          _tag: "@smthrs/platform-node/NodeHostError",
          name: "NodeHostError",
          code: "invalid_repository_root"
        })
        expect((error as Error).message.length).toBeLessThan(200)
      }
    }
    expect(factory("/repo")).toBeDefined()
  }
})
