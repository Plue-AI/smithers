import { test } from "node:test"
import assert from "node:assert/strict"
import { docsText } from "./docs-text.mjs"

test("preserves example imports while removing MDX imports", () => {
  const source = 'import { Code } from "@astrojs/starlight/components"\n\n```ts title="main.ts"\nimport { Action } from "@smthrs/flow"\nconst value = 1\n```'
  const result = docsText(source)
  assert.ok(!result.includes("starlight/components"))
  assert.ok(result.includes('import { Action } from "@smthrs/flow"'))
})

test("exports navigation and diagram text", () => {
  const result = docsText('<CardGrid>\n<LinkCard title="Run" href="/docs/run/" description="Launch a flow." />\n</CardGrid>\n<DocsDiagram title="Resume" caption="Reuse the committed outcome." rows={[]} />')
  assert.match(result, /\[Run\]\(\/docs\/run\/\)/)
  assert.match(result, /Reuse the committed outcome/)
  assert.ok(!result.includes("<"))
})

test("preserves blank lines in fenced template literals while collapsing prose blank lines", () => {
  const fence = '```js\nconst content = `first\n\n\nsecond`\n```'
  const source = `Before\n\n\nparagraph.\n\n\n${fence}\n\n\nAfter\n\n\nparagraph.`
  assert.equal(docsText(source), `Before\n\nparagraph.\n\n${fence}\n\nAfter\n\nparagraph.`)
})

test("exports app screenshots with their captions for text readers", () => {
  const result = docsText('<AppScreenshot src="/images/app/home.png" alt="The repository home." caption="Choose a featured flow." />')
  assert.equal(result, '![The repository home.](/images/app/home.png)\n\nChoose a featured flow.')
})

test("expands imported help and version fields", () => {
  const result = docsText('<Code lang="text" code={help} />\nNode {versions.node}', { raw: { help: "Usage: smthrs flow list   \n" }, versions: { node: "26.4.0" } })
  assert.match(result, /```text\nUsage: smthrs flow list\n```/)
  assert.match(result, /Node 26\.4\.0/)
})

test("exports literal install commands and refuses unknown code bindings", () => {
  assert.match(docsText('<Code lang="bash" code={`pnpm add package`} />'), /pnpm add package/)
  assert.throws(() => docsText('<Code code={missing} />'), /Cannot export/)
})

test("removes wrapper indentation without changing fenced source", () => {
  const result = docsText('<Tabs>\n  <TabItem label="Node">\n```ts\nconst content = `kept  `\n```\n  </TabItem>\n</Tabs>')
  assert.ok(!/^ +$/m.test(result))
  assert.ok(result.includes('`kept  `'))
})

test("exports the theme-selected animation as its single image", () => {
  const result = docsText(
    '<picture>\n  <source srcset="/images/light.gif" media="(prefers-color-scheme: light)" />\n  <img src="/images/dark.gif" class="hero-anim" alt="The graph." loading="lazy" decoding="async" />\n</picture>'
  )
  assert.equal(result, "![The graph.](/images/dark.gif)")
})
