import { describe, expect, test } from "vitest"
import {
  APPLICATION_SIGN_IN_PATH,
  APPLICATION_TOKEN_SCOPES,
  ApplicationUserSchema,
  AUTHENTICATED_USER_PATH,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SETUP_TOKEN_PARAM,
  SOCKET_TICKET_PATH,
  SocketTicketResponseSchema
} from "../src/ApplicationAuth.ts"

const ticketResponse = { ticket: "one-use-socket-ticket", expires_at: "2026-09-27T12:01:00Z" }

describe("socket-ticket response (unit)", () => {
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

  test("rejects unknown fields", () => {
    expect(SocketTicketResponseSchema.safeParse({ ...ticketResponse, user: { id: 1, username: "will" } }).success)
      .toBe(false)
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

  test.each(["Ada Park", ""])("preserves the profile display_name %j", (display_name) => {
    expect(ApplicationUserSchema.parse({ username: "will", display_name })).toEqual({ username: "will", display_name })
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
      ["token_scopes", ["read:user", ""]],
      ["display_name", null],
      ["display_name", 1]
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
  test("pins the backend identity, browser-ticket and CSRF wire names", () => {
    expect({
      SOCKET_TICKET_PATH,
      AUTHENTICATED_USER_PATH,
      APPLICATION_SIGN_IN_PATH,
      SETUP_TOKEN_PARAM,
      CSRF_COOKIE_NAME,
      CSRF_HEADER_NAME
    }).toEqual({
      SOCKET_TICKET_PATH: "/api/auth/sse-ticket",
      AUTHENTICATED_USER_PATH: "/api/user",
      APPLICATION_SIGN_IN_PATH: "/api/auth/github",
      SETUP_TOKEN_PARAM: "setup_token",
      CSRF_COOKIE_NAME: "__csrf",
      CSRF_HEADER_NAME: "X-CSRF-Token"
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
