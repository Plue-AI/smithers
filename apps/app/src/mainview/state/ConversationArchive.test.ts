import { describe, expect, test } from "bun:test"
import type { AppTransition, WorldDocument } from "./AppState"
import { archiveNotice, conversationNotes } from "./ConversationArchive"

/*
 * conversationNotes turns a model's chosen note titles into wiki records, and
 * a model chooses titles freely: two identical ones in a sweep, one that
 * already exists in another case, one made entirely of characters Windows
 * reserves. Nothing here was pinned, so dropping either de-duplication loop
 * or the character scrub was silent.
 */

type Notes = Extract<AppTransition, { readonly type: "conversation.cleared" }>["notes"]

const note = (title: string, body = "a fact recorded nowhere else"): Notes[number] => ({ title, body, confidence: 0.9 })

const document = (id: string, path: string): WorldDocument => ({
  id,
  path,
  title: path,
  body: "",
  links: [],
  tags: [],
  sources: [],
  confidence: 1,
  updatedBy: "smithers",
  updatedAt: 1_700_000_000_000,
  revision: 1
})

const sweep = (notes: Notes, existing: ReadonlyArray<WorldDocument> = []): WorldDocument[] =>
  conversationNotes(notes, existing, "branch-old", 7, "branch-new", 8, 1_700_000_000_000)

describe("conversation notes", () => {
  for (const [kept, permanent] of [
    [0, "Started a new conversation. [Open the archived conversation](/previous)."],
    [1, "Saved 1 new note to Wiki and started a new conversation. [Open the archived conversation](/previous)."],
    [2, "Saved 2 new notes to Wiki and started a new conversation. [Open the archived conversation](/previous)."]
  ] as const) {
    for (const temporary of [false, true]) test(`archive notice keeps ${kept} notes with temporary=${temporary}`, () => {
      const expected = temporary
        ? `${permanent} This archive is only available until this session closes; local storage is unavailable.`
        : permanent
      expect(archiveNotice(kept, "/previous", temporary)).toBe(expected)
    })
  }

  test("links keep first-seen targets and authored bytes without mutating notes or existing documents", () => {
    const notes = [note("Links", "[[Deploy notes]] then [[Other]] and [[Deploy notes|again]]")]
    const existing = [document("old", "Other.md")]
    const beforeNotes = structuredClone(notes), beforeExisting = structuredClone(existing)
    const written = sweep(notes, existing)
    expect(written[0]?.links).toEqual(["Deploy notes", "Other"])
    expect(written[0]).toMatchObject({ body: "[[Deploy notes]] then [[Other]] and [[Deploy notes|again]]", confidence: 0.9,
      updatedAt: 1_700_000_000_000, revision: 8 })
    expect(notes).toEqual(beforeNotes)
    expect(existing).toEqual(beforeExisting)
    expect(sweep([], existing)).toEqual([])
  })

  test("existing numbered paths reserve every suffix before the next free name", () => {
    expect(sweep([note("Deploy")], [document("a", "Chat notes/Note - Deploy.md"),
      document("b", "Chat notes/Note - Deploy (2).md"), document("c", "Chat notes/Note - Deploy (3).md")])[0]?.path)
      .toBe("Chat notes/Note - Deploy (4).md")
  })

  test("titles repeated inside one sweep take (2), (3) instead of overwriting each other", () => {
    const written = sweep([note("Deploy notes"), note("Deploy notes"), note("Deploy notes")])
    expect(written.map((record) => record.path)).toEqual([
      "Chat notes/Note - Deploy notes.md",
      "Chat notes/Note - Deploy notes (2).md",
      "Chat notes/Note - Deploy notes (3).md"
    ])
    // Every record is its own document; the title the model chose is kept verbatim.
    expect(new Set(written.map((record) => record.id)).size).toBe(3)
    for (const record of written) expect(record.title).toBe("Deploy notes")
  })

  test("a title colliding with an existing document in another case or normal form takes a suffix", () => {
    const cased = sweep([note("Deploy notes")], [document("w1", "chat notes/note - deploy notes.md")])
    expect(cased[0]?.path).toBe("Chat notes/Note - Deploy notes (2).md")
    // NFKC: the fullwidth D normalizes onto the ASCII one, so the paths collide on disk.
    const normalized = sweep([note("Deploy notes")], [document("w1", "Chat notes/Note - Ｄeploy notes.md")])
    expect(normalized[0]?.path).toBe("Chat notes/Note - Deploy notes (2).md")
  })

  test("reserved characters and trailing dots never reach the path", () => {
    const written = sweep([note("CON."), note("a/b:c"), note("what? <now> |then| \"quoted\"  ")])
    expect(written.map((record) => record.path)).toEqual([
      "Chat notes/Note - CON.md",
      "Chat notes/Note - a-b-c.md",
      "Chat notes/Note - what- -now- -then- -quoted-.md"
    ])
    // One separator only: a title can never write outside the Chat notes folder.
    for (const record of written) expect(record.path.split("/")).toHaveLength(2)
    for (const record of written) expect(record.path.endsWith("..md")).toBe(false)
  })

  test("an id already taken by an existing document is never reused", () => {
    const written = sweep(
      [note("First"), note("Second")],
      [document("world-sweep-branch-new-0", "other.md"), document("world-sweep-branch-new-0-new", "other-2.md")]
    )
    expect(written[0]?.id).toBe("world-sweep-branch-new-0-new-new")
    expect(written[1]?.id).toBe("world-sweep-branch-new-1")
  })

  test("the archive records where the notes came from and the revision they were written at", () => {
    const [written] = sweep([note("Wiring", "see [[Deploy notes]] for the rest")])
    expect(written?.sources).toEqual(["chat-sweep", "conversation:branch-old@7"])
    expect(written?.links).toEqual(["Deploy notes"])
    expect(written?.revision).toBe(8)
    expect(written?.updatedBy).toBe("smithers")
  })
})
