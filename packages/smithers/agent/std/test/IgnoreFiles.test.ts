import { NodeServices } from "@effect/platform-node"
import * as Path from "@smthrs/kernel/Path"
import { Context, Effect, Layer, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, posix, relative, sep } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as Ignore from "../src/internal/Ignore.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Search from "../src/Search.ts"

const temporary = mkdtempSync(join(tmpdir(), "std-ignore-"))
afterAll(() => rmSync(temporary, { recursive: true, force: true }))
let sequence = 0
const fixture = (files: Record<string, string>) => {
  const root = join(temporary, String(sequence++))
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return root
}
const cases = [
  {
    name: "matches the entire filename including a final newline",
    posixNames: true,
    rules: "end.txt\n",
    files: ["end.txt", "end.txt\n"],
    kept: ["end.txt\n"]
  },
  {
    name: "UTF-8 bytes and brace alternatives",
    rules: "?.tmp\n??.tmp\n*.{log,cache}\n",
    files: ["a.tmp", "é.tmp", "😀.tmp", "a.log", "a.cache"],
    kept: ["😀.tmp"]
  },
  {
    name: "BOM, CRLF and malformed rules",
    rules: "\uFEFFdrop.txt\r\n[z-a]\n{broken\nother.txt\r\n",
    files: ["drop.txt", "other.txt", "keep.txt"],
    kept: ["keep.txt"]
  },
  {
    name: "unclosed and negated character classes",
    rules: "[literal\n[!ab].txt\n",
    files: ["[literal", "a.txt", "c.txt"],
    kept: ["a.txt"]
  },
  { name: "basename at every depth", rules: "*.tmp\n", files: ["a.tmp", "sub/b.tmp", "keep.txt"], kept: ["keep.txt"] },
  {
    name: "last matching rule and negation",
    rules: "*.tmp\n!keep.tmp\nkeep.tmp\n!sub/keep.tmp\n",
    files: ["a.tmp", "keep.tmp", "sub/keep.tmp"],
    kept: ["sub/keep.tmp"]
  },
  { name: "leading slash anchors", rules: "/a.txt\n", files: ["a.txt", "sub/a.txt"], kept: ["sub/a.txt"] },
  {
    name: "interior slash anchors",
    rules: "one/a.txt\n",
    files: ["one/a.txt", "sub/one/a.txt"],
    kept: ["sub/one/a.txt"]
  },
  {
    name: "trailing slash is directory-only",
    rules: "cache/\n",
    files: ["cache/a.txt", "sub/cache"],
    kept: ["sub/cache"]
  },
  {
    name: "globstar matches zero or more directories",
    rules: "a/**/b.txt\n**/gone.txt\ntree/**\n",
    files: ["a/b.txt", "a/x/y/b.txt", "gone.txt", "sub/gone.txt", "tree/a.txt", "a/keep.txt"],
    kept: ["a/keep.txt"]
  },
  {
    name: "escaped markers, comments and blank lines",
    rules: "# comment\n\n\\#literal\n\\!literal\n",
    files: ["#literal", "!literal", "keep.txt"],
    kept: ["keep.txt"]
  },
  {
    name: "spaces and escaped glob characters",
    posixNames: true,
    rules: "drop.txt   \nspace\\ \nliteral\\*.txt\n",
    files: ["drop.txt", "space ", "literal*.txt", "literalX.txt"],
    kept: ["literalX.txt"]
  },
  {
    name: "character classes and question marks",
    rules: "[ab]?.txt\n",
    files: ["a1.txt", "b2.txt", "c3.txt"],
    kept: ["c3.txt"]
  },
  {
    name: "ignored directories cannot be re-included from below",
    rules: "pruned/\n!pruned/keep.txt\n",
    files: ["pruned/keep.txt", "keep.txt"],
    kept: ["keep.txt"]
  },
  {
    name: "directory negation permits descent",
    rules: "*\n!sub/\n!sub/keep.txt\n",
    files: ["a.txt", "sub/a.txt", "sub/keep.txt"],
    kept: ["sub/keep.txt"]
  }
]

