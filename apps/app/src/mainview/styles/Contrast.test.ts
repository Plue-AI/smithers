import { describe, expect, test } from "bun:test"
import { PALETTES } from "../state/AppState"
import { ratioOf, variant } from "./paletteTokens"

/* Paper light and dark must meet the same small-text WCAG AA floor. */

/**
 * WCAG 1.4.3 for body-size text. The tokens under test are read at 9px-13px,
 * which is never "large text", so the 3:1 allowance never applies to them.
 */
const AA = 4.5

/**
 * Every (text token, background token) pair the product actually paints small
 * text with. `--text-faint` is the card byline and the composer hints;
 * `--text-muted` is every card subtitle and list secondary line; both land on
 * the page background and on card surfaces.
 */
const PAIRS = [
  { text: "--text", on: "--bg" },
  { text: "--text", on: "--surface" },
  { text: "--text-muted", on: "--bg" },
  { text: "--text-muted", on: "--surface" },
  { text: "--text-faint", on: "--bg" },
  { text: "--text-faint", on: "--surface" },
  { text: "--text-placeholder", on: "--bg" },
  { text: "--text-placeholder", on: "--surface" }
] as const

describe("every palette clears WCAG AA for the small text it paints", () => {
  test("no text/background pair in any palette or mode falls below 4.5:1", () => {
    const failures: string[] = []
    for (const palette of PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        const declarations = variant(palette, mode)
        for (const pair of PAIRS) {
          const ratio = ratioOf(declarations, pair.text, pair.on)
          if (ratio < AA) {
            failures.push(`${palette} ${mode}: ${pair.text} on ${pair.on} is ${ratio}:1`)
          }
        }
      }
    }
    // Reported all at once: one palette's miss is usually a family of them,
    // and fixing one failure per run is how a sweep gets abandoned halfway.
    expect(failures).toEqual([])
  })
})

/*
 * WCAG 1.4.11: the keyboard focus ring is a non-text indicator, so it needs
 * 3:1 against every surface it is drawn on (#3427). Light mode's ring was
 * --water-400 at 2.70:1 on --surface-2; it is now --water-500.
 */
const NON_TEXT = 3

describe("the focus ring stays visible on every surface", () => {
  test("--ring-border clears 3:1 on --bg, --surface and --surface-2 in every palette and mode", () => {
    const failures: string[] = []
    for (const palette of PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        const declarations = variant(palette, mode)
        for (const on of ["--bg", "--surface", "--surface-2"] as const) {
          const ratio = ratioOf(declarations, "--ring-border", on)
          if (ratio < NON_TEXT) failures.push(`${palette} ${mode}: --ring-border on ${on} is ${ratio}:1`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})
