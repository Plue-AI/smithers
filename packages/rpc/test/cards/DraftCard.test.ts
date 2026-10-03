/**
 * Behavioral projection contract checks for Draft.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { DraftCardSchema } from "../../src/DraftCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Draft.ts"

cardContract("Draft", DraftCardSchema, fixtures)

describe("Draft link safety", () => {
  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "ftp://example.com"])(
    "rejects unsafe issue URL %s",
    (url) => {
      const base = DraftCardSchema.parse(fixtures.issue)
      expect(DraftCardSchema.safeParse({ ...base, issue: { ...base.issue!, url } }).success).toBe(false)
    }
  )
})
