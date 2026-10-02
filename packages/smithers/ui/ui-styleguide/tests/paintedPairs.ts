/**
 * Every (foreground, background) pair the shipped stylesheets actually paint,
 * measured at WCAG AA for every selectable palette.
 *
 * The package's central claim is that any `data-palette` a user can select is
 * accessible. Proving that needs a table, not a spot check: the previous suite
 * asserted three pairs behind a per-key `continue` and an `if` guard that
 * skipped precisely when the primary foreground was the thing failing, so no
 * assertion in it could fail.
 *
 * Backgrounds are resolved to exact unrounded channels. `mixColors` rounds each
 * channel to an integer; a browser evaluating `color-mix(in srgb, ...)` does
 * not, and at least one shipped pair (`one` dark `--success` on its own soft
 * tint) sits in the gap between the two.
 */
import { contrastRatioOf, type Rgb } from "../src/contrastRatio.ts";
import { mixChannels } from "../src/mixColors.ts";
import { rgbChannels } from "../src/rgbChannels.ts";
import type { ThemeVariantTokens } from "../src/ThemeVariantTokens.ts";
import { SOFT_TINT_AMOUNT } from "../src/themeTokens.ts";

/** WCAG AA for normal-size text. The sheet's type scale tops out at 24px bold nowhere near the large-text exemption for body copy. */
export const AA_MINIMUM = 4.5;

/** The four surface tokens `ThemeVariantTokens` documents as interchangeable elevations. */
const SURFACES = ["bg", "surface", "surface2", "surface3"] as const;

/** The graded foreground ramp, most to least prominent. */
export const TEXT_RAMP = ["text", "textMuted", "textFaint", "textPlaceholder"] as const;

const SEMANTICS = ["brand", "success", "danger", "warning", "info"] as const;

/** Composite an `rgba(...)` token over an already-resolved background. */
function rgbaOver(color: string, background: Rgb): Rgb {
  const parsed = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color);
  if (parsed === null) throw new TypeError(`expected an rgb()/rgba() token, received ${JSON.stringify(color)}`);
  const alpha = parsed[4] === undefined ? 1 : Number(parsed[4]);
  const channels = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])] as const;
  return channels.map((channel, index) => channel * alpha + background[index]! * (1 - alpha)) as unknown as Rgb;
}

/** The `saturate()` amount in the topbar's `backdrop-filter`. */
const TOPBAR_SATURATION = 1.8;

/** Foregrounds the topbar carries: the text ramp plus brand-colored pills. */
const TOPBAR_FOREGROUNDS = ["text", "textMuted", "textFaint", "textPlaceholder", "brand"] as const;

/**
 * The Filter Effects `saturate(s)` color matrix, applied in sRGB.
 *
 * `backdrop-filter` filters the backdrop before the element's own translucent
 * background composites over it, so a saturated backdrop is what the pixels
 * under the topbar text actually are.
 */
