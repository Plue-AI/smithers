import { describe, expect, it } from "bun:test"
import * as Output from "../src/shell-output.ts"
import * as Shell from "../src/shell.ts"

describe("incremental shell output", () => {
  it("preserves UTF-8 and strips split CSI, OSC, DCS and CRLF at every byte boundary", () => {
    const raw = Buffer.from(
      "中文 👩🏽‍💻 é\r\n\x1b[31mred\x1b[0m\x1b]0;title\x07\x1bPprivate\x1b\\\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\\rend"
    )
    for (let split = 0; split <= raw.length; split++) {
      const stream = Output.decoder()
      expect(stream.write(raw.subarray(0, split)) + stream.write(raw.subarray(split)) + stream.end()).toBe(
        "中文 👩🏽‍💻 é\nredlink\nend"
      )
    }
    const stream = Output.decoder()
    expect([...raw].map((byte) => stream.write(Buffer.from([byte]))).join("") + stream.end()).toBe(
      "中文 👩🏽‍💻 é\nredlink\nend"
    )
  })

  it("redacts before emitting split values, including overlapping credentials and regexp characters", () => {
    const env = {
      API_KEY: "abcdefgh",
      AUTH_TOKEN: "defghijklm",
      LONG_SECRET: "abcdefgh-plus",
      OTHER_SECRET: "x.$[abc](value)"
    }
    const text = "plain abcdefghijklm abcdefgh-plus x.$[abc](value) ending abc"
    const expected = "plain [redacted $API_KEY]ijklm [redacted $LONG_SECRET] [redacted $OTHER_SECRET] ending abc"
    for (let split = 0; split <= text.length; split++) {
      const stream = Output.redactor(env)
      const first = stream.write(text.slice(0, split))
      const rest = stream.write(text.slice(split)) + stream.end()
      expect(first + rest).toBe(expected)
    }
    const stream = Output.redactor(env)
    expect([...text].map((character) => stream.write(character)).join("") + stream.end()).toBe(expected)
    const held = Output.redactor({ API_KEY: "abcdefgh" })
    expect(held.write("prefix abc")).toBe("prefix ")
    expect(held.write("defgh suffix")).toBe("[redacted $API_KEY] suffix")
    expect(held.end()).toBe("")
  })

  it("does not accumulate unfinished terminal control strings", () => {
    const stream = Output.decoder()
    expect(stream.write(Buffer.from("before\x1b]0;"))).toBe("before")
    for (let count = 0; count < 100; count++) expect(stream.write(Buffer.from("x".repeat(4096)))).toBe("")
    expect(stream.write(Buffer.from("\x07after")) + stream.end()).toBe("after")
  })

  it("recognizes normalized multiline credential values", () => {
    const value = "private-material\r\nsecond-line"
    const stream = Output.redactor({ PRIVATE_KEY: value })
    expect(stream.write(Output.clean(value)) + stream.end()).toBe("[redacted $PRIVATE_KEY]")
    expect(Output.redact(value, { PRIVATE_KEY: value })).toBe("[redacted $PRIVATE_KEY]")
  })

  it("keeps a truncated one-line Unicode tail valid and within the byte limit", () => {
    for (const character of ["中", "👩🏽‍💻"]) {
      const tail = Shell.tail(character.repeat(Shell.maxBytes))
      expect(tail.truncated).toBe(true)
      expect(tail.text).not.toContain("�")
      expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(Shell.maxBytes)
    }
  })
})
