import { CapabilityPattern, make } from "@smthrs/capability/Capability"
import { PermissionDenied, Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Fetch from "../src/Fetch.ts"
import * as HttpPost from "../src/HttpPost.ts"
import { guarded, refusal, ResolveHost } from "../src/internal/HttpNetwork.ts"
import * as WebFetch from "../src/WebFetch.ts"

// Mock clients perform no I/O; explicitly opt these policy fixtures into the contract.
const HttpClient = {
  ...KernelHttpClient,
  make: (...args: Parameters<typeof KernelHttpClient.make>) =>
    KernelHttpClient.withDestinationPinning(KernelHttpClient.make(...args))
}

const cases = [
  ["loopback IPv4", "http://127.0.0.1/private"],
  ["link-local IPv4", "http://169.254.169.254/latest/meta-data"],
  ["private IPv4", "http://10.1.2.3/private"],
  ["private 172 IPv4", "http://172.16.0.1/private"],
  ["private 192 IPv4", "http://192.168.1.1/private"],
  ["loopback IPv6", "http://[::1]/private"],
  ["unique-local IPv6", "http://[fd00::1]/private"],
  ["link-local IPv6", "http://[fe80::1]/private"],
  ["multicast IPv6", "http://[ff02::1]/private"],
  ["unspecified IPv6", "http://[::]/private"],
  ["mapped loopback IPv4", "http://[::ffff:127.0.0.1]/private"],
  ["expanded mapped loopback IPv4", "http://[0:0:0:0:0:ffff:7f00:1]/private"],
  ["shared IPv4", "http://100.64.1.1/private"],
  ["benchmark IPv4", "http://198.18.0.1/private"],
  ["multicast IPv4", "http://224.0.0.1/private"],
  ["localhost", "http://localhost/private"]
] as const

const publicLiterals = [
  "http://11.0.0.1/public",
  "http://172.15.255.255/public",
  "http://172.32.0.1/public",
  "http://192.167.255.255/public",
  "http://192.169.0.1/public",
  "http://169.255.0.1/public",
  "http://[2606:4700:4700::1111]/public",
  "http://[::ffff:93.184.216.34]/public"
] as const

const tools = [
  ["fetch", (url: string) => Effect.asVoid(Fetch.run({ url }))],
  ["http-post", (url: string) => Effect.asVoid(HttpPost.run({ url, body: "{}" }))],
  ["webfetch", (url: string) => Effect.asVoid(WebFetch.run({ url, format: "text" }))]
] as const

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined

const transport = () => {
  const requests: Array<string> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url)
      return HttpClientResponse.fromWeb(
        request,
        new Response("ok", {
          headers: { "content-type": "text/plain" }
        })
      )
    })
  )
  return { client, requests }
}

const grantRules = (rules: ReadonlyArray<Rule>) =>
  GrantStore.layer({
    attended: false,
    rules
  }).pipe(Layer.provide(Workspace.layer("/workspace")))

const grant = (origin: string) =>
  grantRules([
    new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
    new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:post", resource: "*" }) }),
    new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:private", resource: origin }) })
  ])

const ordinaryGrant = () =>
  grantRules([
    new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
    new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:post", resource: "*" }) })
  ])

