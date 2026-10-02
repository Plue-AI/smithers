---
title: "Audit a color pair"
description: "Score a new foreground and background pair across both shipped variants with the package's own contrast math, and record it so the suite keeps checking it."
sidebar:
  order: 5
---

You added a rule that paints a color on a background. Before it ships, it has to
clear 4.5:1 in both Paper modes. Here is how to find out, and how
to make the check permanent.

## Score one pair

For two opaque hex colors, `contrastRatio` is the whole answer:

```ts
import { contrastRatio } from "@smthrs/ui-styleguide"

contrastRatio("#403f53", "#FBFBFB") // 9.8805
```

It returns the WCAG 2.x ratio from 1 to 21, and both arguments must be opaque
`#rgb`, `#rrggbb`, or `#rrggbbaa` with `aa` equal to `ff`. A translucent color
throws instead of scoring the dropped alpha, because `#00000000` on white is not
21:1; it is whatever the invisible text sits on. Composite first.

## Score a tint

A tinted fill is a `color-mix`, and a browser evaluates it in floating point.
`mixColors` rounds each channel to an integer, which is enough to change a
verdict: the 12 percent `one` dark `--success` tint scored 4.5033 rounded and
4.4781 as rendered. Use `mixChannels` and `contrastRatioOf`, which work in
unrounded channels end to end:

```ts
import { contrastRatioOf, mixChannels, SOFT_TINT_AMOUNT, themeRegistry } from "@smthrs/ui-styleguide"
import type { Rgb } from "@smthrs/ui-styleguide"

const AA_MINIMUM = 4.5

/** Exact 0-255 channels of a hex token. mixChannels is identity at amount 1. */
const channels = (hex: string): Rgb => mixChannels(hex, hex, 1)

for (const [key, theme] of Object.entries(themeRegistry)) {
  for (const mode of ["light", "dark"] as const) {
    const variant = theme[mode]
    const ratio = contrastRatioOf(
      channels(variant.info),
      mixChannels(variant.info, variant.surface, SOFT_TINT_AMOUNT)
    )
    const verdict = ratio >= AA_MINIMUM ? "pass" : "FAIL"
    console.log(`${verdict} ${key}/${mode} info on info-soft ${ratio.toFixed(4)}`)
  }
}
```

```text
pass paper/light info on info-soft 5.2547
pass paper/dark info on info-soft 5.8572
```

Keep the audited 10 percent tint recipe and check any new host colors.

## Score the fill you actually paint

The background to score is the **resolved** fill for the state, not the first
declaration that mentions one. `.primary:hover` matches the generic
`.button:hover` rule as well as its own, so the pair a browser paints depends on
which rule wins. The package's own audit resolves the sheet rule by rule for
exactly this reason. Do not trust a background you read off a single
declaration.

Two cases need work before you can score them at all:

- **A translucent token** such as `--surface-glass-strong` or `--border` is
  `rgba(...)`. Composite it over what is behind it, then score the composite.
  [The audited pair table](https://github.com/smithersai/smithers/blob/main/packages/smithers/ui/ui-styleguide/tests/paintedPairs.ts)
  has `rgbaOver` for this.
- **A `backdrop-filter` background** is the filtered backdrop, not the raw one.
  `saturate(180%)` changes the pixels under the text; `blur()` over a uniform
  background does not. The topbar is measured on both paths.

## Keep the check

A one-off script proves the pair today. Move it into your own test suite and it
proves the pair on every change, including changes to your own tokens:

```ts
import { contrastRatioOf, mixChannels, SOFT_TINT_AMOUNT, themeRegistry } from "@smthrs/ui-styleguide"
import type { Rgb } from "@smthrs/ui-styleguide"

const AA_MINIMUM = 4.5
const channels = (hex: string): Rgb => mixChannels(hex, hex, 1)

/** Every variant in which info text on an info tint misses AA. */
export function infoOnInfoSoftFailures(): readonly string[] {
  const failures: string[] = []
  for (const [key, theme] of Object.entries(themeRegistry)) {
    for (const mode of ["light", "dark"] as const) {
      const variant = theme[mode]
      const ratio = contrastRatioOf(
        channels(variant.info),
        mixChannels(variant.info, variant.surface, SOFT_TINT_AMOUNT)
      )
      if (ratio < AA_MINIMUM) failures.push(`${key}/${mode} ${ratio.toFixed(4)}`)
    }
  }
  return failures
}
```

Assert that the array is empty. The failures carry their palette, mode, and
ratio, so a red test names the variant rather than sending you back to the
script.

That is the shape of the package's own audit, scaled up: a table of pairs, each
scored in every palette and every mode, so one row becomes 16 assertions. See
[The contrast budget](../concepts/contrast-budget.md) for what the shipped table
covers.

## When a pair fails

A rule of your own that fails is a rule to change. Lower the tint percentage,
pick a different token for the foreground, or drop the tint and paint on a plain
surface.

The one case that is not yours to fix is a failure that traces to a palette
value the package inherits from upstream. Those are recorded by name with the
ratio each one scores, and the suite asserts they still fail at that number, so
an exemption cannot outlive the defect. See
[Where the palettes come from](../concepts/palette-sources.md).

## Related

- [The contrast budget](../concepts/contrast-budget.md): what the table covers
  and what the sheet forbids.
- [API reference](../api.md): every signature and the errors each function
  throws.
