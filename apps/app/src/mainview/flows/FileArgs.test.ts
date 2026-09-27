import { describe, expect, test } from "bun:test"
import { fileArgs, parseFileArgs } from "./FileArgs"
import { payloadFor } from "./SlashPayload"
import { flowArgs } from "./FlowArgs"

describe("file arguments shared by commands, cards and forms", () => {
  test("citation links retain their repository, immutable revision and line through the file flow", () => {
    const payload = { path: "src/answer.ts", repo: "org/repo", line: 2, ref: "a".repeat(40) }
    expect(payloadFor("files.read", flowArgs("files.read", payload))).toEqual({ payload })
    expect(payloadFor("files.read", `src/answer.ts:2 org/repo --ref ${payload.ref}`)).toEqual({ payload })
    expect(payloadFor("files.read", "src/answer.ts --ref")).toHaveProperty("error")
  })
  test("spaces, quotes, literal backslashes and Unicode round-trip without changing the path", () => {
    for (const path of ["docs/Meeting Notes.md", 'docs/a "quote".md', "docs/it's here.md", "docs/a\\b.md", "docs/你好 world.md", "docs/line\nbreak.md"]) {
      expect(parseFileArgs(fileArgs(path, "repo-2"))).toEqual({ tokens: [path, "repo-2"] })
      expect(payloadFor("files.read", fileArgs(path, "repo-2"))).toEqual({ payload: { path, repo: "repo-2" } })
    }
  })

  test("human single quotes and unquoted paths retain their literal contents", () => {
    expect(parseFileArgs("'docs/Meeting Notes.md' repo-2")).toEqual({ tokens: ["docs/Meeting Notes.md", "repo-2"] })
    expect(parseFileArgs("docs/a\\b.md repo-2")).toEqual({ tokens: ["docs/a\\b.md", "repo-2"] })
    expect(parseFileArgs('"unfinished')).toHaveProperty("error")
    expect(parseFileArgs('"closed"extra')).toHaveProperty("error")
  })
})
