/** Public native editing API: exact bytes, cursor boundaries, deletion, and history. */
import { EditBuffer, type WidthMethod } from "@opentui/core"
import { expect, test } from "bun:test"

const methods: WidthMethod[] = ["wcwidth", "unicode", "unicode-wide"]
const withBuffer = (method: WidthMethod, body: (buffer: EditBuffer) => void) => {
  const buffer = EditBuffer.create(method)
  try {
    body(buffer)
  } finally {
    buffer.destroy()
  }
}
const insertScalars = (buffer: EditBuffer, text: string) => {
  for (const scalar of text) buffer.insertText(scalar)
}
for (const method of methods) {
  for (const text of ["e\u0301x", "😀e\u0301👨‍👩‍👧‍👦", "a\u0301\u0327b", "🏳️‍🌈x", "😀\ne\u0301x"]) {
    test(`${method} incremental ${text} preserves every prefix and whole-string cursor`, () => {
      withBuffer(method, (typed) => {
        let prefix = ""
        for (const scalar of text) {
          typed.insertText(scalar)
          prefix += scalar
          expect(typed.getText()).toBe(prefix)
          const cursor = typed.getCursorPosition()
          expect(typed.getTextRange(0, cursor.offset)).toBe(prefix)
        }
        withBuffer(method, (pasted) => {
          pasted.setText(text)
          pasted.gotoLine(pasted.getLineCount() - 1)
          const end = pasted.getEOL()
          pasted.setCursor(end.row, end.col)
          expect(typed.getCursorPosition()).toEqual(pasted.getCursorPosition())
        })
      })
    })
  }
  for (const suffix of ["😀", "日本", "👨‍👩‍👧‍👦"]) {
    test(`${method} selects complete accent before ${suffix}`, () => {
      withBuffer(method, (buffer) => {
        insertScalars(buffer, "😀e\u0301" + suffix)
        expect(buffer.getTextRange(0, 3)).toBe("😀e\u0301")
        expect(buffer.getTextRangeByCoords(0, 2, 0, 3)).toBe("e\u0301")
      })
    })
  }
  test(`${method} movement and middle insertion preserve accented base`, () => {
    withBuffer(method, (buffer) => {
      insertScalars(buffer, "😀e\u0301x")
      buffer.moveCursorLeft()
      expect(buffer.getCursorPosition().col).toBe(3)
      buffer.insertText("!")
      expect(buffer.getText()).toBe("😀e\u0301!x")
      buffer.moveCursorLeft()
      buffer.moveCursorLeft()
      expect(buffer.getCursorPosition().col).toBe(2)
      buffer.moveCursorRight()
      expect(buffer.getCursorPosition().col).toBe(3)
      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("😀!x")
      buffer.undo()
      expect(buffer.getText()).toBe("😀e\u0301!x")
    })
  })
  test(`${method} edits normalized CRLF in the middle line and restores newline`, () => {
    withBuffer(method, (buffer) => {
      buffer.setText("head\r\n😀x\r\nend")
      buffer.setCursor(1, 2)
      insertScalars(buffer, "e\u0301")
      expect(buffer.getText()).toBe("head\n😀e\u0301x\nend")
      expect(buffer.getTextRangeByCoords(1, 2, 1, 3)).toBe("e\u0301")
      buffer.insertText("\r\n")
      expect(buffer.getText()).toBe("head\n😀e\u0301\nx\nend")
      expect(buffer.getCursorPosition().row).toBe(2)
      expect(buffer.getCursorPosition().col).toBe(0)
      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("head\n😀e\u0301x\nend")
      buffer.undo()
      expect(buffer.getText()).toBe("head\n😀e\u0301\nx\nend")
    })
  })
  for (const action of ["deleteCharBackward", "deleteChar"] as const) {
    for (const marks of ["\u0301", "\u0301\u0327"]) {
      for (const suffix of ["", "x"]) {
        for (const typed of [false, true]) {
          test(`${method} ${action} ${typed ? "typed" : "loaded"} ${marks} before ${suffix || "end"} is undoable`, () => {
            withBuffer(method, (buffer) => {
              if (typed) {
                buffer.setText(suffix)
                buffer.setCursor(0, 0)
                insertScalars(buffer, marks)
              } else {
                buffer.setText(marks + suffix)
                buffer.setCursor(0, 0)
              }
              expect(buffer.getText()).toBe(marks + suffix)
              buffer[action]()
              expect(buffer.getText()).toBe(suffix)
              expect(buffer.getCursorPosition().col).toBe(0)
              buffer.undo()
              expect(buffer.getText()).toBe(marks + suffix)
              buffer.redo()
              expect(buffer.getText()).toBe(suffix)
            })
          })
        }
      }
    }
  }
}
test("joining a right-hand suffix leaves the cursor after the joined grapheme", () => {
  withBuffer("unicode", (buffer) => {
    buffer.setText("👩")
    buffer.setCursor(0, 0)
    insertScalars(buffer, "👨‍")
    expect(buffer.getText()).toBe("👨‍👩")
    expect(buffer.getCursorPosition().col).toBe(2)
    buffer.insertText("x")
    expect(buffer.getText()).toBe("👨‍👩x")
    buffer.moveCursorLeft()
    buffer.deleteCharBackward()
    expect(buffer.getText()).toBe("x")
  })
})
test("a combining continuation survives original storage and a 64 KiB add-buffer boundary", () => {
  withBuffer("wcwidth", (buffer) => {
    buffer.setText("😀e")
    buffer.setCursor(0, 3)
    insertScalars(buffer, "\u0301x")
    expect(buffer.getText()).toBe("😀e\u0301x")
    buffer.undo()
    buffer.undo()
    expect(buffer.getText()).toBe("😀e")
    buffer.setText("")
    const prefix = "a".repeat(65_535)
    buffer.insertText(prefix)
    insertScalars(buffer, "e\u0301x")
    expect(buffer.getText()).toBe(prefix + "e\u0301x")
    expect(buffer.getTextRange(65_535, 65_536)).toBe("e\u0301")
    buffer.setCursor(0, 65_536)
    buffer.deleteCharBackward()
    expect(buffer.getText()).toBe(prefix + "x")
  })
})

for (const method of methods) {
  for (const insertion of ["typed", "preloaded"] as const) {
    for (
      const fixture of [
        { text: "\u0301x", start: 0, end: 1, row: 0, expected: "\u0301x", before: "" },
        { text: "a\n\u0301\u0308x", start: 2, end: 3, row: 1, expected: "\u0301\u0308x", before: "a\n" },
        { text: "\u0301\n", start: 0, end: 1, row: 0, expected: "\u0301\n", before: "" }
      ]
    ) {
      test(`${method} ${insertion} leading marks belong to their own nonempty range: ${JSON.stringify(fixture.text)}`, () => {
        withBuffer(method, (buffer) => {
          if (insertion === "typed") insertScalars(buffer, fixture.text)
          else buffer.setText(fixture.text)
          expect(buffer.getText()).toBe(fixture.text)
          expect(buffer.getTextRange(fixture.start, fixture.end)).toBe(fixture.expected)
          expect(buffer.getTextRange(0, fixture.start)).toBe(fixture.before)
          expect(buffer.getTextRange(fixture.start, fixture.start)).toBe("")
          expect(buffer.getTextRangeByCoords(fixture.row, 0, fixture.row, 0)).toBe("")
          if (!fixture.text.endsWith("\n")) {
            expect(buffer.getTextRangeByCoords(fixture.row, 0, fixture.row, 1)).toBe(fixture.expected)
          }
        })
      })
    }
  }
}
