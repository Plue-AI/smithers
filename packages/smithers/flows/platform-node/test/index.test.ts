/** Barrel parity with the platform-browser and platform-bun packages. */
import { describe, expect, it } from "@effect/vitest"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"
import * as Index from "../src/index.ts"
import * as NodeHost from "../src/NodeHost.ts"
import * as ScopedProcess from "../src/ScopedProcess.ts"

describe("@smthrs/platform-node barrel", () => {
  it("re-exports every module as a namespace", () => {
    expect(Object.keys(Index).sort()).toEqual([
      "EgressHttpClient",
      "HostLiveness",
      "NodeHost",
      "ProcessConfinement",
      "ProcessReaper",
      "ProcessSandbox",
      "ScopedProcess"
    ])
    expect(Index.NodeHost.layer).toBe(NodeHost.layer)
    expect(Index.NodeHost.layerAt).toBe(NodeHost.layerAt)
    expect(Index.NodeHost.layerContained).toBe(NodeHost.layerContained)
    expect(Index.NodeHost.layerContainedAt).toBe(NodeHost.layerContainedAt)
    expect(Index.EgressHttpClient.layer).toBe(EgressHttpClient.layer)
    expect(Index.NodeHost.EgressHttpClient).toBe(EgressHttpClient)
    expect(Index.ScopedProcess.spawn).toBe(ScopedProcess.spawn)
    expect(Index.ScopedProcess.status).toBe(ScopedProcess.status)
  })
})
