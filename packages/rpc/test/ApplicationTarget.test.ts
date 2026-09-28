import { describe, expect, test } from "vitest"
import { resolveApplicationTarget } from "../src/ApplicationTarget.ts"

const PAGE = "https://app.example.test"

describe("application target matrix", () => {
  test.each(
    [
      ["web-selfhost", "", "session", "owner", "none"],
      ["web-plue", "", "session", "plue", "none"],
      ["local-own", "http://127.0.0.1:4100", "token", "owner", "connect"],
      ["local-plue", "https://plue.example.test", "bearer", "plue", "none"],
      ["native-own", "http://127.0.0.1:4200", "session", "owner", "supervisor"],
      ["native-plue", "https://plue.example.test", "bearer", "plue", "none"]
    ] as const
  )("resolves %s without mode-specific product behavior", (mode, apiOrigin, auth, ownership, launch) => {
    const external = apiOrigin !== ""
    const target = resolveApplicationTarget({
      apiVersion: 1,
      mode,
      apiOrigin,
      auth: { kind: auth },
      cors: external && mode.endsWith("plue") ? "credentialed" : "same-origin",
      developerExternal: mode === "web-plue" && external
    }, PAGE)
    expect({ ownership: target.ownership, launch: target.launch }).toEqual({ ownership, launch })
    expect(target.launch === "supervisor").toBe(mode === "native-own")
  })

  test("remote modes never select the supervisor", () => {
    for (const mode of ["web-plue", "local-plue", "native-plue"] as const) {
      const target = resolveApplicationTarget({
        apiVersion: 1,
        mode,
        apiOrigin: mode === "web-plue" ? "" : "https://plue.example.test",
        auth: { kind: mode === "web-plue" ? "session" : "bearer" },
        cors: mode === "web-plue" ? "same-origin" : "credentialed",
        developerExternal: false
      }, PAGE)
      expect(target.launch).not.toBe("supervisor")
    }
  })

  test("rejects implicit cross-origin Plue and missing owned launch handshakes", () => {
    expect(() =>
      resolveApplicationTarget({
        apiVersion: 1,
        mode: "web-plue",
        apiOrigin: "https://plue.example.test",
        auth: { kind: "bearer" }
      }, PAGE)
    ).toThrow("developerExternal")
    expect(() =>
      resolveApplicationTarget({
        apiVersion: 1,
        mode: "native-own",
        apiOrigin: "",
        auth: { kind: "session" }
      }, PAGE)
    ).toThrow("launch handshake")
  })

  test("defaults same-origin deployment fields and normalizes equivalent origins", () => {
    const target = resolveApplicationTarget({
      apiVersion: 1,
      mode: "web-selfhost",
      auth: { kind: "session" }
    }, PAGE)
    expect(target).toEqual({
      apiVersion: 1,
      mode: "web-selfhost",
      apiOrigin: "",
      auth: { kind: "session" },
      cors: "same-origin",
      developerExternal: false,
      shell: "web",
      ownership: "owner",
      launch: "none",
      baseUrl: ""
    })
    expect(
      resolveApplicationTarget({
        apiVersion: 1,
        mode: "web-selfhost",
        apiOrigin: " HTTPS://APP.EXAMPLE.TEST:443/ ",
        auth: { kind: "token" }
      }, PAGE).baseUrl
    ).toBe("")
  })

  test("treats an explicit API origin as external when the page origin is unavailable", () => {
    const target = resolveApplicationTarget({
      apiVersion: 1,
      mode: "local-plue",
      apiOrigin: "https://plue.example.test",
      auth: { kind: "token" },
      cors: "credentialed"
    })
    expect(target.baseUrl).toBe("https://plue.example.test")
    expect(target.apiOrigin).toBe("https://plue.example.test")
  })

  test.each(
    [
      ["https://plue.example.test", "https://plue.example.test"],
      [" https://PLUE.EXAMPLE.TEST:443/ ", "https://plue.example.test"],
      ["http://plue.example.test:80/", "http://plue.example.test"]
    ] as const
  )("normalizes an external Plue origin %s", (apiOrigin, expected) => {
    const target = resolveApplicationTarget({
      apiVersion: 1,
      mode: "web-plue",
      apiOrigin,
      auth: { kind: "token" },
      cors: "credentialed",
      developerExternal: true
    }, PAGE)
    expect(target.apiOrigin).toBe(expected)
    expect(target.baseUrl).toBe(expected)
    expect(target.launch).toBe("none")
  })

  test.each(
    [
      ["web-selfhost", "https://other.example.test", "session", "web-selfhost must use its serving origin."],
      [
        "local-own",
        "http://127.0.0.1:4100",
        "bearer",
        "Owner backends use the owner session or an owner token, not Plue bearer auth."
      ],
      [
        "native-own",
        "http://127.0.0.1:4100",
        "bearer",
        "Owner backends use the owner session or an owner token, not Plue bearer auth."
      ],
      ["local-own", "", "token", "local-own requires the owned backend launch handshake origin."],
      ["native-own", "", "session", "native-own requires the owned backend launch handshake origin."]
    ] as const
  )("rejects invalid owned topology %s / %s / %s", (mode, apiOrigin, kind, message) => {
    expect(() => resolveApplicationTarget({ apiVersion: 1, mode, apiOrigin, auth: { kind } }, PAGE)).toThrow(message)
  })

  test.each(
    [
      ["web-plue", false, "credentialed", "token", "developerExternal"],
      ["web-plue", true, "same-origin", "token", "credentialed CORS"],
      ["web-plue", true, "credentialed", "session", "explicit token auth"],
      ["local-plue", false, "same-origin", "token", "credentialed CORS"],
      ["local-plue", false, "credentialed", "session", "explicit token auth"],
      ["native-plue", false, "same-origin", "bearer", "credentialed CORS"],
      ["native-plue", false, "credentialed", "session", "explicit token auth"]
    ] as const
  )("rejects unsafe external Plue %s / %s / %s / %s", (mode, developerExternal, cors, kind, message) => {
    expect(() =>
      resolveApplicationTarget({
        apiVersion: 1,
        mode,
        apiOrigin: "https://plue.example.test",
        auth: { kind },
        cors,
        developerExternal
      }, PAGE)
    ).toThrow(message)
  })

  test.each(["web-selfhost", "web-plue", "local-own", "local-plue", "native-own", "native-plue"] as const)(
    "rejects credentialed CORS on same-origin %s",
    (mode) => {
      expect(() =>
        resolveApplicationTarget({
          apiVersion: 1,
          mode,
          apiOrigin: mode.endsWith("own") && mode !== "web-selfhost" ? PAGE : "",
          auth: { kind: "token" },
          cors: "credentialed"
        }, PAGE)
      ).toThrow("Credentialed CORS is only valid for an external API origin.")
    }
  )

  test.each(
    [
      ["/relative", "Application API origin must be an absolute HTTP(S) origin."],
      ["ftp://example.test", "Application API origin must use HTTP(S)."],
      [
        "https://user:pass@example.test",
        "Application API origin cannot contain credentials, a path, a query, or a fragment."
      ],
      ["https://example.test/v1", "Application API origin cannot contain credentials, a path, a query, or a fragment."],
      [
        "https://example.test/?q=1",
        "Application API origin cannot contain credentials, a path, a query, or a fragment."
      ],
      [
        "https://example.test/#fragment",
        "Application API origin cannot contain credentials, a path, a query, or a fragment."
      ]
    ] as const
  )("rejects non-origin API URL %s", (apiOrigin, message) => {
    expect(() =>
      resolveApplicationTarget({
        apiVersion: 1,
        mode: "web-plue",
        apiOrigin,
        auth: { kind: "token" },
        cors: "credentialed",
        developerExternal: true
      }, PAGE)
    ).toThrow(message)
  })

  test.each([
    { apiVersion: 2, mode: "web-selfhost", auth: { kind: "session" } },
    { apiVersion: 1, mode: "unknown", auth: { kind: "session" } },
    { apiVersion: 1, mode: "web-selfhost", auth: { kind: "bearer", token: "secret" } },
    { apiVersion: 1, mode: "web-selfhost", auth: { kind: "unknown" } },
    { apiVersion: 1, mode: "web-selfhost", auth: { kind: "session" }, token: "secret" },
    { apiVersion: 1, mode: "web-selfhost", auth: { kind: "session" }, developerExternal: "true" }
  ])("rejects malformed or secret-bearing deployment documents", (document) => {
    expect(() => resolveApplicationTarget(document, PAGE)).toThrow()
  })
})
