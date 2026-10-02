/**
 * What a document resolves to once a palette and a mode are selected.
 *
 * The selector tests in `index.test.ts` pass for any declarations at all:
 * swapping `serializeThemeVariant(theme.dark)` for `theme.light` in either
 * non-default dark rule of `paletteThemeCss` keeps every selector, every source
 * order, and the single font block intact while breaking dark mode for all
 * seven selected palettes. Nothing else closes that gap --
 * `standaloneThemeCss.test.ts` extracts only the default light and dark blocks,
 * `themeRegistry.test.ts` scores registry objects rather than emitted rules,
 * and `cascade.test.ts` filters `:root` and `@media` rules out on purpose.
 *
 * So this suite runs the cascade instead of reading it. For every palette (plus
 * an absent and an unregistered key), every `data-theme` value (plus absent),
 * and both system preferences, it resolves the emitted token rules the way a
 * browser would and compares every winning declaration against
 * `serializeThemeVariant` of the registry variant that state must select.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_THEME_KEY,
  findTheme,
  serializeThemeVariant,
  standaloneThemeCss,
  themeCss,
  themeRegistry,
  workflowUiThemeCss,
} from "../src/index.ts";

type RegisteredTheme = (typeof themeRegistry)[keyof typeof themeRegistry];

/** One selection state a browser can be in: the two attributes plus the OS preference. */
type State = {
  readonly palette: string | undefined;
  readonly mode: "light" | "dark" | undefined;
  readonly system: "light" | "dark";
};

/** One emitted token rule, with the media feature it is nested in, if any. */
type TokenRule = {
  readonly selector: string;
  readonly declarations: string;
  readonly media: "light" | "dark" | undefined;
  readonly order: number;
};

const ROOT_RULE = /^(:root[^{]*?)\s*\{\s*(.*?)\s*\}$/;
const MEDIA_RULE = /^@media \(prefers-color-scheme: (light|dark)\) \{\s*(:root[^{]*?)\s*\{\s*(.*?)\s*\}\s*\}$/;

/**
 * Every `:root` token rule in `css`, in source order.
 *
 * The emitter writes one rule per line, so the line index is the source order
 * the cascade breaks specificity ties with. Component rules, the body block and
 * the reduced-motion policy declare no custom properties and are skipped.
 */
function tokenRules(css: string): TokenRule[] {
  return css.split("\n").flatMap((line, order): TokenRule[] => {
    const media = MEDIA_RULE.exec(line);
    if (media !== null) {
      return [{ selector: media[2]!, declarations: media[3]!, media: media[1]! as "light" | "dark", order }];
    }
    const root = ROOT_RULE.exec(line);
    if (root !== null) return [{ selector: root[1]!, declarations: root[2]!, media: undefined, order }];
    return [];
  });
}

const SELECTOR_PART = /:not\([^)]*\)|\[[^\]]*\]|:[\w-]+/g;

