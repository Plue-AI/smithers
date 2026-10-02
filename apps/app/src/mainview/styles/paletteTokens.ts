/*
 * The palette table, read as values.
 *
 * `tokens.css` IS the source of every colour the product paints, so a ratio
 * computed from its declarations cannot pass while the painted pixels fail.
 * This module resolves one palette and mode to the colours in force for it,
 * and it exists because two tests need the same resolution: the sweep over
 * every small-text pair (Contrast.test.ts) and the graph's own state colours
 * (cards/FlowGraphHardening.test.tsx). A second hand-rolled resolver is how
 * the two would disagree about what `--text-muted` is in the dark variant.
 *
 * Nothing here runs in the app. It reads a stylesheet off disk.
 *
 * @since 1.0.0
 * @category styles
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const tokens = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8")
/** Comments carry braces and colour-looking text, so the block scan reads the code alone. */
const code = tokens.replace(/\/\*[\s\S]*?\*\//g, "")

/** The custom properties one selector declares. */
export type Declarations = ReadonlyMap<string, string>

const declarationsIn = (selector: string): Declarations => {
  const found = new Map<string, string>()
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").trim() !== selector) continue
    for (const line of (match[2] ?? "").split(";")) {
      const [name, ...rest] = line.split(":")
      const key = (name ?? "").trim()
      if (key.startsWith("--")) found.set(key, rest.join(":").trim())
    }
  }
  return found
}

/** `:root` carries the base scale plus the default palette's light variant. */
const ROOT = declarationsIn(":root")

/** Every custom property `:root` itself declares, whatever the palette. */
export const rootTokens = (): ReadonlySet<string> => new Set(ROOT.keys())

/**
 * The declarations in force for one palette and mode, later blocks winning:
 * the base `:root`, then the palette's light block, then its dark block.
 *
 * `paper` is the sole palette, so it has no `data-palette` block of
 * its own and its dark variant is the bare `:root[data-theme="dark"]`.
 *
 * @since 1.0.0
 * @category styles
 */
export const variant = (palette: string, mode: "light" | "dark"): Declarations => {
  const merged = new Map(ROOT)
  if (palette !== "paper") throw new Error(`No active palette: ${palette}`)
  const layers = mode === "dark" ? [':root[data-theme="dark"]'] : []
  for (const selector of layers) {
    for (const [name, value] of declarationsIn(selector)) merged.set(name, value)
  }
  return merged
}

/** One opaque sRGB triple. */
export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/**
 * Resolve a declaration to an opaque sRGB triple, following `var()` chains.
 *
 * @since 1.0.0
 * @category styles
 */
export const rgbOf = (declarations: Declarations, token: string, depth = 0): Rgb => {
  const raw = declarations.get(token)
  if (raw === undefined) throw new Error(`${token} is declared nowhere`)
  if (depth > 8) throw new Error(`${token} resolves through too many var() hops`)
  const alias = /^var\(\s*(--[a-z0-9-]+)/i.exec(raw)
  if (alias !== null) return rgbOf(declarations, alias[1] ?? "", depth + 1)
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)
  if (hex !== null) {
    const value = Number.parseInt(hex[1] ?? "", 16)
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
  }
  const triple = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\)$/.exec(raw)
  if (triple !== null) {
    return { r: Number(triple[1]), g: Number(triple[2]), b: Number(triple[3]) }
  }
  throw new Error(`${token} is not an opaque colour this check can read: ${raw}`)
}

const channel = (value: number): number => {
  const srgb = value / 255
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
}

const luminance = (color: Rgb): number =>
  0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)

/**
 * The WCAG contrast ratio, rounded to two places so a report reads cleanly.
 *
 * @since 1.0.0
 * @category styles
 */
export const contrastRatio = (foreground: Rgb, background: Rgb): number => {
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
}

/**
 * The ratio between two tokens in one palette and mode.
 *
 * @since 1.0.0
 * @category styles
 */
export const ratioOf = (declarations: Declarations, token: string, on: string): number =>
  contrastRatio(rgbOf(declarations, token), rgbOf(declarations, on))
