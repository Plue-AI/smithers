/**
 * `serializeThemeVariant`'s input contract and its font-block option.
 *
 * The function interpolates each token straight into a declaration string that
 * a caller drops into a `<style>` element, and it is exported. Nothing outside
 * this package imports it today, so the grammar checks below close an API
 * contract gap rather than a live vulnerability -- but an exported function
 * with an unusual input contract and no stated one is the defect.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME_KEY, serializeThemeVariant, themeRegistry } from "../src/index.ts";
import type { ThemeVariantTokens } from "../src/index.ts";

const base = themeRegistry[DEFAULT_THEME_KEY].light;
const variantWith = (overrides: Partial<Record<keyof ThemeVariantTokens, unknown>>): ThemeVariantTokens =>
  ({ ...base, ...overrides }) as unknown as ThemeVariantTokens;

describe("the font block", () => {
  test("is off by default and on only when asked", () => {
    expect(serializeThemeVariant(base)).not.toContain("--font-sans");
    expect(serializeThemeVariant(base, {})).not.toContain("--font-sans");
    expect(serializeThemeVariant(base, { fonts: false })).not.toContain("--font-sans");
    const withFonts = serializeThemeVariant(base, { fonts: true });
    expect(withFonts).toContain("font-family:var(--font-sans)");
    expect(withFonts).toContain("--font-sans:Inter,");
    expect(withFonts).toContain("--font-mono:ui-monospace,");
  });

  test("does not key off colorScheme, which every palette's light variant shares", () => {
    for (const theme of Object.values(themeRegistry)) {
      expect(theme.light.colorScheme).toBe("light");
      expect(serializeThemeVariant(theme.light)).not.toContain("--font-sans");
    }
  });

  test("emits colors in the declared order either way", () => {
    const plain = serializeThemeVariant(base);
    const withFonts = serializeThemeVariant(base, { fonts: true });
    expect(plain.startsWith("color-scheme:light; --bg:")).toBe(true);
    expect(withFonts.endsWith(plain.slice("color-scheme:light; ".length))).toBe(true);
  });
});

describe("the input contract", () => {
  test("rejects a value that would end the declaration or the rule", () => {
    for (const hostile of ["red;color:blue", "red}", "red{", "red</style><script>alert(1)</script><style>x"]) {
      expect(() => serializeThemeVariant(variantWith({ bg: hostile })), hostile).toThrow(
        /theme token --bg is not a color, RGB channel triple, or shadow recipe/,
      );
    }
  });

  test("rejects a comment opener, an at-rule, and quote characters", () => {
    for (const hostile of ["red/*", '"', "'", "@import url(x)"]) {
      expect(() => serializeThemeVariant(variantWith({ text: hostile })), hostile).toThrow(TypeError);
    }
  });

  test("rejects a value that loads a URL, so an untrusted token cannot make the viewer fetch", () => {
    for (
      const hostile of [
        "url(//evil.example/t)",
        "url(https://evil.example/t)",
        "image-set(//evil.example/t 1x)",
        "image(//evil.example/t)",
        "src(//evil.example/t)",
        "0 1px 2px url(//evil.example/t)",
        "var(--x)",
        "expression(alert(1))",
        "red",
      ]
    ) {
      expect(() => serializeThemeVariant(variantWith({ bg: hostile })), hostile).toThrow(
        /theme token --bg is not a color, RGB channel triple, or shadow recipe/,
      );
    }
  });

  test("accepts the documented color forms", () => {
    for (
      const value of [
        "#fff",
        "#ffff",
        "#ff3366",
        "#ff336680",
        "rgba(43,108,176,0.3)",
        "rgba(49, 93, 152, 0.22)",
        "rgb(1,2,3)",
        "1 22 39",
        "0 1px 2px rgb(var(--shadow-rgb) / 0.05)",
        "0 4px 6px -1px rgb(var(--shadow-rgb) / 0.1), 0 2px 4px -2px rgb(var(--shadow-rgb) / 0.1)",
      ]
    ) {
      expect(serializeThemeVariant(variantWith({ bg: value })), value).toContain(`--bg:${value};`);
    }
  });

  test("rejects control characters", () => {
    expect(() => serializeThemeVariant(variantWith({ brand: "red\nx" }))).toThrow(TypeError);
    expect(() => serializeThemeVariant(variantWith({ brand: "red\u0000" }))).toThrow(TypeError);
    expect(() => serializeThemeVariant(variantWith({ brand: "red\u007F" }))).toThrow(TypeError);
  });

  test("rejects a getter, so a proxy or accessor cannot smuggle a value past the check", () => {
    const withGetter = Object.defineProperty({ ...base }, "bg", {
      get: () => "red;}",
      enumerable: true,
      configurable: true,
    }) as ThemeVariantTokens;
    expect(() => serializeThemeVariant(withGetter)).toThrow(/must be an own data property/);

    const proxy = new Proxy({ ...base }, { get: (target, key) => (key === "bg" ? "red;}" : Reflect.get(target, key)) });
    expect(() => serializeThemeVariant(proxy as ThemeVariantTokens)).not.toThrow();
    expect(serializeThemeVariant(proxy as ThemeVariantTokens)).toContain(`--bg:${base.bg}`);
  });

  test("rejects a missing token, a non-string, and an over-long value", () => {
    const missing = { ...base } as Record<string, unknown>;
    delete missing.warning;
    expect(() => serializeThemeVariant(missing as unknown as ThemeVariantTokens)).toThrow(
      /theme token --warning must be an own data property/,
    );
    expect(() => serializeThemeVariant(variantWith({ info: 42 }))).toThrow(/must be a string, received 42/);
    expect(() => serializeThemeVariant(variantWith({ info: "" }))).toThrow(/must be 1 to 160 characters/);
    expect(() => serializeThemeVariant(variantWith({ info: "#".repeat(161) }))).toThrow(/received 161/);
  });

  test("rejects a color-scheme that is neither light nor dark", () => {
    expect(() => serializeThemeVariant(variantWith({ colorScheme: "sepia" }))).toThrow(
      /color-scheme must be "light" or "dark"/,
    );
  });

  test("accepts every shipped token, including the rgba and shadow forms", () => {
    for (const theme of Object.values(themeRegistry)) {
      for (const variant of [theme.light, theme.dark]) {
        expect(() => serializeThemeVariant(variant)).not.toThrow();
      }
    }
    expect(serializeThemeVariant(base)).toContain("--shadow-1:0 1px 2px rgb(var(--shadow-rgb) / ");
    expect(serializeThemeVariant(base)).toContain("--surface-glass:rgba(");
  });
});
