---
title: "Troubleshooting"
description: "The errors this package throws, what each one means, and the theming failures that produce no error at all."
---

## Errors you can read

### `RangeError: unknown palette "dracula"`

```text
RangeError: unknown palette "dracula"; registered: night-owl, fucory, one,
github, catppuccin, solarized, gruvbox, rose-pine
```

`themeCss({ palettes })` names a key the registry does not have. The message
lists the eight that exist. Note that the registry keys are hyphenated
(`night-owl`, `rose-pine`), not camel case, and they are not the file names in
`src/themes/`.

`themeCss` validates the whole request before emitting anything, so a typo in a
list of eight fails rather than silently dropping one palette.

### `TypeError: expected a hex color`

```text
TypeError: expected a hex color (#rgb, #rrggbb, or #rrggbbaa), received "rgba(64,63,83,0.08)"
```

You passed a token that is `rgba(...)` to `contrastRatio`, `mixColors`, or
`mixChannels`. Six of the 29 tokens in every variant are translucent by
construction: `--surface-glass`, `--surface-glass-strong`, `--border`,
`--border-strong`, `--hover-subtle`, and `--inline-code-bg`. So is
`TerminalPalette.selectionBackground`.

Composite it over whatever is behind it yourself, then pass the composite.
`rgbaOver` in
[the audited pair table](https://github.com/smithersai/smithers/blob/main/packages/smithers/ui/ui-styleguide/tests/paintedPairs.ts)
is the reference implementation.

### `TypeError: contrastRatio needs an opaque foreground`

```text
TypeError: contrastRatio needs an opaque foreground; composite the alpha yourself, received "#00000000"
```

The value parsed as hex but carried an alpha byte other than `ff`. A translucent
color has no contrast ratio of its own: `#00000000` on white is not 21:1, it is
whatever the invisible text sits on. Composite first.

### `TypeError: contrastRatioOf needs three finite 0-255 channels`

```text
TypeError: contrastRatioOf needs three finite 0-255 foreground channels, received [null,0,0]
```

`JSON.stringify` renders `NaN` as `null`, so that message usually means a `NaN`
channel, and a `NaN` channel usually means a hex parse that went wrong upstream.
`Infinity` and negative or over-255 channels raise the same error. Unrounded
values are fine and are the point of the function.

The check exists because the alternatives are worse than an error: `[NaN, 0, 0]`
used to score `NaN`, which compares `false` against every threshold and so reads
as "fails contrast" rather than "unsupported input", and `[-255, 0, 0]` on white
scored 31.3013, outside the 1-to-21 range the function documents.

### `TypeError: mix amount must be a finite fraction from 0 to 1`

```text
TypeError: mix amount must be a finite fraction from 0 to 1, received 10
```

`mixColors` and `mixChannels` take a fraction, not a percentage. The CSS is
`color-mix(in srgb, var(--brand) 10%, var(--surface))`; the call is
`mixColors(brand, surface, 0.1)`.

### `TypeError: theme token --warning must be an own data property`

```text
TypeError: theme token --warning must be an own data property, none found for warning
```

The variant you handed `serializeThemeVariant` is missing a field, or that
field is a getter rather than a value. The function reads own data property
descriptors specifically so that an accessor cannot return one value to the
validation and another to the output. A `Proxy` around a complete object is
fine: the descriptors come from the target.

Spread a registry variant to build a partial override and you cannot hit this:

```ts
const variant = { ...themeRegistry["night-owl"].light, brand: "#ff3366" }
```

### `TypeError: theme token --bg is not a color, RGB channel triple, or shadow recipe`

```text
TypeError: theme token --bg is not a color, RGB channel triple, or shadow recipe: "url(//evil.example/t)"
```

The result of `serializeThemeVariant` is interpolated into a stylesheet
verbatim, so every token must match an allowlist: a hex color (`#rgb`, `#rgba`,
`#rrggbb`, `#rrggbbaa`), an `rgb()` or `rgba()` color with numeric channels, a
space-separated RGB channel triple such as `1 22 39`, or a comma-separated
shadow list such as `0 1px 2px rgb(var(--shadow-rgb) / 0.05)`. Anything else is
rejected, including named colors, `var()`, delimiters that could end the
declaration or escape the `<style>` element, and resource loaders such as
`url()`, `image-set()`, `image()`, and `src()`.

Values are also capped at 160 characters, which is long enough for the widest
shipped shadow recipe.

## Failures with no error

### My token override works until a palette is selected

You wrote `:root { --brand: #ff3366 }`. That is specificity (0,1,0). It beats
the sheet's base rule, which is also (0,1,0) and earlier, so it looks correct.
It loses to `:root[data-palette='<key>']` at (0,2,0) and to
`:root[data-palette='<key>'][data-theme='dark']` at (0,3,0).

Use `:root:root:root { ... }`, placed after the sheet. See
[Override a token](./guides/override-a-token.md).

### My font override is ignored

Same arithmetic, from the other side. If you are writing `:root { --font-sans:
... }` and it is being beaten, check whether something upstream is declaring the
font block in a palette rule. The house sheet declares it exactly once, in the
base `:root` rule, precisely so a bare `:root` override can win, and the
package's test suite counts the occurrences to keep it that way.

### Nothing themes at all

Check three things, in order:

1. The sheet is in the document. Look for a `<style>` element carrying
   `:root { color-scheme:light;`.
2. `data-palette` is on `<html>`, not on `<body>`. Every selector is rooted at
   `:root`.
3. The value is a registered key. An unregistered one is not an error; it
   matches no rule, so the default palette stands. `findTheme(value)` returns
   `undefined` for it.

### Colors change when the page loads a second stylesheet

Two copies of the theme in one document is 70 KB of duplicate rules, and the
later copy wins every tie with the earlier one. In React, render
`<SmithersUiStyles/>` exactly once near the root; it cannot dedupe across
separate React or server-rendered trees.

### Dark mode reverts to the default palette

This is what happens when palette rules are emitted before the default
palette's dark rules. Both are (0,2,0), so source order alone decides.
`themeCss` and `standaloneThemeCss()` get this right; if you are assembling
rules by hand, emit the three default rules first and every palette's three
after. See [Theming](./theming.md).

### Text is hard to read in Solarized

Regenerate older theme files with `scripts/generate-theme-registry.ts`. The
current Solarized UI text ramp meets AA on every audited background in both
modes. Host overrides introduce new pairs and need their own contrast audit.
The terminal palette preserves upstream colors; its light foreground remains
at 4.13:1 and is outside the UI AA guarantee.

### Theme generation reports an unreachable contrast target

```text
unreachable/light/textPlaceholder: target 4.5:1, achieved 1.0000:1
```

The search exhausted its foreground mix without meeting the target on every
background. The error identifies the palette, mode, token, target ratio, and
lowest achieved ratio. Correct the seed or surface recipe in the generator,
then regenerate and run the package tests. Generation validates every palette
before writing any files.

See [Where the palettes come from](./concepts/palette-sources.md).

## Related

- [API reference](./api.md): every signature and the errors it throws.
- [Theming](./theming.md): the cascade rules most silent failures come from.
