#!/usr/bin/env node
/**
 * Generate Smithers theme records from the locally pinned @shikijs/themes.
 *
 * The registry it writes (`packages/smithers/ui/ui-styleguide/src/themes/*.ts`) is
 * generated and checked in, so a consumer never resolves a syntax theme at
 * runtime. Re-run it when the upstream themes move or a seed here changes,
 * and commit the result.
 *
 * Run it with: node --experimental-strip-types packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts
 * (or through any TypeScript runner). It resolves paths from its own location
 * rather than from a runtime-specific global, so it runs under Node and Bun
 * alike.
 *
 * It writes the checked-in shape directly: unquoted identifier keys, trailing
 * commas, two-space indent. A regeneration that changes nothing is therefore a
 * byte-for-byte no-op. (It used to emit `JSON.stringify` and lean on a
 * repository formatter to unquote the keys; this workspace formats no package
 * that has no lint script, so every regeneration rewrote all seven files.)
 *
 * `--check` writes nothing and exits 1 naming every file whose bytes differ
 * from what this script would write now. `packages/smithers/ui/ui-styleguide` runs it as a
 * test, which is what keeps a hand edit to a generated file from surviving:
 * the emitted import specifier carries the `.ts` extension because
 * `apps/review` resolves this package under Node ESM, where an extensionless
 * relative specifier does not resolve, and a regeneration without this check
 * would silently take that extension back off.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contrastRatioOf, type Rgb } from "../src/contrastRatio.ts";
import { rgbChannels } from "../src/rgbChannels.ts";
import { mixChannels, mixColors } from "../src/mixColors.ts";
import { secondaryText } from "./secondaryText.ts";
import { selectionColor } from "./selectionColor.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const require = createRequire(import.meta.url);
const shikiManifest = resolve(dirname(require.resolve("@shikijs/themes")), "../package.json");
const { version: shikiVersion } = JSON.parse(readFileSync(shikiManifest, "utf8")) as { version: string };
const outputDir = resolve(root, "packages/smithers/ui/ui-styleguide/src/themes");

type Mode = "light" | "dark";
type UpstreamTheme = { colors: Record<string, string | null>; name: string };

const specs = [
  ["nightOwl", "Night Owl", "night-owl", "night-owl-light"],
  ["one", "One", "one-dark-pro", "one-light"],
  ["github", "GitHub", "github-dark", "github-light"],
  ["catppuccin", "Catppuccin", "catppuccin-mocha", "catppuccin-latte"],
  ["solarized", "Solarized", "solarized-dark", "solarized-light"],
  ["gruvbox", "Gruvbox", "gruvbox-dark-medium", "gruvbox-light-medium"],
  ["rosePine", "Rosé Pine", "rose-pine", "rose-pine-dawn"],
] as const;

const keyForFile: Record<string, string> = { nightOwl: "night-owl", rosePine: "rose-pine" };
const accents: Record<string, { dark: string; light: string }> = {
  nightOwl: { dark: "#c792ea", light: "#994cc3" },
  one: { dark: "#c678dd", light: "#a626a4" },
  github: { dark: "#58a6ff", light: "#0969da" },
  catppuccin: { dark: "#cba6f7", light: "#8839ef" },
  solarized: { dark: "#268bd2", light: "#00629d" },
  gruvbox: { dark: "#d3869b", light: "#8f3f71" },
  rosePine: { dark: "#c4a7e7", light: "#907aa9" },
};

/** Adjust a semantic seed until it reaches WCAG AA on its shared soft tint. */
function contrastSafe(seed: string, surface: string, amount: number, mode: Mode): string {
  let value = seed.slice(0, 7);
  const target = mode === "light" ? "#000000" : "#ffffff";
  for (let step = 0; step <= 100 && contrastRatioOf(rgbChannels(value), mixChannels(value, surface, amount)) < 4.5; step += 1) {
    value = mixColors(target, value, 0.035);
  }
  return value;
}

function opaque(value: string | null | undefined, fallback: string): string {
  return value && /^#[\da-f]{6}(?:ff)?$/i.test(value) ? value.slice(0, 7) : fallback;
}

async function load(id: string): Promise<UpstreamTheme> {
  const modulePath = require.resolve(`@shikijs/themes/${id}`);
  return (await import(pathToFileURL(modulePath).href)).default as UpstreamTheme;
}

