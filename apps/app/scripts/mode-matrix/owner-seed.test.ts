import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ownerSeed } from "./owner-seed"

test("the seed stores only the token's SHA-256 and names the login as the one owner", () => {
  const seed = ownerSeed("matrix-owner")
  expect(seed.token).toMatch(/^smithers_[0-9a-f]{40}$/)
  const hash = createHash("sha256").update(seed.token).digest("hex")
  expect(seed.sql).toContain(`'${hash}', '${hash.slice(-8)}'`)
  expect(seed.sql).not.toContain(seed.token)
  expect(seed.sql).toContain("VALUES ('matrix-owner', 'matrix-owner', 'matrix-owner', TRUE)")
  expect(seed.sql).toContain("'matrix-owner', 'owner' FROM owner_user")
  expect(ownerSeed("matrix-owner").token).not.toBe(seed.token)
})

test.each(["", "Matrix", "owner'; DROP TABLE users; --", "a".repeat(40)])("refuses login %j before writing SQL", (login) => {
  expect(() => ownerSeed(login)).toThrow("is not a lowercase GitHub login")
})
