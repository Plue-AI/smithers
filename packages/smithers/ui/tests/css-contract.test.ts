import { describe, expect, test } from "bun:test";
import { reducedMotionCss, workflowUiThemeCss } from "@smthrs/ui-styleguide";
import { agentOutputCss, smithersUiCss } from "../src/uiCss";
import { tokens } from "../src/tokens";

/**
 * The theming contract. These invariants are what make every component
 * correct in light AND dark without any dark-mode code:
 *
 * 1. No `:root` token emission -- the styleguide owns the page tokens, and
 *    its `--primary`/`--accent`/`--muted` aliases have different semantics
 *    than shadcn's. Redefining root tokens would recolor legacy UIs.
 * 2. Every color resolves through `var(--house-token, lightFallback)` or a
 *    `color-mix(in srgb, ...)` over one. Raw hex/rgba outside fallback
 *    position pins a color to one theme (the exact bug class that hit the
 *    operator console's rgba(255,255,255,...) backgrounds).
 * 3. Fallbacks are byte-equal to the styleguide's light values, so components
 *    render the same standalone as under the styleguide in light mode.
 * 4. Every class is `sui-` namespaced.
 */

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return (
    css
      // Shadow tokens carry a full shadow list (with raw rgb() stops) as their
      // light fallback; strip them first so the raw-color rules below only see
      // colors outside sanctioned fallback position.
      .replace(/var\(--shadow-[123],\s*(?:[^()]|rgba?\([^)]*\))*\)/g, "VAR")
      .replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR")
  );
}

