/**
 * The two exported color utilities, against WCAG golden vectors and their
 * documented failure modes.
 *
 * Before this file existed neither function had a direct test, and both
 * answered garbage for every non-hex input: `contrastRatio(rgba, ...)` returned
 * `NaN` (which compares `false` against every threshold, so a caller read
 * "fails contrast" instead of "unsupported input"), `mixColors` returned
 * `"#NaNNaNNaN"` (a value a browser drops with no console message), and a fully
 * transparent `#00000000` scored a plausible, maximal, wrong 21:1.
 */
import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  contrastRatioOf,
  mixChannels,
  mixColors,
  type Rgb,
  SOFT_TINT_AMOUNT,
  themeRegistry,
} from "../src/index.ts";
import { PAINTED_PAIRS, ratioFor } from "./paintedPairs.ts";

describe("contrastRatio", () => {
  test("matches the WCAG anchors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#ffffff", "#000000")).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#808080", "#ffffff")).toBeCloseTo(3.9494, 4);
  });

  test("reads #rgb and #rrggbb as the same color", () => {
    expect(contrastRatio("#fff", "#000")).toBe(contrastRatio("#ffffff", "#000000"));
    expect(contrastRatio("#abc", "#123")).toBe(contrastRatio("#aabbcc", "#112233"));
  });

  test("accepts #rrggbbaa only when it is opaque", () => {
    expect(contrastRatio("#000000ff", "#ffffff")).toBe(21);
    expect(() => contrastRatio("#00000000", "#ffffff")).toThrow(/opaque foreground/);
    expect(() => contrastRatio("#ffffff", "#00000080")).toThrow(/opaque background/);
  });

  test("names the offending value instead of returning NaN", () => {
    const border = themeRegistry.paper!.dark.border;
    expect(border).toStartWith("rgba(");
    expect(() => contrastRatio(border, themeRegistry.paper!.dark.bg)).toThrow(TypeError);
    expect(() => contrastRatio(border, "#ffffff")).toThrow(border);
    for (const bad of ["red", "", "#1234", "#12345", "#123456789", "ffffff", " #ffffff", "#ffffff "]) {
      expect(() => contrastRatio(bad, "#ffffff"), bad).toThrow(TypeError);
    }
  });

  test("does not truncate an over-long hex to a plausible answer", () => {
    // "#123456789".slice(0, 6) used to score as "#123456".
    expect(() => contrastRatio("#123456789", "#ffffff")).toThrow(TypeError);
  });
});

describe("mixColors", () => {
  test("is identity at the endpoints and the midpoint of a known pair", () => {
    expect(mixColors("#ffffff", "#000000", 1)).toBe("#ffffff");
    expect(mixColors("#ffffff", "#000000", 0)).toBe("#000000");
    expect(mixColors("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(mixColors("#fff", "#000", 0.5)).toBe("#808080");
  });

  test("drops alpha on its inputs, as documented", () => {
    expect(mixColors("#ffffff00", "#000000", 0.5)).toBe(mixColors("#ffffff", "#000000", 0.5));
  });

  test("rejects a non-hex color and an out-of-range amount", () => {
    expect(() => mixColors("red", "#ffffff", 0.5)).toThrow(/received "red"/);
    expect(() => mixColors("rgba(0,0,0,0.5)", "#ffffff", 0.5)).toThrow(TypeError);
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2, 1.0001]) {
      expect(() => mixColors("#ffffff", "#000000", amount), String(amount)).toThrow(/finite fraction from 0 to 1/);
    }
  });
});

