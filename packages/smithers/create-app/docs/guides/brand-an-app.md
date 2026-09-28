---
title: "Brand an app"
description: "Declare an app's identity once in PACKAGE.ts: the tokens the Vite plugin turns into CSS custom properties, the font stacks it imports, and the two virtual modules it serves."
sidebar:
  order: 4
---

An app declares its identity once, in the `brand` field of `CreateApp`. The
Vite plugin turns that declaration into CSS custom properties and serves it to
the shell as a manifest, so no component holds a color and no stylesheet
repeats one.

## Declare the brand

```ts
import { CreateApp } from "@smthrs/create-app"

export const App = CreateApp({
  name: "ledger",
  brand: {
    name: "Ledger",
    wordmark: "LEDGER",
    theme: "system",
    fonts: {
      body: "'Inter', system-ui, sans-serif",
      mono: "'JetBrains Mono', ui-monospace, monospace",
      googleFonts: ["Inter:wght@400;500;600", "JetBrains+Mono:wght@400"]
    },
    tokens: {
      accent: "#5288c2",
      accentForeground: "#ffffff",
      background: "#ffffff",
      surface: "#f6f7f9",
      border: "#e4e4e7",
      foreground: "#09090b",
      radiusMd: "0.5rem"
    }
  },
  deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
})
```

A brand is a patch, not a theme. A token you do not list keeps the styleguide
default, so declaring six tokens changes six things.

## The tokens

Every token is optional, and every one that is declared is emitted as
`--house-<kebab-case-name>`. Most also alias the styleguide property that
[`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui) components actually resolve their colors through:

| Token              | Styleguide properties it also sets   |
| ------------------ | ------------------------------------ |
| `primary`          | `--inverse-bg`, `--code-bg`          |
| `primarySubtle`    | `--hover`, `--code-text`             |
| `accent`           | `--brand`                            |
| `accentForeground` | `--inverse-text`                     |
| `success`          | `--success`                          |
| `warning`          | `--warning`                          |
| `danger`           | `--danger`                           |
| `info`             | `--info`                             |
| `background`       | `--bg`                               |
| `surface`          | `--surface-2`, `--hover-subtle`      |
| `surfaceRaised`    | `--surface`, `--surface-3`           |
| `border`           | `--border`                           |
| `borderStrong`     | `--border-strong`, `--border-solid`  |
| `foreground`       | `--text`                             |
| `foregroundMuted`  | `--text-muted`                       |
| `foregroundSubtle` | `--text-faint`, `--text-placeholder` |
| `radiusSm`         | `--r-1`                              |
| `radiusMd`         | `--r-2`                              |
| `radiusLg`         | `--r-3`, `--r-bubble`                |
| `radiusXl`         | `--r-4`                              |
| `radiusPill`       | `--r-full`                           |
| `shadowSm`         | `--shadow-1`                         |
| `shadowMd`         | `--shadow-2`                         |
| `shadowLg`         | `--shadow-3`                         |

Eight more tokens exist and emit only their `--house-*` alias, for app CSS to
read: `primaryHover`, `primaryActive`, `accentSubtle`, `accentRing`,
`secondary`, `secondarySubtle`, `successSubtle`, and `radiusComposer`.

## The fonts

Four font stacks and a list of Google Fonts specifications:

| Field      | Custom properties                  |
| ---------- | ---------------------------------- |
| `body`     | `--house-font-ui`, `--font-sans`   |
| `mono`     | `--house-font-mono`, `--font-mono` |
| `display`  | `--house-font-display`             |
| `wordmark` | `--house-font-wordmark`            |

Each `googleFonts` entry is a `family=` specification, so
`"Geist:wght@400;500"` becomes an `@import` of the matching Google Fonts URL.
The imports are emitted ahead of the rule, because CSS ignores an `@import`
that follows one.

Values are written into the sheet verbatim, so the plugin refuses a token or
font value containing `;`, `{`, `}`, `<`, a backslash, a line break, or `/*`,
and a `googleFonts` entry with any character outside letters, digits, and
`+:@;,.-`. Either would let a copied theme add its own rules or imports.

## What the plugin serves

Add the plugin to `vite.config.ts`:

```ts
import { cloudflare } from "@cloudflare/vite-plugin"
import { createApp } from "@smthrs/create-app/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [createApp(), react(), cloudflare({ configPath: "./worker/wrangler.jsonc" })],
  resolve: { dedupe: ["effect", "react", "react-dom"] }
})
```

It serves two virtual modules:

- `virtual:smthrs-app/brand.css` is the brand as one CSS rule, scoped to
  `:root, [data-theme]`. Import it for its side effect from the browser entry
  point.
- `virtual:smthrs-app/manifest` is the whole `AppManifest` as the default
  export: the name, the brand, the nav, the source directories, and the deploy
  target. The shell layout reads its nav and wordmark from it.

Both ids are exported as `brandModuleId` and `manifestModuleId`, so a host that
resolves them itself does not have to spell them.

Declare their types once, as the templates do in a `virtual.d.ts`:

```ts
declare module "virtual:smthrs-app/manifest" {
  import type { AppManifest } from "@smthrs/create-app/app"
  const manifest: AppManifest
  export default manifest
}
```

## Plugin options

`createApp()` needs nothing. Three options change what it does:

| Option          | Default                           | Why you would set it                                                     |
| --------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `root`          | Vite's resolved root              | The app root is not the Vite root                                        |
| `manifest`      | `loadManifest(<root>/PACKAGE.ts)` | Supply the manifest directly, which also drops the `tsx` peer dependency |
| `onRouterError` | report on stderr                  | Send a refused tree somewhere else while the dev server runs             |

The default loader evaluates `PACKAGE.ts` through `tsx`, because the Vite
config process is not a TypeScript process and `PACKAGE.ts` imports
`@smthrs/targets`. It requires the file to export `App` built by `CreateApp`,
and says so when it does not:

```text
/work/ledger/PACKAGE.ts must export `App` from CreateApp({ ... })
```

## Render the brand yourself

`brandCss` is exported, so a host that is not using Vite can produce the same
stylesheet:

```ts
import { brandCss } from "@smthrs/create-app/vite"

const css = brandCss(manifest.brand)
```
