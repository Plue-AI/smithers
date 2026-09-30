import * as NodeHttp from "node:http"
import * as NodeNet from "node:net"
import * as NodeTimers from "node:timers"
import { describe, expect, it, vi } from "vitest"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"

describe("Secret declarations", () => {
  it("names the environment variable and nothing else", () => {
    expect(Secret.Secret("SMITHERS_CACHE_TOKEN")).toEqual({
      _tag: "Secret",
      env: "SMITHERS_CACHE_TOKEN"
    })
  })

  it("does not carry the value, even when the variable is set", () => {
    process.env["SECRET_DECLARATION_PROBE"] = "super-secret"
    try {
      const declaration = Secret.Secret("SECRET_DECLARATION_PROBE")
      expect(declaration).toEqual({ _tag: "Secret", env: "SECRET_DECLARATION_PROBE" })
      expect(JSON.stringify(declaration)).not.toContain("super-secret")
    } finally {
      delete process.env["SECRET_DECLARATION_PROBE"]
    }
  })

  it("trims and accepts a portable variable name", () => {
    expect(Secret.Secret("  NPM_TOKEN  ").env).toBe("NPM_TOKEN")
    expect(Secret.Secret("_private").env).toBe("_private")
  })

  it("refuses anything that is not an environment variable name", () => {
    expect(() => Secret.Secret("")).toThrow(/environment variable name/)
    expect(() => Secret.Secret("has-dash")).toThrow(/environment variable name/)
    expect(() => Secret.Secret("1LEADING_DIGIT")).toThrow(/environment variable name/)
    expect(() => Secret.Secret("has space")).toThrow(/environment variable name/)
    expect(() => Secret.Secret("A".repeat(Secret.maximumNameLength + 1))).toThrow(/bounded well-formed/)
    expect(() => Secret.Secret(7 as never)).toThrow(/must be a string/)
  })

  it("recognises its own declarations and nothing else", () => {
    expect(Secret.isSecret(Secret.Secret("NPM_TOKEN"))).toBe(true)
    expect(Secret.isSecret({ _tag: "Secret", env: "NPM_TOKEN" })).toBe(true)
    expect(Secret.isSecret({ _tag: "Secret" })).toBe(false)
    expect(Secret.isSecret(null)).toBe(false)
    expect(Secret.isSecret("NPM_TOKEN")).toBe(false)
    expect(Secret.isSecret({ _tag: "Secret", env: "NPM_TOKEN", extra: true })).toBe(false)
    expect(Secret.isSecret({ _tag: "Secret", env: " NPM_TOKEN " })).toBe(false)
    expect(Secret.isSecret({ _tag: "Secret", env: "NPM_TOKEN", fallback: "" })).toBe(false)
  })

  it("rejects hostile option and guard objects without invoking them", () => {
    let calls = 0
    const accessor = Object.defineProperty({}, "fallback", {
      enumerable: true,
      get: () => {
        calls += 1
        return "value"
      }
    })
    const proxy = new Proxy({ fallback: "value" }, {
      ownKeys: (target) => {
        calls += 1
        return Reflect.ownKeys(target)
      }
    })
    const forged = Object.defineProperty({ env: "NPM_TOKEN" }, "_tag", {
      enumerable: true,
      get: () => {
        calls += 1
        return "Secret"
      }
    })
    expect(() => Secret.Secret("NPM_TOKEN", accessor)).toThrow(/data property/)
    expect(() => Secret.Secret("NPM_TOKEN", proxy)).toThrow(/plain object/)
    expect(() => Secret.Secret("NPM_TOKEN", null as never)).toThrowError(
      new TypeError("Secret options must be a plain object")
    )
    expect(() => Secret.Secret("NPM_TOKEN", new Date() as never)).toThrow(/plain object/)
    expect(() => Secret.Secret("NPM_TOKEN", { typo: true } as never)).toThrowError(
      new TypeError("Secret received unknown option \"typo\"")
    )
    expect(() => Secret.Secret("NPM_TOKEN", { fallback: 1 as never })).toThrow(/bounded non-empty/)
    expect(() => Secret.Secret("NPM_TOKEN", { [Symbol("extra")]: true } as never)).toThrow(/symbol/)
    expect(Secret.isSecret(forged)).toBe(false)
    expect(Secret.isSecret(proxy)).toBe(false)
    expect(calls).toBe(0)
  })

  it("binds credentials to normalized exact origins", () => {
    const source = Secret.Secret("NPM_TOKEN")
    const credential = Secret.HttpSecret(source, ["https://REGISTRY.NPMJS.ORG:443", "http://127.0.0.1:8080"])
    expect(credential).toEqual({
      _tag: "HttpCredential",
      secret: source,
      audiences: ["https://registry.npmjs.org", "http://127.0.0.1:8080"]
    })
    expect(Object.isFrozen(credential)).toBe(true)
    expect(Object.isFrozen(credential.audiences)).toBe(true)
    expect(Secret.isHttpCredential(credential)).toBe(true)
  })

  it("rejects ambiguous, insecure, duplicate, and malformed audiences", () => {
    const source = Secret.Secret("NPM_TOKEN")
    for (
      const audience of [
        "http://registry.npmjs.org",
        "https://user@example.test",
        "https://example.test/path",
        "https://example.test/?query=1",
        "not a url"
      ]
    ) expect(() => Secret.HttpSecret(source, [audience])).toThrow(/audience|origin/)
    expect(() => Secret.HttpSecret(source, [])).toThrow(/between 1/)
    expect(() => Secret.HttpSecret(source, ["https://example.test", "https://EXAMPLE.test:443"]))
      .toThrow(/duplicate/)
    expect(() => Secret.HttpSecret({ _tag: "Secret", env: "bad name" } as never, ["https://example.test"]))
      .toThrow(/secret declaration/)
    expect(Secret.isHttpCredential({
      _tag: "HttpCredential",
      secret: source,
      audiences: ["http://example.test"]
    })).toBe(false)
  })

  it("rejects hostile audience collections without invoking them", () => {
    const source = Secret.Secret("NPM_TOKEN")
    let calls = 0
    const accessor = Object.defineProperty([], "0", {
      enumerable: true,
      get: () => {
        calls += 1
        return "https://example.test"
      }
    })
    const proxy = new Proxy(["https://example.test"], {
      ownKeys: (target) => {
        calls += 1
        return Reflect.ownKeys(target)
      }
    })
    expect(() => Secret.HttpSecret(source, accessor as Array<string>)).toThrow(/text data/)
    expect(() => Secret.HttpSecret(source, proxy)).toThrow(/between 1/)
    expect(Secret.isHttpCredential(
      new Proxy({
        _tag: "HttpCredential",
        secret: source,
        audiences: ["https://example.test"]
      }, {})
    )).toBe(false)
    expect(calls).toBe(0)
  })
})

