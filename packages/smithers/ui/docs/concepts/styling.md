---
title: "How styling ships"
description: "The stylesheet is a JavaScript string, not a CSS import: the two delivery paths, the sui- namespace, why the package never emits a :root block, and the invariants a test enforces."
sidebar:
  order: 1
---

This package ships no `.css` file. The entire component stylesheet is one
JavaScript string, `smithersUiCss`, and it reaches the document through a
`<style>` element the library renders or injects.

That is not a preference. The bundler the Smithers applications are built with
keeps only the JavaScript output of `Bun.build` and drops CSS artifacts, so an
`import "./button.css"` would compile without error and produce an unstyled
application. A string cannot be dropped.

## The two delivery paths

| Path                       | Who calls it        | Runs during server rendering | Dedupes |
| -------------------------- | ------------------- | ---------------------------- | ------- |
| `<SmithersUiStyles />`     | Your application    | Yes                          | No      |
| `useInjectUiCss()`         | Every component     | No                           | Yes     |

`SmithersUiStyles` renders `<style data-smithers-ui="">` containing the composed
sheet. It works under `renderToStaticMarkup`, where effects never run, which is
why it is the path a host is expected to use. It cannot dedupe itself: deduping
requires reading the document, and the whole point of this element is to work
where there is no document. Render it exactly once per document.

`useInjectUiCss` is the browser fallback. Every component calls it, so a
consumer who forgets the element still gets styled output in a browser. It runs
in an insertion effect, checks for an existing `style[data-smithers-ui]`, and
stands down when it finds one. `SMITHERS_UI_STYLE_ATTR` is that marker string,
exported so a host can find or assert on the element.

The marker is a one-way signal, not a mutual guard. A rendered sheet silences
the injector; a previously injected sheet does not stop a second
`SmithersUiStyles` from rendering a duplicate. Two elements are the failure this
package cannot detect for you.

## Lane fragments

Some component families own a CSS fragment of their own: the conversation
foundation, prompt attachments, reasoning and tools, plans and queues,
approvals, sources and citations, agents, artifacts, sandbox, canvas, calendar,
and vault. Each fragment is composed into `smithersUiCss`, so a host that
renders `SmithersUiStyles` already has all of them.

Components in those families inject nothing beyond the composed sheet: one
`useInjectUiCss()` call delivers every lane fragment, so a mounted lane
component adds at most one `<style>` element. Two fragments carry a public id
and string so a host can mount them alone: `CALENDAR_CSS_ID` with `calendarCss`,
and `VAULT_CSS_ID` with `vaultCss`.

## Compose your own sheet

`composeSmithersUiStyles` is the string behind the element, and it takes the
same options:

```ts
import { composeSmithersUiStyles } from "@smthrs/ui"

// The component sheet alone.
const componentsOnly: string = composeSmithersUiStyles()

// The theme token block first, then the component sheet, then your overrides.
const standalone: string = composeSmithersUiStyles({
  withTheme: true,
  extra: ":root { --brand: #2a78d6; }"
})
```

Use it when you emit HTML yourself: a static report, an email-shaped page, an
inlined `<style>` in a server template. `extra` is appended last, at the same
specificity, so its declarations win the cascade.

## Every class is namespaced

Every selector in the sheet starts with `.sui-`. A test asserts it over the
whole string, so there is no exception. The namespace keeps the package from
colliding with two other vocabularies that live in the same document: the
styleguide's page-global classes (`.button`, `.badge`, `.card`) and whatever the
consuming application defines.

That is also why `cn` is nothing but `clsx`. There are no utility-class
conflicts to resolve, so the package carries no `tailwind-merge`.

Rules are document-global. None of them is scoped under a shell class, because
Radix mounts portal content on `document.body`, outside your React tree. A
scoped sheet would leave every dialog, tooltip, and select popover unstyled.

## The package never emits a `:root` block

`smithersUiCss` contains no `:root` selector, and a test asserts that too.

The styleguide already defines page-global `--primary`, `--accent`, and
`--muted` aliases, and their meanings are not shadcn's. In the styleguide,
`--accent` is the brand teal; in shadcn's vocabulary, `accent` is the hover
fill. Redefining shadcn's canonical token names at the document root would
silently recolor every legacy `.pill`, `.badge`, and `.button` sharing the page.

The bridge therefore lives entirely inside `var()` expressions, in
[the token table](./theming.md), rather than in a root block of its own.

## The invariants a test holds

A test in the package reads the shipped string and enforces what this page
claims, so these are guarantees rather than intentions:

- No raw hex or `rgb()` color outside `var()` fallback position. A literal color
  pins a value to one theme, which is the bug class that puts opaque white
  panels into a dark interface.
- Every fallback is byte-equal to the styleguide's light value, so a component
  rendered with no styleguide present looks identical to the same component in
  light mode with it.
- Every tint is `color-mix(in srgb, ...)`. The `oklab` interpolation drifts from
  the house recipes.
- Geometry stays on the documented scales: font sizes from the `--fs` steps,
  radii from `--r-1`, `--r-2`, and `--r-bubble`, padding and gap on a 2px grid,
  and font weights of 400, 500, and 650, with 700 reserved for a KPI numeral.
  A component you compose from these tokens sits on the same grid as the rest
  of the library.
- One document-wide reduced-motion policy is composed after every component
  block, so `prefers-reduced-motion: reduce` neutralizes animation and
  transition durations across the sheet.

## Motion the stylesheet cannot reach

A canvas animation or an imperative scroll is not a CSS transition, so the
media-query policy cannot touch it. Two exports let you honor the same
preference from JavaScript:

```ts
import { observeReducedMotion, prefersReducedMotion } from "@smthrs/ui"

if (prefersReducedMotion()) {
  // Skip the entrance animation entirely.
}

const stop = observeReducedMotion((reduced) => {
  // The OS preference changed while the page was open.
  console.log(reduced)
})
stop()
```

Both answer safely with no `window` present, so they are usable in code that
also runs during server rendering.

## Related

- [Theme tokens](./theming.md): what the `var()` expressions resolve to.
- [Style a host application](../guides/style-a-host-application.md): the
  task-shaped version of this page.
- [`@smthrs/ui-styleguide`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui/ui-styleguide): the package that owns the theme
  token block and the palettes.
