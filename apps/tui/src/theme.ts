/**
 * Paper dark, the retained brand palette the Smithers app uses
 * (`apps/app/src/mainview/styles/tokens.css`, `:root[data-theme="dark"]`).
 * Surfaces layer the way the app's do: the page, a panel, an element on it.
 */
import { ansi256IndexToRgb, type OptimizedBuffer, RGBA, SyntaxStyle, TextAttributes } from "@opentui/core"

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

const page = "#0d1514"
const surface = "#131b1a"
const brand = "#45c4b2"

/**
 * The colors the terminal shows: `none` under NO_COLOR (bold, dim and reverse
 * video only), 16 or 256 indexed colors when TERM names no more, else 24-bit.
 */
export type ColorMode = "truecolor" | "ansi256" | "ansi16" | "none"
export const colorModeOf = (env: Readonly<Record<string, string | undefined>>): ColorMode => {
  if ((env.NO_COLOR ?? "") !== "") return "none"
  const term = (env.TERM ?? "").toLowerCase()
  if (term === "" || /direct|truecolor|24bit|kitty|ghostty|alacritty|wezterm|foot/.test(term)) return "truecolor"
  if (!term.includes("256")) return "ansi16"
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") ? "truecolor" : "ansi256"
}
let mode: ColorMode = "truecolor"

export const color = {
  /** `--bg`: the page. */
  page,
  /** `--surface`: panels, the composer, dialogs. */
  surface,
  /** `--surface-2`: menus, hovered and nested elements. */
  element: "#1a2422",
  /** A selected or focused row's fill; the brand fill, drawn as reverse video, under NO_COLOR. */
  selected: "#1a2422",
  /** `--surface-3`. */
  raised: "#202b29",
  /** `--border-solid`. */
  border: "#293532",
  text: "#ece7db",
  muted: "#a8a193",
  faint: "#969083",
  brand,
  success: "#7fbfb3",
  warning: "#f0c169",
  danger: "#d97757",
  info: "#82a8b8",
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

/** Under NO_COLOR the selected fill is the brand color, which every frame draws as reverse video. */
const fillSelected = () => {
  color.selected = mode === "none" ? color.brand : color.element
}

/**
 * Degrades every frame to `next`: 24-bit colors become the nearest indexed
 * color, or under NO_COLOR the terminal's own colors with dim for muted text
 * and reverse video for the selected fill.
 */
export const applyColorMode = (
  renderer: { addPostProcessFn(fn: (buffer: OptimizedBuffer) => void): void },
  next: ColorMode
): void => {
  mode = next
  fillSelected()
  if (next !== "truecolor") renderer.addPostProcessFn(next === "none" ? plain : indexed(next === "ansi16" ? 0 : 16))
}

// A cell color is four u16 channels: the low byte is r, g, b, a; the high bytes pack the palette slot and the intent.
const intentRgb = 0
const intentIndexed = 1
const intentDefault = 2
const intentOf = (channels: Uint16Array, at: number) => channels[at + 1]! >>> 8
const retarget = (channels: Uint16Array, at: number, intent: number, slot: number) => {
  channels[at] = (channels[at]! & 0xff) | (slot << 8)
  channels[at + 1] = (channels[at + 1]! & 0xff) | (intent << 8)
}
const byte = (channels: Uint16Array, at: number) => channels[at]! & 0xff
/** Muted, faint and dimmed-backdrop text: brightness under 80%. */
const muted = (channels: Uint16Array, at: number) =>
  Math.max(byte(channels, at), byte(channels, at + 1), byte(channels, at + 2)) < 204

/** Italic and underline are emphasis, not color, so they stay. */
const plain = (buffer: OptimizedBuffer): void => {
  const { fg, bg, attributes } = buffer.buffers
  const [r, g, b] = RGBA.fromHex(color.brand).toInts()
  for (let cell = 0; cell < attributes.length; cell++) {
    const at = cell * 4
    const selected = intentOf(bg, at) === intentRgb && byte(bg, at) === r && byte(bg, at + 1) === g &&
      byte(bg, at + 2) === b && byte(bg, at + 3) > 0
    if (selected) attributes[cell] = attributes[cell]! | TextAttributes.INVERSE
    else if (intentOf(fg, at) === intentRgb && muted(fg, at)) attributes[cell] = attributes[cell]! | TextAttributes.DIM
    retarget(fg, at, intentDefault, 0)
    retarget(bg, at, intentDefault, 0)
  }
}

/** In 16 colors the palette keeps its hues and text stays brighter than muted; other colors take the nearest slot. */
const sixteen: ReadonlyArray<readonly [string, number]> = [
  // Semantic Paper colors keep their readable terminal counterparts on ANSI16.
  ["#0d1514", 0],
  ["#131b1a", 0],
  ["#1a2422", 0],
  ["#202b29", 0],
  ["#ece7db", 15],
  ["#a8a193", 7],
  ["#969083", 8],
  ["#45c4b2", 14],
  ["#d6deeb", 15],
  ["#8badc1", 7],
  ["#748fa5", 8],
  ["#ef5350", 9],
  ["#addb67", 10],
  ["#ecc48d", 11],
  ["#ffcb8b", 11],
  ["#82aaff", 12],
  ["#c792ea", 13],
  ["#7fdbca", 14],
  ["#f78c6c", 3]
]

const indexed = (first: number) => {
  const nearest = new Map<number, number>(
    first === 0 ? sixteen.map(([hex, slot]) => [Number.parseInt(hex.slice(1), 16), slot]) : []
  )
  const slotOf = (channels: Uint16Array, at: number) => {
    const key = (byte(channels, at) << 16) | (byte(channels, at + 1) << 8) | byte(channels, at + 2)
    const known = nearest.get(key)
    if (known !== undefined) return known
    let best = first
    let distance = Number.POSITIVE_INFINITY
    for (let slot = first; slot < (first === 0 ? 16 : 256); slot++) {
      const [r, g, b] = ansi256IndexToRgb(slot)
      const next = (r - byte(channels, at)) ** 2 + (g - byte(channels, at + 1)) ** 2 + (b - byte(channels, at + 2)) ** 2
      if (next < distance) [best, distance] = [slot, next]
    }
    nearest.set(key, best)
    return best
  }
  const degrade = (channels: Uint16Array, at: number) => {
    if (intentOf(channels, at) === intentRgb && byte(channels, at + 3) > 0) {
      retarget(channels, at, intentIndexed, slotOf(channels, at))
    }
  }
  return (buffer: OptimizedBuffer): void => {
    const { char, fg, bg } = buffer.buffers
    for (let cell = 0; cell < char.length; cell++) {
      degrade(fg, cell * 4)
      degrade(bg, cell * 4)
    }
  }
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
export const syntax = makeSyntax()

/** Braille spinner frames, advanced by the app's clock. */
export const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
