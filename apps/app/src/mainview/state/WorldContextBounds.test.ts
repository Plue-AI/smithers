import { expect, test } from "bun:test"
import { worldContextDocuments } from "./WorldContext"

const note = (id: string, body: string) => ({ id, path: `${id}.md`, title: id, body, confidence: 0.75 })

test("a nearby line ending frees its unused character budget for the next note", () => {
  expect(worldContextDocuments([note("first", "abcdef\nGHIJK"), note("second", "tail")], null, 10, 10))
    .toEqual([
      { path: "first.md", title: "first", confidence: 0.75, body: "abcdef", bodyTruncated: true },
      { path: "second.md", title: "second", confidence: 0.75, body: "tail" }
    ])
})

test("a line ending exactly halfway through the available room does not discard the later text", () => {
  expect(worldContextDocuments([note("first", "abcde\nFGHIJK")], null, 10, 10))
    .toEqual([{ path: "first.md", title: "first", confidence: 0.75, body: "abcde\nFGHI", bodyTruncated: true }])
})

for (const [budget, perDocument] of [[0, 10], [10, 0], [0, 0]]) {
  test(`zero available body room (${budget}, ${perDocument}) preserves metadata and distinguishes blank notes`, () => {
    expect(worldContextDocuments([note("text", " meaningful "), note("blank", " \n\t ")], "missing", budget, perDocument))
      .toEqual([
        { path: "text.md", title: "text", confidence: 0.75, body: "", bodyTruncated: true },
        { path: "blank.md", title: "blank", confidence: 0.75, body: "" }
      ])
  })
}

test("selected-note priority retains caller order and leaves an exact-fit selected body unmarked", () => {
  const documents = [note("first", "first"), note("selected", "picked"), note("last", "last")]
  const before = structuredClone(documents)
  expect(worldContextDocuments(documents, "selected", 6, 6)).toEqual([
    { path: "first.md", title: "first", confidence: 0.75, body: "", bodyTruncated: true },
    { path: "selected.md", title: "selected", confidence: 0.75, body: "picked" },
    { path: "last.md", title: "last", confidence: 0.75, body: "", bodyTruncated: true }
  ])
  expect(documents).toEqual(before)
  expect(worldContextDocuments([], null, 0, 0)).toEqual([])
})