it.each(cases.filter((scenario) => "posixNames" in scenario))(
  "matches POSIX filename bytes on every host: $name",
  (scenario) => {
    const scope = Ignore.parse("/repo", scenario.rules)
    const kept = scenario.files.filter((file) =>
      !Ignore.ignored([scope], posix.join("/repo", file), file, false, posix.relative)
    )
    expect(kept).toEqual(scenario.kept)
  }
)

for (const [name, layer] of [["portable", PortableSearch.layer], ["native", NativeSearch.layer]] as const) {
  describe(`ignore files (${name})`, () => {
    const implementation = layer.pipe(Layer.provide(NodeServices.layer))
    const glob = (input: Glob.Input) => Effect.runPromise(Glob.run(input).pipe(Effect.provide(implementation)))
    const grep = (input: Grep.Input) => Effect.runPromise(Grep.run(input).pipe(Effect.provide(implementation)))
    for (const scenario of cases) {
      // Windows cannot create names containing newlines, literal *, or trailing spaces.
      it.skipIf(process.platform === "win32" && "posixNames" in scenario)(scenario.name, async () => {
        const root = fixture({
          ".gitignore": scenario.rules,
          ...Object.fromEntries(scenario.files.map((file) => [file, "needle\n"]))
        })
        expect((await glob({ root, pattern: "**/*" })).paths.map((file) => relative(root, file).split(sep).join("/")))
          .toEqual(
            scenario.kept.sort()
          )
        const found = await grep({ root, pattern: "needle", globs: ["**/*"], symbols: false })
        expect(found.matches.map((match) => relative(root, match.file).split(sep).join("/"))).toEqual(
          scenario.kept.sort()
        )
        expect(found.filesSearched).toBe(scenario.kept.length)
        expect((await grep({ root, pattern: "needle", noIgnore: true, symbols: false })).filesSearched).toBe(
          scenario.files.length
        )
        expect((await glob({ root, pattern: "**/*", noIgnore: true })).total).toBe(scenario.files.length)
      })
    }
    it("counts and limits results across native argv batches", async () => {
      const files = Object.fromEntries(Array.from({ length: 270 }, (_, index) => [
        `${String(index).padStart(3, "0")}-${"é".repeat(70)}.txt`,
        index === 269 ? "needle\0" : "needle\n"
      ]))
      const root = fixture(files)
      const result = await grep({ root, pattern: "needle", symbols: false, limit: 1 })
      expect(result).toMatchObject({ filesSearched: 270, skippedBinary: 1, truncated: true })
      expect(result.matches).toHaveLength(1)
      expect(result.notice).toContain("of 269 matches")
      expect((await glob({ root, pattern: "*.txt", limit: 1 })).total).toBe(270)
    })
    it.each([
      { name: "omitted", options: {}, noIgnore: false },
      { name: "false", options: { noIgnore: false }, noIgnore: false },
      { name: "true", options: { noIgnore: true }, noIgnore: true }
    ])("scopes root and nested rules with noIgnore $name", async ({ options, noIgnore }) => {
      const files = {
        "one/keep.tmp": "needle",
        "two/keep.tmp": "needle",
        "one/anchored.txt": "needle",
        "one/sub/anchored.txt": "needle",
        "one/cache/a.txt": "needle",
        "two/cache/a.txt": "needle"
      }
      const root = fixture({
        ".gitignore": "*.tmp\n",
        "one/.gitignore": "!keep.tmp\n/anchored.txt\ncache/\n",
        ...files
      })
      const expected = (noIgnore
        ? Object.keys(files)
        : ["one/keep.tmp", "one/sub/anchored.txt", "two/cache/a.txt"]).sort()
      const foundPaths = await glob({ root, pattern: "**/*", ...options })
      expect(foundPaths.paths.map((file) => relative(root, file).split(sep).join("/"))).toEqual(expected)
      expect(foundPaths.total).toBe(expected.length)
      const foundMatches = await grep({ root, pattern: "needle", symbols: false, ...options })
      expect(foundMatches.matches.map((match) => relative(root, match.file).split(sep).join("/"))).toEqual(expected)
      expect(foundMatches.filesSearched).toBe(expected.length)
    })
    it("ignores only root-scoped .gitignore", async () => {
      const parent = fixture({
        ".gitignore": "*.txt\n",
        "project/.ignore": "*.txt\n",
        "project/.rgignore": "*.txt\n",
        "project/.git/info/exclude": "*.txt\n",
        "project/a.txt": "needle",
        "project/.gitignore": "b.txt\n",
        "project/b.txt": "needle"
      })
      expect((await glob({ root: join(parent, "project"), pattern: "*.txt" })).paths).toEqual([
        join(parent, "project/a.txt")
      ])
    })
    it("applies parent rules across a nested repository boundary", async () => {
      const root = fixture({
        ".gitignore": "*.tmp\n",
        "nested/.git/HEAD": "ref: refs/heads/main\n",
        "nested/a.tmp": "needle",
        "nested/keep.txt": "needle"
      })
      expect((await glob({ root, pattern: "**/*" })).paths).toEqual([join(root, "nested/keep.txt")])
    })
    it("searches explicit ignored files and directory roots", async () => {
      const root = fixture({ ".gitignore": "ignored/\n*.txt\n", "ignored/a.txt": "needle" })
      expect((await glob({ root: join(root, "ignored"), pattern: "*" })).total).toBe(1)
      expect((await grep({ root: join(root, "ignored/a.txt"), pattern: "needle" })).filesSearched).toBe(1)
    })
    it("reports ignore exclusions on empty results and names the escape hatch", async () => {
      const root = fixture({ ".gitignore": "build/\n", "build/a.ts": "needle", "keep.txt": "hay" })
      for (const result of [await glob({ root, pattern: "build/**/*.ts" }), await grep({ root, pattern: "needle" })]) {
        expect(result.notice).toContain("ignore files")
        expect(result.notice).toContain("noIgnore: true")
      }
      expect((await glob({ root, pattern: "missing/**", noIgnore: true })).notice).toContain(
        "there is no missing directory"
      )
      expect((await grep({ root, pattern: "absent", noIgnore: true })).notice).toBeUndefined()
    })
    it("keeps hidden and fixed skip rules independent of noIgnore", async () => {
      const root = fixture({
        ".gitignore": "*.txt\n",
        ".secret.txt": "needle",
        "node_modules/a.txt": "needle",
        "a.txt": "needle"
      })
      expect((await glob({ root, pattern: "*.txt", hidden: true })).total).toBe(0)
      expect((await glob({ root, pattern: "*.txt", noIgnore: true })).total).toBe(1)
      expect((await glob({ root, pattern: "*.txt", noIgnore: true, hidden: true })).total).toBe(2)
    })
  })
}

