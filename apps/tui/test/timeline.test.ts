import { describe, expect, test } from "bun:test"
import * as Timeline from "../src/timeline.ts"
import * as Transcript from "../src/transcript.ts"

const chat = Transcript.note(
  Transcript.note(Transcript.user(Transcript.empty, "fix the build", false, 10), "3 failed", 30),
  "checking",
  40
)
const texts = (rows: ReadonlyArray<Timeline.Row>) => rows.map((row) => Timeline.text(row.item))

describe("timeline", () => {
  test("keys each row by its chat item", () => {
    expect(Timeline.rows(chat).map((row) => row.key)).toEqual(["chat:0", "chat:1", "chat:2"])
  })

  test("keeps the transcript's order when a later item carries an earlier time", () => {
    const skewed = Transcript.note(Transcript.note(Transcript.empty, "first", 50), "second", 5)
    expect(Timeline.rows(skewed).map((row) => row.at)).toEqual([50, 50])
  })

  test("an item without a time takes the time of the item before it", () => {
    const unstamped = Transcript.note(Transcript.note(Transcript.empty, "stamped", 25), "unstamped")
    expect(Timeline.rows(unstamped).map((row) => row.at)).toEqual([25, 25])
  })

  test("hides a kind, or rows without the text", () => {
    expect(texts(Timeline.rows(chat, Timeline.toggleKind(Timeline.all, "user")))).toEqual(["3 failed", "checking"])
    expect(texts(Timeline.rows(chat, { ...Timeline.all, query: "FAILED" }))).toEqual(["3 failed"])
  })

  test("toggling a kind twice shows it again", () => {
    const twice = Timeline.toggleKind(Timeline.toggleKind(Timeline.all, "user"), "user")
    expect(Timeline.active(twice)).toBe(false)
    expect(Timeline.rows(chat, twice)).toHaveLength(3)
  })
})

test("reuses rows across clock renders and invalidates a changed transcript", () => {
  const rows = Timeline.cached()
  const first = rows(chat, Timeline.all)
  expect(rows(chat, Timeline.all)).toBe(first)
  const changed = Transcript.note(chat, "new", 60)
  expect(rows(changed, Timeline.all).at(-1)?.item).toMatchObject({ text: "new" })
  expect(rows(changed, { ...Timeline.all, query: "new" })).toHaveLength(1)
})

describe("the chat's own view", () => {
  const ran: Transcript.Item = {
    kind: "cell",
    id: "c",
    index: 1,
    prose: "",
    source: "await ctx.call(\"read\", { path: \"math.js\" })",
    status: "done",
    calls: [{ flow: "read", subject: "math.js", status: "ok", startedAt: 1, endedAt: 2 }],
    printed: "",
    startedAt: 1,
    endedAt: 2
  }
  const turn = { ...chat, items: [...chat.items, ran] }

  test("hides each cell's program by default, not the cell's rows, and is not a filter", () => {
    expect(Timeline.program(Timeline.initial)).toBe(false)
    expect(Timeline.active(Timeline.initial)).toBe(false)
    expect(Timeline.rows(turn, Timeline.initial).map((row) => row.item.kind)).toEqual(["user", "note", "note", "cell"])
  })

  test("Cells shows the program; Show all shows it too", () => {
    const shown = Timeline.toggleKind(Timeline.initial, "cell")
    expect(Timeline.program(shown)).toBe(true)
    expect(Timeline.active(shown)).toBe(false)
    expect(Timeline.program(Timeline.all)).toBe(true)
    expect(Timeline.program(Timeline.toggleKind(shown, "cell"))).toBe(false)
  })

  test("hiding another kind or searching text is a filter, and still keeps cells by kind", () => {
    const quiet = Timeline.toggleKind(Timeline.initial, "note")
    expect(Timeline.active(quiet)).toBe(true)
    expect(Timeline.rows(turn, quiet).map((row) => row.item.kind)).toEqual(["user", "cell"])
    const searched = { ...Timeline.initial, query: "math.js" }
    expect(Timeline.active(searched)).toBe(true)
    expect(Timeline.rows(turn, searched).map((row) => row.key)).toEqual(["chat:c"])
  })
})
