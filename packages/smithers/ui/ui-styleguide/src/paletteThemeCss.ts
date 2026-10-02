import { serializeThemeVariant } from "./serializeThemeVariant.ts";
import { DEFAULT_THEME_KEY, findTheme, themeRegistry } from "./themeRegistry.ts";
import { sharedTokens } from "./themeTokens.ts";

/** Options for {@link paletteThemeCss}. */
export type PaletteThemeCssOptions = {
  /**
   * Registered keys to validate. Paper rules always carry shared tokens and fonts.
   */
  palettes?: readonly string[];
};

/** Emit Paper light/dark rules, validating any explicitly requested palette key. */
export function paletteThemeCss(quote: "'" | '"', options: PaletteThemeCssOptions = {}): string[] {
  const attr = (name: string, value: string) => `[data-${name}=${quote}${value}${quote}]`;
  const defaults = themeRegistry[DEFAULT_THEME_KEY];
  const rules = [
    `:root { ${serializeThemeVariant(defaults.light, { fonts: true })}; ${sharedTokens}; }`,
    `@media (prefers-color-scheme: dark) { :root:not(${attr("theme", "light")}) { ${
      serializeThemeVariant(defaults.dark)
    }; } }`,
    `:root${attr("theme", "dark")} { ${serializeThemeVariant(defaults.dark)}; }`,
  ];
  // Validate first, then walk the registry rather than the caller's array, so a
  // reordered or repeated request still emits each palette once in registry
  // order. Two callers asking for the same set get byte-identical CSS.
  const requested = new Set(options.palettes ?? Object.keys(themeRegistry));
  for (const key of requested) {
    if (findTheme(key) === undefined) {
      throw new RangeError(
        `unknown palette ${JSON.stringify(key)}; registered: ${Object.keys(themeRegistry).join(", ")}`,
      );
    }
  }
  return rules;
}
