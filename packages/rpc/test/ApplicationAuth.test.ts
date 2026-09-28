import { describe, expect, test } from "vitest"
import {
  APPLICATION_SIGN_IN_PATH,
  APPLICATION_TOKEN_SCOPES,
  ApplicationUserSchema,
  AUTHENTICATED_USER_PATH,
  BOOTSTRAP_TOKEN_HEADER_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  LOCAL_AUTH_BOOTSTRAP_PATH,
  LOCAL_AUTH_LOGIN_PATH,
  LOCAL_AUTH_STATUS_PATH,
  LocalAuthUserSchema,
  LocalBootstrapRequestSchema,
  LocalCredentialSchema,
  LocalIdentityStatusSchema,
  LocalLoginResponseSchema,
  LocalTokenRequestSchema,
  LocalTokenResponseSchema,
  SOCKET_TICKET_PATH,
  SocketTicketResponseSchema
} from "../src/ApplicationAuth.ts"

const credentials = { username: "will", password: "local-password" }
const owner = { id: 1, username: "will" }
const tokenResponse = {
  token: "smithers_local_owner_token",
  token_id: 7,
  expires_at: "2026-10-27T12:00:00Z",
  user: owner
}
const ticketResponse = { ticket: "one-use-socket-ticket", expires_at: "2026-09-27T12:01:00Z" }

describe("local authentication inputs (unit)", () => {
  test("decodes credentials without changing the username or password", () => {
    expect(LocalCredentialSchema.parse(credentials)).toEqual({ username: "will", password: "local-password" })
    expect(LocalCredentialSchema.parse({ username: "李", password: "é" })).toEqual({ username: "李", password: "é" })
  })

  test.each(["username", "password"] as const)("requires a nonempty string %s", (field) => {
    for (const value of [undefined, null, "", 1, false, [], {}]) {
      const result = LocalCredentialSchema.safeParse({ ...credentials, [field]: value })
      expect(result.success, `${field}: ${JSON.stringify(value)}`).toBe(false)
      if (!result.success) {
        expect(new Set(result.error.issues.map((issue) => issue.path.join(".")))).toEqual(new Set([field]))
      }
    }
  })

  test("requires the credential envelope and rejects extra input fields", () => {
    for (const value of [undefined, null, "will", [], { ...credentials, is_admin: true }]) {
      expect(LocalCredentialSchema.safeParse(value).success).toBe(false)
    }
  })

  test.each([undefined, "will@example.com"])("decodes first-owner bootstrap with email %s", (email) => {
    const input = {
      ...credentials,
      bootstrapToken: "trusted-owner-bootstrap",
      ...(email === undefined ? {} : { email })
    }
    expect(LocalBootstrapRequestSchema.parse(input)).toEqual(input)
  })

  test.each([undefined, null, "", 1, false])("rejects bootstrap token %s", (bootstrapToken) => {
    const result = LocalBootstrapRequestSchema.safeParse({ ...credentials, bootstrapToken })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["bootstrapToken"]])
  })

  test.each([null, "", "will", "will@", "@example.com", 1])("rejects malformed optional email %s", (email) => {
    const result = LocalBootstrapRequestSchema.safeParse({ ...credentials, bootstrapToken: "bootstrap", email })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["email"]])
  })

  test("extended bootstrap credentials still reject missing credentials and unknown authority fields", () => {
    expect(LocalBootstrapRequestSchema.safeParse({ password: "password", bootstrapToken: "bootstrap" }).success).toBe(
      false
    )
    expect(LocalBootstrapRequestSchema.safeParse({ username: "will", bootstrapToken: "bootstrap" }).success).toBe(false)
    expect(
      LocalBootstrapRequestSchema.safeParse({ ...credentials, bootstrapToken: "bootstrap", scopes: ["admin"] }).success
    )
      .toBe(false)
  })

  test.each([
    {},
    { name: "CLI" },
    { scopes: [] },
    { scopes: ["read:repository"] },
    { name: "CI", scopes: ["write:repository", "read:user", "write:repository"] }
  ])("decodes token options without granting or reordering scopes: %j", (options) => {
    expect(LocalTokenRequestSchema.parse({ ...credentials, ...options })).toEqual({ ...credentials, ...options })
  })

  test.each([null, "", 1, false])("rejects invalid optional token name %s", (name) => {
    const result = LocalTokenRequestSchema.safeParse({ ...credentials, name })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([["name"]])
  })

  test.each([null, "read:user", {}, [""], [1], [null], ["read:user", ""]])(
    "rejects malformed token scopes %j",
    (scopes) => {
      expect(LocalTokenRequestSchema.safeParse({ ...credentials, scopes }).success).toBe(false)
    }
  )

  test("token options require credentials and reject caller-supplied owner identity", () => {
    expect(LocalTokenRequestSchema.safeParse({ scopes: [] }).success).toBe(false)
    expect(LocalTokenRequestSchema.safeParse({ ...credentials, user: owner }).success).toBe(false)
  })
})