describe("css contract", () => {
  test("never emits a :root token block", () => {
    expect(smithersUiCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(smithersUiCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors: only shadow channels via rgb(var(--shadow-rgb ...))", () => {
    const stripped = stripVarFallbacks(smithersUiCss)
      // The shadow recipe rgb(VAR / a) is the one sanctioned rgb() form.
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb (matches the house recipes; oklab drifts)", () => {
    const mixes = smithersUiCss.match(/color-mix\([^,]+/g) ?? [];
    expect(mixes.length).toBeGreaterThan(0);
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = smithersUiCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("var() fallbacks are byte-equal to the styleguide light values", () => {
    // Parse the styleguide's light :root block into token -> value.
    const rootBlock = workflowUiThemeCss.split("\n")[0] ?? "";
    const lightValues = new Map<string, string>();
    for (const m of rootBlock.matchAll(/(--[\w-]+):([^;]+);/g)) {
      lightValues.set(m[1]!, m[2]!.trim());
    }
    expect(lightValues.get("--bg")).toBe("#f7f4ee");

    const sources = [
      smithersUiCss,
      Object.values(tokens)
        .filter((v) => typeof v === "string")
        .join("\n"),
    ];
    let checked = 0;
    for (const source of sources) {
      for (const m of source.matchAll(/var\((--[\w-]+),\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\d\s]+)\)/g)) {
        const houseValue = lightValues.get(m[1]!);
        // Tokens not defined by the styleguide (e.g. Radix layout vars) are
        // exempt from the light-parity rule.
        if (houseValue === undefined) continue;
        // Alias tokens (--panel etc.) resolve to var() refs; skip those.
        if (houseValue.startsWith("var(") || houseValue.startsWith("color-mix(")) continue;
        expect(`${m[1]}=${m[2]!.trim()}`).toBe(`${m[1]}=${houseValue}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("standalone token recipes match Paper, including tints, shadows and fonts", () => {
    const lightValues = new Map(
      [...workflowUiThemeCss.split("\n")[0]!.matchAll(/(--[\w-]+):([^;]+);/g)]
        .map((match) => [match[1]!, match[2]!.trim()]),
    );
    const resolve = (value: string): string => value.replace(
      /var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
      (_, name: string, fallback: string | undefined) => fallback ?? lightValues.get(name)!,
    );
    for (const token of Object.values(tokens)) {
      const [, name, fallback] = token.match(/^var\((--[\w-]+),\s*([\s\S]+)\)$/)!;
      expect(`${name}=${resolve(fallback!)}`).toBe(`${name}=${resolve(lightValues.get(name!)!)}`);
    }
  });

  test("focus ring follows the house recipe through the --ring custom properties", () => {
    // Routed through --ring/--ring-border so a host that themes the ring
    // re-themes these components; the fallbacks stay the house recipe.
    expect(smithersUiCss).toContain(
      "border-color:var(--ring-border, color-mix(in srgb, var(--brand, #0f766e) 50%, transparent))",
    );
    expect(smithersUiCss).toContain(
      "0 0 0 3px var(--ring, color-mix(in srgb, var(--brand, #0f766e) 22%, transparent))",
    );
  });

  test("the default button variant is the house tinted primary, not a solid fill", () => {
    const defaultRule = smithersUiCss.match(/\.sui-button-default \{[^}]+\}/)?.[0] ?? "";
    expect(defaultRule).toContain("color-mix(in srgb, var(--brand, #0f766e) 10%,");
    expect(defaultRule).toContain("color:var(--brand, #0f766e)");
  });

  test("badge variants consume the shared semantic soft and border tokens", () => {
    const variants = [
      ["default", "brand"],
      ["success", "success"],
      ["warning", "warning"],
      ["destructive", "danger"],
    ] as const;
    for (const [variant, semantic] of variants) {
      const rule = smithersUiCss.match(new RegExp(`\\.sui-badge-${variant} \\{[^}]+\\}`))?.[0] ?? "";
      expect(rule).toContain(`var(--${semantic}-border,`);
      expect(rule).toContain(`var(--${semantic}-soft,`);
    }
  });

  test("composes the agent output block into the shipped stylesheet", () => {
    expect(agentOutputCss).toContain(".sui-agent-output {");
    expect(agentOutputCss).toContain(".sui-agent-output-tools {");
    expect(smithersUiCss).toContain(agentOutputCss);
  });

  test("composes one document-wide reduced-motion policy after every component block", () => {
    expect(smithersUiCss.endsWith(reducedMotionCss)).toBe(true);
    expect(smithersUiCss.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
    expect(reducedMotionCss).toContain("*, *::before, *::after");
    expect(reducedMotionCss).toContain("animation-duration:0.001ms !important");
    expect(reducedMotionCss).toContain("transition-duration:0.001ms !important");
    expect(smithersUiCss.indexOf(".sui-spinner")).toBeLessThan(smithersUiCss.indexOf(reducedMotionCss));
    expect(smithersUiCss.indexOf(".sui-skeleton")).toBeLessThan(smithersUiCss.indexOf(reducedMotionCss));
  });

  test("uses the documented compact type step without a 12.5px half-step", () => {
    expect(tokens.fontSizeCompact).toBe("var(--fs-2, 12px)");
    expect(smithersUiCss).toContain("font-size:var(--fs-2, 12px)");
    expect(smithersUiCss).not.toContain("12.5px");
  });
});

/**
 * The geometry contract: the sheets must practice the scales the styleguide
 * declares. Named exceptions are listed inline; anything else is drift.
 */
describe("geometry contract", () => {
  // The --fs steps (11/12/13/15/17/20) plus the named exceptions: 10px
  // micro-labels (tab counts, file chips, citation chips), 16px composer
  // inputs (an iOS input under 16px triggers page zoom on focus), and 18px
  // icon glyphs (chevrons, close/remove/send marks).
  const FONT_SIZES = new Set([10, 11, 12, 13, 15, 16, 17, 18, 20]);
  // 400 body, 500 de-emphasis, 650 the one emphasis weight; 700 is reserved
  // for KPI numerals and pinned to exactly one rule below.
  const FONT_WEIGHTS = new Set([400, 500, 650, 700]);
  // --r-1 controls, --r-2 cards, --r-bubble chat surfaces, --r-full pills, plus
  // the named micro-radii: 2px caret, 4px favicon/status chips.
  const RADII = new Set([2, 4, 6, 10, 18, 999]);

  test("every raw font-size sits on the type scale or a named exception", () => {
    const sizes = [...smithersUiCss.matchAll(/font-size:([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(20);
    for (const size of sizes) {
      expect(FONT_SIZES.has(size), `font-size:${size}px is off the type scale`).toBe(true);
    }
    // The font shorthand carries weight + size; hold it to the same scales.
    for (const m of smithersUiCss.matchAll(/font:(\d{3})\s+([\d.]+)px/g)) {
      expect(FONT_WEIGHTS.has(Number(m[1])), `font shorthand weight ${m[1]}`).toBe(true);
      expect(FONT_SIZES.has(Number(m[2])), `font shorthand size ${m[2]}px`).toBe(true);
    }
  });

  test("font weights are 400/500/650, with 700 reserved for the KPI numeral", () => {
    const weights = [...smithersUiCss.matchAll(/font-weight:(\d+)/g)].map((m) => Number(m[1]));
    for (const weight of weights) {
      expect(FONT_WEIGHTS.has(weight), `font-weight:${weight} is off the weight roles`).toBe(true);
    }
    expect(weights.filter((w) => w === 700)).toHaveLength(1);
    expect(smithersUiCss.match(/\.sui-kpi-value \{[^}]+font-weight:700/)).toBeTruthy();
  });

  test("every border-radius resolves to a house radius", () => {
    const decls = smithersUiCss.match(/border-radius:[^;}]+/g) ?? [];
    expect(decls.length).toBeGreaterThan(20);
    for (const decl of decls) {
      for (const m of decl.matchAll(/([\d.]+)px/g)) {
        expect(RADII.has(Number(m[1])), `${decl.trim()} is off the radius scale`).toBe(true);
      }
    }
  });

  test("exact control heights and full radii route through their house tokens", () => {
    expect(smithersUiCss).not.toContain("min-height:32px");
    expect(smithersUiCss).not.toContain("height:32px");
    expect(smithersUiCss).not.toContain("border-radius:999px");
    expect(smithersUiCss).toContain("min-height:var(--ctl-h, 32px)");
    expect(smithersUiCss).toContain("border-radius:var(--r-full, 999px)");
  });

  test("does not restore selectors with no component or consumer references", () => {
    for (const selector of [".sui-badge-info", ".sui-md-code-block", ".sui-msg-main", ".sui-vault-save-status"]) {
      expect(smithersUiCss).not.toContain(selector);
    }
  });

  test("padding and gap stay on the 2px grid (1px hairline gaps sanctioned)", () => {
    const decls = smithersUiCss.match(/(?:padding[a-z-]*|gap|row-gap|column-gap):[^;}]+/g) ?? [];
    expect(decls.length).toBeGreaterThan(50);
    for (const decl of decls) {
      // gap:1px is the hairline row-separation device (file tree); like 1px
      // borders it sits below the grid on purpose.
      if (/^gap:1px$/.test(decl.trim())) continue;
      for (const m of decl.matchAll(/(\d+)px/g)) {
        expect(Number(m[1]) % 2, `${decl.trim()} is off the 2px spacing grid`).toBe(0);
      }
    }
  });

  test("shared utilities and keyframes are defined exactly once", () => {
    expect(smithersUiCss.match(/\.sui-sr-only \{/g)).toHaveLength(1);
    expect(smithersUiCss.match(/@keyframes sui-shimmer-sweep/g)).toHaveLength(1);
    expect(smithersUiCss).not.toContain("sui-plan-shimmer-sweep");
  });

  test("interactive controls carry pressed feedback at the house speed", () => {
    expect(smithersUiCss).toContain(".sui-button:active:not(:disabled)");
    expect(smithersUiCss).toContain(".sui-button-default:active:not(:disabled)");
    expect(smithersUiCss).toContain(".sui-button-destructive:active:not(:disabled)");
    expect(smithersUiCss).toContain(".sui-row-button:active:not(:disabled)");
    const buttonRule = smithersUiCss.match(/\.sui-button \{[^}]+\}/)?.[0] ?? "";
    expect(buttonRule).toContain("transition:background-color .12s ease, border-color .12s ease, color .12s ease;");
  });

  test("elevation and fonts route through the styleguide custom properties", () => {
    expect(tokens.shadow2).toStartWith("var(--shadow-2,");
    expect(tokens.shadow3).toStartWith("var(--shadow-3,");
    expect(tokens.ring).toStartWith("var(--ring,");
    expect(tokens.ringBorder).toStartWith("var(--ring-border,");
    expect(tokens.fontSans).toStartWith("var(--font-sans,");
    expect(tokens.fontMono).toStartWith("var(--font-mono,");
    expect(tokens.radiusBubble).toBe("var(--r-bubble, 18px)");
    expect(tokens.radiusFull).toBe("var(--r-full, 999px)");
  });
});
