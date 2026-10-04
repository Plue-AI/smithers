import { describe, expect, test } from "vitest"
import { CARD_CONTENT_CAP, fileValue } from "../src/FileRead.ts"

describe("the files.read answer", () => {
  test("the card holds at most 16 KiB characters", () => {
    expect(CARD_CONTENT_CAP).toBe(16_384)
  })

  test("the model reads the card's text, its truncation and binary stated", () => {
    expect(fileValue("acme/app", "JOURNEY.md", { content: "Add a greeting\n", truncated: false }))
      .toBe("JOURNEY.md in acme/app:\nAdd a greeting\n")
    expect(fileValue("acme/app", "big.ts", { content: "head", truncated: true }))
      .toBe("big.ts in acme/app (truncated at the card cap; the rest stays in the repository):\nhead")
    expect(fileValue("acme/app", "logo.png", { content: "", truncated: false, binary: true }))
      .toBe("logo.png in acme/app is a binary file; its bytes are not shown.")
  })
})