it("accepts both boolean noIgnore values in the public schemas", () => {
  for (const noIgnore of [false, true]) {
    expect(Schema.decodeUnknownSync(Grep.Input)({ pattern: "needle", noIgnore }).noIgnore).toBe(noIgnore)
    expect(Schema.decodeUnknownSync(Glob.Input)({ pattern: "*", noIgnore }).noIgnore).toBe(noIgnore)
  }
})

it("never descends into an ignored directory", async () => {
  const root = fixture({ ".gitignore": "build/\n", "build/deep/a.txt": "needle", "keep.txt": "needle" })
  const visited: Array<string> = []
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const fs = yield* FileSystem.FileSystem
      const search = PortableSearch.make(
        Context.add(services, FileSystem.FileSystem, {
          ...fs,
          readDirectory: (directory) => {
            visited.push(directory)
            return fs.readDirectory(directory)
          }
        })
      )
      return yield* Glob.run({ root, pattern: "**/*" }).pipe(Effect.provideService(Search.Search, search))
    }).pipe(Effect.provide(NodeServices.layer))
  )
  expect(visited).toEqual([root])
  expect(result.total).toBe(1)
})

it("native search ignores global excludes and ripgrep configuration", async () => {
  const root = fixture({ "project/a.txt": "needle", "config/git/ignore": "*.txt\n", "rg.conf": "--glob=!*.txt\n" })
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const services = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | import("@smthrs/kernel/ChildProcessSpawner").ChildProcessSpawner
      >()
      const search = NativeSearch.make(services, {
        XDG_CONFIG_HOME: join(root, "config"),
        RIPGREP_CONFIG_PATH: join(root, "rg.conf")
      })
      return yield* Glob.run({ root: join(root, "project"), pattern: "*.txt" }).pipe(
        Effect.provideService(Search.Search, search)
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )
  expect(result.paths).toEqual([join(root, "project/a.txt")])
})