describe("local authentication responses (unit)", () => {
  test.each([
    { enabled: false, initialized: false },
    { enabled: false, initialized: true },
    { enabled: true, initialized: false },
    { enabled: true, initialized: true }
  ])("decodes status observations independently: %j", (status) => {
    expect(LocalIdentityStatusSchema.parse(status)).toEqual(status)
    expect(LocalIdentityStatusSchema.parse({ ...status, username: "will" })).toEqual({ ...status, username: "will" })
  })

  test.each(["enabled", "initialized"] as const)("requires boolean status %s", (field) => {
    for (const value of [undefined, null, "true", 0, 1]) {
      expect(LocalIdentityStatusSchema.safeParse({ enabled: true, initialized: true, [field]: value }).success).toBe(
        false
      )
    }
  })

  test.each([null, "", 1])("rejects malformed optional status username %s", (username) => {
    expect(LocalIdentityStatusSchema.safeParse({ enabled: true, initialized: true, username }).success).toBe(false)
  })

  test("decodes the owner directly and inside login and token responses", () => {
    expect(LocalAuthUserSchema.parse(owner)).toEqual({ id: 1, username: "will" })
    expect(LocalLoginResponseSchema.parse({ user: owner })).toEqual({ user: { id: 1, username: "will" } })
    expect(LocalTokenResponseSchema.parse(tokenResponse)).toEqual({
      token: "smithers_local_owner_token",
      token_id: 7,
      expires_at: "2026-10-27T12:00:00Z",
      user: { id: 1, username: "will" }
    })
  })

  test.each([undefined, null, "1", 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed owner id %s in every local envelope",
    (id) => {
      const user = { ...owner, id }
      expect(LocalAuthUserSchema.safeParse(user).success).toBe(false)
      expect(LocalLoginResponseSchema.safeParse({ user }).success).toBe(false)
      expect(LocalTokenResponseSchema.safeParse({ ...tokenResponse, user }).success).toBe(false)
    }
  )

  test.each([undefined, null, "", 1])("rejects malformed owner username %s in every local envelope", (username) => {
    const user = { ...owner, username }
    expect(LocalAuthUserSchema.safeParse(user).success).toBe(false)
    expect(LocalLoginResponseSchema.safeParse({ user }).success).toBe(false)
    expect(LocalTokenResponseSchema.safeParse({ ...tokenResponse, user }).success).toBe(false)
  })

  test.each([undefined, null, "will", []])("requires an owner object in login and token responses: %j", (user) => {
    expect(LocalLoginResponseSchema.safeParse({ user }).success).toBe(false)
    expect(LocalTokenResponseSchema.safeParse({ ...tokenResponse, user }).success).toBe(false)
  })

  test.each(["token", "expires_at"] as const)("requires nonempty token response %s", (field) => {
    for (const value of [undefined, null, "", 1]) {
      const result = LocalTokenResponseSchema.safeParse({ ...tokenResponse, [field]: value })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(new Set(result.error.issues.map((issue) => issue.path.join(".")))).toEqual(new Set([field]))
      }
    }
  })

  test.each([undefined, null, "7", 7.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "requires an integer token id: %s",
    (token_id) => {
      expect(LocalTokenResponseSchema.safeParse({ ...tokenResponse, token_id }).success).toBe(false)
    }
  )

  test("decodes the one-use socket-ticket receipt", () => {
    expect(SocketTicketResponseSchema.parse(ticketResponse)).toEqual({
      ticket: "one-use-socket-ticket",
      expires_at: "2026-09-27T12:01:00Z"
    })
  })

  test.each(["ticket", "expires_at"] as const)("requires nonempty socket-ticket %s", (field) => {
    for (const value of [undefined, null, "", 1]) {
      const result = SocketTicketResponseSchema.safeParse({ ...ticketResponse, [field]: value })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(new Set(result.error.issues.map((issue) => issue.path.join(".")))).toEqual(new Set([field]))
      }
    }
  })

  test("rejects unknown fields at each local response boundary", () => {
    expect(LocalIdentityStatusSchema.safeParse({ enabled: true, initialized: true, token: "secret" }).success).toBe(
      false
    )
    expect(LocalAuthUserSchema.safeParse({ ...owner, is_admin: true }).success).toBe(false)
    expect(LocalLoginResponseSchema.safeParse({ user: owner, token: "secret" }).success).toBe(false)
    expect(LocalLoginResponseSchema.safeParse({ user: { ...owner, token: "secret" } }).success).toBe(false)
    expect(LocalTokenResponseSchema.safeParse({ ...tokenResponse, scopes: ["admin"] }).success).toBe(false)
    expect(LocalTokenResponseSchema.safeParse({ ...tokenResponse, user: { ...owner, is_admin: true } }).success).toBe(
      false
    )
    expect(SocketTicketResponseSchema.safeParse({ ...ticketResponse, user: owner }).success).toBe(false)
  })
})