function terminal(theme: UpstreamTheme, bg: string, text: string, semantic: Record<string, string>) {
  const c = theme.colors;
  // Themes without terminal.ansi* use the corresponding UI semantic seed.
  // Bright fallbacks repeat that mapping; bright black is a text/background
  // midpoint and bright white uses the editor foreground.
  const ansi = (name: string, fallback: string) => opaque(c[`terminal.ansi${name}`], fallback);
  const selection = selectionColor(
    c["terminal.selectionBackground"],
    `rgba(${rgbChannels(semantic.info).join(",")},0.3)`,
  );
  return {
    background: opaque(c["terminal.background"], bg),
    foreground: opaque(c["terminal.foreground"], text),
    cursor: opaque(c["terminalCursor.foreground"], text),
    selectionBackground: selection,
    black: ansi("Black", bg),
    red: ansi("Red", semantic.danger),
    green: ansi("Green", semantic.success),
    yellow: ansi("Yellow", semantic.warning),
    blue: ansi("Blue", semantic.info),
    magenta: ansi("Magenta", semantic.brand),
    cyan: ansi("Cyan", semantic.info),
    white: ansi("White", text),
    brightBlack: ansi("BrightBlack", mixColors(text, bg, 0.45)),
    brightRed: ansi("BrightRed", semantic.danger),
    brightGreen: ansi("BrightGreen", semantic.success),
    brightYellow: ansi("BrightYellow", semantic.warning),
    brightBlue: ansi("BrightBlue", semantic.info),
    brightMagenta: ansi("BrightMagenta", semantic.brand),
    brightCyan: ansi("BrightCyan", semantic.info),
    brightWhite: ansi("BrightWhite", text),
  };
}

function variant(theme: UpstreamTheme, mode: Mode, accent: string, name: string) {
  const c = theme.colors;
  const bg = opaque(c["editor.background"], mode === "dark" ? "#111111" : "#ffffff");
  const foreground = opaque(c["editor.foreground"], mode === "dark" ? "#eeeeee" : "#222222");
  // Dark surfaces rise by mixing foreground into the editor background. Light
  // surfaces follow the existing zinc semantics: the page background sits one
  // step below a near-white card, inset fills darken from that card, and
  // overlays return to white.
  const surface = mode === "dark" ? mixColors(foreground, bg, 0.055) : mixColors("#ffffff", bg, 0.75);
  const surface2 = mode === "dark" ? mixColors(foreground, bg, 0.095) : mixColors(foreground, surface, 0.055);
  const surface3 = mode === "dark" ? mixColors(foreground, bg, 0.135) : "#ffffff";
  const textBackgrounds = [bg, surface, surface2, surface3];
  // Leave room for the 5:1 muted token and a visible step below primary text.
  // Surfaces keep their upstream seed so correcting text does not move the
  // backgrounds being measured or change unrelated semantic colors.
  const text = secondaryText(mode === "light" ? "#000000" : "#ffffff", foreground, textBackgrounds, 0, 5.25, {
    palette: name,
    mode,
    token: "text",
  });
  const nightOwlSeeds =
    mode === "dark"
      ? { success: "#addb67", danger: "#ef5350", warning: "#ecc48d", info: "#82aaff" }
      : { success: "#2AA298", danger: "#E64D49", warning: "#daaa01", info: "#4876d6" };
  const semanticSeeds = {
    brand: accent,
    success:
      name === "nightOwl"
        ? nightOwlSeeds.success
        : opaque(
            c["gitDecoration.addedResourceForeground"] ??
              c["gitDecoration.untrackedResourceForeground"] ??
              c["editorGutter.addedBackground"],
            "#2e9b57",
          ),
    danger:
      name === "nightOwl"
        ? nightOwlSeeds.danger
        : opaque(c["errorForeground"] ?? c["editorError.foreground"], "#d73a49"),
    warning:
      name === "nightOwl"
        ? nightOwlSeeds.warning
        : opaque(c["editorWarning.foreground"] ?? c["gitDecoration.conflictingResourceForeground"], "#b7791f"),
    info:
      name === "nightOwl"
        ? nightOwlSeeds.info
        : opaque(c["editorInfo.foreground"] ?? c["editorGutter.modifiedBackground"], "#2b6cb0"),
  };
  const semantic = Object.fromEntries(
    Object.entries(semanticSeeds).map(([name, seed]) => {
      const amount = name === "success" || name === "warning" ? 0.12 : 0.1;
      let value = contrastSafe(seed, surface, amount, mode);
      const target = mode === "light" ? "#000000" : "#ffffff";
      for (let step = 0; step <= 100 && contrastRatioOf(rgbChannels(value), rgbChannels(surface3)) < 4.5; step += 1) value = mixColors(target, value, 0.035);
      return [name, value];
    }),
  ) as Record<string, string>;
  const t = rgbChannels(text);
  const s = rgbChannels(surface);
  const rgba = (channels: Rgb, alpha: number) => `rgba(${channels.join(",")},${alpha})`;
  const tokens = {
    colorScheme: mode,
    bg,
    text,
    textMuted: secondaryText(text, bg, textBackgrounds, 0.68, 5, { palette: name, mode, token: "textMuted" }),
    textFaint: secondaryText(text, bg, textBackgrounds, mode === "dark" ? 0.65 : 0.56, 4.75, {
      palette: name,
      mode,
      token: "textFaint",
    }),
    textPlaceholder: secondaryText(text, bg, textBackgrounds, 0.46, 4.5, { palette: name, mode, token: "textPlaceholder" }),
    surface,
    surface2,
    surface3,
    surfaceGlass: rgba(s, 0.72),
    surfaceGlassStrong: rgba(s, 0.85),
    border: rgba(t, mode === "dark" ? 0.09 : 0.08),
    borderStrong: rgba(t, mode === "dark" ? 0.16 : 0.14),
    borderSolid: mixColors(text, bg, mode === "dark" ? 0.15 : 0.11),
    hover: surface2,
    hoverSubtle: rgba(t, mode === "dark" ? 0.05 : 0.04),
    inverseBg: text,
    inverseText: bg,
    codeBg: bg,
    codeText: text,
    inlineCodeBg: rgba(t, mode === "dark" ? 0.08 : 0.06),
    ...semantic,
    shadowRgb: mode === "dark" ? "0 0 0" : t.join(" "),
    shadow1: `0 1px 2px rgb(var(--shadow-rgb) / ${mode === "dark" ? "0.35" : "0.05"})`,
    shadow2:
      mode === "dark"
        ? "0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)"
        : "0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",
    shadow3:
      mode === "dark"
        ? "0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"
        : "0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)",
  };
  return { tokens, terminal: terminal(theme, bg, foreground, semantic) };
}

