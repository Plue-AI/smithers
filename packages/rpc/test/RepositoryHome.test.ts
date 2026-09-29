import { describe, expect, it } from "vitest"
import { RepositoryHomeSchema } from "../src/RepositoryHome.ts"

describe("resolved homepage links", () => {
  const decode = (url: string) => RepositoryHomeSchema.safeParse({
    kind: "blocks",
    blocks: [{ type: "links", links: [{ label: "Guide", url }] }]
  })

  it("preserves HTTP(S) scheme casing", () => {
    for (const scheme of ["HTTP", "HTTPS", "HtTp", "HtTpS"]) {
      const url = `${scheme}://example.com/guide`
      const result = decode(url)
      expect(result.success).toBe(true)
      if (result.success && result.data.kind === "blocks") {
        expect(result.data.blocks[0]).toEqual({ type: "links", links: [{ label: "Guide", url }] })
      }
    }
  })

  it("refuses unsupported schemes and malformed links", () => {
    for (const url of [
      "ftp://example.com/guide",
      "file:///guide",
      "mailto:x@example.com",
      "javascript:alert(1)",
      "https://",
      "HtTp://",
      "/relative"
    ]) expect(decode(url).success).toBe(false)
  })
})