describe("Secret.normalizeAudience", () => {
  it("never echoes a rejected audience, so embedded credentials stay out of the message", () => {
    const cases = [
      "https://api.example.test/?token=SYNTHETIC_TOKEN",
      "https://user:SYNTHETIC_PASSWORD@api.example.test",
      "http://user:SYNTHETIC_PASSWORD@api.example.test/#SYNTHETIC_FRAGMENT",
      "not a url SYNTHETIC_TOKEN"
    ]
    for (const audience of cases) {
      let message = ""
      try {
        Secret.normalizeAudience(audience)
      } catch (error) {
        message = String((error as Error).message)
      }
      expect(message).not.toBe("")
      expect(message).not.toContain("SYNTHETIC_")
      expect(message).not.toContain("api.example.test")
    }
  })
})

describe("SecretProxy vault", () => {
  const audience = "https://api.example.test"
  const token = Secret.HttpSecret(Secret.Secret("VAULT_TEST_TOKEN"), [audience])

  it("mints an unguessable placeholder and reuses it per declaration", () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    expect(vault.isEmpty()).toBe(true)
    const first = vault.mint(token)
    const second = vault.mint(token)
    expect(first).toBe(second)
    expect(vault.isEmpty()).toBe(false)
    expect(first.startsWith(Secret.placeholderPrefix)).toBe(true)
    expect(first).toHaveLength(Secret.placeholderPrefix.length + Secret.placeholderBytes * 2)
  })

  it("mints a different placeholder per vault, so one run's token is not another's", () => {
    const left = SecretProxy.makeVault({ read: () => "value" }).mint(token)
    const right = SecretProxy.makeVault({ read: () => "value" }).mint(token)
    expect(left).not.toBe(right)
  })

  it("substitutes lazily, reading the host only when a request needs it", () => {
    let reads = 0
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return "real-value"
      }
    })
    const placeholder = vault.mint(token)
    expect(reads).toBe(0)
    expect(vault.request(audience).substitute(`Bearer ${placeholder}`)).toBe("Bearer real-value")
    expect(reads).toBe(1)
  })

  it("leaves text without a placeholder untouched and reads nothing", () => {
    let reads = 0
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return "real-value"
      }
    })
    vault.mint(token)
    expect(vault.request(audience).substitute("nothing to see")).toBe("nothing to see")
    expect(reads).toBe(0)
  })

  it("substitutes nothing when no placeholder was minted", () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const foreign = `${Secret.placeholderPrefix}${"a".repeat(64)}`
    expect(vault.request(audience).substitute(foreign)).toBe(foreign)
  })

  it("refuses to substitute a placeholder this vault never minted", () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    vault.mint(token)
    // A well-formed placeholder from somewhere else. Substitution is a
    // capability: holding the exact minted string is what earns the value.
    const forged = `${Secret.placeholderPrefix}${"b".repeat(Secret.placeholderBytes * 2)}`
    expect(vault.request(audience).substitute(forged)).toBe(forged)
  })

  it("fails when the declared secret has no value on this host", () => {
    for (const read of [() => undefined, () => ""]) {
      const vault = SecretProxy.makeVault({ read })
      const placeholder = vault.mint(token)
      expect(() => vault.request(audience).substitute(placeholder)).toThrow(SecretProxy.SecretUnavailable)
      expect(() => vault.request(audience).substitute(placeholder)).toThrow(/VAULT_TEST_TOKEN is not set/)
    }
  })

  it("refuses unbounded or control-bearing host values", () => {
    for (const value of ["line\nbreak", "x".repeat(SecretProxy.maximumSecretValueBytes + 1), 7 as never]) {
      const vault = SecretProxy.makeVault({ read: () => value })
      const placeholder = vault.mint(token)
      expect(() => vault.request(audience).substitute(placeholder)).toThrow(SecretProxy.SecretValueInvalid)
    }
  })

  it("uses a declared public fallback only at substitution time", () => {
    let reads = 0
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return undefined
      }
    })
    const placeholder = vault.mint(Secret.HttpSecret(
      Secret.Secret("VAULT_FALLBACK", { fallback: "public-value" }),
      [audience]
    ))
    expect(reads).toBe(0)
    expect(vault.request(audience).substitute(placeholder)).toBe("public-value")
    expect(reads).toBe(1)
  })

  it("substitutes header records, single and repeated", () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const placeholder = vault.mint(token)
    expect(
      vault.request(audience).substituteHeaders({
        authorization: `Bearer ${placeholder}`,
        "x-repeated": [placeholder, "plain"],
        "x-absent": undefined
      })
    ).toEqual({
      authorization: "Bearer real-value",
      "x-repeated": ["real-value", "plain"]
    })
  })

  it("reads process.env by default", () => {
    const vault = SecretProxy.makeVault()
    const placeholder = vault.mint(Secret.HttpSecret(Secret.Secret("VAULT_DEFAULT_READ"), [audience]))
    process.env["VAULT_DEFAULT_READ"] = "from-process"
    try {
      expect(vault.request(audience).substitute(placeholder)).toBe("from-process")
    } finally {
      delete process.env["VAULT_DEFAULT_READ"]
    }
  })

  it("denies a mismatched audience before reading the host", () => {
    let reads = 0
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return "real-value"
      }
    })
    const placeholder = vault.mint(token)
    expect(() => vault.request("https://attacker.example").substitute(placeholder))
      .toThrow(SecretProxy.SecretAudienceDenied)
    expect(reads).toBe(0)
  })

  it("resolves each credential once per request and redacts it from responses", () => {
    let reads = 0
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return "real-value"
      }
    })
    const placeholder = vault.mint(token)
    const request = vault.request(audience)
    expect(request.substitute(`${placeholder}/${placeholder}`)).toBe("real-value/real-value")
    expect(reads).toBe(1)
    expect(request.redact("echo real-value")).toBe(`echo ${placeholder}`)
    expect(request.redactBytes(Buffer.from("echo real-value"))).toEqual(Buffer.from(`echo ${placeholder}`))
  })

  it("resolves destination sources without minting a child credential", () => {
    const source = Secret.Secret("DESTINATION_URL")
    const vault = SecretProxy.makeVault({ read: () => "https://rpc.example.test" })
    expect(vault.resolve(source)).toBe("https://rpc.example.test")
    expect(vault.isEmpty()).toBe(true)
  })

  it("rejects hostile vault options before any reader can run", () => {
    let calls = 0
    const accessor = Object.defineProperty({}, "read", {
      enumerable: true,
      get: () => {
        calls += 1
        return () => "value"
      }
    })
    expect(() => SecretProxy.makeVault(null as never)).toThrow(/plain/)
    expect(() => SecretProxy.makeVault({ read: "value" as never })).toThrow(/function/)
    expect(() => SecretProxy.makeVault({ typo: true } as never)).toThrow(/unknown/)
    expect(() => SecretProxy.makeVault(accessor)).toThrow(/data property/)
    expect(calls).toBe(0)
  })

  it("rejects forged bindings, declarations, and request origins", () => {
    const vault = SecretProxy.makeVault({ read: () => "value" })
    expect(() => vault.mint({} as never)).toThrow(/HTTP credential binding/)
    expect(() => vault.resolve({} as never)).toThrow(/secret declaration/)
    expect(() => vault.request("not a URL")).toThrow(/must be an HTTP origin/)
    expect(() => vault.request("https://api.example.test/path")).toThrow(/exact HTTP origin/)
    expect(() => vault.request("ftp://api.example.test")).toThrow(/exact HTTP origin/)
  })
})

