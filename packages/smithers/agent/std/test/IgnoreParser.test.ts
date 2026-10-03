import { posix } from "node:path"
import { describe, expect, it } from "vitest"
import * as Ignore from "../src/internal/Ignore.ts"

const ignored = (content: string, filename: string, directory = false): boolean =>
  Ignore.ignored(
    [Ignore.parse("/repo", content)],
    posix.join("/repo", filename),
    posix.basename(filename),
    directory,
    posix.relative
  )

describe("Ignore parser boundaries", () => {
  it("keeps valid rules around dangling escapes and unopened alternatives", () => {
    const content = "first.txt\ninvalid\\\nbad}.txt\nlast.txt\n"
    expect(Ignore.parse("/repo", content).rules).toHaveLength(2)
    expect(ignored(content, "first.txt")).toBe(true)
    expect(ignored(content, "last.txt")).toBe(true)
    expect(ignored(content, "invalid")).toBe(false)
  })

  it("allows empty brace alternatives without discarding surrounding literal text", () => {
    expect(ignored("prefix{,}suffix\n", "prefixsuffix")).toBe(true)
    expect(ignored("prefix{,}suffix\n", "prefixXsuffix")).toBe(false)
    expect(ignored("{a,{b,c}}.txt\n", "b.txt")).toBe(true)
    expect(ignored("{a,{b,c}}.txt\n", "c.txt")).toBe(true)
    expect(ignored("{a,{b,c}}.txt\n", "d.txt")).toBe(false)
  })

  it("matches a leading closing bracket in a character class without losing later rules", () => {
    const content = "[]a].txt\nkeep.txt\n"
    expect(Ignore.parse("/repo", content).rules).toHaveLength(2)
    expect(ignored(content, "a.txt")).toBe(true)
    expect(ignored(content, "].txt")).toBe(true)
    expect(ignored(content, "b.txt")).toBe(false)
    expect(ignored(content, "keep.txt")).toBe(true)
  })

  it("uses the deepest matching scope and falls back to parent rules on a miss", () => {
    const scopes = [Ignore.parse("/repo", "*.tmp\n"), Ignore.parse("/repo/sub", "!keep.tmp\ncache/\n")]
    expect(Ignore.ignored(scopes, "/repo/sub/keep.tmp", "keep.tmp", false, posix.relative)).toBe(false)
    expect(Ignore.ignored(scopes, "/repo/sub/other.tmp", "other.tmp", false, posix.relative)).toBe(true)
    expect(Ignore.ignored(scopes, "/repo/sub/cache", "cache", false, posix.relative)).toBe(false)
    expect(Ignore.ignored(scopes, "/repo/sub/cache", "cache", true, posix.relative)).toBe(true)
    expect(Ignore.ignored([], "/repo/a.tmp", "a.tmp", false, posix.relative)).toBe(false)
  })
})
