import { describe, expect, test } from "vitest"
import { ApplicationTargetRefused, resolveApplicationTarget } from "../src/ApplicationTarget.ts"
import type { ApplicationTargetRefusalCode } from "../src/ApplicationTarget.ts"

const PAGE = "https://app.example.test"

/** The tagged refusal a call throws, as its code and sentence. */
const refusal = (call: () => unknown): { readonly code: ApplicationTargetRefusalCode; readonly message: string } => {
  try {
    call()
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationTargetRefused)
    const refused = error as ApplicationTargetRefused
    expect(refused._tag).toBe("ApplicationTargetRefused")
    expect(refused.name).toBe("ApplicationTargetRefused")
    return { code: refused.code, message: refused.message }
  }
  return expect.unreachable("the target was accepted")
}

const sentences: Readonly<Record<ApplicationTargetRefusalCode, (mode: string) => string>> = {
  origin_not_absolute: () => "Application API origin must be an absolute HTTP(S) origin.",
  origin_not_http: () => "Application API origin must use HTTP(S).",
  origin_not_bare: () => "Application API origin cannot contain credentials, a path, a query, or a fragment.",
  selfhost_external_origin: () => "web-selfhost must use its serving origin.",
  owner_bearer_auth: () => "Owner backends use the owner session or an owner token, not Plue bearer auth.",
  external_web_plue_undeclared: () => "An external web Plue origin requires developerExternal.",
  external_plue_cors: () => "An external Plue origin requires credentialed CORS.",
  external_plue_session_auth: () => "An external Plue origin requires explicit token auth.",
  same_origin_credentialed_cors: () => "Credentialed CORS is only valid for an external API origin.",
  owned_launch_origin_missing: (mode) => `${mode} requires the owned backend launch handshake origin.`
}

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
      ["web-selfhost", "https://other.example.test", "session", "selfhost_external_origin"],
      [
        "local-own",
        "http://127.0.0.1:4100",
        "bearer",
        "owner_bearer_auth"
      ],
      ["native-own", "http://127.0.0.1:4100", "bearer", "owner_bearer_auth"],
      ["local-own", "", "token", "owned_launch_origin_missing"],
      ["native-own", "", "session", "owned_launch_origin_missing"]
    ] as const
  )("rejects invalid owned topology %s / %s / %s as %s", (mode, apiOrigin, kind, code) => {
    expect(refusal(() => resolveApplicationTarget({ apiVersion: 1, mode, apiOrigin, auth: { kind } }, PAGE)))
      .toEqual({ code, message: sentences[code](mode) })
  })

  test.each(
    [
      ["web-plue", false, "credentialed", "token", "external_web_plue_undeclared"],
      ["web-plue", true, "same-origin", "token", "external_plue_cors"],
      ["web-plue", true, "credentialed", "session", "external_plue_session_auth"],
      ["local-plue", false, "same-origin", "token", "external_plue_cors"],
      ["local-plue", false, "credentialed", "session", "external_plue_session_auth"],
      ["native-plue", false, "same-origin", "bearer", "external_plue_cors"],
      ["native-plue", false, "credentialed", "session", "external_plue_session_auth"]
    ] as const
  )("rejects unsafe external Plue %s / %s / %s / %s as %s", (mode, developerExternal, cors, kind, code) => {
    expect(refusal(() =>
      resolveApplicationTarget({
        apiVersion: 1,
        mode,
        apiOrigin: "https://plue.example.test",
        auth: { kind },
        cors,
        developerExternal
      }, PAGE)
    )).toEqual({ code, message: sentences[code](mode) })
  })

  test.each(["web-selfhost", "web-plue", "local-own", "local-plue", "native-own", "native-plue"] as const)(
    "rejects credentialed CORS on same-origin %s",
    (mode) => {
      expect(refusal(() =>
        resolveApplicationTarget({
          apiVersion: 1,
          mode,
          apiOrigin: mode.endsWith("own") && mode !== "web-selfhost" ? PAGE : "",
          auth: { kind: "token" },
          cors: "credentialed"
        }, PAGE)
      )).toEqual({ code: "same_origin_credentialed_cors", message: sentences.same_origin_credentialed_cors(mode) })
    }
  )

  test.each(
    [
      ["/relative", "origin_not_absolute"],
      ["ftp://example.test", "origin_not_http"],
      ["https://user:pass@example.test", "origin_not_bare"],
      ["https://example.test/v1", "origin_not_bare"],
      ["https://example.test/?q=1", "origin_not_bare"],
      ["https://example.test/#fragment", "origin_not_bare"]
    ] as const
  )("rejects non-origin API URL %s as %s", (apiOrigin, code) => {
    expect(refusal(() =>
      resolveApplicationTarget({
        apiVersion: 1,
        mode: "web-plue",
        apiOrigin,
        auth: { kind: "token" },
        cors: "credentialed",
        developerExternal: true
      }, PAGE)
    )).toEqual({ code, message: sentences[code]("web-plue") })
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
