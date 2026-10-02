import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THEME_KEY,
  reducedMotionCss,
  themeCss,
  themeRegistry,
  workflowUiLayoutCss,
  workflowUiPrimitiveCss,
  workflowUiStyles,
  workflowUiThemeCss,
} from "../src/index.ts";

const nonDefaultKeys = Object.keys(themeRegistry).filter((key) => key !== DEFAULT_THEME_KEY);

describe("ui styleguide", () => {
  test("exports the combined theme and layout styles", () => {
    expect(workflowUiThemeCss).toContain(":root {");
    expect(workflowUiLayoutCss).toContain(".workflow-shell {");
    expect(workflowUiStyles).toBe(`${workflowUiThemeCss}\n${workflowUiLayoutCss}`);
  });

  test("defines and consumes one shared soft-tint recipe per semantic", () => {
    for (const semantic of ["brand", "success", "danger", "warning", "info"]) {
      expect(workflowUiThemeCss).toContain(`--${semantic}-soft:color-mix(in srgb, var(--${semantic}) 10%`);
      expect(workflowUiThemeCss).toContain(`--${semantic}-border:color-mix(in srgb, var(--${semantic})`);
    }
    expect(workflowUiThemeCss).toContain("--me:var(--brand-soft)");
    expect(workflowUiThemeCss).toContain(".pill { border-color:var(--brand-border); background:var(--brand-soft);");
  });

  test("routes every tinted fill through a named recipe, never an inline color-mix", () => {
    // The two states that used to hard-code `color-mix(in srgb, var(--brand)
    // 22%, ...)` and `var(--danger) 16%` bypassed the audited recipe list and
    // put semantic text on tints that miss AA in most palettes.
    const rules = workflowUiThemeCss.split("\n").filter((rule) => !rule.startsWith(":root") && !rule.startsWith("@media"));
    for (const rule of rules) {
      const fills = rule.match(/background(?:-color)?:\s*color-mix\([^)]*var\(--(?:brand|success|danger|warning|info)\)[^;}]*/g);
      expect(fills, rule).toBeNull();
    }
  });

  test("keeps the topbar backdrop filter tied to the saturation the audit models", () => {
    // `tests/paintedPairs.ts` composites the topbar over a backdrop saturated
    // by exactly this amount. A change here without a change there would audit
    // a background the browser does not paint.
    const rule = workflowUiThemeCss.split("\n").find((line) => line.startsWith(".top,.topbar {"));
    expect(rule).toBeDefined();
    expect(rule).toContain("background:var(--surface-glass-strong)");
    expect(rule?.match(/backdrop-filter:blur\(18px\) saturate\(180%\)/g)).toHaveLength(2);
  });

  test("sets an explicit foreground on every surface that is not the page background", () => {
    // `.livelog` painted `--code-bg` while letting its text inherit `--text`,
    // an unaudited pair that is not an alias of `--code-text` in every palette.
    for (const selector of [".livelog {", ".code,.source,pre.code {"]) {
      const rule = workflowUiThemeCss.split("\n").find((line) => line.startsWith(selector));
      expect(rule, selector).toBeDefined();
      expect(rule, selector).toContain("color:var(--code-text)");
    }
  });

  test("ships one global reduced-motion policy after primitive transitions", () => {
    expect(workflowUiThemeCss.endsWith(reducedMotionCss)).toBe(true);
    expect(workflowUiThemeCss.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
    expect(workflowUiThemeCss.indexOf(".run-row {")).toBeLessThan(workflowUiThemeCss.indexOf(reducedMotionCss));
  });

  test("declares the theme-invariant font block exactly once", () => {
    // Every palette's light variant reports `colorScheme: "light"`, so keying
    // the font block off that field emitted it in all eight `:root` rules. The
    // palette rules are (0,2,0), which beat a consumer's own bare `:root`
    // overrides on the host application's own root.
    expect(workflowUiThemeCss.match(/--font-sans:Inter/g)).toHaveLength(1);
    expect(workflowUiThemeCss.match(/font-family:var\(--font-sans\)/g)).toHaveLength(1);
    expect(workflowUiThemeCss.match(/--font-mono:ui-monospace/g)).toHaveLength(1);
    for (const key of nonDefaultKeys) {
      const rule = workflowUiThemeCss.split("\n").find((line) => line.startsWith(`:root[data-palette='${key}'] {`));
      expect(rule, key).toBeDefined();
      expect(rule).not.toContain("--font-sans");
      expect(rule).not.toContain("font-family");
    }
  });

  test("emits three selection states for every non-default palette", () => {
    // Selectors only. What each selector declares -- and which variant a
    // document with a given `data-palette`, `data-theme`, and system preference
    // actually resolves to -- is `tests/paletteSelection.test.ts`, because
    // these three assertions hold for any declarations at all.
    for (const key of nonDefaultKeys) {
      expect(workflowUiThemeCss).toContain(`:root[data-palette='${key}'] {`);
      expect(workflowUiThemeCss).toContain(`:root[data-palette='${key}']:not([data-theme='light'])`);
      expect(workflowUiThemeCss).toContain(`:root[data-palette='${key}'][data-theme='dark']`);
    }
    expect(workflowUiThemeCss.split("\n")[0]).toStartWith(":root { color-scheme:light;");
  });

  test("puts every palette override after the equally specific default dark rules", () => {
    // `:root[data-palette='<key>']` and `:root[data-theme='dark']` both compute
    // to (0,2,0), so only source order stops the default's dark tokens from
    // overriding a selected palette's light tokens.
    const defaultDark = workflowUiThemeCss.indexOf(":root[data-theme='dark']");
    const defaultMedia = workflowUiThemeCss.indexOf("@media (prefers-color-scheme: dark) { :root:not(");
    expect(defaultDark).toBeGreaterThan(-1);
    expect(defaultMedia).toBeGreaterThan(-1);
    for (const key of nonDefaultKeys) {
      const palette = workflowUiThemeCss.indexOf(`:root[data-palette='${key}'] {`);
      expect(palette, key).toBeGreaterThan(defaultDark);
      expect(palette, key).toBeGreaterThan(defaultMedia);
    }
  });
});

