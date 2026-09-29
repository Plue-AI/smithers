import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, Layer } from "effect"
import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import * as EgressHttpClient from "../../../flows/platform-node/src/EgressHttpClient.ts"
import * as Fetch from "../src/Fetch.ts"
import * as HttpPost from "../src/HttpPost.ts"
import * as WebFetch from "../src/WebFetch.ts"

const servers: Array<Server> = []

const listen = async (handler: RequestListener): Promise<string> => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
        server.closeAllConnections()
      })
    )
  )
})

const grant = (...origins: ReadonlyArray<string>) =>
  GrantStore.layer({
    attended: false,
    rules: origins.map((origin) =>
      new Rule({
        effect: "allow",
        pattern: new CapabilityPattern({ action: "net:private", resource: origin })
      })
    ).concat([
      new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
      new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:post", resource: "*" }) })
    ])
  }).pipe(Layer.provide(Workspace.layer("/workspace")))

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined

const tools = [
  ["fetch", (url: string) => Effect.asVoid(Fetch.run({ url }))],
  ["http-post", (url: string) => Effect.asVoid(HttpPost.run({ url, body: "{}" }))],
  ["webfetch", (url: string) => Effect.asVoid(WebFetch.run({ url, format: "text" }))]
] as const

describe("HTTP private network with real sockets", () => {
  it.each(tools)("%s blocks localhost before any request and sends it with an explicit origin grant", async (
    _name,
    run
  ) => {
    let hits = 0
    const origin = await listen((_request, response) => {
      hits++
      response.writeHead(200, { "content-type": "text/plain" }).end("local ok")
    })
    const url = `${origin}/private`
    const denied = await Effect.runPromise(Effect.exit(
      run(url).pipe(
        Effect.provide(EgressHttpClient.layer({})),
        Effect.provide(grant())
      )
    ))
    expect(failureOf(denied)).toMatchObject({ code: "permission_denied" })
    expect(hits).toBe(0)

    const allowed = await Effect.runPromise(
      run(url).pipe(
        Effect.provide(EgressHttpClient.layer({})),
        Effect.provide(grant(origin))
      )
    )
    expect(allowed).toBeUndefined()
    expect(hits).toBe(1)
  })

  it.each(tools)("%s stops a redirect to another private origin before opening its socket", async (_name, run) => {
    let firstHits = 0
    let secondHits = 0
    const second = await listen((_request, response) => {
      secondHits++
      response.writeHead(200, { "content-type": "text/plain" }).end("should not arrive")
    })
    const first = await listen((_request, response) => {
      firstHits++
      response.writeHead(302, { location: `${second}/private` }).end()
    })
    const exit = await Effect.runPromise(Effect.exit(
      run(`${first}/start`).pipe(
        Effect.provide(EgressHttpClient.layer({})),
        Effect.provide(grant(first))
      )
    ))
    expect(failureOf(exit)).toMatchObject({ code: "permission_denied" })
    expect(firstHits).toBe(1)
    expect(secondHits).toBe(0)
  })

  it("keeps the private check when the kernel HTTP grant layer is also installed", async () => {
    let hits = 0
    const origin = await listen((_request, response) => {
      hits++
      response.writeHead(200, { "content-type": "text/plain" }).end("kernel ok")
    })
    const store = GrantStore.layer({
      attended: false,
      rules: [
        new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
        new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:private", resource: origin }) })
      ]
    }).pipe(Layer.provide(Workspace.layer("/workspace")))
    const result = await Effect.runPromise(
      Fetch.run({ url: `${origin}/private` }).pipe(
        Effect.provide(HttpClient.layer),
        Effect.provide(EgressHttpClient.layer({})),
        Effect.provide(store)
      )
    )
    expect(result.body).toBe("kernel ok")
    expect(hits).toBe(1)
  })
})
