---
title: "Light and dark"
description: "Paper follows the system preference or an explicit mode."
---

The sheet uses Paper light with no attributes. It switches to Paper dark when
`prefers-color-scheme: dark` matches. `data-theme="light"` or `data-theme="dark"`
overrides the system preference. Remove the attribute to follow the system again.

```ts
document.documentElement.dataset.theme = "dark"
delete document.documentElement.dataset.theme
```

The palette is fixed to Paper. Legacy `data-palette` values do not select a decorative
preset. Shared spacing, typography, motion, syntax and terminal adapters remain.

[Override a token](./guides/override-a-token.md) for a custom host or flow UI.
[Paper source](./concepts/palette-sources.md) describes generation and restoration.