/** True when `selector` applies to `state`. */
function matchesSelector(selector: string, state: State): boolean {
  const parts = selector.trim().match(SELECTOR_PART) ?? [];
  if (parts.length === 0) throw new Error(`unparsed selector ${JSON.stringify(selector)}`);
  return parts.every((part) => {
    if (part.startsWith(":not(")) return !matchesSelector(part.slice(5, -1), state);
    if (part.startsWith("[")) {
      const attribute = /^\[data-([\w-]+)=(["'])([^"']*)\2\]$/.exec(part);
      if (attribute === null) throw new Error(`unparsed attribute selector ${part}`);
      if (attribute[1] === "palette") return state.palette === attribute[3];
      if (attribute[1] === "theme") return state.mode === attribute[3];
      throw new Error(`unknown attribute selector ${part}`);
    }
    if (part === ":root") return true;
    throw new Error(`unparsed selector part ${part}`);
  });
}

/** The (0,b,0) half of CSS specificity: `:root` plus every attribute, `:not()` counting its argument. */
function specificity(selector: string): number {
  const parts = selector.trim().match(SELECTOR_PART) ?? [];
  return parts.reduce(
    (total, part) => total + (part.startsWith(":not(") ? specificity(part.slice(5, -1)) : 1),
    0,
  );
}

/** The `property:value` pairs of one declaration block. No token value may contain `;`. */
function declarations(block: string): Map<string, string> {
  return new Map(
    block.split(";").flatMap((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon === -1) return [];
      return [[declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()] as const];
    }),
  );
}

/** Every property `css` resolves to for `state`, by specificity then source order. */
function resolveTokens(css: string, state: State): Map<string, string> {
  const applicable = tokenRules(css)
    .flatMap((rule) => rule.selector.split(",").map((selector) => ({ ...rule, selector: selector.trim() })))
    .filter((rule) => (rule.media ?? state.system) === state.system && matchesSelector(rule.selector, state))
    .map((rule) => ({ rule, score: specificity(rule.selector) }))
    .sort((left, right) => left.score - right.score || left.rule.order - right.rule.order);
  const resolved = new Map<string, string>();
  for (const { rule } of applicable) {
    for (const [property, value] of declarations(rule.declarations)) resolved.set(property, value);
  }
  return resolved;
}

/**
 * The theme `palette` selects in `css`.
 *
 * A key the sheet did not emit rules for -- unregistered, or trimmed out of a
 * subset -- selects nothing, so the default palette's rules keep winning.
 */
function selectedTheme(css: string, palette: string | undefined): RegisteredTheme {
  const theme = palette === undefined ? undefined : findTheme(palette);
  const emitted = palette !== undefined
    && (css.includes(`[data-palette='${palette}']`) || css.includes(`[data-palette="${palette}"]`));
  return emitted && theme !== undefined ? theme : themeRegistry[DEFAULT_THEME_KEY];
}

/** An explicit `data-theme` wins over the system preference; absent falls back to it. */
function expectedVariant(theme: RegisteredTheme, state: State) {
  return (state.mode ?? state.system) === "dark" ? theme.dark : theme.light;
}

function describeState(state: State): string {
  return `palette=${state.palette ?? "(absent)"} data-theme=${state.mode ?? "(absent)"} system=${state.system}`;
}

const MODES = ["light", "dark", undefined] as const;
const SYSTEMS = ["light", "dark"] as const;
const PALETTE_KEYS = Object.keys(themeRegistry);
/** Every registered key, plus a document that selects none and one that names an unregistered palette. */
const PALETTES: readonly (string | undefined)[] = [...PALETTE_KEYS, undefined, "dracula"];

function statesFor(palette: string | undefined): State[] {
  return MODES.flatMap((mode) => SYSTEMS.map((system) => ({ palette, mode, system })));
}

const ALL_STATES = PALETTES.flatMap(statesFor);

/** Every per-variant declaration `state` resolves to equals the variant the registry holds. */
function expectSelectedVariant(css: string, state: State): void {
  const expected = declarations(serializeThemeVariant(expectedVariant(selectedTheme(css, state.palette), state)));
  expect(expected.size, "serialized variant").toBeGreaterThan(20);
  const resolved = resolveTokens(css, state);
  const actual = [...expected.keys()].map((property) => [property, resolved.get(property)] as const);
  expect(Object.fromEntries(actual), describeState(state)).toEqual(Object.fromEntries(expected));
}

const ENTRY_POINTS = [
  { name: "workflowUiThemeCss", css: workflowUiThemeCss },
  { name: "standaloneThemeCss", css: standaloneThemeCss() },
] as const;

describe("documented per-axis bridge", () => {
  const guide = readFileSync(new URL("../docs/guides/override-a-token.md", import.meta.url), "utf8");
  const bridge = /export const houseBridgeCss = `([^`]+)`/.exec(guide)?.[1];
  if (bridge === undefined) throw new Error("missing documented houseBridgeCss example");
  // The guide uses multiline blocks; the emitter and resolver use one rule per line.
  const css = `${themeCss()}\n${bridge.trim().replace(/\s+/g, " ").replace(/}\s*(?=@media|:root)/g, "}\n")}`;
  const expected = {
    "--bg": "var(--house-background)",
    "--text": "var(--house-foreground)",
    "--surface": "var(--house-surface-raised)",
    "--brand": "var(--house-accent)",
    "--font-sans": "var(--house-font-ui)",
    "--r-2": "var(--house-radius-md)",
  };

  for (const state of statesFor(undefined)) {
    test(`keeps the bridge values with ${describeState(state)}`, () => {
      const resolved = resolveTokens(css, state);
      expect(Object.fromEntries(Object.keys(expected).map((key) => [key, resolved.get(key)]))).toEqual(expected);
    });
  }
});

for (const entry of ENTRY_POINTS) {
  describe(`${entry.name} palette selection`, () => {
    test("parses the three token rules every palette emits, and no others", () => {
      const rules = tokenRules(entry.css);
      expect(rules).toHaveLength(PALETTE_KEYS.length * 3);
      for (const rule of rules) {
        expect(declarations(rule.declarations).size, rule.selector).toBeGreaterThan(20);
        // A rule no enumerated state reaches would let the table below pass
        // while the browser painted something the table never resolved.
        expect(
          ALL_STATES.some((state) => (rule.media ?? state.system) === state.system && matchesSelector(rule.selector, state)),
          rule.selector,
        ).toBe(true);
      }
    });

    for (const palette of PALETTES) {
      test(`resolves ${palette ?? "no palette"} to its registry variant in every mode`, () => {
        for (const state of statesFor(palette)) expectSelectedVariant(entry.css, state);
      });
    }

    test("keeps the theme-invariant tokens under every selection", () => {
      for (const state of ALL_STATES) {
        const resolved = resolveTokens(entry.css, state);
        const label = describeState(state);
        expect(resolved.get("--font-sans"), label).toStartWith("Inter,");
        expect(resolved.get("--font-mono"), label).toStartWith("ui-monospace,");
        expect(resolved.get("--panel"), label).toBe("var(--surface)");
        expect(resolved.get("--sp-1"), label).toBe("4px");
      }
    });

    test("lets a consumer's own :root font override win under every selection", () => {
      // The palette rules are (0,2,0) and would out-rank a consumer's bare
      // `:root`, so the font block rides only on the (0,1,0) base rule that the
      // consumer's later, equally specific rule replaces.
      const withOverride = `${entry.css}\n:root { --font-sans:ConsumerSans; }`;
      for (const state of ALL_STATES) {
        expect(resolveTokens(withOverride, state).get("--font-sans"), describeState(state)).toBe("ConsumerSans");
        expectSelectedVariant(withOverride, state);
      }
    });
  });
}

describe("subset sheets", () => {
  test("resolves the pinned palette and falls back to the default for the rest", () => {
    const pinned = themeCss({ palettes: ["paper"] });
    for (const palette of PALETTES) {
      for (const state of statesFor(palette)) expectSelectedVariant(pinned, state);
    }
    expect(tokenRules(pinned)).toHaveLength(3);
  });

  test("keeps the default palette answering every selection when no palette is requested", () => {
    const defaultsOnly = themeCss({ palettes: [] });
    expect(tokenRules(defaultsOnly)).toHaveLength(3);
    for (const state of ALL_STATES) {
      expectSelectedVariant(defaultsOnly, state);
      const expected = expectedVariant(themeRegistry[DEFAULT_THEME_KEY], state);
      expect(resolveTokens(defaultsOnly, state).get("--bg"), describeState(state)).toBe(expected.bg);
    }
  });
});