function saturate(channels: Rgb, s: number): Rgb {
  const [r, g, b] = channels;
  const out = [
    (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  ];
  return out.map((channel) => Math.min(255, Math.max(0, channel))) as unknown as Rgb;
}

/** One audited pair: a label a failure can be read from, and both resolved colors. */
export type PaintedPair = {
  readonly label: string;
  readonly foreground: (variant: ThemeVariantTokens) => Rgb;
  readonly background: (variant: ThemeVariantTokens) => Rgb;
};

/**
 * The table. Each entry names the rule in `src/index.ts` or
 * `src/standaloneThemeCss.ts` that paints it, so an entry can be retired when
 * its rule goes away and a new rule can be checked against the list.
 *
 * Backgrounds are the RESOLVED fill for the state, not the first declaration
 * that mentions it. `.primary:hover` matches the generic `.button:hover` rule
 * too, so the tinted states restate their own `background`; if that ever stops
 * being true, the resolved pair is `brand` on `--hover`, which is not here.
 */
export const PAINTED_PAIRS: readonly PaintedPair[] = [
  // body/h1-h3 (`--text`), p/.muted/.meta/.section-head/.label/.table th
  // (`--muted`), and input::placeholder (`--text-placeholder`), on every
  // surface elevation a consumer may place them on.
  ...TEXT_RAMP.flatMap((token) =>
    SURFACES.map((surface): PaintedPair => ({
      label: `${token} on ${surface}`,
      foreground: (variant) => rgbChannels(variant[token]),
      background: (variant) => rgbChannels(variant[surface]),
    }))
  ),
  // .button:hover, .run-row:hover, .workflow-run-row:hover
  ...(["text", "textMuted"] as const).map((token): PaintedPair => ({
    label: `${token} on hover`,
    foreground: (variant) => rgbChannels(variant[token]),
    background: (variant) => rgbChannels(variant.hover),
  })),
  // .button:active:not(:disabled)
  {
    label: "text on the neutral active fill",
    foreground: (variant) => rgbChannels(variant.text),
    background: (variant) => mixChannels(variant.text, variant.hover, 0.06),
  },
  // `.top,.topbar`: the one translucent background this sheet paints text on.
  // It sits directly on the shell, whose background is `--bg`, and carries the
  // title, meta text, and brand-colored pills.
  //
  // Two rendering paths, both audited. Without `backdrop-filter` support the
  // translucent fill composites straight onto `--bg`; with it, the backdrop is
  // filtered first. `blur(18px)` is inert over a uniform background but
  // `saturate(180%)` is not, so the live path is measured separately.
  ...TOPBAR_FOREGROUNDS.flatMap((token) => [
    {
      label: `${token} on the glass topbar over bg`,
      foreground: (variant: ThemeVariantTokens) => rgbChannels(variant[token]),
      background: (variant: ThemeVariantTokens) => rgbaOver(variant.surfaceGlassStrong, rgbChannels(variant.bg)),
    },
    {
      label: `${token} on the saturated glass topbar over bg`,
      foreground: (variant: ThemeVariantTokens) => rgbChannels(variant[token]),
      background: (variant: ThemeVariantTokens) =>
        rgbaOver(variant.surfaceGlassStrong, saturate(rgbChannels(variant.bg), TOPBAR_SATURATION)),
    },
  ]),
  // .badge.ok/.warn/.running/.info/.bad and .pill, whose text is the semantic
  // color on the matching `*-soft` tint.
  ...SEMANTICS.map((semantic): PaintedPair => ({
    label: `${semantic} on ${semantic}-soft`,
    foreground: (variant) => rgbChannels(variant[semantic]),
    background: (variant) => mixChannels(variant[semantic], variant.surface, SOFT_TINT_AMOUNT),
  })),
  // .plus/.minus, .error-text, .alert.err, and every untinted semantic label.
  ...SEMANTICS.flatMap((semantic) =>
    SURFACES.map((surface): PaintedPair => ({
      label: `${semantic} on ${surface}`,
      foreground: (variant) => rgbChannels(variant[semantic]),
      background: (variant) => rgbChannels(variant[surface]),
    }))
  ),
  // .code/.source/pre.code and .livelog + .livelog-event + .livelog-node.
  {
    label: "codeText on codeBg",
    foreground: (variant) => rgbChannels(variant.codeText),
    background: (variant) => rgbChannels(variant.codeBg),
  },
  {
    label: "brand on codeBg",
    foreground: (variant) => rgbChannels(variant.brand),
    background: (variant) => rgbChannels(variant.codeBg),
  },
  {
    label: "warning on codeBg",
    foreground: (variant) => rgbChannels(variant.warning),
    background: (variant) => rgbChannels(variant.codeBg),
  },
  // `.plus` and `.minus` are bare class selectors that set only a foreground,
  // so one inside a `.code` or `.livelog` container paints on that container's
  // `--code-bg`.
  {
    label: "success on codeBg",
    foreground: (variant) => rgbChannels(variant.success),
    background: (variant) => rgbChannels(variant.codeBg),
  },
  {
    label: "danger on codeBg",
    foreground: (variant) => rgbChannels(variant.danger),
    background: (variant) => rgbChannels(variant.codeBg),
  },
  // Inverted chrome: `--ink`, tooltips, inverse buttons.
  {
    label: "inverseText on inverseBg",
    foreground: (variant) => rgbChannels(variant.inverseText),
    background: (variant) => rgbChannels(variant.inverseBg),
  },
];

/** `contrastRatio` for one pair of one variant, from exact channels. */
export function ratioFor(pair: PaintedPair, variant: ThemeVariantTokens): number {
  return contrastRatioOf(pair.foreground(variant), pair.background(variant));
}

/**
 * Terminal palettes whose own foreground misses AA on their own background.
 * Terminal colors preserve upstream fidelity separately from the UI AA guarantee.
 */
export const KNOWN_TERMINAL_GAPS: ReadonlyMap<string, number> = new Map();

/**
 * Semantic role pairs that share one hex, as `palette/mode/<a>=<b>`.
 * `rose-pine` gives `success` and `info` the same value in both modes, so a
 * passing state and an informational state are indistinguishable.
 */
export const KNOWN_ROLE_COLLISIONS: ReadonlySet<string> = new Set();

export { SEMANTICS, SURFACES };
