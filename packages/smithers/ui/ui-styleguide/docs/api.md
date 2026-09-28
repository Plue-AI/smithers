---
title: "API reference"
description: "Every export of @smthrs/ui-styleguide: the five stylesheet strings, the palette registry, the variant serializer, the contrast math, and the nine exported types."
sidebar:
  order: 1
---

The package ships as source. The export map has one entry, `.`, pointing at
`src/index.ts`; there is no build step, no runtime dependency, and no subpath
export. Everything below is imported from `@smthrs/ui-styleguide`.

The package's test suite reads this page against the barrel and fails when an
export is missing from it, so nothing below can fall behind the code.

## Stylesheets

| Export                 | Type                                          | What it is                                                                     |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `workflowUiThemeCss`   | `string`                                      | Theme tokens plus the base element and primitive rules. 33 KB.                   |
| `workflowUiPrimitiveCss` | `string`                                    | The element and component rules alone, with no tokens, for composing with a `themeCss` subset. 8.5 KB. |
| `workflowUiLayoutCss`  | `string`                                      | The `.workflow-*` shell and dashboard grid classes. 2 KB.                        |
| `workflowUiStyles`     | `string`                                      | The theme and layout sheets joined with a newline, for one-tag embedding. 35 KB. |
| `standaloneThemeCss()` | `() => string`                                | A complete theme for HTML rendered outside a Smithers UI shell. 26 KB.           |
| `themeCss(options?)`   | `(options?: PaletteThemeCssOptions) => string` | The token rules alone, optionally for a subset of palettes. 25 KB for all eight. |
| `reducedMotionCss`     | `string`                                      | The document-wide reduced-motion guard, already composed into both sheets above. |

Every sheet grows by roughly 2.9 KB per registered palette. A host that pins one
palette calls `themeCss({ palettes: ["one"] })` (7.7 KB) instead of shipping all
eight (24.9 KB). See [Pin a palette](./guides/pin-a-palette.md).

### `themeCss(options?)`

```ts
function themeCss(options?: PaletteThemeCssOptions): string
```

Emits three token rules for the default palette plus three for each requested
palette, in registry order, joined by newlines. The default palette's rules are
always emitted, because they carry the 61 theme-invariant tokens and the two
font stacks.

The function walks the registry rather than the caller's array, so a reordered
or repeated request emits each palette once in registry order and two callers
asking for the same set get byte-identical CSS. Rule order is load bearing; see
[Theming](./theming.md).

**Throws** `RangeError` when `options.palettes` names a key the registry does
not have. The message quotes the key and lists the registered ones.

### `standaloneThemeCss()`

```ts
function standaloneThemeCss(): string
```

Returns the same token rules with `"` selector quoting, plus base element rules
for `body`, `a`, `code`, `pre`, `table`, and `hr`, plus `reducedMotionCss`.

Built once at module evaluation from the same frozen registry snapshot as
`workflowUiThemeCss`, so repeat calls cost nothing and the two surfaces cannot
answer differently for one selected theme.

## Registry

| Export              | Type                                               | What it is                                             |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `themeRegistry`     | `DeepReadonly<Record<ThemeKey, SmithersTheme>>`     | The eight palettes, in emission order.                  |
| `DEFAULT_THEME_KEY` | `"night-owl"`                                       | The palette the base `:root` rule carries.              |
| `findTheme(key)`    | `(key: string) => DeepReadonly<SmithersTheme> \| undefined` | Registry lookup for an unvalidated `data-palette` value. |

`themeRegistry` is **deeply frozen at construction** and typed to match. That is
load bearing: `workflowUiThemeCss` snapshots it at module evaluation while widget
adapters read it per render, so a runtime mutation would give one document two
different answers for the same selected theme. Copy before editing.

`findTheme` reads through `Object.hasOwn`, so a prototype name such as
`"toString"` returns `undefined` rather than a function.

## Serialization

```ts
function serializeThemeVariant(
  variant: ThemeVariantTokens,
  options?: SerializeThemeVariantOptions
): string
```

Turns one theme variant into the joined declaration string a rule body needs:
`color-scheme` first, then the optional font block, then the 29 color tokens in
a fixed order.

- `options.fonts` defaults to `false`. Setting it adds the theme-invariant font
  block. Exactly one rule in a stylesheet should set it, because palette rules
  are `:root[data-palette='<key>']` at specificity (0,2,0) and restating fonts
  there out-ranks a consumer's own bare `:root` overrides.
- Input is trusted but checked. Every token is read as an own data property, so
  a getter or a proxy cannot return one value to the check and another to the
  output, and each must be a non-empty string of at most 160 characters that
  is a hex or numeric `rgb()`/`rgba()` color, an RGB channel triple, or a shadow
  list over `rgb(var(--shadow-rgb) / <alpha>)`, because the result is
  interpolated into a stylesheet verbatim. Named colors, `var()`, and
  resource loaders such as `url()` are rejected.

**Throws** `TypeError` naming the property when a token is missing, is an
accessor, is not a string, is empty, exceeds 160 characters, is not a
color, RGB channel triple, or shadow recipe, or when `color-scheme` is neither `"light"` nor `"dark"`.

## Color math

