---
title: "The contrast budget"
description: "Every foreground and background pair the shipped rules paint is required to meet WCAG AA across all Paper light/dark variants in both modes."
sidebar:
  order: 1
---

The package makes one central claim: every audited UI text pair in any selectable palette
meets WCAG AA at 4.5:1 or higher. Eight palettes times two modes is 16 token sets, and a person
picking Solarized at random is not opting out of legible text. That claim is
what shapes the token values, the tint percentages, and several rules that are
conspicuously absent from the sheet.

## The claim is a table, not a spot check

[`tests/paintedPairs.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/ui/ui-styleguide/tests/paintedPairs.ts) enumerates every
(foreground, background) pair the shipped stylesheets actually paint, and the
package's test suite registers one assertion per pair per variant. The pairs
cover:

- The four-step text ramp (`--text`, `--text-muted`, `--text-faint`,
  `--text-placeholder`) on each of the four surface elevations.
- Text on `--hover` and on the neutral active fill, which is a `color-mix` and
  not a token.
- Each semantic color on its own soft tint, which is what a `.badge.ok` or a
  `.pill` paints, and on each surface elevation, which is what an untinted
  `.error-text` paints.
- `--code-text`, plus the four semantic colors, on `--code-bg`: `.plus` and
  `.minus` are bare class selectors that set only a foreground, so one inside a
  `.livelog` paints on that container's background.
- `--inverse-text` on `--inverse-bg`.
- The translucent topbar, twice. See below.

The predecessor of this table asserted three pairs behind a per-key `continue`
and an `if` guard that skipped precisely when the primary foreground was the
thing failing, so no assertion in it could fail. The table is the fix: it names
what is painted, so a rule with no entry is visibly an unaudited surface.

## Backgrounds resolve to exact channels

`mixColors` rounds each channel to an integer. A browser evaluating
`color-mix(in srgb, ...)` does not. At least one shipped pair sits in the gap.

The `one` dark `--success` tint at the old 12 percent scored 4.5033 with rounded
channels and 4.4781 with the channels the browser renders: passing on the
rounded number, failing in the product. That is why `mixChannels` returns
unrounded `Rgb` and `contrastRatioOf` scores channels rather than hex, and why
the audit uses that pair throughout. The current 10 percent recipe scores 4.6329
rounded and 4.6469 rendered, so it clears AA either way.

## Two tint ceilings

`SOFT_TINT_AMOUNT` is 0.1 and `STRONG_TINT_AMOUNT` is 0.16. The difference
between them is whether the fill carries text in its own semantic color.

- **A fill under same-color text is capped at 10 percent.** The darkest shipped
  seeds sit near 4.6:1 on a plain `--surface`, so 11px badge text on an
  11 percent tint already misses AA in at least one palette.
- **A fill with no tinted text may go to 16 percent.**
  `--brand-soft-strong` exists for exactly that, and the sheet never puts brand
  text on it: brand on a 16 percent brand tint measures below 4.5:1 in 10 of the
  16 shipped variants.

Two visible consequences follow. Hover and press on `.button.primary` and
`.button.danger` move the border and the elevation rather than deepening the
fill, because there is nowhere deeper to go. And each of those state rules
restates its own `background`, because the generic `.button:hover` and
`.button:active` rules match them too at higher specificity; without the
restatement the resolved fill is brand text on a neutral surface nobody
measured. The suite resolves the sheet rule by rule and pins what each state
actually paints.

## The topbar is measured twice

`.top, .topbar` is the one translucent background this sheet paints text on. It
uses `--surface-glass-strong` over the shell, whose background is `--bg`, plus
`backdrop-filter: blur(18px) saturate(180%)`.

`backdrop-filter` filters the backdrop before the element's own translucent
background composites over it, so the pixels under the topbar text depend on
whether the browser supports it. Both paths are in the table: the plain
composite over `--bg` for browsers without support, and the composite over a
backdrop put through the Filter Effects saturation matrix at 1.8 for browsers
with it. `blur(18px)` is inert over a uniform background; `saturate(180%)` is
not.

Change the `saturate()` amount in the rule and you audit a background the
browser no longer paints, so the suite pins the two together.

## What the budget forbids

**No `::selection` rule.** A brand wash leaves the foreground inherited, which
puts it under all nine foregrounds this sheet paints. The inherited foreground may be a semantic status color; a wash can reduce
its contrast. Pinning a foreground instead is
worse, because `::selection` is global and a downstream sheet that overrides
only the selection background inherits the pinned color, which `@smthrs/ui`'s
markdown editor does. The user agent's own selection colors are contrast
guaranteed, so the sheet leaves them alone.

**No inline `color-mix` on a semantic fill.** Every tinted fill routes through a
named recipe. The suite scans the component rules and fails on any
`background: color-mix(... var(--brand) ...)` written by hand, because a hand
written percentage bypasses the audited list.

**No surface without an explicit foreground.** `.livelog` once painted
`--code-bg` and let its text inherit `--text`, which is not an alias of
`--code-text` in every palette. Every rule that sets a background that is not
the page background sets a color too.

## UI text has no contrast exemptions

Every audited UI pair must meet 4.5:1 in every palette and mode, including
Solarized. The generator preserves the upstream surface seeds and adjusts
primary text toward black or white until it reaches 5.25:1 on `bg`, `surface`,
`surface2`, and `surface3`. This leaves room for the secondary ramp's targets:
5:1 for muted text, 4.75:1 for faint text, and 4.5:1 for placeholders.

Each search checks every background before accepting its result. Exhaustion
throws an error naming the palette, mode, token, target, and achieved minimum
ratio. All palettes are validated before any output file is written. The suite
also measures the actual active fills and both glass topbar composites.

Terminal and syntax colors preserve upstream fidelity separately from this UI
AA guarantee. Solarized light's terminal foreground remains at 4.13:1; its
measured exception is pinned in `KNOWN_TERMINAL_GAPS`. Rose Pine's shared
success/info colors remain in `KNOWN_ROLE_COLLISIONS`. These lists must name
only existing variants whose recorded behavior still holds. See
[Where the palettes come from](./palette-sources.md).

## The same discipline in your own rules

The budget only covers what this package ships. Any rule you write that puts a
foreground on a background is a new pair, and it is unaudited until you measure
it in all 16 variants. Deleting a rule to make a failing pair disappear hides
the token failure rather than fixing it.

For the mechanics, see [Audit a color pair](../guides/audit-a-color-pair.md).
