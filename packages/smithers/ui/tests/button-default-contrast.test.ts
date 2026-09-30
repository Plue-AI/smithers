// The default Button paints brand-colored text on a brand tint. Text contrast is
// only audited up to SOFT_TINT_AMOUNT, so every interactive state has to stay
// at or under it in every shipped palette. Ratios are computed with the
// styleguide's exact-channel relative-luminance formula, not estimated.
import { describe, expect, test } from "bun:test";
import { contrastRatioOf, mixChannels, themeRegistry } from "@smthrs/ui-styleguide";
import { rgbChannels as rgbChannelsOf } from "../ui-styleguide/src/rgbChannels";
import { buttonCss } from "../src/uiCss";
import { tokens as t } from "../src/tokens";

const AA_MINIMUM = 4.5;
const SOFT_TINT_PERCENT = 10;

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, "m").exec(buttonCss);
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1]!;
}

/** The brand percentage of the rule's `background: color-mix(in srgb, <primary> N%, <card>)`. */
function brandTintPercent(selector: string): number {
  const body = ruleBody(selector);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`background:color-mix\\(in srgb, ${escape(t.primary)} ([\\d.]+)%, ${escape(t.card)}\\)`).exec(body);
  if (!match) throw new Error(`no brand tint background in ${selector}: ${body}`);
  return Number(match[1]);
}

const STATES = [".sui-button-default", ".sui-button-default:hover", ".sui-button-default:active:not(:disabled)"] as const;

describe("default Button text contrast", () => {
  test("text is the brand color and every state tints brand over the card surface", () => {
    expect(ruleBody(".sui-button-default")).toContain(`color:${t.primary};`);
    for (const state of STATES) expect(brandTintPercent(state)).toBeGreaterThan(0);
  });

  test.each(STATES)("%s never exceeds the audited soft tint", (state) => {
    expect(brandTintPercent(state)).toBeLessThanOrEqual(SOFT_TINT_PERCENT);
  });

  const cases = Object.entries(themeRegistry).flatMap(([key, theme]) =>
    (["light", "dark"] as const).flatMap((mode) => STATES.map((state) => [key, mode, state] as const)),
  );

  test.each(cases)("%s %s %s keeps brand text at or above 4.5:1", (key, mode, state) => {
    const variant = themeRegistry[key as keyof typeof themeRegistry][mode];
    const background = mixChannels(variant.brand, variant.surface, brandTintPercent(state) / 100);
    const ratio = contrastRatioOf(rgbChannelsOf(variant.brand), background);
    expect(ratio).toBeGreaterThanOrEqual(AA_MINIMUM);
  });

  test("hover and press remain distinguishable from rest without a stronger fill", () => {
    expect(ruleBody(".sui-button-default:hover")).toContain("border-color:");
    expect(ruleBody(".sui-button-default:active:not(:disabled)")).toContain("box-shadow:inset");
  });
});
