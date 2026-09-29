import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import * as OutputStream from "../src/OutputStream.ts"

describe("bounded live subprocess output", () => {
  it("preserves counts and versions when credential-like names are public process switches", () => {
    const redact = OutputStream.redactor({ CLAUDE_CODE_CHILD_SESSION: "1", SMITHERS_OPENAI_AUTH: "chatgpt" })
    const message = "Found 1 error in v1.0.0; 10 tests passed using chatgpt"
    expect(redact(message)).toBe(message)
  })

  it("protects short and explicitly designated secrets without rewriting replacement markers", () => {
    const redact = OutputStream.redactor({ API_TOKEN: "private-value", SECRET: "A", OTHER_KEY: "a.b[0]" })
    expect(redact("private-value A a.b[0]")).toBe("[REDACTED] [REDACTED] [REDACTED]")
    expect(OutputStream.redactor({ CLAUDE_CODE_CHILD_SESSION: "1" }, ["CLAUDE_CODE_CHILD_SESSION"])("value 1"))
      .toBe("value [REDACTED]")
  })

  it("reassembles UTF-8 and split credentials before redacting", () => {
    const lines: Array<string> = []
    const observer = OutputStream.make({
      write: (stream, text) => lines.push(`${stream}: ${text}`),
      environment: { API_TOKEN: "private-value" }
    })
    observer.onStdout(Buffer.from("hello private-"))
    expect(lines).toEqual([])
    observer.onStdout(Buffer.from("value\nBearer abcd"))
    observer.onStdout(Buffer.from("efghijkl\n"))
    const encoded = Buffer.from("🦊\n")
    observer.onStderr(encoded.subarray(0, 2))
    observer.onStderr(encoded.subarray(2))
    observer.close()
    expect(lines.join("")).toContain("[REDACTED]")
    expect(lines.join("")).toContain("[REDACTED_TOKEN]")
    expect(lines.join("")).toContain("🦊")
    expect(lines.join("")).not.toContain("private-value")
    expect(lines.join("")).not.toContain("abcdefghijkl")
  })

  it("removes terminal injection, bounds lines, and flushes final fragments once", () => {
    const lines: Array<string> = []
    const observer = OutputStream.make({ write: (_stream, text) => lines.push(text), maximumLines: 2 })
    observer.onStdout(Buffer.from("\u001b[2Jone\n"))
    observer.onStderr(Buffer.from("two"))
    observer.close()
    observer.close()
    expect(lines).toEqual(["one\n", "two\n"])
    const bounded = OutputStream.make({ write: (_stream, text) => lines.push(text), maximumLines: 1 })
    bounded.onStdout(Buffer.from("a\nb\nc\n"))
    bounded.close()
    expect(lines).toHaveLength(4)
    expect(lines.at(-1)).toContain("limit reached")
  })

  it("redacts each line of a multiline known secret", () => {
    const lines: Array<string> = []
    const observer = OutputStream.make({
      write: (_stream, text) => lines.push(text),
      environment: { PRIVATE_KEY: "first-part\nsecond-part" }
    })
    observer.onStdout(Buffer.from("first-part\nsecond-part\n"))
    observer.close()
    expect(lines).toEqual(["[REDACTED]\n", "[REDACTED]\n"])
  })

  it("redacts a private key and an inspected string split over lines and chunks", () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const pem = `-----BEGIN PRIVATE KEY-----\n${secret}${secret}\n${secret}\n-----END PRIVATE KEY-----\n`
    const text = `${pem}${inspect({ privateKey: `${secret}\n`.repeat(8) })}\ndone\n`
    const lines: Array<string> = []
    const observer = OutputStream.make({ write: (_stream, line) => lines.push(line) })
    for (let offset = 0; offset < text.length; offset += 7) {
      observer.onStdout(Buffer.from(text.slice(offset, offset + 7)))
    }
    observer.close()
    expect(lines.join("")).not.toContain(secret)
    expect(lines.join("")).toContain("[REDACTED]")
    expect(lines.at(-1)).toBe("done\n")
  })

  it("keeps a value opened by an overlong line held until it closes", () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const lines: Array<string> = []
    const observer = OutputStream.make({ write: (_stream, line) => lines.push(line) })
    observer.onStdout(Buffer.from(`password: "${"a".repeat(33_000)}\n`))
    observer.onStdout(Buffer.from(`${secret}\n"\nafter\n`))
    observer.close()
    expect(lines.join("")).not.toContain(secret)
    expect(lines[0]).toBe("[overlong line omitted]\n")
    expect(lines.at(-1)).toBe("after\n")
  })

  it("withholds what an opener in the dropped middle of an overlong line swallows", () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const lines: Array<string> = []
    const observer = OutputStream.make({ environment: {}, write: (_stream, line) => lines.push(line) })
    const text = `${"x".repeat(20_000)} password: { value: "${"a".repeat(20_000)}\n${secret}\n" }\n`
    for (let offset = 0; offset < text.length; offset += 4096) {
      observer.onStdout(Buffer.from(text.slice(offset, offset + 4096)))
    }
    observer.close()
    expect(lines.join("")).not.toContain(secret)
  })

  it("redacts a known value split across chunks", () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const lines: Array<string> = []
    const observer = OutputStream.make({
      environment: { API_TOKEN: secret },
      write: (_stream, line) => lines.push(line)
    })
    observer.onStdout(Buffer.from(`value ${secret.slice(0, 10)}`))
    observer.onStdout(Buffer.from(`${secret.slice(10)} end\n`))
    observer.close()
    expect(lines).toEqual(["value [REDACTED] end\n"])
  })

  it("redacts diagnostic credential spellings in reporter text and live lines", () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const redact = OutputStream.redactor({})
    expect(redact(`sshpass -p ${secret} ssh host`)).toBe("sshpass -p [REDACTED] ssh host")
    expect(redact(`Authorization: Token ${secret}`)).toBe("Authorization: [REDACTED]")
    const lines: Array<string> = []
    const observer = OutputStream.make({ environment: {}, write: (_stream, line) => lines.push(line) })
    observer.onStderr(Buffer.from(`sshpass -p ${secret} ssh host\nAuthorization: Token ${secret}\n`))
    observer.close()
    expect(lines).toEqual(["sshpass -p [REDACTED] ssh host\n", "Authorization: [REDACTED]\n"])
  })

  it("discards overlong unterminated lines and isolates observer errors", () => {
    const lines: Array<string> = []
    const observer = OutputStream.make({ write: (_stream, text) => lines.push(text) })
    observer.onStdout(Buffer.from("s".repeat(40 * 1024)))
    observer.onStdout(Buffer.from("secret\nnext\n"))
    observer.close()
    expect(lines).toEqual(["[overlong line omitted]\n", "next\n"])
    const broken = OutputStream.make({
      write: () => {
        throw new Error("terminal closed")
      }
    })
    expect(() => {
      broken.onStdout(Buffer.from("hello\n"))
      broken.close()
    }).not.toThrow()
  })
})
