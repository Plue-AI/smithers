import { describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse, run } from "../src/search.ts"

const match = (data: unknown): string => JSON.stringify({ type: "match", data })
const fields = (path: unknown, lines: unknown, line_number: unknown = 7): unknown => ({ path, lines, line_number })

describe("rg JSON message parsing", () => {
  it("ignores malformed messages and non-match events", () => {
    for (
      const message of [
        "not json",
        "null",
        "[]",
        "42",
        "\"match\"",
        JSON.stringify({ type: "begin", data: fields({ text: "file.txt" }, { text: "hit\n" }) }),
        JSON.stringify({ type: null, data: fields({ text: "file.txt" }, { text: "hit\n" }) }),
        JSON.stringify({ type: 1, data: fields({ text: "file.txt" }, { text: "hit\n" }) }),
        JSON.stringify({ type: "match", data: null }),
        JSON.stringify({ type: "match", data: [] }),
        match(fields({ text: "file.txt" }, { text: "hit\n" }, 1.5)),
        match(fields({ text: "file.txt" }, { text: "hit\n" }, "7"))
      ]
    ) {
      expect(parse(message)).toBeUndefined()
    }
  })

  it("rejects missing, null, primitive, and numeric-byte path or lines", () => {
    const validPath = { text: "file.txt" }
    const validLines = { text: "hit\n" }
    for (
      const invalid of [undefined, null, "file.txt", 123, [], { text: null }, { text: 123 }, { bytes: null }, {
        bytes: [104, 105, 116]
      }]
    ) {
      expect(parse(match(fields(invalid, validLines)))).toBeUndefined()
      expect(parse(match(fields(validPath, invalid)))).toBeUndefined()
    }
  })

  it("rejects malformed base64 byte fields", () => {
    const path = { text: "file.txt" }
    const lines = { text: "hit\n" }
    for (const invalid of [{ bytes: "%%%" }, { bytes: "a" }, { bytes: "a===" }]) {
      expect(parse(match(fields(invalid, lines)))).toBeUndefined()
      expect(parse(match(fields(path, invalid)))).toBeUndefined()
    }
  })

  it("keeps Unicode text and decodes base64 path and lines", () => {
    expect(parse(match(fields({ text: "./café/日本語.txt" }, { text: "naïve 雪\r\n" })))).toEqual({
      path: "café/日本語.txt",
      line: 7,
      text: "naïve 雪"
    })

    const bytes = (value: string): { bytes: string } => ({ bytes: Buffer.from(value).toString("base64") })
    expect(parse(match(fields(bytes("./café/日本語.txt"), bytes("naïve 雪\n"), 12)))).toEqual({
      path: "café/日本語.txt",
      line: 12,
      text: "naïve 雪"
    })
  })

  it("skips malformed stdout records and retains a later match", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-search-parse-"))
    const command = join(cwd, "rg-shim")
    const valid = match(fields({ text: "./café.txt" }, { text: "naïve\n" }))
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s\\n' 'null' '{"type":"match","data":{"path":{"bytes":[1]},"lines":{"text":"bad"},"line_number":1}}' '${valid}'\n`
    )
    chmodSync(command, 0o755)
    try {
      expect(await run({ cwd, command, query: "naïve" }).done).toEqual({
        _tag: "done",
        hits: [{ path: "café.txt", line: 7, text: "naïve" }],
        truncated: false
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
