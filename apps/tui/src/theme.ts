/**
 * Night Owl dark, the palette the Smithers app uses
 * (`apps/app/src/mainview/styles/tokens.css`, `:root[data-theme="dark"]`).
 * Surfaces layer the way the app's do: the page, a panel, an element on it.
 */
import { RGBA, SyntaxStyle } from "@opentui/core"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** `color-mix(in srgb, a percent%, b)`. */
export const mix = (a: string, percent: number, b: string): string => {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16)
  const weight = percent / 100
  return `#${
    [0, 1, 2]
      .map((at) => Math.round(channel(a, at) * weight + channel(b, at) * (1 - weight)).toString(16).padStart(2, "0"))
      .join("")
  }`
}

const page = "#011627"
const surface = "#0b253a"
export const themes = {
  purple: "#c792ea",
  blue: "#82aaff",
  green: "#addb67",
  orange: "#f78c6c"
} as const
export type Theme = keyof typeof themes
const file = () => join(homedir(), ".smithers", "tui", "theme")
export const isTheme = (value: string): value is Theme => Object.hasOwn(themes, value)
export const loadTheme = (): Theme => {
  try {
    const saved = readFileSync(file(), "utf8").trim()
    return isTheme(saved) ? saved : "purple"
  } catch {
    return "purple"
  }
}
let current: Theme = "purple"
const brand: string = themes.purple

export const color = {
  /** `--bg`: the page. */
  page,
  /** `--surface`: panels, the composer, dialogs. */
  surface,
  /** `--surface-2`: menus, hovered and nested elements. */
  element: "#1d3b53",
  /** `--surface-3`. */
  raised: "#234d70",
  /** `--border-solid`. */
  border: "#122d42",
  text: "#d6deeb",
  muted: "#8badc1",
  faint: "#748fa5",
  brand,
  success: "#addb67",
  warning: "#ecc48d",
  danger: "#ef5350",
  info: "#82aaff",
  /** The person acts now: a question, a spend cap, a take-over. Never a theme color. */
  needs: "#c792ea",
  /** `--bubble-outgoing` (dark): the user's messages. */
  bubble: mix(brand, 24, surface),
  addedBg: mix("#addb67", 14, page),
  removedBg: mix("#ef5350", 16, page)
}

/** Worker lanes in the chat timeline, never the brand color the chat's own rows use. */
const lanes = ["#7fdbca", "#82aaff", "#ffcb8b", "#addb67", "#f78c6c", "#c792ea"]
export const lane = (index: number): string => {
  const free = lanes.filter((hex) => hex !== color.brand)
  return free[index % free.length]!
}

export const activeTheme = (): Theme => current
export const setTheme = (theme: Theme): void => {
  current = theme
  color.brand = themes[theme]
  color.bubble = mix(color.brand, 24, color.surface)
  syntax = makeSyntax()
}

export const saveTheme = (theme: Theme): void => {
  mkdirSync(join(homedir(), ".smithers", "tui"), { recursive: true })
  writeFileSync(file(), theme + "\n")
}

const fg = (hex: string, extra: { bold?: boolean; italic?: boolean; underline?: boolean } = {}) => ({
  fg: RGBA.fromHex(hex),
  ...extra
})

const makeSyntax = () =>
  SyntaxStyle.fromStyles({
    default: fg(color.text),
    keyword: fg(color.brand, { italic: true }),
    "keyword.return": fg(color.brand, { italic: true }),
    operator: fg("#7fdbca"),
    string: fg(color.warning),
    "string.special": fg(color.warning),
    number: fg("#f78c6c"),
    boolean: fg("#ff5874"),
    constant: fg("#82aaff"),
    "constant.builtin": fg("#ff5874"),
    comment: fg("#637777", { italic: true }),
    function: fg(color.info),
    "function.call": fg(color.info),
    "function.method": fg(color.info),
    "function.method.call": fg(color.info),
    variable: fg(color.text),
    "variable.member": fg("#addb67"),
    property: fg("#addb67"),
    type: fg("#ffcb8b"),
    punctuation: fg("#7fdbca"),
    "punctuation.bracket": fg(color.text),
    "markup.heading": fg(color.brand, { bold: true }),
    "markup.strong": fg(color.text, { bold: true }),
    "markup.italic": fg(color.text, { italic: true }),
    "markup.raw": fg(color.warning),
    "markup.link": fg(color.info, { underline: true }),
    "markup.link.url": fg(color.info, { underline: true }),
    "markup.list": fg(color.brand),
    "markup.quote": fg(color.muted, { italic: true })
  })
export let syntax = makeSyntax()

/** Braille spinner frames, advanced by the app's clock. */
export const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
