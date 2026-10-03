import { expect, test } from "bun:test"
import { recommendTail, TAIL_MAX_MESSAGES, TAIL_MAX_CHARS } from "./Recommend"

test("the tail keeps the newest 12 messages and drops the oldest past 4000 characters", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, text: `m${index}` }))
    const capped = recommendTail(many)
    expect(capped.length).toBe(TAIL_MAX_MESSAGES)
    expect(capped[0]?.text).toBe("m8")
    expect(capped.at(-1)?.text).toBe("m19")

    const long = "x".repeat(3000)
    const heavy = recommendTail([
      { role: "user", text: long },
      { role: "smithers", text: long },
      { role: "user", text: "latest" }
    ])
    expect(heavy.map((entry) => entry.text)).toEqual([long, "latest"])
    expect(heavy.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(TAIL_MAX_CHARS)

    const [lone] = recommendTail([{ role: "user", text: `${"a".repeat(4000)}tail` }])
    expect(lone?.text.length).toBe(TAIL_MAX_CHARS)
    expect(lone?.text.endsWith("tail")).toBe(true)
  })
