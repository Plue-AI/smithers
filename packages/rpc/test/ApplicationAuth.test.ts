import { describe, expect, test } from "vitest"
import {
  APPLICATION_SIGN_IN_PATH,
  APPLICATION_TOKEN_SCOPES,
  ApplicationUserSchema,
  AUTHENTICATED_USER_PATH,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SOCKET_TICKET_PATH,
  SocketTicketResponseSchema
} from "../src/ApplicationAuth.ts"

describe("socket ticket", () => {
 test("validates the socket ticket", () => {
  expect(SocketTicketResponseSchema.parse({ticket:"one-use",expires_at:"2026-10-04T00:00:00Z"})).toEqual({ticket:"one-use",expires_at:"2026-10-04T00:00:00Z"})
  expect(SocketTicketResponseSchema.safeParse({ticket:"",expires_at:""}).success).toBe(false)
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
  test("pins the owner, backend identity, browser-ticket and CSRF wire names", () => {
    expect({
      SOCKET_TICKET_PATH,
      AUTHENTICATED_USER_PATH,
      APPLICATION_SIGN_IN_PATH,
      CSRF_COOKIE_NAME,
      CSRF_HEADER_NAME
    }).toEqual({
      SOCKET_TICKET_PATH: "/api/auth/sse-ticket",
      AUTHENTICATED_USER_PATH: "/api/user",
      APPLICATION_SIGN_IN_PATH: "/api/auth/github",
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
