import { describe, expect, test } from "bun:test"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { nativeBackendConfig } from "./NativeBackendConfig"
import type { NativeBackend } from "./NativeBackendProcess"

const backend = (mode: NativeBackend["mode"], origin?: string) => {
  let stops = 0
  const value: NativeBackend = { mode, origin, failure: undefined, stop: async () => { stops++ } }
  return { value, stops: () => stops }
}

describe("native backend handshake", () => {
  test("own consumes the supervisor origin", () => {
    expect(nativeBackendConfig({}, {
      mode: "own",
      origin: "http://127.0.0.1:4400",
      failure: undefined,
      stop: async () => {}
    }))
      .toEqual({
        rendererOrigin: "http://127.0.0.1:4400",
        target: {
          apiVersion: 1,
          mode: "native-own",
          apiOrigin: "http://127.0.0.1:4400",
          auth: { kind: "session" },
          cors: "same-origin",
          developerExternal: false
        },
        token: null
      })
  })

  test("own never adopts a Plue bearer exported in the launcher shell", () => {
    const config = nativeBackendConfig({ SMITHERS_API_TOKEN: "plue-pat" }, {
      mode: "own", origin: "http://127.0.0.1:4400", failure: undefined, stop: async () => {}
    })
    expect(config.token).toBeNull()
    expect(config.target.auth).toEqual({ kind: "session" })
  })

  test("owned backend uses the packaged renderer proxy for its API", () => {
    const config = nativeBackendConfig({}, {
      mode: "own", origin: "http://127.0.0.1:4400", failure: undefined, stop: async () => {}
    }, "http://127.0.0.1:5100")
    expect(config).toEqual({
      rendererOrigin: "http://127.0.0.1:5100",
      target: { apiVersion: 1, mode: "native-own", apiOrigin: "http://127.0.0.1:5100", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
  })

  test("Plue never requests an owned backend launch", () => {
    const config = nativeBackendConfig({
      SMITHERS_API_ORIGIN: "https://plue.example.test",
      SMITHERS_RENDERER_ORIGIN: "http://127.0.0.1:5173",
      SMITHERS_API_TOKEN: "secret"
    }, { mode: "plue", origin: undefined, failure: undefined, stop: async () => {} })
    expect(config).toEqual({
      rendererOrigin: "http://127.0.0.1:5173",
      target: { apiVersion: 1, mode: "native-plue", apiOrigin: "https://plue.example.test", auth: { kind: "bearer" }, cors: "credentialed", developerExternal: false },
      token: "secret"
    })
  })

  test("missing supervisor and remote origins fail before opening the app", () => {
    expect(() => nativeBackendConfig({}, {
      mode: "own", origin: "", failure: undefined, stop: async () => {}
    })).toThrow("owned backend origin is required")
    expect(() => nativeBackendConfig({}, {
      mode: "plue", origin: undefined, failure: undefined, stop: async () => {}
    })).toThrow("SMITHERS_API_ORIGIN is required")
  })
})

describe("pure native configuration topology and precedence", () => {
  test("owner handshake ignores malformed remote origin, token, and unrelated launcher settings", () => {
    const instance = backend("own", "http://127.0.0.1:4400")
    const env = { SMITHERS_API_ORIGIN: "not a URL", SMITHERS_API_TOKEN: "remote-token", UNRELATED: "ignored" }
    const before = { ...env }
    expect(nativeBackendConfig(env, instance.value)).toEqual({
      rendererOrigin: "http://127.0.0.1:4400",
      target: { apiVersion: 1, mode: "native-own", apiOrigin: "http://127.0.0.1:4400", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    expect(env).toEqual(before)
    expect(instance.value.origin).toBe("http://127.0.0.1:4400")
    expect(instance.stops()).toBe(0)
  })

  test.each([
    { name: "omitted", renderer: undefined }, { name: "empty", renderer: "" }, { name: "whitespace", renderer: " \t" }
  ])("$name renderer setting falls back to the normalized owned handshake", ({ renderer }) => {
    const instance = backend("own", " \thttp://127.0.0.1:4400/ \n")
    expect(nativeBackendConfig({ SMITHERS_RENDERER_ORIGIN: renderer }, instance.value)).toEqual({
      rendererOrigin: "http://127.0.0.1:4400",
      target: { apiVersion: 1, mode: "native-own", apiOrigin: "http://127.0.0.1:4400", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    expect(instance.stops()).toBe(0)
  })

  test("explicit external renderer leaves the owner API on the owned handshake", () => {
    const instance = backend("own", "http://127.0.0.1:4400")
    expect(nativeBackendConfig({ SMITHERS_RENDERER_ORIGIN: " https://shell.example.test/ " }, instance.value)).toEqual({
      rendererOrigin: "https://shell.example.test",
      target: { apiVersion: 1, mode: "native-own", apiOrigin: "http://127.0.0.1:4400", auth: { kind: "session" }, cors: "credentialed", developerExternal: false },
      token: null
    })
    expect(instance.stops()).toBe(0)
  })

  test("packaged owner renderer overrides an invalid env renderer", () => {
    const instance = backend("own", "http://127.0.0.1:4400")
    expect(nativeBackendConfig({ SMITHERS_RENDERER_ORIGIN: "invalid", SMITHERS_API_ORIGIN: "invalid", SMITHERS_API_TOKEN: "ignored" }, instance.value, "http://127.0.0.1:5100")).toEqual({
      rendererOrigin: "http://127.0.0.1:5100",
      target: { apiVersion: 1, mode: "native-own", apiOrigin: "http://127.0.0.1:5100", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    expect(instance.stops()).toBe(0)
  })

  test.each([
    { name: "omitted", token: undefined }, { name: "empty", token: "" }, { name: "whitespace", token: " \t\n" }
  ])("same-origin Plue uses session auth with $name token", ({ token }) => {
    const instance = backend("plue")
    expect(nativeBackendConfig({ SMITHERS_API_ORIGIN: " https://plue.example.test/ ", SMITHERS_API_TOKEN: token }, instance.value)).toEqual({
      rendererOrigin: "https://plue.example.test",
      target: { apiVersion: 1, mode: "native-plue", apiOrigin: "https://plue.example.test", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    expect(instance.stops()).toBe(0)
  })

  test("same-origin Plue accepts a trimmed bearer without enabling cross-origin CORS", () => {
    const instance = backend("plue")
    expect(nativeBackendConfig({ SMITHERS_API_ORIGIN: "https://plue.example.test", SMITHERS_RENDERER_ORIGIN: " https://plue.example.test/ ", SMITHERS_API_TOKEN: " \tremote-token\n" }, instance.value)).toEqual({
      rendererOrigin: "https://plue.example.test",
      target: { apiVersion: 1, mode: "native-plue", apiOrigin: "https://plue.example.test", auth: { kind: "bearer" }, cors: "same-origin", developerExternal: false },
      token: "remote-token"
    })
    expect(instance.stops()).toBe(0)
  })

  test("packaged Plue renderer overrides launcher renderer while preserving selected external API auth", () => {
    const instance = backend("plue")
    expect(nativeBackendConfig({ SMITHERS_API_ORIGIN: "https://plue.example.test", SMITHERS_RENDERER_ORIGIN: "invalid", SMITHERS_API_TOKEN: " remote-token " }, instance.value, "http://127.0.0.1:5100")).toEqual({
      rendererOrigin: "http://127.0.0.1:5100",
      target: { apiVersion: 1, mode: "native-plue", apiOrigin: "https://plue.example.test", auth: { kind: "bearer" }, cors: "credentialed", developerExternal: false },
      token: "remote-token"
    })
    expect(instance.stops()).toBe(0)
  })

  test("packaged same-origin Plue retains session auth and no CORS", () => {
    const instance = backend("plue")
    expect(nativeBackendConfig({ SMITHERS_API_ORIGIN: "http://127.0.0.1:5100", SMITHERS_RENDERER_ORIGIN: "invalid" }, instance.value, "http://127.0.0.1:5100")).toEqual({
      rendererOrigin: "http://127.0.0.1:5100",
      target: { apiVersion: 1, mode: "native-plue", apiOrigin: "http://127.0.0.1:5100", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    expect(instance.stops()).toBe(0)
  })
})

describe("pure native handshake validation", () => {
  test.each([
    { name: "undefined", origin: undefined }, { name: "empty", origin: "" }, { name: "whitespace", origin: " \t" }
  ])("$name owned origin refuses even when a valid packaged proxy exists", ({ origin }) => {
    const instance = backend("own", origin)
    expect(() => nativeBackendConfig({}, instance.value, "http://127.0.0.1:5100")).toThrow(new Error("owned backend origin is required."))
    expect(instance.stops()).toBe(0)
  })

  test.each([
    { name: "undefined", origin: undefined }, { name: "empty", origin: "" }, { name: "whitespace", origin: " \t" }
  ])("$name Plue API origin is required even with a packaged renderer", ({ origin }) => {
    const instance = backend("plue")
    expect(() => nativeBackendConfig({ SMITHERS_API_ORIGIN: origin }, instance.value, "http://127.0.0.1:5100")).toThrow(new Error("SMITHERS_API_ORIGIN is required."))
    expect(instance.stops()).toBe(0)
  })

  test.each([
    { name: "relative", origin: "/backend", suffix: "must be an absolute HTTP(S) origin." },
    { name: "malformed", origin: "http://[", suffix: "must be an absolute HTTP(S) origin." },
    { name: "protocol", origin: "ftp://backend.example.test", suffix: "must be an absolute HTTP(S) origin without a path." },
    { name: "path", origin: "https://backend.example.test/api", suffix: "must be an absolute HTTP(S) origin without a path." },
    { name: "query", origin: "https://backend.example.test?view=1", suffix: "must be an absolute HTTP(S) origin without a path." },
    { name: "fragment", origin: "https://backend.example.test#view", suffix: "must be an absolute HTTP(S) origin without a path." },
    { name: "credentials", origin: "https://user:password@backend.example.test", suffix: "must be an absolute HTTP(S) origin without a path." }
  ])("$name origin is rejected at every actual config input boundary", ({ origin, suffix }) => {
    const owner = backend("own", origin), validOwner = backend("own", "http://127.0.0.1:4400"), plue = backend("plue")
    expect(() => nativeBackendConfig({}, owner.value)).toThrow(new Error(`owned backend origin ${suffix}`))
    expect(() => nativeBackendConfig({ SMITHERS_API_ORIGIN: origin }, plue.value)).toThrow(new Error(`SMITHERS_API_ORIGIN ${suffix}`))
    expect(() => nativeBackendConfig({ SMITHERS_RENDERER_ORIGIN: origin }, validOwner.value)).toThrow(new Error(`SMITHERS_RENDERER_ORIGIN ${suffix}`))
    expect(() => nativeBackendConfig({}, validOwner.value, origin)).toThrow(new Error(`packaged renderer origin ${suffix}`))
    expect([owner.stops(), validOwner.stops(), plue.stops()]).toEqual([0, 0, 0])
  })

  test.each([
    { name: "omitted", token: undefined }, { name: "empty", token: "" }, { name: "whitespace", token: " \t" }
  ])("external Plue with $name token preserves the shared target authority refusal", ({ token }) => {
    const instance = backend("plue")
    const env = { SMITHERS_API_ORIGIN: "https://plue.example.test", SMITHERS_API_TOKEN: token }
    expect(() => nativeBackendConfig({ ...env, SMITHERS_RENDERER_ORIGIN: "http://127.0.0.1:5173" }, instance.value)).toThrow(new Error("An external Plue origin requires explicit token auth."))
    expect(() => nativeBackendConfig(env, instance.value, "http://127.0.0.1:5100")).toThrow(new Error("An external Plue origin requires explicit token auth."))
    expect(instance.stops()).toBe(0)
  })

  test("invalid packaged Plue renderer identifies the same named input boundary as owner", () => {
    const instance = backend("plue")
    expect(() => nativeBackendConfig({ SMITHERS_API_ORIGIN: "https://plue.example.test", SMITHERS_API_TOKEN: "remote-token" }, instance.value, "file:///renderer")).toThrow(new Error("packaged renderer origin must be an absolute HTTP(S) origin without a path."))
    expect(instance.stops()).toBe(0)
  })
})

// Absolute HTTP(S) origins are URL values, not canonical-spelling-only strings.
// The expected normalized origins below are literals, independent of the parser.
describe("native origin normalization contract", () => {
  const ownerOrigins = [
    { name: "uppercase scheme", raw: "HTTP://localhost:4400", normalized: "http://localhost:4400" },
    { name: "uppercase host", raw: "http://LOCALHOST:4400", normalized: "http://localhost:4400" },
    { name: "explicit default port", raw: "http://127.0.0.1:80", normalized: "http://127.0.0.1" }
  ]
  for (const boundary of ["handshake", "renderer env", "packaged renderer"] as const) {
    test.each(ownerOrigins)(`${boundary} normalizes owner $name`, ({ raw, normalized }) => {
      const instance = backend("own", boundary === "handshake" ? raw : normalized)
      const config = nativeBackendConfig(boundary === "renderer env" ? { SMITHERS_RENDERER_ORIGIN: raw } : {}, instance.value, boundary === "packaged renderer" ? raw : undefined)
      expect(config).toEqual({
        rendererOrigin: normalized,
        target: { apiVersion: 1, mode: "native-own", apiOrigin: normalized, auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
        token: null
      })
      // A compatibility check follows the independent output oracle; it does
      // not manufacture the expected config from the shared implementation.
      expect(resolveApplicationTarget(config.target, config.rendererOrigin)).toMatchObject({ shell: "native", ownership: "owner", launch: "supervisor", baseUrl: "" })
      expect(instance.stops()).toBe(0)
    })
  }

  const plueOrigins = [
    { name: "uppercase scheme", raw: "HTTPS://plue.example.test", normalized: "https://plue.example.test" },
    { name: "uppercase host", raw: "https://PLUE.EXAMPLE.TEST", normalized: "https://plue.example.test" },
    { name: "explicit default port", raw: "https://plue.example.test:443", normalized: "https://plue.example.test" }
  ]
  for (const boundary of ["API env", "renderer env", "packaged renderer"] as const) {
    test.each(plueOrigins)(`${boundary} normalizes Plue $name`, ({ raw, normalized }) => {
      const instance = backend("plue")
      const config = nativeBackendConfig({
        SMITHERS_API_ORIGIN: boundary === "API env" ? raw : normalized,
        SMITHERS_RENDERER_ORIGIN: boundary === "renderer env" ? raw : undefined,
        SMITHERS_API_TOKEN: "remote-token"
      }, instance.value, boundary === "packaged renderer" ? raw : undefined)
      expect(config).toEqual({
        rendererOrigin: normalized,
        target: { apiVersion: 1, mode: "native-plue", apiOrigin: normalized, auth: { kind: "bearer" }, cors: "same-origin", developerExternal: false },
        token: "remote-token"
      })
      expect(resolveApplicationTarget(config.target, config.rendererOrigin)).toMatchObject({ shell: "native", ownership: "plue", launch: "none", baseUrl: "" })
      expect(instance.stops()).toBe(0)
    })
  }

  test.each([
    { name: "trimmed", owner: " \thttp://127.0.0.1:5100 \n" },
    { name: "trailing slash", owner: "http://127.0.0.1:5100/" }
  ])("$name packaged owner renderer is normalized before topology classification", ({ owner }) => {
    const instance = backend("own", "http://127.0.0.1:4400")
    expect(nativeBackendConfig({}, instance.value, owner)).toEqual({
      rendererOrigin: "http://127.0.0.1:5100",
      target: { apiVersion: 1, mode: "native-own", apiOrigin: "http://127.0.0.1:5100", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    expect(instance.stops()).toBe(0)
  })

  test.each([
    { name: "trimmed", raw: " \thttps://plue.example.test \n" },
    { name: "trailing slash", raw: "https://plue.example.test/" }
  ])("$name packaged Plue renderer preserves a genuinely same-origin session topology", ({ raw }) => {
    const instance = backend("plue")
    expect(nativeBackendConfig({ SMITHERS_API_ORIGIN: "https://plue.example.test" }, instance.value, raw)).toEqual({
      rendererOrigin: "https://plue.example.test",
      target: { apiVersion: 1, mode: "native-plue", apiOrigin: "https://plue.example.test", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    expect(instance.stops()).toBe(0)
  })

  test("expanded IPv6 loopback handshake normalizes its host while preserving a nondefault port", () => {
    const instance = backend("own", "http://[0:0:0:0:0:0:0:1]:4400/")
    expect(nativeBackendConfig({}, instance.value)).toEqual({
      rendererOrigin: "http://[::1]:4400",
      target: { apiVersion: 1, mode: "native-own", apiOrigin: "http://[::1]:4400", auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    expect(instance.stops()).toBe(0)
  })

  test.each([
    { name: "IPv6/default port", raw: "https://[::1]:443/", normalized: "https://[::1]" },
    { name: "internationalized host", raw: "https://bücher.example/", normalized: "https://xn--bcher-kva.example" },
    { name: "nondefault port", raw: "https://plue.example.test:444/", normalized: "https://plue.example.test:444" },
    { name: "empty query delimiter", raw: "https://plue.example.test?", normalized: "https://plue.example.test" },
    { name: "empty fragment delimiter", raw: "https://plue.example.test#", normalized: "https://plue.example.test" },
    { name: "root dot segment", raw: "https://plue.example.test/./", normalized: "https://plue.example.test" },
    { name: "path reduced to root", raw: "https://plue.example.test/temporary/..", normalized: "https://plue.example.test" }
  ])("Plue $name normalization preserves same-origin session topology", ({ raw, normalized }) => {
    const instance = backend("plue")
    const config = nativeBackendConfig({ SMITHERS_API_ORIGIN: raw }, instance.value)
    expect(config).toEqual({
      rendererOrigin: normalized,
      target: { apiVersion: 1, mode: "native-plue", apiOrigin: normalized, auth: { kind: "session" }, cors: "same-origin", developerExternal: false },
      token: null
    })
    // Empty delimiters and dot segments leave no normalized query/fragment/path;
    // the nonempty denial matrix above continues to exercise actual exclusions.
    expect(resolveApplicationTarget(config.target, config.rendererOrigin)).toMatchObject({ shell: "native", ownership: "plue", launch: "none", baseUrl: "" })
    expect(instance.stops()).toBe(0)
  })

  test("normalized internationalized renderer and API origins retain bearer auth without external CORS", () => {
    const instance = backend("plue")
    expect(nativeBackendConfig({ SMITHERS_API_ORIGIN: "https://bücher.example/", SMITHERS_RENDERER_ORIGIN: "https://xn--bcher-kva.example", SMITHERS_API_TOKEN: "remote-token" }, instance.value)).toEqual({
      rendererOrigin: "https://xn--bcher-kva.example",
      target: { apiVersion: 1, mode: "native-plue", apiOrigin: "https://xn--bcher-kva.example", auth: { kind: "bearer" }, cors: "same-origin", developerExternal: false },
      token: "remote-token"
    })
    expect(instance.stops()).toBe(0)
  })
})