describe("themeCss", () => {
  test("defaults to the whole registry and opens workflowUiThemeCss", () => {
    expect(workflowUiThemeCss.startsWith(`${themeCss()}\n`)).toBe(true);
    expect(themeCss()).toBe(themeCss({ palettes: Object.keys(themeRegistry) }));
  });

  test("emits a subset for a host that pins one palette", () => {
    const subset = themeCss({ palettes: ["one"] });
    expect(subset).toContain(":root[data-palette='one'] {");
    for (const key of nonDefaultKeys.filter((k) => k !== "one")) {
      expect(subset).not.toContain(`:root[data-palette='${key}']`);
    }
    expect(subset).toContain(":root { color-scheme:light;");
    expect(subset.length).toBeLessThan(themeCss().length / 2);
  });

  test("names an unregistered palette instead of emitting nothing", () => {
    expect(() => themeCss({ palettes: ["dracula"] })).toThrow(/unknown palette "dracula"/);
    expect(() => themeCss({ palettes: ["one", "dracula"] })).toThrow(/registered: night-owl, fucory/);
  });

  test("emits registry order for any request order, and each palette once", () => {
    const forward = themeCss({ palettes: ["one", "github"] });
    expect(themeCss({ palettes: ["github", "one"] })).toBe(forward);
    expect(themeCss({ palettes: ["one", "github", "one"] })).toBe(forward);
    expect(forward.indexOf(":root[data-palette='one'] {")).toBeLessThan(
      forward.indexOf(":root[data-palette='github'] {"),
    );
    expect(forward.match(/:root\[data-palette='one'\] \{/g)).toHaveLength(1);
  });
});

describe("workflowUiPrimitiveCss", () => {
  test("is the half of workflowUiThemeCss that carries no tokens", () => {
    expect(workflowUiThemeCss).toBe(`${themeCss()}\n${workflowUiPrimitiveCss}`);
    expect(workflowUiPrimitiveCss).toContain("* { box-sizing:border-box; }");
    expect(workflowUiPrimitiveCss).not.toContain(":root {");
    expect(workflowUiPrimitiveCss).not.toContain("data-palette");
  });

  test("pins a palette without slicing the combined sheet", () => {
    // The recipe `docs/guides/pin-a-palette.md` used to document: derive the
    // primitives from a character offset into the combined sheet. The export
    // has to reproduce it byte for byte, or a host that follows the old guide
    // and a host that follows the new one ship different CSS.
    const palettes = ["gruvbox"];
    const sliced = [
      themeCss({ palettes }),
      workflowUiThemeCss.slice(themeCss().length + 1),
      workflowUiLayoutCss,
    ].join("\n");
    expect([themeCss({ palettes }), workflowUiPrimitiveCss, workflowUiLayoutCss].join("\n")).toBe(sliced);
  });
});
