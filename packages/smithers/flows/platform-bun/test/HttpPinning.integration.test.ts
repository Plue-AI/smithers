// Keep the shared socket contracts in the persistent Bun host lane.
import "../../../agent/std/test/HttpPinning.integration.test.ts"
import "../../../agent/std/test/HttpPinningProxy.integration.test.ts"
import "../../../agent/std/test/HttpPrivate.test.ts"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, it } from "vitest"
import * as Fetch from "../../../agent/std/src/Fetch.ts"
import { ResolveHost } from "../../../agent/std/src/internal/HttpNetwork.ts"
import * as BunHost from "../src/BunHost.ts"

it("BunHost pins a granted hostname through the public web tool", async () => {
  const hosts: Array<string | undefined> = []
  const server = createServer((request, response) => {
    hosts.push(request.headers.host)
    response.end("bun host")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://bun-host.invalid:${port}`
  try {
    const output = await Effect.runPromise(
      Fetch.run({ url: origin }).pipe(
        Effect.provideService(ResolveHost, () => Effect.succeed(["127.0.0.1"])),
        Effect.provide(BunHost.layerHttpClient),
        Effect.provide(
          GrantStore.layer({
            attended: false,
            rules: [
              new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
              new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:private", resource: origin }) })
            ]
          }).pipe(Layer.provide(Workspace.layer("/workspace")))
        )
      )
    )
    expect(output.body).toBe("bun host")
    expect(hosts).toEqual([`bun-host.invalid:${port}`])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
