---
title: "@smthrs/ui-styleguide"
description: "The Smithers house stylesheet: one Paper palette in light and dark, emitted as CSS custom properties, with the base element and component rules that consume them."
---

`@smthrs/ui-styleguide` supplies Paper light/dark CSS tokens, element rules,
flow layouts, and syntax/terminal colors. Import the string into a `<style>`
element. The sheet follows the system preference; `data-theme="light"` or
`data-theme="dark"` overrides it.

Semantic roles keep color meaning consistent. Every foreground/background
pair painted by the shipped rules is checked against WCAG AA in both modes.
See [The contrast budget](./concepts/contrast-budget.md).

```ts
import { workflowUiStyles } from "@smthrs/ui-styleguide"
document.head.append(Object.assign(document.createElement("style"), {
  textContent: workflowUiStyles
}))
```

## What is in the box

| Piece                    | What it gives you                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Theme tokens             | 29 per-variant color properties plus `color-scheme`, over 63 theme-invariant ones, for Paper light/dark variants in two modes. |
| Primitive rules          | Base element styling and the `.button`, `.input`, `.badge`, `.card`, `.table`, `.code` families.        |
| Layout rules             | The `.workflow-*` shell, dashboard, and run-row grid.                                                   |
| The palette registry     | Paper as data, including its Shiki syntax ids and xterm terminal palettes.                 |
| Contrast math            | `contrastRatio`, `mixColors`, and the unrounded-channel pair the audit is written against.              |

## How this fits with @smthrs/ui

This package is the layer underneath [`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui), the React
component library the Smithers surfaces are built from. `@smthrs/ui` builds its
shadcn-anatomy components on these tokens, and it owns the React way of getting
the sheet into a document: render its `SmithersUiStyles` component once, near
the root, rather than appending a `<style>` element yourself.

Reach for `@smthrs/ui-styleguide` on its own when you are theming plain HTML: a
server-rendered report, a static page, a widget with no React in it. Reach for
[`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui) when you want the components too, and let it pull these
tokens in for you. Nothing here imports React, so both routes lead to the same
CSS.

Both packages sit under [`@smthrs/cli`](/api/cli), the `smthrs` command line
that runs Smithers flows. Start there for the product these interfaces are
built for.

## Where to go next

- [Installation](./installation.md): where the package comes from, the import
  forms, and the three runtimes it loads under.
- [Quickstart](./quickstart.md): a themed page with light/dark support.
- [Theming](./theming.md): light/dark selection and host overrides.
- Guides: [embed a stylesheet](./guides/embed-a-stylesheet.md),
  [override a token](./guides/override-a-token.md),
  [pin a palette](./guides/pin-a-palette.md),
  [audit a color pair](./guides/audit-a-color-pair.md).
- Concepts: [the contrast budget](./concepts/contrast-budget.md) and
  [where the palettes come from](./concepts/palette-sources.md).
- Reference: [every token](./reference/tokens.md), [every class](./reference/classes.md),
  and the [API](./api.md).
- [Troubleshooting](./troubleshooting.md): the errors this package throws and
  the theming failures that produce no error at all.
