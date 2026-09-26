import { describe, expect, test } from "bun:test"
import * as Timeline from "../src/timeline.ts"
import * as Transcript from "../src/transcript.ts"

const chat = Transcript.note(Transcript.user(Transcript.empty, "fix the build", false, 10), "checking", 40)
const worker = Transcript.note(Transcript.user(Transcript.empty, "run the tests", false, 20), "3 failed", 30)
const sources = [{ id: Timeline.chat, transcript: chat }, { id: "tests", transcript: worker }]
const texts = (rows: ReadonlyArray<Timeline.Row>) => rows.map((row) => `${row.source}:${Timeline.text(row.item)}`)

describe("timeline", () => {
  test("interleaves workers with the chat by time", () => {
    expect(texts(Timeline.merge(sources))).toEqual([
      "chat:fix the build",
      "tests:run the tests",
      "tests:3 failed",
      "chat:checking"
    ])
  })

  test("keeps a source's own order when a later item carries an earlier time", () => {
    const skewed = Transcript.note(Transcript.note(Transcript.empty, "first", 50), "second", 5)
    expect(texts(Timeline.merge([{ id: "w", transcript: skewed }]))).toEqual(["w:first", "w:second"])
  })

  test("an item without a time follows the item before it", () => {
    const unstamped = Transcript.note(Transcript.note(Transcript.empty, "stamped", 25), "unstamped")
    expect(texts(Timeline.merge([...sources, { id: "late", transcript: unstamped }]))).toEqual([
      "chat:fix the build",
      "tests:run the tests",
      "late:stamped",
      "late:unstamped",
      "tests:3 failed",
      "chat:checking"
    ])
  })

  test("hides a source, a kind, or rows without the text", () => {
    expect(texts(Timeline.merge(sources, Timeline.toggleSource(Timeline.all, "tests")))).toEqual([
      "chat:fix the build",
      "chat:checking"
    ])
    expect(texts(Timeline.merge(sources, Timeline.toggleKind(Timeline.all, "user")))).toEqual([
      "tests:3 failed",
      "chat:checking"
    ])
    expect(texts(Timeline.merge(sources, { ...Timeline.all, query: "FAILED" }))).toEqual(["tests:3 failed"])
  })

  test("toggling twice shows the source again", () => {
    const twice = Timeline.toggleSource(Timeline.toggleSource(Timeline.all, "tests"), "tests")
    expect(Timeline.active(twice)).toBe(false)
    expect(Timeline.merge(sources, twice)).toHaveLength(4)
  })
})

test("reuses merged rows across clock renders and invalidates changed transcripts", () => {
  const merge = Timeline.cached()
  const first = merge(sources, Timeline.all)
  expect(merge(sources.map((source) => ({ ...source })), Timeline.all)).toBe(first)
  const changed = [{ ...sources[0]!, transcript: Transcript.note(chat, "new", 60) }, sources[1]!]
  expect(merge(changed, Timeline.all).at(-1)?.item).toMatchObject({ text: "new" })
  expect(merge(changed, { ...Timeline.all, query: "new" })).toHaveLength(1)
})
