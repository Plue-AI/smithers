---
title: "Paper stylesheet"
description: "The shared sheet carries only Paper."
---

`themeCss()` emits Paper light/dark tokens. The optional registered-key validation
API remains compatible with `themeCss({ palettes: ["paper"] })`; this produces the
same complete sheet. An empty list also retains the default. Unknown keys throw.

```ts
import { themeCss, workflowUiPrimitiveCss, workflowUiLayoutCss } from "@smthrs/ui-styleguide"
const styles = [themeCss(), workflowUiPrimitiveCss, workflowUiLayoutCss].join("\n")
```

Custom token authoring and syntax/highlighter APIs remain available.
[Override a token](./override-a-token.md) for host-specific styling.