describe("contrastRatioOf", () => {
  test("scores parsed channels the same way contrastRatio scores hex", () => {
    expect(contrastRatioOf([0, 0, 0], [255, 255, 255])).toBe(21);
    expect(contrastRatioOf([255, 255, 255], [255, 255, 255])).toBe(1);
    // Unrounded channels are the point of the pair form: an exact 50% gray is
    // 3.9767 against white, while the `#808080` the hex form rounds it to is
    // 3.9494. Half a channel of rounding moves the third decimal.
    expect(contrastRatioOf([255, 255, 255], [127.5, 127.5, 127.5])).toBeCloseTo(3.9767, 4);
    expect(contrastRatio("#ffffff", "#808080")).toBeCloseTo(3.9494, 4);
  });

  test("rejects channels no color can have instead of answering NaN or 31:1", () => {
    // The public pair form takes numbers, not strings, so its parser cannot
    // catch these. Before it validated, `[Number.NaN, 0, 0]` scored `NaN`,
    // `[Number.POSITIVE_INFINITY, 0, 0]` scored `Infinity`, and `[-255, 0, 0]`
    // against white scored 31.3013 -- outside the documented 1-to-21 range, and
    // the same plausible-wrong-answer class the hex parser was hardened against.
    const white: Rgb = [255, 255, 255];
    for (const bad of [[Number.NaN, 0, 0], [Number.POSITIVE_INFINITY, 0, 0], [-255, 0, 0], [0, 256, 0]] as const) {
      expect(() => contrastRatioOf(bad, white), JSON.stringify(bad)).toThrow(/finite 0-255 foreground channels/);
      expect(() => contrastRatioOf(white, bad), JSON.stringify(bad)).toThrow(/finite 0-255 background channels/);
    }
    expect(() => contrastRatioOf([Number.NaN, 0, 0], white)).toThrow(TypeError);
    expect(() => contrastRatioOf([0, 0] as unknown as Rgb, white)).toThrow(/received \[0,0\]/);
    expect(() => contrastRatioOf("#ffffff" as unknown as Rgb, white)).toThrow(TypeError);
  });

  for (const [label, channels] of [
    ["fully sparse", new Array<number>(3)],
    ["missing red", [, 0, 0]],
    ["missing green", [0, , 0]],
    ["missing blue", [0, 0, ,]],
  ] as const) {
    for (const role of ["foreground", "background"] as const) {
      test(`rejects ${label} ${role} channels`, () => {
        const sparse = channels as unknown as Rgb;
        const white: Rgb = [255, 255, 255];
        const score = () => role === "foreground"
          ? contrastRatioOf(sparse, white)
          : contrastRatioOf(white, sparse);
        expect(score).toThrow(TypeError);
        expect(score).toThrow(
          `contrastRatioOf needs three finite 0-255 ${role} channels, received ${JSON.stringify(channels)}`,
        );
      });
    }
  }

  test("keeps every answer inside the WCAG range", () => {
    for (const pair of PAINTED_PAIRS) {
      for (const theme of Object.values(themeRegistry)) {
        for (const variant of [theme.light, theme.dark]) {
          const ratio = ratioFor(pair, variant);
          expect(ratio, pair.label).toBeGreaterThanOrEqual(1);
          expect(ratio, pair.label).toBeLessThanOrEqual(21);
        }
      }
    }
  });
});

describe("mixChannels", () => {
  test("returns the exact channels the browser computes, not the rounded hex", () => {
    const exact = mixChannels("#64bc9d", "#2f333c", 0.12);
    expect(exact).toEqual([53.36, 67.44, 71.64]);
    expect(mixColors("#64bc9d", "#2f333c", 0.12)).toBe("#354348");
  });

  test("exposes the rounding gap that hid one dark --success below AA", () => {
    // This is the 12% recipe the package shipped before `SOFT_TINT_AMOUNT` was
    // lowered to 10%. The vector stays because the generator's own ratchet still
    // runs at percentages where rounding decides the verdict.
    const one = themeRegistry.paper.dark;
    const exact = contrastRatioOf(
      [0x64, 0xbc, 0x9d],
      mixChannels("#64bc9d", "#2f333c", 0.12),
    );
    const rounded = contrastRatio("#64bc9d", mixColors("#64bc9d", "#2f333c", 0.12));
    // The shipped recipe, scored the same exact way. `amount: 1` is the pure
    // foreground: `rgbChannels` is internal, so the barrel reaches it through
    // a full-strength mix.
    const shippedExact = contrastRatioOf(
      mixChannels(one.success, one.surface, 1),
      mixChannels(one.success, one.surface, SOFT_TINT_AMOUNT),
    );
    expect(exact).toBeLessThan(4.5);
    expect(rounded).toBeGreaterThan(4.5);
    expect(rounded - exact).toBeGreaterThan(0.02);
    expect(shippedExact).toBeGreaterThan(4.5);
  });
});