/** Sends one request through the proxy and resolves what the upstream saw. */
const throughProxy = async (
  vault: SecretProxy.Vault,
  requestFor: (
    origin: string
  ) => {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body?: string
    readonly path?: string
    readonly responseBody?: string
    readonly responseHeaders?: Record<string, string>
  }
): Promise<{
  readonly status: number
  readonly headers: NodeHttp.IncomingHttpHeaders
  readonly body: string
  readonly path: string
  readonly responseBody: string
  readonly responseHeaders: NodeHttp.IncomingHttpHeaders
}> => {
  let seen: { headers: NodeHttp.IncomingHttpHeaders; body: string; path: string } | undefined
  let prepared:
    | {
      readonly method: string
      readonly headers: Record<string, string>
      readonly body?: string
      readonly path?: string
      readonly responseBody?: string
      readonly responseHeaders?: Record<string, string>
    }
    | undefined
  const upstream = NodeHttp.createServer((incoming, response) => {
    const chunks: Array<Buffer> = []
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
    incoming.on("end", () => {
      seen = {
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        path: incoming.url ?? ""
      }
      response.writeHead(200, { "content-type": "text/plain", ...prepared?.responseHeaders })
        .end(prepared?.responseBody ?? "upstream-ok")
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddress = upstream.address()
  if (upstreamAddress === null || typeof upstreamAddress === "string") throw new Error("no upstream port")
  const origin = `http://127.0.0.1:${upstreamAddress.port}`
  const request = requestFor(origin)
  prepared = request
  const proxy = await SecretProxy.startProxy(vault)
  try {
    const proxyPort = Number(new URL(proxy.endpoint).port)
    const result = await new Promise<{
      status: number
      responseBody: string
      responseHeaders: NodeHttp.IncomingHttpHeaders
    }>((resolve, reject) => {
      const outgoing = NodeHttp.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: request.method,
        path: `${origin}${request.path ?? "/target?q=1"}`,
        headers: request.headers
      }, (response) => {
        const chunks: Array<Buffer> = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            responseBody: Buffer.concat(chunks).toString("utf8"),
            responseHeaders: response.headers
          }))
      })
      outgoing.on("error", reject)
      outgoing.end(request.body)
    })
    return {
      status: result.status,
      responseBody: result.responseBody,
      responseHeaders: result.responseHeaders,
      headers: seen?.headers ?? {},
      body: seen?.body ?? "",
      path: seen?.path ?? ""
    }
  } finally {
    await proxy.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
}

// Use a real watchdog even when the proxy deadline runs on a fake clock.
const boundedProxyRequest = (
  endpoint: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> =>
  new Promise((resolve) => {
    const outgoing = NodeHttp.request({
      host: "127.0.0.1",
      port: Number(new URL(endpoint).port),
      path,
      headers
    }, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => {
        NodeTimers.clearTimeout(watchdog)
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
      })
      response.on("error", (error) => {
        NodeTimers.clearTimeout(watchdog)
        resolve({ status: 0, body: error.message })
      })
    })
    const watchdog = NodeTimers.setTimeout(() => {
      resolve({ status: 0, body: "proxy did not settle within 2 seconds" })
      outgoing.destroy()
    }, 2_000)
    outgoing.on("error", (error) => {
      NodeTimers.clearTimeout(watchdog)
      resolve({ status: 0, body: error.message })
    })
    outgoing.end()
  })

/** Sends one CONNECT through the proxy and returns the first response bytes. */
const connectThrough = (endpoint: string, authority: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port: Number(new URL(endpoint).port) }, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    socket.setEncoding("utf8")
    let received = ""
    socket.on("data", (chunk: string) => {
      received += chunk
      // A refusal closes the socket after its body; an open tunnel does not.
      if (received.startsWith("HTTP/1.1 200") && received.includes("\r\n\r\n")) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.once("end", () => resolve(received))
    socket.once("error", reject)
  })

