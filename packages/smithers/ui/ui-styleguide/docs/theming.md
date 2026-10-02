---
title: "Theming"
description: "The two orthogonal selection axes, the rules the emitter produces in order, and why source order rather than specificity decides which palette wins."
---

A themed document makes two independent choices: which palette, and light or
dark. Understanding how those two axes are expressed in CSS is what lets you
override the result without breaking it.

## Two orthogonal axes

**Palette** is `data-palette="<key>"` on `<html>`, one of the eight registered
keys. A host stamps the user's choice there. [`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui) reads it
back through `resolvePalette`, which accepts only registered keys and falls back
to the default. An unrecognized value is not an error; it simply does not match
any override rule, so the default palette's tokens stand.

**Mode** is `prefers-color-scheme` by default, overridden by
`data-theme="light"` or `data-theme="dark"` on the same element. The stamp
always wins over the media query, in both directions: `data-theme="light"`
holds a light document open on a dark operating system.

Neither axis knows about the other. Eight palettes times two modes is 16 token
sets, and every one of them is reachable.

## The rules the emitter produces

`themeCss()` and the sheet behind `standaloneThemeCss()` both come from
[`paletteThemeCss`](https://github.com/smithersai/smithers/blob/main/packages/smithers/ui/ui-styleguide/src/paletteThemeCss.ts), which emits exactly this, in
this order:

1. `:root { ... }` with the default palette's light tokens, the 61
   theme-invariant tokens, and the one font block.
2. `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { ... } }`
   with the default palette's dark tokens.
3. `:root[data-theme='dark'] { ... }` with the same dark tokens.
4. For every other palette, the same three shapes with a
   `[data-palette='<key>']` prefix added to each selector.

That is 3 rules plus 3 per additional palette: 24 for the full registry. The
two entry points differ in one detail only, the attribute-selector quoting:
`themeCss()` and `workflowUiThemeCss` use `'`, and `standaloneThemeCss()` uses
`"`. The package's test suite asserts the token declarations themselves are
identical.

## Source order is the cascade

`:root[data-palette='gruvbox']` and `:root[data-theme='dark']` both compute to
specificity **(0,2,0)**. They are tied. Nothing but source order decides which
one wins.

That is why every palette override must come after the default palette's dark
rules. Put them first and the default's dark tokens would override a selected
palette's light tokens, and a Gruvbox document on a dark operating system would
paint half Night Owl. The package's test suite pins that order.

A palette override in dark mode is one step higher again:
`:root[data-palette='gruvbox'][data-theme='dark']` is **(0,3,0)**, and so is the
`prefers-color-scheme` form. (0,3,0) is the ceiling this sheet reaches, and it
is the number any override of yours has to answer. See
[Override a token](./guides/override-a-token.md) for the recipes that clear it.

## Why the font block is opt in

`serializeThemeVariant` takes a `fonts` option that defaults to `false`, and
only the base `:root` rule passes `fonts: true`. The reason is the same
specificity arithmetic read from the other side.

When the font block rode along with every light variant, all eight `:root`
rules declared `--font-sans` at (0,2,0). A consumer declaring its own font on a
bare `:root`, which is (0,1,0), lost the moment any palette was selected.
A host application can declare its own font stack on a bare `:root`. Emitting the fonts once, in the one rule whose specificity a consumer
can actually beat, is what makes a font override possible at all.

## The alias layer

63 of the 92 custom properties in the base `:root` rule never change with the
palette or the mode. Two are the font stacks. The other 61 are either
expressions over the per-variant tokens or fixed geometry, so neither axis has
anything to redeclare.

- **Aliases** map older names onto canonical tokens: `--panel` is `--surface`,
  `--line` is `--border-solid`, `--muted` is `--text-muted`, `--ok` is
  `--success`. Workflow UIs rely on them, so they stay.
- **Tints and borders** are `color-mix` recipes over the semantic colors:
  `--brand-soft`, `--danger-border`, `--ring`. Use them instead of hand rolling
  a percentage, because the percentages are audited. See
  [The contrast budget](./concepts/contrast-budget.md).
- **Geometry** is the spacing scale, type scale, radii, line heights, and
  control heights.

Because a tint is `color-mix(in srgb, var(--brand) 10%, var(--surface))` and not
a literal, redefining `--brand` alone re-derives `--brand-soft`, `--ring`, and
every brand border with no extra rule.

One trap: this page vocabulary's `--accent` is the brand color, while
`@smthrs/ui`'s `tokens.accent` is the hover fill. The two names are not
interchangeable.

## Where to go next

- [Token reference](./reference/tokens.md): every custom property, what it
  means, and which of the two groups it belongs to.
- [The contrast budget](./concepts/contrast-budget.md): the accessibility
  claim these tokens are shaped by.
- [Where the palettes come from](./concepts/palette-sources.md): seven
  generated, one hand written, and what that means for changing one.
