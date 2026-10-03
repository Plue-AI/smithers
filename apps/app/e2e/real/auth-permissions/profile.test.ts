import { describe, expect, test } from "bun:test"
import { parseAuthenticatedUser } from "./profile"

describe("matrix authenticated-user probe", () => {
  test("reads the canonical GET /api/user shape", () => {
    expect(parseAuthenticatedUser(200, { username: "owner", is_admin: true })).toEqual({
      login: "owner",
      admin: true
    })
    expect(parseAuthenticatedUser(200, { username: "member" })).toEqual({
      login: "member",
      admin: false
    })
  })

  test("treats canonical unauthorized as signed out and rejects old session bodies", () => {
    expect(parseAuthenticatedUser(401, undefined)).toBeUndefined()
    expect(() => parseAuthenticatedUser(200, { login: "legacy" } as never)).toThrow("unrecognized user body")
  })
})
