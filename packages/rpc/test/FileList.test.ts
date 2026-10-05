import { describe, expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"
import {
  fileListCard,
  FILES_LIST_COMMAND,
  LISTING_VALUE_CAP,
  listingValue,
  parseFileListArgs,
  sortEntries
} from "../src/FileList.ts"

const COMMIT = "0123456789abcdef0123456789abcdef01234567"

describe("the files.list flow every host binds", () => {
  test("is named and described once", () => {
    expect(FILES_LIST_COMMAND).toEqual({
      name: "files.list",
      summary: "List a repository directory",
      args: "[path] [owner/repo]",
      agent: "run"
    })
    expect(LISTING_VALUE_CAP).toBe(400)
  })

  test("the path is the first token, the repository the second, and no token lists the root", () => {
    expect(parseFileListArgs(undefined)).toEqual({ payload: { path: "" } })
    expect(parseFileListArgs("   ")).toEqual({ payload: { path: "" } })
    expect(parseFileListArgs("src")).toEqual({ payload: { path: "src" } })
    expect(parseFileListArgs("src/lib acme/app")).toEqual({ payload: { path: "src/lib", repo: "acme/app" } })
    expect(parseFileListArgs("\"Meeting Notes\" acme/app")).toEqual({
      payload: { path: "Meeting Notes", repo: "acme/app" }
    })
    expect(parseFileListArgs("a b c")).toEqual({ error: "files.list takes a path and optionally an owner/repo" })
    expect(parseFileListArgs("\"open")).toEqual({ error: "Close the quoted file argument before the next argument." })
  })

  test("directories come first, then names in locale order", () => {
    expect(
      sortEntries([
        { name: "README.md", kind: "file" },
        { name: "test", kind: "dir" },
        { name: "CHANGELOG.md", kind: "file" },
        { name: "Cargo.lock", kind: "file" },
        { name: "src", kind: "dir" }
      ])
    ).toEqual([
      { name: "src", kind: "dir" },
      { name: "test", kind: "dir" },
      { name: "Cargo.lock", kind: "file" },
      { name: "CHANGELOG.md", kind: "file" },
      { name: "README.md", kind: "file" }
    ])
  })

  test("the model's copy marks directories, names an empty directory, and stops at the cap", () => {
    expect(listingValue("acme/app", "", [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }])).toBe(
      "/ in acme/app:\nsrc/\na.md"
    )
    expect(listingValue("acme/app", "docs", [])).toBe("docs in acme/app is empty.")
    const many = Array.from({ length: LISTING_VALUE_CAP + 3 }, (_, index) => ({
      name: `f${index}`,
      kind: "file" as const
    }))
    const lines = listingValue("acme/app", "big", many).split("\n")
    expect(lines).toHaveLength(LISTING_VALUE_CAP + 2)
    expect(lines.at(-1)).toBe("… and 3 more (the card lists them all)")
  })

  test("a listing is one Files card, addressed and sorted, that the card schema accepts", () => {
    const { card, value } = fileListCard(
      {
        repo: "acme/app",
        path: "",
        entries: [{ name: "package.json", kind: "file" }, { name: "test", kind: "dir" }],
        readAt: { changeId: null, commitId: COMMIT, source: "head" }
      },
      3,
      1_000
    )
    expect(card).toEqual({
      id: "files-acme/app-/",
      kind: "file-list",
      title: "Files · acme/app · /",
      status: "active",
      createdAt: 1_000,
      ordinal: 3,
      payload: {
        repo: "acme/app",
        path: "",
        entries: [{ name: "test", kind: "dir" }, { name: "package.json", kind: "file" }],
        address: "/acme/app/",
        readAt: { changeId: null, commitId: COMMIT, source: "head" }
      }
    })
    expect(CardSchema.safeParse(card).success).toBe(true)
    expect(value).toBe("/ in acme/app:\ntest/\npackage.json")
  })

  test("a directory cut short says so on the card and to the model", () => {
    const { card, value } = fileListCard(
      { repo: "acme/app", path: "src", entries: [{ name: "a.ts", kind: "file" }], truncated: true },
      0,
      1
    )
    expect(card.id).toBe("files-acme/app-src")
    expect(card.title).toBe("Files · acme/app · src")
    expect(card.payload).toEqual({
      repo: "acme/app",
      path: "src",
      entries: [{ name: "a.ts", kind: "file" }],
      truncated: true,
      address: "/acme/app/src"
    })
    expect(value).toBe("src in acme/app:\na.ts\n(The directory has more entries than one listing shows.)")
  })
})
