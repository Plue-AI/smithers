---
title: "Style a host application"
description: "Mount the component stylesheet correctly in a workflow page, a standalone app, or a static HTML report, and bridge your own brand tokens onto the ones the components read."
---

Your application renders the stylesheet; the components only guarantee they will
be styled once it is there. This guide covers the three host shapes and the one
seam that lets a brand override the house colors.

## Decide whether you need the theme block

`SmithersUiStyles` always emits the component sheet. `withTheme` additionally
prepends the styleguide theme token block, which defines the custom properties
every component color resolves through, plus the base element rules.

| Host                                                  | Element                     |
| ----------------------------------------------------- | --------------------------- |
| A page that already inlines the theme, as the Smithers gateway does | `<SmithersUiStyles />` |
| A standalone app, report, or plain HTML shell         | `<SmithersUiStyles withTheme />` |

Passing `withTheme` where the theme is already inlined emits the token block
twice. The declarations are identical, so nothing breaks, but the page carries
the bytes twice.

## Render it once, near the root

```tsx
import { SmithersUiStyles } from "@smthrs/ui"

export function App() {
  return (
    <>
      <SmithersUiStyles withTheme />
      <Shell />
    </>
  )
}
```

Once per document, not once per route and not once per island. The element
cannot dedupe itself: it exists to work under `renderToStaticMarkup`, where
there is no document to check. Two elements means two copies of the sheet.

You do not need a guard for the opposite mistake. Every component injects the
sheet itself in a browser when no `style[data-smithers-ui]` is present, so a
forgotten element degrades to a working page rather than an unstyled one. That
fallback runs in an effect, so it cannot help a server-rendered document.

## Override the house colors with `extra`

`extra` is appended after the theme block and the component sheet, at the same
specificity, so its declarations win. Redefine the styleguide custom properties
rather than the component classes, and every component follows at once.

This maps a host application's brand onto the names the
components read:

```tsx
import { SmithersUiStyles } from "@smthrs/ui"

const houseBridgeCss = `:root, :root[data-theme='light'], :root[data-theme='dark'] {
  --bg: var(--house-background);
  --text: var(--house-foreground);
  --surface: var(--house-surface-raised);
  --border: var(--house-border);
  --brand: var(--house-accent);
  --success: var(--house-success);
  --danger: var(--house-danger);
}
`

export function App() {
  return (
    <>
      <SmithersUiStyles withTheme extra={houseBridgeCss} />
      <Shell />
    </>
  )
}
```

Two properties of this bridge are worth copying. It spells no color, only
`var()` references, so one definition covers light and dark. And it overrides
only the source tokens: derived tokens such as `--ring` and `--brand-soft`
resolve `var(--brand)` lazily, so they follow the override with no rule of their
own.

## Select the mode and the palette

Mode and palette are attributes on `<html>`, not props. Set them once, from
wherever your app stores the preference:

```ts
document.documentElement.setAttribute("data-theme", "dark") // "light" | "dark"
document.documentElement.setAttribute("data-palette", "paper")
```

Omit `data-theme` to follow the OS `prefers-color-scheme` preference. An
unregistered `data-palette` value falls back to `paper` rather than leaving
the page unthemed. The retained Paper key are listed in
[Theme tokens](../concepts/theming.md).

## Emit static HTML

For a page you build without React on the client, `composeSmithersUiStyles`
gives you the same string to inline:

```ts
import { composeSmithersUiStyles } from "@smthrs/ui"

const css: string = composeSmithersUiStyles({ withTheme: true })
const html = `<!doctype html><html><head><style>${css}</style></head><body>...</body></html>`
```

Server-rendered React works the same way through the element, because
`SmithersUiStyles` renders a plain `<style>` tag with no effects:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { SmithersUiStyles, StatusPill } from "@smthrs/ui"

const body: string = renderToStaticMarkup(
  <>
    <SmithersUiStyles withTheme />
    <StatusPill status="completed" />
  </>
)
```

## Honor reduced motion outside CSS

The sheet already neutralizes animations and transitions under
`prefers-reduced-motion: reduce`. Motion your own code drives, a canvas loop or
an imperative scroll, needs the preference read directly:

```ts
import { observeReducedMotion, prefersReducedMotion } from "@smthrs/ui"

let reduced = prefersReducedMotion()
const stop = observeReducedMotion((next) => {
  reduced = next
})
```

Both are safe with no `window` present.

## Related

- [How styling ships](../concepts/styling.md): why the sheet is a string.
- [Theme tokens](../concepts/theming.md): the token names to override.
- [`@smthrs/ui-styleguide`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui/ui-styleguide): the package that defines the
  theme block.
