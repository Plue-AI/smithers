import type { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { expect, it } from "bun:test"
import * as Cursor from "../src/cursor.ts"

it("round-trips native cursor boundaries for Unicode, tabs, and multiple lines", async () => {
  const ref = { current: null as TextareaRenderable | null }
  const setup = await testRender(<textarea ref={ref} />, { width: 80, height: 12 })
  try {
    await setup.renderOnce()
    const input = ref.current!
    for (
      const text of ["ascii", "日本語😀a", "e\u0301👨‍👩‍👧‍👦 suffix", "first\t日本\n😀second\nlast", "🇯🇵a", "한글 café"]
    ) {
      input.setText(text)
      input.gotoBufferEnd()
      expect(Cursor.index(input)).toBe(text.length)
      const prefixes = [
        "",
        ...Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
          ({ index, segment }) => text.slice(0, index + segment.length)
        )
      ]
      for (const prefix of prefixes) {
        Cursor.move(input, prefix.length)
        expect(Cursor.index(input), JSON.stringify({ text, prefix })).toBe(prefix.length)
        expect(input.editBuffer.getTextRange(0, input.cursorOffset)).toBe(prefix)
      }
    }
  } finally {
    setup.renderer.destroy()
  }
})

it("inserts at the selected JS boundary without splitting emoji or losing the suffix", async () => {
  const ref = { current: null as TextareaRenderable | null }
  const setup = await testRender(<textarea ref={ref} />, { width: 80, height: 12 })
  try {
    await setup.renderOnce()
    const input = ref.current!
    input.setText("日本語😀 suffix")
    Cursor.move(input, "日本語😀".length)
    input.insertText(" @café.txt")
    expect(input.plainText).toBe("日本語😀 @café.txt suffix")
    Cursor.move(input, 4) // In the emoji's surrogate pair: snap before it.
    expect(Cursor.index(input)).toBe(3)
  } finally {
    setup.renderer.destroy()
  }
})