describe("SecretProxy server", () => {
  const token = Secret.Secret("PROXY_TEST_TOKEN")

  it("binds loopback only", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      expect(proxy.endpoint.startsWith("http://127.0.0.1:")).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  it("turns a secret destination into a loopback capability and resolves it lazily", async () => {
    let requests = 0
    const upstream = NodeHttp.createServer((_request, response) => {
      requests += 1
      response.end("destination-ok")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    if (address === null || typeof address === "string") throw new Error("no upstream port")
    let reads = 0
    const destination = `http://127.0.0.1:${address.port}/rpc?network=test`
    const vault = SecretProxy.makeVault({
      read: () => {
        reads += 1
        return destination
      }
    })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_DESTINATION_URL"))
      expect(capability).not.toContain(destination)
      expect(new URL(capability).hostname).toBe("127.0.0.1")
      expect(reads).toBe(0)
      const body = await new Promise<string>((resolve, reject) => {
        NodeHttp.get(capability, (response) => {
          const chunks: Array<Buffer> = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        }).on("error", reject)
      })
      expect(body).toBe("destination-ok")
      expect(requests).toBe(1)
      expect(reads).toBe(1)
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("replaces the placeholder in request headers on the way out", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const result = await throughProxy(vault, (origin) => {
      const placeholder = vault.mint(Secret.HttpSecret(token, [origin]))
      return { method: "GET", headers: { authorization: `Bearer ${placeholder}` } }
    })
    expect(result.status).toBe(200)
    expect(result.path).toBe("/target?q=1")
    expect(result.headers["authorization"]).toBe("Bearer real-value")
    expect(result.responseBody).toBe("upstream-ok")
  })

  it("replaces the placeholder in a text request body", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const result = await throughProxy(vault, (origin) => {
      const placeholder = vault.mint(Secret.HttpSecret(token, [origin]))
      return {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: placeholder })
      }
    })
    expect(JSON.parse(result.body)).toEqual({ token: "real-value" })
    expect(result.headers["content-length"]).toBe(String(result.body.length))
  })

  it("replaces placeholders in the request path at the same origin", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const result = await throughProxy(vault, (origin) => {
      const placeholder = vault.mint(Secret.HttpSecret(token, [origin]))
      return { method: "GET", headers: {}, path: `/target?token=${placeholder}` }
    })
    expect(result.status).toBe(200)
    expect(result.path).toBe("/target?token=real-value")
  })

  it("denies a credential sent to another origin before contacting it", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const result = await throughProxy(vault, () => {
      const placeholder = vault.mint(Secret.HttpSecret(token, ["https://api.example.test"]))
      return { method: "GET", headers: { authorization: `Bearer ${placeholder}` } }
    })
    expect(result.status).toBe(403)
    expect(result.responseBody).toMatch(/not authorized/)
    expect(result.headers["authorization"]).toBeUndefined()
  })

  it("replaces a resolved credential echoed in response headers and body", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    let placeholder = ""
    const result = await throughProxy(vault, (origin) => {
      placeholder = vault.mint(Secret.HttpSecret(token, [origin]))
      return {
        method: "GET",
        headers: { authorization: `Bearer ${placeholder}` },
        responseHeaders: { "x-echo": "real-value" },
        responseBody: "echo real-value"
      }
    })
    expect(result.status).toBe(200)
    expect(result.responseBody).toBe(`echo ${placeholder}`)
    expect(result.responseHeaders["x-echo"]).toBe(placeholder)
  })

  it("answers 502 when the declared secret is missing rather than sending a placeholder", async () => {
    const vault = SecretProxy.makeVault({ read: () => undefined })
    const result = await throughProxy(vault, (origin) => {
      const placeholder = vault.mint(Secret.HttpSecret(token, [origin]))
      return { method: "GET", headers: { authorization: `Bearer ${placeholder}` } }
    })
    expect(result.status).toBe(502)
    expect(result.responseBody).toMatch(/PROXY_TEST_TOKEN is not set/)
    expect(result.headers["authorization"]).toBeUndefined()
  })

  it("refuses a request that is not in absolute proxy form", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const port = Number(new URL(proxy.endpoint).port)
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = NodeHttp.request({ host: "127.0.0.1", port, path: "/relative" }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        outgoing.on("error", reject)
        outgoing.end()
      })
      expect(status).toBe(400)
    } finally {
      await proxy.close()
    }
  })

  it.each(["real-value", "ECONNREFUSED"])(
    "preserves and redacts the upstream error code (secret: %s)",
    async (value) => {
      const vault = SecretProxy.makeVault({ read: () => value })
      const placeholder = vault.mint(Secret.HttpSecret(token, ["http://127.0.0.1:1"]))
      const proxy = await SecretProxy.startProxy(vault)
      try {
        const result = await boundedProxyRequest(proxy.endpoint, "http://127.0.0.1:1/unreachable", {
          authorization: `Bearer ${placeholder}`
        })
        expect(result.status).toBe(502)
        expect(result.body).toBe(`upstream request failed: ${value === "ECONNREFUSED" ? placeholder : "ECONNREFUSED"}`)
        expect(result.body).not.toContain(value)
      } finally {
        await proxy.close()
      }
    }
  )

  it("settles the child when the upstream resets after a partial body", async () => {
    const upstream = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" })
      response.write("partial", () => NodeTimers.setTimeout(() => response.destroy(), 20))
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address() as NodeNet.AddressInfo
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    try {
      const result = await boundedProxyRequest(proxy.endpoint, `http://127.0.0.1:${address.port}/`)
      expect(result.status).toBe(502)
      expect(result.body).toBe("upstream request failed: upstream response ended early")
      expect(result.body).not.toContain("partial")
    } finally {
      await proxy.close()
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("enforces the elapsed deadline even while the upstream sends data", async () => {
    let send: NodeHttp.ServerResponse | undefined
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const upstream = NodeHttp.createServer((_request, response) => {
      send = response
      response.writeHead(200)
      response.write("partial", started)
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address() as NodeNet.AddressInfo
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const result = boundedProxyRequest(proxy.endpoint, `http://127.0.0.1:${address.port}/`)
      await ready
      await vi.advanceTimersByTimeAsync(SecretProxy.upstreamTimeoutMs / 2)
      await new Promise<void>((resolve) => send!.write("still active", () => resolve()))
      await vi.advanceTimersByTimeAsync(SecretProxy.upstreamTimeoutMs / 2)
      expect(await result).toEqual({ status: 502, body: "upstream request failed: timed out" })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await proxy.close()
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("rejects an oversized body before buffering or contacting an upstream", async () => {
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    try {
      const port = Number(new URL(proxy.endpoint).port)
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = NodeHttp.request({
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "http://127.0.0.1:1/never-contacted",
          headers: { "content-length": String(SecretProxy.maximumRequestBodyBytes + 1) }
        }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        outgoing.on("error", reject)
        outgoing.end()
      })
      expect(status).toBe(413)
    } finally {
      await proxy.close()
    }
  })

  it("rejects malformed CONNECT authorities and parses bracketed IPv6", async () => {
    expect(SecretProxy.parseConnectAuthority("example.com:443")).toEqual({ host: "example.com", port: 443 })
    expect(SecretProxy.parseConnectAuthority("[::1]:8443")).toEqual({ host: "::1", port: 8443 })
    for (
      const authority of [
        "example.com",
        "example.com:nope",
        "example.com:0",
        "example.com:65536",
        "::1:443",
        "[]:443",
        "[host]:443",
        "[::1]443"
      ]
    ) {
      expect(SecretProxy.parseConnectAuthority(authority)).toBeUndefined()
    }

    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    try {
      const port = Number(new URL(proxy.endpoint).port)
      const response = await new Promise<string>((resolve, reject) => {
        const socket = NodeNet.connect({ host: "127.0.0.1", port }, () => {
          socket.write("CONNECT example.com:not-a-port HTTP/1.1\r\nHost: example.com\r\n\r\n")
        })
        socket.setEncoding("utf8")
        socket.once("data", resolve)
        socket.once("error", reject)
      })
      expect(response.startsWith("HTTP/1.1 400 Bad Request")).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  it("tunnels CONNECT when the vault is empty and pipes bytes both ways", async () => {
    const echo = NodeNet.createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve))
    const echoAddress = echo.address()
    if (echoAddress === null || typeof echoAddress === "string") throw new Error("no echo port")
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    try {
      const port = Number(new URL(proxy.endpoint).port)
      const transcript = await new Promise<string>((resolve, reject) => {
        const socket = NodeNet.connect({ host: "127.0.0.1", port }, () => {
          socket.write(`CONNECT 127.0.0.1:${echoAddress.port} HTTP/1.1\r\nHost: 127.0.0.1:${echoAddress.port}\r\n\r\n`)
        })
        socket.setEncoding("utf8")
        let buffer = ""
        let established = false
        const watchdog = NodeTimers.setTimeout(() => {
          socket.destroy()
          reject(new Error(`tunnel did not echo within 5 seconds: ${JSON.stringify(buffer)}`))
        }, 5_000)
        socket.on("data", (data: string) => {
          buffer += data
          if (!established && buffer.includes("\r\n\r\n")) {
            established = true
            socket.write("ping-through-tunnel")
            return
          }
          if (buffer.includes("ping-through-tunnel")) {
            NodeTimers.clearTimeout(watchdog)
            socket.end()
            resolve(buffer)
          }
        })
        socket.once("error", (error) => {
          NodeTimers.clearTimeout(watchdog)
          reject(error)
        })
      })
      expect(transcript.startsWith("HTTP/1.1 200 Connection Established")).toBe(true)
      expect(transcript.includes("ping-through-tunnel")).toBe(true)
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
  })

  it("answers 502 within the deadline when a CONNECT destination never completes the handshake", async () => {
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const port = Number(new URL(proxy.endpoint).port)
      // 192.0.2.0/24 is TEST-NET-1: reserved and unrouted, so the SYN is
      // never answered. Only the proxy's own connect deadline can settle
      // this child.
      let response = ""
      const socket = NodeNet.connect({ host: "127.0.0.1", port }, () => {
        socket.write("CONNECT 192.0.2.1:443 HTTP/1.1\r\nHost: 192.0.2.1:443\r\n\r\n")
      })
      socket.setEncoding("utf8")
      socket.on("data", (data: string) => {
        response += data
      })
      socket.once("error", () => {})
      // Date and setImmediate are not faked, so these polls stay bounded in
      // real time while the proxy deadline runs on the fake clock.
      const until = async (limitMs: number, condition: () => boolean): Promise<boolean> => {
        const start = Date.now()
        while (!condition() && Date.now() - start < limitMs) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        return condition()
      }
      // Wait for the proxy to register its connect deadline, then advance
      // the fake clock past it. A host that refuses the SYN outright takes
      // the error path to the same 502, so an early response also ends the
      // wait.
      await until(2_000, () => vi.getTimerCount() > 0 || response.length > 0)
      await vi.advanceTimersByTimeAsync(SecretProxy.upstreamTimeoutMs)
      const settled = await until(2_000, () => response.length > 0)
      socket.destroy()
      expect(settled).toBe(true)
      expect(response).toMatch(/^HTTP\/1\.1 502 Bad Gateway/)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      // Without a connect deadline the black-holed upstream keeps
      // proxy.close() from ever settling; bound the wait so the regression
      // fails here instead of hanging the file.
      await Promise.race([
        proxy.close(),
        new Promise<void>((resolve) => NodeTimers.setTimeout(resolve, 3_000))
      ])
    }
  })

  describe("close", () => {
    /** Settles with "settled" once `promise` does, or "pending" after `ms`. */
    const within = (promise: Promise<unknown>, ms: number): Promise<"settled" | "pending"> =>
      Promise.race([
        promise.then(() => "settled" as const),
        new Promise<"pending">((resolve) => NodeTimers.setTimeout(() => resolve("pending"), ms))
      ])
    /** A client that sends `request` to the proxy and never closes on its own. */
    const client = (proxy: SecretProxy.Proxy, request: string) => {
      const socket = NodeNet.connect({
        host: "127.0.0.1",
        port: Number(new URL(proxy.endpoint).port),
        allowHalfOpen: true
      })
      socket.setEncoding("utf8")
      let received = ""
      socket.on("data", (data: string) => {
        received += data
      })
      socket.once("error", () => {})
      // Half-open clients never close on their own: the proxy hanging up is the end of the stream.
      const closed = new Promise<void>((resolve) => {
        socket.once("end", () => resolve())
        socket.once("close", () => resolve())
      })
      socket.once("connect", () => socket.write(request))
      const until = async (text: string) => {
        const start = Date.now()
        while (!received.includes(text)) {
          if (Date.now() - start > 5_000) throw new Error(`no ${JSON.stringify(text)} in ${JSON.stringify(received)}`)
          await new Promise<void>((resolve) => NodeTimers.setTimeout(resolve, 5))
        }
      }
      return { socket, closed, until, received: () => received }
    }

    it("drops an established CONNECT tunnel and its upstream without the client's help", async () => {
      const upstreamSockets = new Set<NodeNet.Socket>()
      const upstreamClosed: Array<Promise<void>> = []
      const upstream = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
        upstreamSockets.add(socket)
        upstreamClosed.push(
          new Promise<void>((resolve) => {
            socket.once("end", () => resolve())
            socket.once("close", () => resolve())
          })
        )
        socket.on("data", () => socket.write("held"))
      })
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
      const port = (upstream.address() as NodeNet.AddressInfo).port
      const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
      const tunnel = client(proxy, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
      try {
        await tunnel.until("\r\n\r\n")
        expect(tunnel.received()).toMatch(/^HTTP\/1\.1 200 Connection Established/)
        tunnel.socket.write("before-close")
        await tunnel.until("held")
        expect(await within(proxy.close(), 2_000)).toBe("settled")
        expect(await within(tunnel.closed, 2_000)).toBe("settled")
        expect(await within(Promise.all(upstreamClosed), 2_000)).toBe("settled")
        expect(upstreamClosed).toHaveLength(1)
        // A second close is a no-op that still settles.
        expect(await within(proxy.close(), 2_000)).toBe("settled")
      } finally {
        tunnel.socket.destroy()
        for (const socket of upstreamSockets) socket.destroy()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    })

    it("drops a CONNECT whose upstream has not connected yet", async () => {
      const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
      // 192.0.2.0/24 is TEST-NET-1: the SYN is never answered, so the tunnel
      // is still pending when close runs. A host that refuses it outright
      // answers 502 first, which close must also not wait on.
      const pending = client(proxy, "CONNECT 192.0.2.1:443 HTTP/1.1\r\nHost: 192.0.2.1:443\r\n\r\n")
      try {
        await new Promise<void>((resolve) => pending.socket.once("connect", () => resolve()))
        await new Promise<void>((resolve) => NodeTimers.setTimeout(resolve, 50))
        expect(await within(proxy.close(), 2_000)).toBe("settled")
        expect(await within(pending.closed, 2_000)).toBe("settled")
        expect(pending.received()).not.toContain("200 Connection Established")
      } finally {
        pending.socket.destroy()
      }
    })

    it("drops a refused CONNECT the client never hangs up on, beside an in-flight HTTP request", async () => {
      const held: Array<NodeHttp.ServerResponse> = []
      const upstream = NodeHttp.createServer((_request, response) => {
        held.push(response)
      })
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
      const port = (upstream.address() as NodeNet.AddressInfo).port
      const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
      const refused = client(proxy, "CONNECT example.com:not-a-port HTTP/1.1\r\nHost: example.com\r\n\r\n")
      const plain = client(proxy, `GET http://127.0.0.1:${port}/held HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
      try {
        await refused.until("\r\n\r\n")
        expect(refused.received()).toMatch(/^HTTP\/1\.1 400 Bad Request/)
        const start = Date.now()
        while (held.length === 0 && Date.now() - start < 5_000) {
          await new Promise<void>((resolve) => NodeTimers.setTimeout(resolve, 5))
        }
        expect(held).toHaveLength(1)
        expect(await within(proxy.close(), 2_000)).toBe("settled")
        expect(await within(refused.closed, 2_000)).toBe("settled")
        expect(await within(plain.closed, 2_000)).toBe("settled")
      } finally {
        refused.socket.destroy()
        plain.socket.destroy()
        for (const response of held) response.destroy()
        upstream.closeAllConnections()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    })
  })

  it("refuses an upstream response larger than the buffered ceiling", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const result = await throughProxy(vault, () => ({
      method: "GET",
      headers: {},
      responseBody: "a".repeat(SecretProxy.maximumResponseBodyBytes + 1)
    }))
    expect(result.status).toBe(502)
    expect(result.responseBody).toBe("upstream response is too large")
  })

  it("refuses an encoded upstream response so redaction cannot miss it", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const result = await throughProxy(vault, () => ({
      method: "GET",
      headers: {},
      responseHeaders: { "content-encoding": "gzip" },
      responseBody: "not really gzip"
    }))
    expect(result.status).toBe(502)
    expect(result.responseBody).toBe("upstream returned an encoded response")
  })

  it("answers 404 for an unknown secret destination route", async () => {
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    try {
      const result = await boundedProxyRequest(proxy.endpoint, "/.well-known/smithers-secret-url/deadbeef")
      expect(result.status).toBe(404)
      expect(result.body).toBe("unknown secret destination")
    } finally {
      await proxy.close()
    }
  })

  it("answers 502 when a secret destination is not an http(s) URL", async () => {
    const vault = SecretProxy.makeVault({ read: () => "ftp://example.invalid/x" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = new URL(proxy.urlFor(Secret.Secret("PROXY_NON_HTTP_DESTINATION")))
      const result = await boundedProxyRequest(proxy.endpoint, capability.pathname)
      expect(result.status).toBe(502)
      expect(result.body).toBe("the declared secret PROXY_NON_HTTP_DESTINATION is not an http(s) URL")
    } finally {
      await proxy.close()
    }
  })

  it("answers 502 when the vault cannot resolve the destination", async () => {
    // The route exists, so this is not a 404: the boundary was asked for a
    // credential it is authorized to hold and could not produce it.
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault({ read: () => undefined }))
    try {
      const capability = new URL(proxy.urlFor(Secret.Secret("PROXY_MISSING_DESTINATION")))
      const result = await boundedProxyRequest(proxy.endpoint, capability.pathname)
      expect(result.status).toBe(502)
      // The declaration's own failure text, which names the variable and never
      // the value.
      expect(result.body).toContain("PROXY_MISSING_DESTINATION")
    } finally {
      await proxy.close()
    }
  })

  it("answers 502 without detail when resolving fails for an unexpected reason", async () => {
    // Any other failure is the boundary's own, and its text could carry
    // anything the reader threw, so the response states nothing about it.
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault({
      read: () => {
        throw new Error("real-value leaked through the failure")
      }
    }))
    try {
      const capability = new URL(proxy.urlFor(Secret.Secret("PROXY_HOSTILE_DESTINATION")))
      const result = await boundedProxyRequest(proxy.endpoint, capability.pathname)
      expect(result.status).toBe(502)
      expect(result.body).toBe("secret substitution failed")
    } finally {
      await proxy.close()
    }
  })

  it("answers 502 when a secret destination is not a URL at all", async () => {
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault({ read: () => "example.invalid/x" }))
    try {
      const capability = new URL(proxy.urlFor(Secret.Secret("PROXY_UNPARSEABLE_DESTINATION")))
      const result = await boundedProxyRequest(proxy.endpoint, capability.pathname)
      expect(result.status).toBe(502)
      expect(result.body).toBe("the declared secret PROXY_UNPARSEABLE_DESTINATION is not an http(s) URL")
    } finally {
      await proxy.close()
    }
  })

  it("refuses an opaque CONNECT tunnel to a declared audience and names the brokered origin", async () => {
    let upstreamConnections = 0
    const upstream = NodeNet.createServer((socket) => {
      upstreamConnections += 1
      socket.destroy()
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const upstreamAddress = upstream.address()
    if (upstreamAddress === null || typeof upstreamAddress === "string") throw new Error("no upstream port")

    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    // Declared as localhost, reached as 127.0.0.1: one loopback host.
    vault.mint(Secret.HttpSecret(token, [`http://localhost:${upstreamAddress.port}`]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const response = await connectThrough(proxy.endpoint, `127.0.0.1:${upstreamAddress.port}`)
      expect(response.startsWith("HTTP/1.1 501 Not Implemented")).toBe(true)
      expect(response).toContain(
        `http://localhost:${upstreamAddress.port} is a declared secret audience; ` +
          `point the tool at S.SecretOrigin("http://localhost:${upstreamAddress.port}")`
      )
      expect(upstreamConnections).toBe(0)
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})

describe("SecretOrigin tokens", () => {
  it("names a normalized audience and is found again in text", () => {
    const token = Secret.SecretOrigin("https://API.github.com:443")
    expect(token).toBe("{smthrs:secret-origin:https://api.github.com}")
    expect(Secret.secretOriginsIn(`--url=${token}/user and ${Secret.SecretOrigin("http://127.0.0.1:9")}`))
      .toEqual(["https://api.github.com", "http://127.0.0.1:9"])
    expect(Secret.secretOriginsIn("no token here")).toEqual([])
  })

  it("refuses an origin a credential could not be bound to", () => {
    expect(() => Secret.SecretOrigin("http://example.com")).toThrow(/exact HTTPS or loopback HTTP origin/)
    expect(() => Secret.SecretOrigin("https://example.com/path")).toThrow(/exact HTTPS or loopback HTTP origin/)
  })
})

/** Starts an upstream that records what reached it and answers with `reply`. */
const recordingUpstream = async (
  reply: (origin: string) => { readonly headers?: Record<string, string>; readonly body: string }
) => {
  const seen: Array<{ readonly headers: NodeHttp.IncomingHttpHeaders; readonly path: string }> = []
  let origin = ""
  const server = NodeHttp.createServer((incoming, response) => {
    seen.push({ headers: incoming.headers, path: incoming.url ?? "" })
    incoming.resume()
    incoming.on("end", () => {
      const answer = reply(origin)
      response.writeHead(200, { "content-type": "text/plain", ...answer.headers }).end(answer.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no upstream port")
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const get = (
  url: string,
  headers: Record<string, string> = {},
  via?: string
): Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const proxy = via === undefined ? undefined : new URL(via)
    const outgoing = NodeHttp.request({
      host: "127.0.0.1",
      port: Number((proxy ?? target).port),
      path: proxy === undefined ? `${target.pathname}${target.search}` : url,
      headers
    }, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8")
        }))
    })
    outgoing.on("error", reject)
    outgoing.end()
  })

describe("SecretProxy brokered origins", () => {
  const token = Secret.Secret("ORIGIN_TEST_TOKEN")

  it("binds one loopback origin per audience, memoized, and only for declared audiences", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    vault.mint(Secret.HttpSecret(token, ["https://api.example.test", "https://uploads.example.test"]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const api = await proxy.originFor("https://api.example.test")
      const uploads = await proxy.originFor("https://uploads.example.test")
      expect(api).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(uploads).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(api).not.toBe(uploads)
      expect(api).not.toBe(proxy.endpoint)
      expect(await proxy.originFor("https://API.example.test:443")).toBe(api)
      await expect(proxy.originFor("https://other.example.test")).rejects.toThrow(
        "no declared secret is bound to https://other.example.test"
      )
      await expect(proxy.originFor("not a url")).rejects.toThrow(/exact HTTP origin/)
    } finally {
      await proxy.close()
    }
  })

  it("forwards to the audience, substitutes its placeholder, and rewrites the audience echo", async () => {
    const upstream = await recordingUpstream((origin) => ({
      headers: { location: `${origin}/next` },
      body: `see ${origin}/docs, token real-value`
    }))
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const placeholder = vault.mint(Secret.HttpSecret(token, [upstream.origin]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const origin = await proxy.originFor(upstream.origin)
      const response = await get(`${origin}/user?q=${placeholder}`, { authorization: `token ${placeholder}` })
      expect(response.status).toBe(200)
      expect(upstream.seen[0]!.headers.authorization).toBe("token real-value")
      expect(upstream.seen[0]!.headers.host).toBe(new URL(upstream.origin).host)
      expect(upstream.seen[0]!.path).toBe("/user?q=real-value")
      expect(response.headers.location).toBe(`${origin}/next`)
      expect(response.body).toBe(`see ${origin}/docs, token ${placeholder}`)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("routes a brokered origin sent through the proxy in absolute form to the same audience", async () => {
    const upstream = await recordingUpstream(() => ({ body: "ok" }))
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const placeholder = vault.mint(Secret.HttpSecret(token, [upstream.origin]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const origin = await proxy.originFor(upstream.origin)
      const response = await get(`${origin}/x`, { authorization: placeholder }, proxy.endpoint)
      expect(response.status).toBe(200)
      expect(upstream.seen[0]!.headers.authorization).toBe("real-value")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("denies a placeholder bound to another audience before contacting the upstream", async () => {
    const upstream = await recordingUpstream(() => ({ body: "ok" }))
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    vault.mint(Secret.HttpSecret(token, [upstream.origin]))
    const other = vault.mint(Secret.HttpSecret(Secret.Secret("ORIGIN_OTHER_TOKEN"), ["https://other.example.test"]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const origin = await proxy.originFor(upstream.origin)
      const response = await get(`${origin}/x`, { authorization: other })
      expect(response.status).toBe(403)
      expect(response.body).toBe(`the declared secret ORIGIN_OTHER_TOKEN is not authorized for ${upstream.origin}`)
      expect(upstream.seen).toEqual([])
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("refuses a request target that would leave the audience", async () => {
    const upstream = await recordingUpstream(() => ({ body: "ok" }))
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    vault.mint(Secret.HttpSecret(token, [upstream.origin]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const origin = new URL(await proxy.originFor(upstream.origin))
      for (const path of ["//evil.example.test/x", "*"]) {
        const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const socket = NodeNet.connect({ host: "127.0.0.1", port: Number(origin.port) }, () => {
            socket.write(`GET ${path} HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: close\r\n\r\n`)
          })
          socket.setEncoding("utf8")
          let text = ""
          socket.on("data", (chunk: string) => (text += chunk))
          socket.once("end", () => resolve({ status: Number(text.split(" ")[1]), body: text }))
          socket.once("error", reject)
        })
        expect(response.status).toBe(400)
        expect(response.body).toContain("brokered origin requires an origin-form request target")
      }
      expect(upstream.seen).toEqual([])
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("closes every brokered origin with the proxy", async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    vault.mint(Secret.HttpSecret(token, ["https://api.example.test"]))
    const proxy = await SecretProxy.startProxy(vault)
    const origin = await proxy.originFor("https://api.example.test")
    await proxy.close()
    await expect(get(`${origin}/x`)).rejects.toThrow(/ECONNREFUSED/)
  })

  it("tunnels CONNECT to a host that is not an audience even while the vault holds a placeholder", async () => {
    const echo = NodeNet.createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve))
    const echoAddress = echo.address()
    if (echoAddress === null || typeof echoAddress === "string") throw new Error("no echo port")
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    vault.mint(Secret.HttpSecret(token, ["https://api.example.test"]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const response = await connectThrough(proxy.endpoint, `127.0.0.1:${echoAddress.port}`)
      expect(response.startsWith("HTTP/1.1 200 Connection Established")).toBe(true)
      const refused = await connectThrough(proxy.endpoint, "api.example.test:443")
      expect(refused).toContain("CONNECT to api.example.test:443 refused: https://api.example.test")
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
  })
})

describe.runIf(process.env["SMITHERS_E2E_NETWORK"] === "1")("SecretProxy brokered origins over the network", () => {
  it("forwards a brokered origin to a public HTTPS audience over TLS", async () => {
    const vault = SecretProxy.makeVault({ read: () => "unused-network-value" })
    vault.mint(Secret.HttpSecret(Secret.Secret("ORIGIN_NETWORK_TOKEN"), ["https://api.github.com"]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const origin = await proxy.originFor("https://api.github.com")
      const response = await get(`${origin}/zen`, { "user-agent": "smithers-secret-origin-e2e" })
      expect(response.status).toBe(200)
      expect(response.body.length).toBeGreaterThan(0)
    } finally {
      await proxy.close()
    }
  }, 30_000)
})

describe("SecretProxy brokered origin bound", () => {
  it(`refuses more than ${SecretProxy.maximumBrokeredOrigins} brokered origins`, async () => {
    const vault = SecretProxy.makeVault({ read: () => "real-value" })
    const audiences = Array.from(
      { length: SecretProxy.maximumBrokeredOrigins + 1 },
      (_, index) => `https://a${index}.example.test`
    )
    for (let start = 0; start < audiences.length; start += Secret.maximumAudiences) {
      vault.mint(
        Secret.HttpSecret(
          Secret.Secret(`ORIGIN_BOUND_${start}`),
          audiences.slice(start, start + Secret.maximumAudiences)
        )
      )
    }
    const proxy = await SecretProxy.startProxy(vault)
    try {
      for (const audience of audiences.slice(0, -1)) await proxy.originFor(audience)
      await expect(proxy.originFor(audiences.at(-1)!)).rejects.toThrow(
        `secret proxy brokers at most ${SecretProxy.maximumBrokeredOrigins} origins`
      )
    } finally {
      await proxy.close()
    }
  })
})
