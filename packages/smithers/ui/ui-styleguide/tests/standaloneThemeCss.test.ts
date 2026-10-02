import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reducedMotionCss, standaloneThemeCss, themeRegistry, workflowUiThemeCss } from "../src/index.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function themeDeclarations(css: string, theme: "light" | "dark"): Map<string, string> {
  const block =
    theme === "light"
      ? css.match(/^:root \{ ([^}]+) \}/m)?.[1]
      : css.match(/:root\[data-theme=(["'])dark\1\] \{ ([^}]+) \}/)?.[2];
  if (!block) throw new Error(`${theme} token block not found`);

  return new Map([...block.matchAll(/(--[\w-]+):([^;]+)(?:;|$)/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

const PALETTE_COUNT = Object.keys(themeRegistry).length;
const INITIAL_STANDALONE_THEME_CSS = standaloneThemeCss();

/** Preserve the original eight-palette byte cap after removing the collection. */
const SIZE_BUDGET = 8 * 3_600;

describe("standaloneThemeCss", () => {
  test("returns the same value on repeat calls", () => {
    const first = standaloneThemeCss();
    const second = standaloneThemeCss();
    expect(first).toBe(second);
    expect(first).toBe(INITIAL_STANDALONE_THEME_CSS);
  });

  test("builds the sheet once, at module evaluation", () => {
    // The test above cannot see this. `first`, `second`, and the pre-suite
    // snapshot are primitive strings, so an implementation that rebuilt the
    // whole stylesheet on every call would satisfy all three assertions; the
    // JSDoc and `docs/api.md` both promise more than that ("built once at
    // module evaluation ... repeat calls cost nothing"). Reading the source is
    // what can fail: a timing budget would trade this guarantee for a flaky
    // one, and no runtime observation distinguishes two equal strings.
    const source = readFileSync(join(packageRoot, "src/standaloneThemeCss.ts"), "utf8");
    expect(source).toMatch(/^const standaloneCss = \[/m);
    expect(source).toMatch(/export function standaloneThemeCss\(\): string \{\n {2}return standaloneCss;\n\}/);
  });

  test("ships both dark-mode strategies and keeps color values in token declarations", () => {
    const css = standaloneThemeCss();
    expect(css.length, `${PALETTE_COUNT} palettes`).toBeLessThan(SIZE_BUDGET);
    expect(css).toContain('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    const declarations = css.match(/--[\w-]+:[^;}]+/g) ?? [];
    const withoutTokens = css.replace(/--[\w-]+:[^;}]+/g, "TOKEN");
    expect(declarations.length).toBeGreaterThan(30);
    expect(withoutTokens).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
    const colorRules = withoutTokens.match(/(?:^|[;{])\s*(?:color|background(?:-color)?)\s*:\s*([^;}]+)/g) ?? [];
    for (const rule of colorRules) expect(rule).toContain("var(--");
    expect(css).toContain("border-bottom:1px solid var(--border)");
    expect(css).toContain("border-top:1px solid var(--border)");
  });

  test("routes every radius through the documented scale", () => {
    const css = standaloneThemeCss();
    const radii = css.match(/border-radius:\s*([^;}]+)/g) ?? [];
    expect(radii.length).toBeGreaterThan(0);
    for (const radius of radii) {
      expect(radius, radius).toMatch(/border-radius:\s*(?:var\(--r-[\w-]+\)|999px)/);
    }
  });

  test("keeps unlayered code defaults out of embedded Pierre diffs", () => {
    const css = standaloneThemeCss();
    const guard = ":not(:where(.pierre-diff *))";
    expect(css).toContain(`code${guard} {`);
    expect(css).toContain(`pre${guard} {`);
    expect(css).toContain(`pre${guard} code${guard} {`);
    expect(css).not.toMatch(/(?:^|})\s*(?:code|pre|pre code)\s*\{/);
  });

  test("includes the documented type scale and the shared motion policy", () => {
    const css = standaloneThemeCss();
    expect(css).toContain("--fs-1:11px; --fs-2:12px; --fs-3:13px; --fs-4:15px");
    expect(css).toContain("--fs-5:17px; --fs-6:20px; --fs-7:24px");
    expect(css.endsWith(reducedMotionCss)).toBe(true);
    expect(css.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
  });

  test("uses the corrected dark secondary tokens in both dark selectors", () => {
    const css = standaloneThemeCss();
    expect(css.match(/--text-faint:#969083/g)).toHaveLength(2);
    expect(css.match(/--text-placeholder:#958f82/g)).toHaveLength(2);
  });

  test("declares every workflow theme token in light and dark mode", () => {
    const standaloneCss = standaloneThemeCss();
    for (const theme of ["light", "dark"] as const) {
      expect(themeDeclarations(standaloneCss, theme)).toEqual(themeDeclarations(workflowUiThemeCss, theme));
    }
  });

  test("routes elevation shadows through the theme shadow channels", () => {
    const css = standaloneThemeCss();
    const shadows = css.match(/--shadow-[123]:[^;}]+/g) ?? [];
    // Three `--shadow-*` declarations in each of the three rules every palette
    // emits (light, prefers-color-scheme dark, explicit data-theme dark).
    expect(shadows).toHaveLength(PALETTE_COUNT * 3 * 3);
    for (const shadow of shadows) expect(shadow).toContain("rgb(var(--shadow-rgb) /");
    expect(css).not.toMatch(/rgb\((?:24 24 27|0 0 0) \//);
  });
});