/**
 * Serialize a record as a TypeScript object literal in the checked-in style.
 *
 * Every key the registry emits is a plain identifier, so none is quoted; a key
 * that ever needs quoting would be a schema change and is quoted here rather
 * than emitted as invalid source.
 */
const literal = (value: unknown, indent = 0): string => {
  const pad = "  ".repeat(indent + 1);
  const close = "  ".repeat(indent);
  if (Array.isArray(value)) {
    return value.length === 0
      ? "[]"
      : `[\n${value.map((entry) => `${pad}${literal(entry, indent + 1)},\n`).join("")}${close}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const body = entries
      .map(([key, entry]) => {
        const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
        return `${pad}${name}: ${literal(entry, indent + 1)},\n`;
      })
      .join("");
    return `{\n${body}${close}}`;
  }
  return JSON.stringify(value);
};

const check = process.argv.includes("--check");
const stale: string[] = [];
const outputs: { file: string; source: string }[] = [];

for (const [name, label, shikiDark, shikiLight] of specs) {
  const [darkSource, lightSource] = await Promise.all([load(shikiDark), load(shikiLight)]);
  const dark = variant(darkSource, "dark", accents[name].dark, name);
  const light = variant(lightSource, "light", accents[name].light, name);
  const key = keyForFile[name] ?? name;
  const record = {
    key,
    label,
    light: light.tokens,
    dark: dark.tokens,
    syntax: { shikiDark, shikiLight },
    terminal: { dark: dark.terminal, light: light.terminal },
  };
  const source = `// Generated by packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts from @shikijs/themes ${shikiVersion}. Do not edit.\nimport type { SmithersTheme } from "../SmithersTheme.ts";\n\nexport const ${name}: SmithersTheme = ${literal(record)};\n`;
  const file = resolve(outputDir, `${name}.ts`);
  if (!check) {
    outputs.push({ file, source });
    continue;
  }
  let current: string | undefined;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== source) stale.push(`${name}.ts`);
}

if (check && stale.length > 0) {
  console.error(
    `These generated theme files do not match this script's output: ${stale.join(", ")}.\n` +
      "Run: node --experimental-strip-types packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts",
  );
  process.exit(1);
}

// Validate every palette before writing any generated output.
for (const { file, source } of outputs) writeFileSync(file, source);