describe("selected backend identity (unit)", () => {
  test("decodes the minimum identity and preserves additional backend fields", () => {
    expect(ApplicationUserSchema.parse({ username: "will" })).toEqual({ username: "will" })
    expect(
      ApplicationUserSchema.parse({ username: "will", id: 1, email: "will@example.com", profile: { name: "Will" } })
    )
      .toEqual({ username: "will", id: 1, email: "will@example.com", profile: { name: "Will" } })
  })

  test.each([true, false])("preserves explicit administrator status %s and token authority", (is_admin) => {
    expect(ApplicationUserSchema.parse({
      username: "will",
      is_admin,
      token_scopes: ["write:repository", "read:user"],
      token_source: "personal-access-token"
    })).toEqual({
      username: "will",
      is_admin,
      token_scopes: ["write:repository", "read:user"],
      token_source: "personal-access-token"
    })
    expect(ApplicationUserSchema.parse({ username: "will", token_scopes: [] })).toEqual({
      username: "will",
      token_scopes: []
    })
  })

  test.each(
    [
      ["username", undefined],
      ["username", null],
      ["username", ""],
      ["username", 1],
      ["is_admin", null],
      ["is_admin", "true"],
      ["is_admin", 1],
      ["token_source", null],
      ["token_source", ""],
      ["token_source", 1],
      ["token_scopes", null],
      ["token_scopes", "write:user"],
      ["token_scopes", [""]],
      ["token_scopes", [1]],
      ["token_scopes", ["read:user", ""]]
    ] as const
  )("rejects malformed known identity field %s: %j", (field, value) => {
    expect(ApplicationUserSchema.safeParse({ username: "will", [field]: value }).success).toBe(false)
  })

  test("requires an identity object", () => {
    for (const input of [undefined, null, "will", []]) {
      expect(ApplicationUserSchema.safeParse(input).success).toBe(false)
    }
  })
})

describe("authentication route and capability names (unit)", () => {
  test("pins the owner, backend identity, browser-ticket and CSRF wire names", () => {
    expect({
      LOCAL_AUTH_STATUS_PATH,
      LOCAL_AUTH_BOOTSTRAP_PATH,
      LOCAL_AUTH_LOGIN_PATH,
      SOCKET_TICKET_PATH,
      AUTHENTICATED_USER_PATH,
      APPLICATION_SIGN_IN_PATH,
      CSRF_COOKIE_NAME,
      CSRF_HEADER_NAME,
      BOOTSTRAP_TOKEN_HEADER_NAME
    }).toEqual({
      LOCAL_AUTH_STATUS_PATH: "/api/auth/local/status",
      LOCAL_AUTH_BOOTSTRAP_PATH: "/api/auth/local/bootstrap",
      LOCAL_AUTH_LOGIN_PATH: "/api/auth/local/login",
      SOCKET_TICKET_PATH: "/api/auth/sse-ticket",
      AUTHENTICATED_USER_PATH: "/api/user",
      APPLICATION_SIGN_IN_PATH: "/api/auth/github",
      CSRF_COOKIE_NAME: "__csrf",
      CSRF_HEADER_NAME: "X-CSRF-Token",
      BOOTSTRAP_TOKEN_HEADER_NAME: "X-Smithers-Bootstrap-Token"
    })
    expect(APPLICATION_TOKEN_SCOPES).toEqual([
      "write:user",
      "write:repository",
      "write:workspace",
      "write:approval",
      "write:agent"
    ])
  })
})
