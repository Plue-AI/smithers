import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Transport from "../src/internal/Transport.ts"

const bytes = (text: string) => new TextEncoder().encode(text)

const split = (chunks: ReadonlyArray<string>, crTerminates?: boolean, maxLineBytes = 64) =>
  Effect.runPromise(
    Stream.runCollect(
      Transport.lines(
        "lines",
        maxLineBytes,
        Stream.fromIterable(chunks.map(bytes)),
        crTerminates === undefined ? {} : { crTerminates }
      )
    )
  )

describe("Transport.lines", () => {
  it("ends lines at LF only by default, dropping the CR of a CRLF and keeping blank lines", async () => {
    expect(await split(["a\rb\n", "x\r\n", "\n", "tail"])).toEqual(["a\rb", "x", "", "tail"])
  })

  it("ends lines at CR, LF, and CRLF when CR terminates, including a CRLF split across chunks", async () => {
    expect(await split(["a\rb\r", "\nc\r\n\r", "d", "\n"], true)).toEqual(["a", "b", "c", "", "d"])
  })

  it("fails a line longer than the bound in either mode", async () => {
    for (const crTerminates of [false, true]) {
      await expect(split(["12345", "6\r"], crTerminates, 5)).rejects.toMatchObject({
        code: "protocol_error",
        message: "MCP frame exceeded 5 bytes"
      })
      await expect(split(["123456\n"], crTerminates, 5)).rejects.toMatchObject({
        message: "MCP frame exceeded 5 bytes"
      })
    }
  })
})
