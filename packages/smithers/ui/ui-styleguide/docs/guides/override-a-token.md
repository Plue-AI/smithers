---
title: "Override a token"
description: "Change a house token in a consumer stylesheet: which selector beats the emitted rules, why a bare :root override silently stops working, and when to override a seed instead."
sidebar:
  order: 2
---

Every color, radius, and size in the sheet resolves through a custom property,
so overriding one property re-skins everything that reads it. The only hard part
is winning the cascade.

## The specificity you have to beat

The emitted sheet declares tokens in six selector shapes. Their specificities:

| Selector                                              | Specificity | When it applies                          |
| ----------------------------------------------------- | ----------- | ---------------------------------------- |
| `:root`                                                | (0,1,0)     | Always. Carries the default palette light. |
| `:root:not([data-theme='light'])`                      | (0,2,0)     | Inside the dark media query.              |
| `:root[data-theme='dark']`                             | (0,2,0)     | Explicit dark stamp.                      |
| `:root[data-palette='<key>']`                          | (0,2,0)     | A selected palette, light.                |
| `:root[data-palette='<key>']:not([data-theme='light'])` | (0,3,0)     | A selected palette, dark media query.     |
| `:root[data-palette='<key>'][data-theme='dark']`       | (0,3,0)     | A selected palette, explicit dark.        |

**(0,3,0) is the ceiling.** An override that reaches (0,3,0) and sits after the
sheet in source order wins in every one of the 16 combinations.

This is why a bare `:root { --brand: #ff3366 }` is the classic failure. It is
(0,1,0). It appears to work, because in the default palette in light mode the
only competing rule is also (0,1,0) and yours is later. Then a user picks a
palette, or the sun goes down, and the brand color reverts with no error
anywhere.

## Recipe: out-specify the sheet

The general answer, correct for every palette and every mode:

```css
:root:root:root {
  --brand: #ff3366;
  --r-2: 4px;
}
```

Every `:root` matches the same element, so the rule still applies everywhere,
and three of them put it at (0,3,0): tied with the sheet's most specific rules
and later than all of them. Emit it after the house sheet:

```tsx
import { SmithersUiStyles } from "@smthrs/ui"

<SmithersUiStyles withTheme extra={brandOverrides} />
```

`extra` is appended after the theme, which is the position this needs.

## Recipe: re-declare per axis

A host that never stamps `data-palette` can name the shapes it actually uses.
This bridges a generated brand onto the house names used by
[`@smthrs/create-app`](/api/create-app), abbreviated here to six declarations:

```ts
export const houseBridgeCss = `:root, :root[data-theme='light'], :root[data-theme='dark'] {
  --font-sans: var(--house-font-ui);
  --bg: var(--house-background);
  --text: var(--house-foreground);
  --surface: var(--house-surface-raised);
  --brand: var(--house-accent);
  --r-2: var(--house-radius-md);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg: var(--house-background);
    --text: var(--house-foreground);
    --surface: var(--house-surface-raised);
    --brand: var(--house-accent);
  }
}
`
```

Every value is a `var()` reference, so no color is spelled here and the bridge
cannot drift from the brand.

Place the bridge after the house sheet. The dark media rule reaches (0,2,0)
even when `data-theme` is absent, so the bridge covers the default palette in
both modes. Pinning a non-default palette also requires overrides at or above
that palette's dark selectors, (0,3,0). Use the previous recipe for a pinned
non-default palette or a palette picker.

## Override the seed, not the derivation

The 15 tint and border tokens are `color-mix` expressions over the semantic
colors, not literals:

```css
--brand-soft: color-mix(in srgb, var(--brand) 10%, var(--surface));
--brand-border: color-mix(in srgb, var(--brand) 40%, transparent);
--ring: color-mix(in srgb, var(--brand) 22%, transparent);
```

`var()` resolves lazily, so overriding `--brand` alone re-derives all six
brand-dependent tokens plus the focus ring. Write one declaration, not seven.
The same holds for `--success`, `--danger`, `--warning`, and `--info`.

Two consequences worth knowing:

- **A tint percentage is audited; a color is not.** If you replace `--brand`
  with a color of your own, the 10 percent recipe still applies but the ratio it
  produces is yours to check. See
  [Audit a color pair](./audit-a-color-pair.md).
- **Do not hand roll a tint.** Never string-concatenate an alpha suffix onto a
  token, and never write your own `color-mix` percentage for a fill that carries
  text. Use the `*-soft` and `*-border` tokens.

## Recipe: register a whole palette

To add a palette rather than patch one, build the rule from your own
`ThemeVariantTokens` and give it an unused `data-palette` key:

```ts
import { serializeThemeVariant, themeRegistry, workflowUiStyles } from "@smthrs/ui-styleguide"
import type { ThemeVariantTokens } from "@smthrs/ui-styleguide"

const light: ThemeVariantTokens = { ...themeRegistry["night-owl"].light, brand: "#ff3366" }
const dark: ThemeVariantTokens = { ...themeRegistry["night-owl"].dark, brand: "#ff85a1" }

const houseTheme = [
  workflowUiStyles,
  `:root[data-palette='house'] { ${serializeThemeVariant(light)}; }`,
  `@media (prefers-color-scheme: dark) { :root[data-palette='house']:not([data-theme='light']) { ${
    serializeThemeVariant(dark)
  }; } }`,
  `:root[data-palette='house'][data-theme='dark'] { ${serializeThemeVariant(dark)}; }`
].join("\n")
```

Three rules, in that order, matching the shapes the emitter produces. Leave
`fonts` off: only the base `:root` rule should declare the font block, because a
palette rule that restates it out-ranks a consumer's own bare `:root` font
declarations.

`serializeThemeVariant` validates every token as it goes. A missing key, a
non-string, a value over 160 characters, or one that is not a hex or numeric
`rgb()`/`rgba()` color, RGB channel triple, or shadow recipe throws a
`TypeError` naming the property, because the result is interpolated into a
stylesheet verbatim. Accessor properties are rejected too:
the function reads own data properties, so a getter cannot return one value to
the check and another to the output.

## What you cannot override this way

`@smthrs/ui` deliberately emits no `:root` token block of its own, because the
styleguide already defines page-global `--primary`, `--accent`, and `--muted`
aliases with different meanings than shadcn's. Its bridge lives inside `var()`
expressions instead. If you are recoloring components, override the house token
the bridge reads, not the shadcn name.

## Related

- [Theming](../theming.md): the two axes and the cascade in full.
- [Token reference](../reference/tokens.md): what each name means.
- [Embed a stylesheet](./embed-a-stylesheet.md): getting your override after the
  sheet.