```ts
function contrastRatio(foreground: string, background: string): number
function contrastRatioOf(foreground: Rgb, background: Rgb): number
function mixColors(foreground: string, background: string, amount: number): string
function mixChannels(foreground: string, background: string, amount: number): Rgb
```

`contrastRatio` returns the WCAG 2.x ratio, 1 to 21. Both arguments must be
**opaque** `#rgb`, `#rrggbb`, or `#rrggbbaa` with `aa` equal to `ff`. Anything
else throws `TypeError` quoting the offending value:

- A translucent color has no contrast ratio of its own. `#00000000` on white is
  not 21:1, it is whatever the invisible text sits on. Composite first.
- Six of the 29 tokens in every variant are `rgba(...)` by construction, and so
  is `TerminalPalette.selectionBackground`. Passing one used to return `NaN`,
  and `NaN >= 4.5` is `false`, so a caller read "fails contrast" instead of
  "unsupported input".
- An over-long hex is rejected, not sliced: `"#123456789"` is an error, not
  `"#123456"`.

`contrastRatioOf` scores an already-parsed pair. It takes numbers, so the hex
parser that guards `contrastRatio` never sees its input: it checks that each
argument is three finite channels from 0 to 255 and throws `TypeError`
otherwise. Unrounded values are legal; sparse arrays and negative, `NaN`,
`Infinity`, or over-255 channels are rejected. Missing channels would otherwise
produce `NaN`, which silently fails every contrast threshold comparison.

`mixColors` is the srgb mix the house recipes use, matching
`color-mix(in srgb, fg <amount>%, bg)` with `amount` as a 0-1 fraction. It drops
alpha on its inputs, requires a finite `amount` in `[0, 1]`, and rounds the
result to `#rrggbb`.

`mixChannels` returns the same mix as **unrounded** channels. Use it with
`contrastRatioOf` when auditing a `color-mix` recipe: browsers evaluate
`color-mix` in floating point, and rounding can change the verdict. The 12
percent `one` dark `--success` tint that shipped before `SOFT_TINT_AMOUNT` was
lowered scored 4.5033 with rounded channels but 4.4781 with rendered channels.
The current 10 percent recipe scores 4.6329 rounded and 4.6469 rendered, so it
clears AA. See [Audit a color pair](./guides/audit-a-color-pair.md).

## Recipe constants

| Export                | Value  | What it means                                                            |
| --------------------- | ------ | ------------------------------------------------------------------------- |
| `SOFT_TINT_AMOUNT`    | `0.1`  | The ceiling for a semantic fill that carries text in its own semantic color. |
| `STRONG_TINT_AMOUNT`  | `0.16` | For a fill that carries no text in the tinted color.                        |

The contrast audit reads both constants rather than restating the numbers, so a
recipe and the measurement that justifies it cannot drift apart.

## Types

| Type                          | Shape                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `SmithersTheme`               | `{ key, label, light, dark, syntax: { shikiDark, shikiLight }, terminal: { dark, light } }`.   |
| `ThemeVariantTokens`          | The 30 per-variant declarations: `colorScheme` plus 29 colors. See the token reference.        |
| `TerminalPalette`             | The 19 xterm.js `ITheme` fields the terminal adapter sets, as a plain record.                  |
| `ThemeSyntaxId`               | The closed union of the 14 Shiki bundled-theme ids the shipped suite uses.                     |
| `ThemeKey`                    | The eight registered `data-palette` values.                                                    |
| `DeepReadonly<T>`             | `T` with every nested property readonly, matching the registry's deep freeze.                  |
| `Rgb`                         | `readonly [number, number, number]`: parsed 0-255 srgb channels.                                |
| `PaletteThemeCssOptions`      | `{ palettes?: readonly string[] }`.                                                            |
| `SerializeThemeVariantOptions` | `{ fonts?: boolean }`.                                                                        |

`DeepReadonly` treats functions as leaves, and its mapped type over an array
preserves tuple keys and arity rather than collapsing to a homogeneous element
type.

`Rgb` channels are unrounded on purpose, so the pair a `color-mix` recipe is
audited against is the one the browser renders. `TerminalPalette` is a plain
record rather than an `@xterm/xterm` import, which is what keeps this package
free of dependencies; the adapter widens it to `ITheme` at the call site.

Every field of `ThemeVariantTokens` and every value in `themeRegistry` is
documented on the [token reference](./reference/tokens.md).

## Errors

| Thrown by                                                | Type         | Cause                                                       |
| -------------------------------------------------------- | ------------ | ------------------------------------------------------------ |
| `themeCss`                                                | `RangeError` | `palettes` names a key the registry does not have.           |
| `serializeThemeVariant`                                   | `TypeError`  | A token is missing, an accessor, not a string, empty, over 160 characters, or not a color, RGB channel triple, or shadow recipe. |
| `serializeThemeVariant`                                   | `TypeError`  | `colorScheme` is neither `"light"` nor `"dark"`.             |
| `contrastRatio`                                           | `TypeError`  | An argument is not an opaque hex color.                      |
| `contrastRatioOf`                                         | `TypeError`  | An argument is not three finite 0-255 channels.              |
| `mixColors`, `mixChannels`                                | `TypeError`  | A color is not hex, or `amount` is outside `[0, 1]`.         |

See [Troubleshooting](./troubleshooting.md) for what each message means in
practice.
