import type { TerminalPalette } from "./TerminalPalette.ts";
import type { ThemeVariantTokens } from "./ThemeVariantTokens.ts";
import type { ThemeSyntaxId } from "./ThemeSyntaxId.ts";

/**
 * One house color theme: both light/dark token variants plus the literal
 * upstream colors the syntax-highlighting surfaces need.
 *
 * A theme is selected with `data-palette="<key>"` on `<html>`. That axis is
 * orthogonal to the light/dark axis, which stays on `data-theme` plus
 * `prefers-color-scheme`.
 *
 * `syntax` holds Shiki bundled-theme ids for the Pierre diff view. `terminal`
 * holds the xterm palettes for the terminal adapter. Both are the theme's own
 * upstream colors, not a re-derivation from the token variants.
 */
export type SmithersTheme = {
  /** Registry key and `data-palette` attribute value. */
  key: string;
  /** Human-readable palette name. */
  label: string;
  light: ThemeVariantTokens;
  dark: ThemeVariantTokens;
  syntax: { shikiDark: ThemeSyntaxId; shikiLight: ThemeSyntaxId };
  terminal: { dark: TerminalPalette; light: TerminalPalette };
};
