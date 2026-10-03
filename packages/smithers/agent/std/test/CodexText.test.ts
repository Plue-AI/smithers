import { describe, expect, it } from "vitest"
import * as CodexText from "../src/internal/CodexText.ts"

describe("CodexText boundaries", () => {
  it("counts UTF-8 bytes and rounds partial tokens up", () => {
    expect(CodexText.byteLength("aé😀")).toBe(7)
    expect(CodexText.approxBytesForTokens(0)).toBe(0)
    expect(CodexText.approxBytesForTokens(3)).toBe(12)
    expect([0, 1, 4, 5].map(CodexText.approxTokensFromByteCount)).toEqual([0, 1, 1, 2])
  })

  it("keeps empty values empty even with no display budget", () => {
    expect(CodexText.truncateMiddleChars("", 0)).toBe("")
    expect(CodexText.truncateMiddleWithTokenBudget("", 0)).toEqual({
      text: "",
      originalTokenCount: undefined
    })
    expect(CodexText.formatExecOutputForModel({
      output: "",
      exitCode: 9,
      durationSeconds: 0,
      maxOutputTokens: 0
    })).toBe("Exit code: 9\nWall time: 0 seconds\nOutput:\n")
  })

  it("counts removed Unicode scalars at zero bytes and retains values within a token budget", () => {
    expect(CodexText.truncateMiddleChars("a😀", 0)).toBe("…2 chars truncated…")
    expect(CodexText.truncateMiddleWithTokenBudget("é", 1)).toEqual({
      text: "é",
      originalTokenCount: undefined
    })
  })

  it("splits odd byte budgets while counting removed Unicode scalars", () => {
    expect(CodexText.truncateMiddleChars("a😀éb", 5)).toBe("a…1 chars truncated…éb")
    expect(CodexText.truncateMiddleChars("😀x😀", 3)).toBe("…3 chars truncated…")
    expect(CodexText.truncateMiddleChars("é", 2)).toBe("é")
    expect(CodexText.truncateMiddleWithTokenBudget("é😀é", 1)).toEqual({
      text: "é…1 tokens truncated…é",
      originalTokenCount: 2
    })
  })

  it("does not mark an unchanged truncation marker as altered output", () => {
    expect(CodexText.truncateMiddleWithTokenBudget("…6 tokens truncated…", 0)).toEqual({
      text: "…6 tokens truncated…",
      originalTokenCount: undefined
    })
  })

  it("discloses lost lines for a zero budget and includes a zero-duration timeout", () => {
    expect(CodexText.formatExecOutputForModel({
      output: "one\ntwo\n",
      exitCode: 124,
      durationSeconds: 1.26,
      maxOutputTokens: 0,
      timedOutAfterMs: 0
    })).toBe(
      "Exit code: 124\nWall time: 1.3 seconds\nTotal output lines: 3\nOutput:\n…12 tokens truncated…"
    )
  })
})
