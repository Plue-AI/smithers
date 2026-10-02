import { expect, test } from "bun:test"
import { rgbOf, variant } from "../../app/src/mainview/styles/paletteTokens"
import { color } from "../src/theme.ts"
import * as View from "../src/view.tsx"

const hex = (token: string): string => {
  const rgb = rgbOf(variant("paper", "dark"), token)
  return "#" + [rgb.r, rgb.g, rgb.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")
}

test("terminal semantic colors match the retained browser Paper dark palette", () => {
  for (
    const [name, token] of [
      ["page", "--bg"],
      ["surface", "--surface"],
      ["element", "--surface-2"],
      ["text", "--text"],
      ["muted", "--text-muted"],
      ["faint", "--text-faint"],
      ["brand", "--brand"]
    ] as const
  ) {
    expect(color[name]).toBe(hex(token))
  }
})

test("writing status uses the retained brand accent", () => {
  expect(View.statusColor("writing")).toBe(color.brand)
})
