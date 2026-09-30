---
title: "Test a component"
description: "Test a surface built on @smthrs/ui: register happy-dom before Radix loads, choose between static markup and a real root, drive the theme, and keep injected stylesheets from leaking between tests."
---

Testing a surface built on this library is ordinary React testing with three
wrinkles: Radix has to see a DOM at module load, the components inject a
stylesheet into the shared document, and computed colors need the theme block.
This guide covers all three. The examples run on Bun's test runner against
happy-dom, which is what the package itself uses, and the shapes transfer to
Vitest and jsdom unchanged.

Also run a typecheck over your tests. The package ships TypeScript sources
rather than a build, so `tsc --noEmit` is what catches a prop that no longer
exists.

When editing this package's JSX, write rendered edge spaces as `{" "}`. The
pinned dprint TypeScript plugin drops literal spaces beside expressions such as
`<span>{label} </span>`; see [dprint/dprint-plugin-typescript#476](https://github.com/dprint/dprint-plugin-typescript/issues/476).

## Register happy-dom in a preload, not a test file

Radix resolves its server-safe `useLayoutEffect` shim at module load time. With
no `globalThis.document` at that moment, every Radix layout effect becomes a
no-op for the rest of the process, and portal content never appears, even if you
register happy-dom a line later. ESM imports hoist above any in-file
registration call, so the registration must happen before any test file imports
`radix-ui`.

Point `bunfig.toml` at a preload file:

```toml
[test]
preload = ["./tests/happy-dom-preload.ts"]
```

The preload registers the global DOM before anything imports Radix:

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

// Mutate the live settings object rather than passing `settings` to register(),
// which replaces happy-dom's defaults wholesale. Without this, a test that
// renders an iframe at a real URL performs a genuine network fetch and hangs
// where there is no network.
const happy = globalThis as { happyDOM?: { settings: Record<string, unknown> } }
if (happy.happyDOM) happy.happyDOM.settings.disableIframePageLoading = true
```

Under Vitest, the equivalent is an `environment` of `happy-dom` or `jsdom` in
the config, which the runner applies before it loads a test file.

## Assert on markup when the question is markup

`renderToStaticMarkup` is the cheapest shape and works for anything that does
not need effects, state, or portals:

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Button, SmithersUiStyles } from "@smthrs/ui"

test("the default button wears the house tinted recipe", () => {
  const html = renderToStaticMarkup(
    <>
      <SmithersUiStyles />
      <Button>Launch</Button>
    </>
  )
  expect(html).toContain('data-slot="button"')
  expect(html).toContain("sui-button-default")
})
```

Prefer `data-slot` over a class name when you are asserting on a part rather
than on styling.

## Mount a real root when behavior is the question

Radix portals, focus management, controlled state, and effects need a real root
and React's act environment:

```tsx
import { afterEach, expect, test } from "bun:test"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { SMITHERS_UI_STYLE_ATTR, Tabs, TabsContent, TabsList, TabsTrigger } from "@smthrs/ui"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement | undefined
let root: Root | undefined

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const created = root
  await act(async () => created.render(element))
}

afterEach(async () => {
  if (root) {
    const created = root
    await act(async () => created.unmount())
    root = undefined
  }
  container?.remove()
  container = undefined
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove())
})

test("the selected tab renders its panel", async () => {
  await render(
    <Tabs defaultValue="runs">
      <TabsList>
        <TabsTrigger value="runs">Runs</TabsTrigger>
      </TabsList>
      <TabsContent value="runs">Nothing running</TabsContent>
    </Tabs>
  )
  expect(container?.textContent).toContain("Nothing running")
})
```

The stylesheet cleanup in `afterEach` matters. Every component injects the sheet
into `document.head` on mount, and the document is shared across every test in
the process. Removing `style[data-smithers-ui]` keeps one test's injection from
deciding whether the next test's injector stands down.

## Test against a theme

Computed styles need the token block, which the component sheet does not carry
on its own. Compose both and install them:

```ts
import { composeSmithersUiStyles } from "@smthrs/ui"

function installThemeStyles(): void {
  const style = document.createElement("style")
  style.setAttribute("data-theme-test", "")
  style.textContent = composeSmithersUiStyles({ withTheme: true })
  document.head.appendChild(style)
}
```

Then drive the mode with the attribute the components read:

```ts
document.documentElement.setAttribute("data-theme", "dark")
```

Remove the element and the attribute afterwards, for the same reason as above.

## Assert on absence with a control

When a test asserts that something is *not* there, add a second assertion that
proves the test could have seen it. The bundle test in this package is the
example: it asserts that no heavy dependency reaches the base barrel, and,
because a negative assertion passes against an empty bundle, it also asserts a
minimum bundle size and bundles a control entry point that must contain the
dependency.

The same applies to a link checker, a lint rule, or any scan you write over your
own tree: pin the scanner against an input it must catch as well as one it must
ignore, because a scanner that silently matches nothing looks exactly like a
clean tree.

## Related

- [The adapters boundary](../concepts/adapters.md): what the bundle test
  measures, and why importing an adapter is a deliberate act.
- [How styling ships](../concepts/styling.md): why the sheet reaches the
  document twice.
