---
title: "Add a page"
description: "Give an app a second screen: where a page file goes, how its route is derived, how to put it in the sidebar, and what the shell layout does."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/guides/add-a-page.md"
---

A page is a React component at `app/**/page.tsx`. Its directory is its route,
so `app/page.tsx` is `/` and `app/operate/logs/page.tsx` is `/operate/logs`.
Nothing registers it.

## Write the file

Create `app/settings/page.tsx` with a default export:

```tsx
export default function Page() {
  return (
    <section className="page">
      <h1>Settings</h1>
      <p className="page-lede">Where the app keeps its provider and deploy configuration.</p>
    </section>
  )
}
```

The export must be the default one. Every directory segment of the route obeys
the route grammar, so `app/Settings/page.tsx` and `app/v1.2/page.tsx` are
refused with `invalid_name`.

Regenerate:

```bash
pnpm routes
```

```text
routes: 2 pages, 1 panes, 1 flows
```

## Put it in the sidebar

Navigation is declared once, in `PACKAGE.ts`, and the shell reads it from the
manifest:

```ts
export const App = CreateApp({
  name: "ledger",
  brand: { name: "Ledger", tokens: { accent: "#5288c2" } },
  nav: [
    { label: "App", items: [{ label: "Chat", href: "/", icon: "message-square" }] },
    { label: "Configure", items: [{ label: "Settings", href: "/settings", icon: "settings" }] }
  ],
  deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
})
```

`href` is an app route, so `/settings` requires `app/settings/page.tsx`.
`icon` is a lucide icon name the shell resolves. Nothing checks that an `href`
has a page: an entry with no page routes to the shell's own not-found view.

## The shell layout

`app/layout.tsx` is optional. When it exists, the router exports its default
component as `layout` and the entry point wraps every page in it:

```tsx
import type { ReactNode } from "react"
import manifest from "virtual:smthrs-app/manifest"

export default function Layout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="shell-sidebar">{manifest.brand.wordmark ?? manifest.brand.name}</aside>
      <main className="shell-main">{children}</main>
    </div>
  )
}
```

Only the app root's `layout.tsx` is a shell layout. A nested one is an ordinary
file the router ignores, so nesting layouts is not a way to give one subtree a
different frame: put that branch inside the root layout, or inside the pages.

The `virtual:smthrs-app/manifest` module is served by the Vite plugin from the
declaration in `PACKAGE.ts`. See [Brand an app](/guides/brand-an-app/).

## How the templates route in the browser

The generated `routes.ui.gen.ts` is a table, not a router. Each template ships
a small entry point that reads it. The `default` template matches on the
location hash, which needs no server rewrite rules. The `aomi` template routes
on history (`pushState`) and honors a `#/path` hash as a fallback, which the
`not_found_handling: single-page-application` its assets are served with
allows.

Replace that entry point with any router you like. Its only obligation is to
read `pages` and `layout` from the generated module rather than importing pages
itself: the generated module already imports every page, so a page that
imported it back would close an initialization cycle.
