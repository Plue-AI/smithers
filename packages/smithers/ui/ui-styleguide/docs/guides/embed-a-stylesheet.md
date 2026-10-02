---
title: "Embed a stylesheet"
description: "Pick between the workflow sheets, the standalone sheet, and the bare token sheet, then get the string into a document exactly once."
sidebar:
  order: 1
---

The package exports five CSS strings. They overlap, so a document embeds one
composition, not several.

## Pick the sheet

| You are building                                  | Embed                          | You get                                                        |
| ------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| A workflow UI shell with the `.workflow-*` grid    | `workflowUiStyles`             | Tokens, primitive rules, and layout rules..               |
| A page that uses the primitives with its own layout | `workflowUiThemeCss`           | Tokens and primitive rules..                              |
| A report, landing page, or plain HTML document     | `standaloneThemeCss()`         | Tokens and base element rules for `body`, `a`, `code`, `pre`, `table`, `hr`.. |
| A page whose CSS you write yourself                | `themeCss()`                   | Tokens only, no rules..                                   |

`workflowUiLayoutCss` (2 KB) is the layout half on its own, for a host that has
already embedded `workflowUiThemeCss` elsewhere. `reducedMotionCss` is the
document-wide motion policy and is already composed into both the workflow theme
sheet and the standalone sheet; embed it separately only alongside a bare
`themeCss()`.

The workflow sheets quote their attribute selectors with `'`, and
`standaloneThemeCss()` quotes with `"`. That is the only difference between
their token blocks: the package's test suite asserts the two declare identical
tokens in both modes.

## Server-rendered HTML

Interpolate the string into a `<style>` element:

```ts
import { standaloneThemeCss } from "@smthrs/ui-styleguide"

export const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>smithers review</title>
<style>
${standaloneThemeCss()}
main { max-width: 720px; margin: 0 auto; padding: var(--sp-8) var(--sp-6); }
</style>
</head>
<body><main><h1>smithers review</h1></main></body>
</html>`
```

Put your own rules after the sheet. They then win any tie at equal specificity.

## In the browser

```ts
import { workflowUiStyles } from "@smthrs/ui-styleguide"

document.head.append(
  Object.assign(document.createElement("style"), { textContent: workflowUiStyles })
)
```

Do this once. Two copies in one document is 70 KB of duplicate rules, and the
second copy silently wins every tie with the first.

## In React

Do not inject the sheet yourself. [`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui) owns this:

```tsx
import { SmithersUiStyles } from "@smthrs/ui"

export function App() {
  return (
    <>
      <SmithersUiStyles withTheme extra={myOverrides} />
      {/* ... */}
    </>
  )
}
```

`withTheme` prepends `workflowUiThemeCss` to the component sheet, and `extra` is
appended after both, which is the position a token override needs. Render it
once, near the root. A host whose page already inlines the theme leaves
`withTheme` off.

## Stamp the selection

With no attributes, the sheet applies Paper light by default and switches
to Paper dark when `prefers-color-scheme: dark` matches. Use `data-theme` for optional overrides:

```ts
document.documentElement.dataset.theme = "dark"        // or "light", or absent
```

Leave `data-theme` absent to follow `prefers-color-scheme`, which is the usual
choice. Legacy unregistered palette values leave Paper active.

## Next

- [Override a token](./override-a-token.md) once the sheet is in place.
- [Paper stylesheet](./pin-a-palette.md) describes the retained palette.
