/**
 * Destination policy shared by the web tools, including every redirect hop.
 *
 * @since 1.0.0
 */

import * as Capability from "@smthrs/capability/Capability"
import { GrantStore } from "@smthrs/kernel/GrantStore"
import {
  authorizePreflight,
  Destination,
  fromHttpClientError,
  supportsDestinationPinning
} from "@smthrs/kernel/HttpClient"
import { Context, Effect, Option } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import * as StdError from "../StdError.ts"
import { parseHttpUrl } from "./Url.ts"

/** Resolver seam: all addresses must be public before an unprivileged request.
 * @since 1.0.0
 * @private
 */
export const ResolveHost = Context.Reference<
  (hostname: string) => Effect.Effect<ReadonlyArray<string>, unknown>
>("@smthrs/std/HttpNetwork/ResolveHost", {
  defaultValue: () => (hostname) =>
    Effect.tryPromise(async () => (await lookup(hostname, { all: true })).map((a) => a.address))
})

const blocked = new BlockList()
for (
  const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["192.0.0.0", 24],
    ["100.64.0.0", 10],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ] as const
) blocked.addSubnet(address, prefix, "ipv4")
// Allow global IPv6 and mapped IPv4 only, excluding transition tunnels.
const publicV6 = new BlockList()
publicV6.addSubnet("2000::", 3, "ipv6")
publicV6.addSubnet("::ffff:0:0", 96, "ipv6")
blocked.addSubnet("2002::", 16, "ipv6")
blocked.addSubnet("2001::", 32, "ipv6")

const isPublic = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, "ipv4")
  return family === 6 && publicV6.check(address, "ipv6") && !blocked.check(address, "ipv6")
}

const failure = (code: StdError.Code, message: string, path: string) => new StdError.StdError({ code, message, path })

const check = Effect.fn("HttpNetwork.check")(function*(value: string, client: HttpClient.HttpClient) {
  const url = parseHttpUrl(value)
  if (url === undefined) {
    return yield* Effect.fail(failure("invalid_input", "URL must use http or https without user information", value))
  }
  if (!supportsDestinationPinning(client)) {
    return yield* Effect.fail(failure("unsupported", "HTTP host must support destination pinning", value))
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const local = hostname.replace(/\.$/, "").toLowerCase()
  const literal = isIP(hostname) !== 0
  const localhost = local === "localhost" || local.endsWith(".localhost")
  const resolve = yield* ResolveHost
  // Refuse localhost before DNS unless the origin is explicitly authorized.
  const privateGrant = Effect.gen(function*() {
    const store = yield* GrantStore
    const capability = yield* Effect.try({
      try: () => Capability.make("net:private", url.origin),
      catch: () => failure("invalid_input", "Private HTTP origin exceeds the capability resource limit", value)
    })
    yield* store.check(capability).pipe(
      Effect.mapError(() =>
        failure("permission_denied", "Private HTTP destination requires a net:private grant", value)
      )
    )
  })
  if (localhost) yield* privateGrant
  const addresses = literal ? [hostname] : [
    ...yield* resolve(hostname).pipe(
      Effect.mapError(() => failure("request_failed", "Could not resolve HTTP destination", value))
    )
  ]
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
    return yield* Effect.fail(failure("request_failed", "HTTP destination has no valid addresses", value))
  }
  if (!localhost && !addresses.every(isPublic)) yield* privateGrant
  return Object.freeze({ origin: url.origin, addresses: Object.freeze(addresses) })
})

/** Decorates the supplied client before following redirects through the guard.
 * The transport must honor manual redirects, as required by the kernel client.
 * @since 1.0.0
 * @private
 */
export const guarded = (
  client: HttpClient.HttpClient,
  follow = true
): HttpClient.HttpClient.With<HttpClientError.HttpClientError, GrantStore> => {
  const checked = HttpClient.transform(
    client,
    (execute, request) =>
      authorizePreflight(
        request,
        check(request.url, client).pipe(
          Effect.mapError((cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause, description: cause.message })
            })
          ),
          Effect.flatMap((destination) =>
            Effect.updateContext(execute, (context: Context.Context<never>) =>
              Context.add(Context.add(context, Destination, destination), FetchHttpClient.RequestInit, {
                ...Context.getOrUndefined(context, FetchHttpClient.RequestInit),
                redirect: "manual"
              }))
          )
        )
      )
  )
  return follow ? HttpClient.followRedirects(checked) : checked
}

/** Recovers the typed refusal carried through Effect's HTTP error channel.
 * @since 1.0.0
 * @private
 */
export const refusal = (error: unknown): StdError.StdError | undefined => {
  if (!(error instanceof HttpClientError.HttpClientError) || error.reason._tag !== "TransportError") return undefined
  if (error.reason.cause instanceof StdError.StdError) return error.reason.cause
  if (Option.isSome(fromHttpClientError(error))) {
    return failure(
      "permission_denied",
      error.reason.description ?? "HTTP permission was refused",
      error.reason.request.url
    )
  }
  return undefined
}