describe("HTTP tools private network boundary", () => {
  it.each(tools)("%s refuses every private literal without a grant", async (_name, run) => {
    for (const [_kind, url] of cases) {
      const { client, requests } = transport()
      const exit = await Effect.runPromise(Effect.exit(
        run(url).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(ordinaryGrant())
        )
      ))
      expect(failureOf(exit), `${_kind}: ${url}`).toMatchObject({ code: "permission_denied" })
      expect(requests, `${_kind}: ${url}`).toHaveLength(0)
    }
  })

  it.each(tools)("%s refuses private and mixed DNS answers before dispatch", async (_name, run) => {
    for (const addresses of [["10.0.0.2"], ["93.184.216.34", "169.254.169.254"]]) {
      const { client, requests } = transport()
      const exit = await Effect.runPromise(Effect.exit(
        run("https://example.test/private").pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(ResolveHost, () => Effect.succeed(addresses)),
          Effect.provide(ordinaryGrant())
        )
      ))
      expect(failureOf(exit), addresses.join(",")).toMatchObject({ code: "permission_denied" })
      expect(requests, addresses.join(",")).toHaveLength(0)
    }
  })

  it.each(tools)("%s sends a public DNS answer", async (_name, run) => {
    const { client, requests } = transport()
    const exit = await Effect.runPromise(Effect.exit(
      run("https://example.test/public").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"])),
        Effect.provide(ordinaryGrant())
      )
    ))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(requests).toEqual(["https://example.test/public"])
  })

  it.each(tools)("%s sends only public address literals", async (_name, run) => {
    for (const url of publicLiterals) {
      const { client, requests } = transport()
      let resolved = 0
      const exit = await Effect.runPromise(Effect.exit(
        run(url).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(ResolveHost, () => {
            resolved++
            return Effect.succeed(["10.0.0.1"])
          }),
          Effect.provide(ordinaryGrant())
        )
      ))
      expect(Exit.isSuccess(exit), url).toBe(true)
      expect(requests, url).toEqual([new URL(url).toString()])
      expect(resolved, url).toBe(0)
    }
  })

  it.each(tools)("%s fails closed when DNS is empty or errors", async (_name, run) => {
    for (const resolve of [() => Effect.succeed([]), () => Effect.fail(new Error("DNS failed"))]) {
      const { client, requests } = transport()
      const exit = await Effect.runPromise(Effect.exit(
        run("https://example.test/unresolved").pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(ResolveHost, resolve),
          Effect.provide(ordinaryGrant())
        )
      ))
      expect(failureOf(exit)).toMatchObject({ code: "request_failed" })
      expect(requests).toHaveLength(0)
    }
  })

  it.each(tools)("%s accepts only an explicit private origin grant", async (_name, run) => {
    for (const [_kind, url] of cases) {
      const { client, requests } = transport()
      const exit = await Effect.runPromise(Effect.exit(
        run(url).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(grant(new URL(url).origin))
        )
      ))
      expect(Exit.isSuccess(exit), url).toBe(true)
      expect(requests, url).toEqual([new URL(url).toString()])
    }
  })

  it.each(tools)("%s accepts private DNS with an exact origin grant", async (_name, run) => {
    const { client, requests } = transport()
    const url = "https://private.test:8443/resource"
    const exit = await Effect.runPromise(Effect.exit(
      run(url).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ResolveHost, () => Effect.succeed(["10.0.0.1"])),
        Effect.provide(grant("https://private.test:8443"))
      )
    ))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(requests).toEqual([url])
  })

  it.each(tools)("%s refuses a different private origin and ordinary network wildcard grants", async (_name, run) => {
    const url = "http://127.0.0.1:8080/private"
    for (
      const layer of [
        grant("http://127.0.0.1:8081"),
        grantRules([
          new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
          new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:post", resource: "*" }) })
        ]),
        grantRules([new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:*", resource: "*" }) })]),
        grantRules([new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "*", resource: "**" }) })])
      ]
    ) {
      const { client, requests } = transport()
      const exit = await Effect.runPromise(Effect.exit(
        run(url).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(layer)
        )
      ))
      expect(failureOf(exit)).toMatchObject({ code: "permission_denied" })
      expect(requests).toHaveLength(0)
    }
  })

  it.each(tools)("%s checks ordinary network authority before DNS", async (_name, run) => {
    const { client, requests } = transport()
    let resolutions = 0
    const exit = await Effect.runPromise(Effect.exit(
      run("https://private.test/resource").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ResolveHost, () => {
          resolutions++
          return Effect.succeed(["10.0.0.1"])
        }),
        Effect.provide(grantRules([
          new Rule({
            effect: "allow",
            pattern: new CapabilityPattern({ action: "net:private", resource: "https://private.test" })
          })
        ]))
      )
    ))
    expect(failureOf(exit)).toMatchObject({ code: "permission_denied" })
    expect(resolutions).toBe(0)
    expect(requests).toHaveLength(0)
  })

  it.each(tools)("%s refuses a redirect from a public host to a private origin", async (_name, run) => {
    const requests: Array<string> = []
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url)
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:8080/private" }
          })
        )
      })
    )
    const exit = await Effect.runPromise(Effect.exit(
      run("https://example.test/start").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"])),
        Effect.provide(ordinaryGrant())
      )
    ))
    expect(failureOf(exit)).toMatchObject({ code: "permission_denied" })
    expect(requests).toEqual(["https://example.test/start"])
  })

  it("interrupts pending DNS resolution without dispatch", async () => {
    const { client, requests } = transport()
    const interrupted = await Effect.runPromise(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const fiber = yield* Fetch.run({ url: "https://pending.test/" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ResolveHost, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never)
          )),
        Effect.provide(ordinaryGrant()),
        Effect.forkChild
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }))
    expect(Exit.isFailure(interrupted)).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it("returns a typed refusal for an invalid URL at the client guard", async () => {
    const { client, requests } = transport()
    const exit = await Effect.runPromise(Effect.exit(
      guarded(client).execute(HttpClientRequest.get("file:///etc/passwd")).pipe(Effect.provide(ordinaryGrant()))
    ))
    const failure = failureOf(exit)
    expect(refusal(failure)).toMatchObject({ code: "invalid_input" })
    expect(requests).toHaveLength(0)
  })

  it("leaves an unrelated transport failure available to the request error mapper", () => {
    const request = HttpClientRequest.get("https://example.test/")
    const error = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: new Error("connection reset") })
    })
    expect(refusal(error)).toBeUndefined()
    expect(refusal(new Error("unrelated"))).toBeUndefined()
    const permission = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        cause: new PermissionDenied({
          code: "permission_denied",
          capability: make("net:get", "example.test"),
          reason: "missing grant"
        })
      })
    })
    expect(refusal(permission)).toMatchObject({
      code: "permission_denied",
      message: "HTTP permission was refused"
    })
  })

  it("uses the default DNS resolver for an ordinary hostname", async () => {
    const { client, requests } = transport()
    const exit = await Effect.runPromise(Effect.exit(
      Fetch.run({ url: "http://localhost.localdomain/" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(ordinaryGrant())
      )
    ))
    expect(["request_failed", "permission_denied"]).toContain(failureOf(exit)?.code)
    expect(requests).toHaveLength(0)
  })

  it("the default resolver returns every local DNS answer", async () => {
    const addresses = await Effect.runPromise(Effect.gen(function*() {
      const resolve = yield* ResolveHost
      return yield* resolve("localhost")
    }))
    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses.every((address) => address === "127.0.0.1" || address === "::1")).toBe(true)
  })

  it("returns a typed input error when a private origin exceeds the capability resource limit", async () => {
    const { client, requests } = transport()
    const url = `https://${"a".repeat(4081)}.localhost/private`
    const exit = await Effect.runPromise(Effect.exit(
      Fetch.run({ url }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(ordinaryGrant())
      )
    ))
    expect(failureOf(exit)).toMatchObject({ code: "invalid_input" })
    expect(requests).toHaveLength(0)
  })
})
