---
title: "Theme tokens"
description: "How every color resolves through a var(--house-token, lightFallback) bridge onto the styleguide theme, how light, dark, and Paper light/dark are selected, and the two token names that mean something different here."
sidebar:
  order: 2
---

No component in this package names a color. Every color is a token expression
of the form `var(--house-token, #lightFallback)`, and `tokens` is the table of
them:

```ts
import { tokens } from "@smthrs/ui"

tokens.background // "var(--bg, #f7f4ee)"
tokens.destructive // "var(--danger, #a4442a)"
tokens.primarySoft // "var(--brand-soft, color-mix(in srgb, var(--brand, #0f766e) 10%, var(--surface, #fffefa)))"
```

Each value is a CSS expression, not a color, so it is usable anywhere CSS is: a
class in the shipped sheet, an inline `style` object, a string you compose
yourself. What it resolves to depends on the document, which is the entire
theming mechanism.

## The two resolution states

**With the styleguide theme present.** The custom properties are defined, the
expressions resolve through them, and every component follows the active theme.
A host page that already inlines the theme block, as the Smithers
[gateway](/api/gateway) does, needs nothing further; every other host gets the
same block from `<SmithersUiStyles withTheme />`.

**Without it.** Every custom property is undefined and the fallback applies. The
fallbacks are byte-equal to the styleguide's light values, enforced by a test,
so a component in a bare HTML page renders exactly as it does in light mode with
the theme loaded. There is no configuration step and no unstyled state.

## Selecting light or dark

Two inputs decide the mode, in this order:

1. An explicit `data-theme="light"` or `data-theme="dark"` on `<html>`. It
   always wins.
2. The OS `prefers-color-scheme` preference.

A non-browser caller resolves to light, matching the styleguide's base token
block. `resolveTheme` is that contract as a function, and `subscribeTheme`
watches both inputs:

```ts
import { resolveTheme, subscribeTheme } from "@smthrs/ui"

resolveTheme() // "light" | "dark"

const stop = subscribeTheme(() => {
  // Fires on a data-theme mutation and on an OS preference change.
})
stop()
```

Components that paint through CSS need neither function: the browser
re-evaluates the `var()` chain on its own. The two exports exist for widget
adapters that must hand a literal palette to a third-party renderer, which is
what `Terminal` and the pierre surfaces do.

## Selecting a palette

Paper is the retained palette. Historical or unregistered `data-palette` values
fallback to Paper. Light/dark selection and generic custom token APIs remain.

```ts
import { DEFAULT_THEME_KEY, resolvePalette, themeRegistry, useResolvedPalette } from "@smthrs/ui"

resolvePalette() // a registered key, or DEFAULT_THEME_KEY
DEFAULT_THEME_KEY // "paper"
Object.keys(themeRegistry).length // 1
```

`useResolvedPalette` is the React hook form, and it re-renders when the
attribute changes. `themeRegistry`, `DEFAULT_THEME_KEY`, and
`standaloneThemeCss` are re-exported from
[`@smthrs/ui-styleguide`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui/ui-styleguide), which owns the palettes
themselves; importing them from here saves a consumer a second dependency, not a
second definition.

## Two names that mean something else here

**`accent` is the hover fill, not the brand.** shadcn's vocabulary calls the
hover surface `accent`. The styleguide's page-global `--accent` alias is the
brand teal. The bridge deliberately does not read `--accent`: `tokens.accent`
resolves `--hover`. Reach for `tokens.primary` when you mean the brand.

**`primary` is tinted, not solid.** The house primary button is a 10 percent
brand surface with brand text, not a filled brand rectangle. `tokens.primary` is
the brand color itself; `tokens.primarySoft` is the tinted surface the default
button variant wears. shadcn's filled look is available as
`<Button variant="solid">`.

## Deriving a color

Two rules keep a derived color correct in both modes.

Use a shared semantic token when one exists. Every status color ships in three
weights: the color, a `Soft` surface, and a `Border`:

```ts
import { tokens } from "@smthrs/ui"

tokens.success // the color
tokens.successSoft // the tinted surface
tokens.successBorder // the 40 percent border
```

When none applies, mix with `color-mix(in srgb, ...)` over a token. Never
concatenate an alpha suffix onto a token string: the token holds a `var()`
expression, so `` `${tokens.primary}20` `` produces invalid CSS rather than a
transparent brand.

```ts
const tint = `color-mix(in srgb, ${tokens.primary} 12%, transparent)`
```

## Status colors

The status vocabulary resolves to these same tokens. `statusColor` takes a raw
status string and answers with the token expression the matching pill wears, so
a custom surface can be tinted from a status without duplicating the table:

```ts
import { statusColor } from "@smthrs/ui"

statusColor("failed") // tokens.destructive
statusColor("waiting-approval") // tokens.warning
```

See [Render a run status](../guides/render-run-status.md) for the buckets and
the label rules.

## Related

- [How styling ships](./styling.md): the sheet these tokens are used in.
- [`@smthrs/ui-styleguide`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui/ui-styleguide): the palettes, the token block,
  and the terminal and syntax palettes the adapters read.
