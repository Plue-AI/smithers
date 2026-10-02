import { describe, expect, test } from "bun:test";
import { contrastRatioOf, mixChannels, contrastRatio, DEFAULT_THEME_KEY, themeRegistry } from "../src/index.ts";
import {
  AA_MINIMUM,
  KNOWN_ROLE_COLLISIONS,
  KNOWN_TERMINAL_GAPS,
  PAINTED_PAIRS,
  ratioFor,
  SEMANTICS,
  TEXT_RAMP,
} from "./paintedPairs.ts";

const SHIKI_IDS = new Set([
  "night-owl",
  "night-owl-light",
  "github-dark",
  "github-light",
  "one-dark-pro",
  "one-light",
  "catppuccin-mocha",
  "catppuccin-latte",
  "solarized-dark",
  "solarized-light",
  "gruvbox-dark-medium",
  "gruvbox-light-medium",
  "rose-pine",
  "rose-pine-dawn",
]);

const variants = Object.entries(themeRegistry).flatMap(([key, theme]) =>
  (["light", "dark"] as const).map((mode) => ({ key, mode, variant: theme[mode] }))
);

describe("theme registry", () => {
  test("Paper is the only active palette", () => {
    expect(DEFAULT_THEME_KEY).toBe("paper");
    expect(Object.keys(themeRegistry)).toEqual(["paper"]);
  });

  test("every record has complete matching variants and bundled Shiki ids", () => {
    const keys = Object.keys(themeRegistry[DEFAULT_THEME_KEY]!.light).sort();
    for (const [key, theme] of Object.entries(themeRegistry)) {
      expect(theme.key).toBe(key);
      expect(Object.keys(theme.light).sort()).toEqual(keys);
      expect(Object.keys(theme.dark).sort()).toEqual(keys);
      expect(Object.keys(theme.terminal.light).sort()).toEqual(
        Object.keys(themeRegistry[DEFAULT_THEME_KEY]!.terminal.light).sort(),
      );
      expect(Object.keys(theme.terminal.dark).sort()).toEqual(
        Object.keys(themeRegistry[DEFAULT_THEME_KEY]!.terminal.dark).sort(),
      );
      expect(SHIKI_IDS.has(theme.syntax.shikiDark)).toBe(true);
      expect(SHIKI_IDS.has(theme.syntax.shikiLight)).toBe(true);
    }
  });

  test("is deeply frozen, so both CSS emitters answer from one snapshot", () => {
    expect(Object.isFrozen(themeRegistry)).toBe(true);
    for (const { variant } of variants) expect(Object.isFrozen(variant)).toBe(true);
    for (const theme of Object.values(themeRegistry)) {
      expect(Object.isFrozen(theme)).toBe(true);
      expect(Object.isFrozen(theme.terminal)).toBe(true);
      expect(Object.isFrozen(theme.terminal.dark)).toBe(true);
    }
    const target = themeRegistry[DEFAULT_THEME_KEY]!.light;
    const before = target.bg;
    expect(() => {
      (target as { bg: string }).bg = "#123456";
    }).toThrow(TypeError);
    expect(themeRegistry[DEFAULT_THEME_KEY]!.light.bg).toBe(before);
  });
});

describe("WCAG AA on every pair the stylesheets paint", () => {
  for (const { key, mode, variant } of variants) {
    for (const pair of PAINTED_PAIRS) {
      test(`${key}/${mode}/${pair.label} meets AA`, () => {
        expect(ratioFor(pair, variant)).toBeGreaterThanOrEqual(AA_MINIMUM);
      });
    }
  }

  test("every terminal palette is legible on its own background", () => {
    for (const [key, theme] of Object.entries(themeRegistry)) {
      for (const mode of ["light", "dark"] as const) {
        const palette = theme.terminal[mode];
        const ratio = contrastRatio(palette.foreground, palette.background);
        const known = KNOWN_TERMINAL_GAPS.get(`${key}/${mode}`);
        if (known === undefined) expect(ratio, `${key}/${mode} terminal`).toBeGreaterThanOrEqual(AA_MINIMUM);
        else {
          expect(ratio, `${key}/${mode} terminal`).toBeLessThan(AA_MINIMUM);
          expect(ratio, `${key}/${mode} terminal`).toBeCloseTo(known, 3);
        }
      }
    }
  });
});

describe("theme vocabulary", () => {
  test("keeps every semantic role pairwise distinct", () => {
    for (const { key, mode, variant } of variants) {
      for (let i = 0; i < SEMANTICS.length; i++) {
        for (let j = i + 1; j < SEMANTICS.length; j++) {
          const [a, b] = [SEMANTICS[i]!, SEMANTICS[j]!];
          const id = `${key}/${mode}/${a}=${b}`;
          const same = variant[a].toLowerCase() === variant[b].toLowerCase();
          expect(same, `${id} (${variant[a]} vs ${variant[b]})`).toBe(KNOWN_ROLE_COLLISIONS.has(id));
        }
      }
    }
  });

  test("every recorded gap names a variant that still exists", () => {
    const ids = new Set(variants.map(({ key, mode }) => `${key}/${mode}`));
    const validRoleIds = new Set<string>();
    for (const { key, mode } of variants) {
      for (let i = 0; i < SEMANTICS.length; i++) {
        for (let j = i + 1; j < SEMANTICS.length; j++) {
          validRoleIds.add(`${key}/${mode}/${SEMANTICS[i]!}=${SEMANTICS[j]!}`);
        }
      }
    }
    for (const id of KNOWN_TERMINAL_GAPS.keys()) expect(ids.has(id), id).toBe(true);
    for (const id of KNOWN_ROLE_COLLISIONS) expect(validRoleIds.has(id), id).toBe(true);
  });

  test("grades the secondary text ramp with a strict step, not a flat line", () => {
    for (const { key, mode, variant } of variants) {
      for (let i = 0; i + 1 < TEXT_RAMP.length; i++) {
        const [stronger, weaker] = [TEXT_RAMP[i]!, TEXT_RAMP[i + 1]!];
        const id = `${key}/${mode}/${stronger} > ${weaker}`;
        const graded = contrastRatio(variant[stronger], variant.bg) > contrastRatio(variant[weaker], variant.bg);
        expect(graded, id).toBe(true);
      }
    }
  });

  test("keeps the surface elevation ramp ordered in both modes", () => {
    const luminanceAgainstBlack = (color: string) => contrastRatio(color, "#000000");
    for (const theme of Object.values(themeRegistry)) {
      expect(luminanceAgainstBlack(theme.light.surface)).toBeGreaterThanOrEqual(luminanceAgainstBlack(theme.light.bg));
      expect(luminanceAgainstBlack(theme.light.surface2)).toBeLessThan(luminanceAgainstBlack(theme.light.surface));
      expect(luminanceAgainstBlack(theme.light.surface3)).toBeGreaterThanOrEqual(
        luminanceAgainstBlack(theme.light.surface),
      );
      expect(luminanceAgainstBlack(theme.dark.surface)).toBeGreaterThan(luminanceAgainstBlack(theme.dark.bg));
      expect(luminanceAgainstBlack(theme.dark.surface2)).toBeGreaterThan(luminanceAgainstBlack(theme.dark.surface));
      expect(luminanceAgainstBlack(theme.dark.surface3)).toBeGreaterThan(luminanceAgainstBlack(theme.dark.surface2));
    }
    expect(luminanceAgainstBlack(themeRegistry[DEFAULT_THEME_KEY]!.light.surface)).toBeGreaterThan(
      luminanceAgainstBlack(themeRegistry[DEFAULT_THEME_KEY]!.light.bg),
    );
  });


});
