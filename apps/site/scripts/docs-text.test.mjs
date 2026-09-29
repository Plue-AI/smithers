import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { docsText } from "./docs-text.mjs"

test("the schedule tutorial documents reviewed registration and keeps the local scheduler distinct", () => {
  const source = readFileSync(new URL("../src/content/docs/docs/learn/agent-and-trigger.mdx", import.meta.url), "utf8")
  const flows = readFileSync(new URL("../../app/src/mainview/flows/entries/triggers.ts", import.meta.url), "utf8")
  assert.match(flows, /name: "triggers\.approve"[\s\S]*?userOnly: true/)
  assert.doesNotMatch(source, /always refuses registration|cannot be registered.*from here yet/)
  assert.match(source, /prepares the plan for you to read and approve before it registers/)
  assert.match(source, /token and time budget/)
  assert.match(source, /Run now/)
  assert.match(source, /Pause/)
  assert.match(source, /until it is live/)
  assert.ok(source.includes('"schedule:0 9 * * 1-5"'))
  assert.ok(source.includes('smthrs triggers register weekday-review --flow reviewer --cron "0 9 * * 1-5"'))
  assert.ok(source.includes("/docs/guides/triggers/"))
})

test("remote serve docs never send the bearer over cleartext HTTP or in argv", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
  const guide = read("../src/content/docs/docs/guides/control-plane.mdx")
  const gateway = read("../../../packages/smithers/gateway/docs/guides/serve-beyond-loopback.md")
  for (const page of [guide, gateway]) {
    assert.doesNotMatch(page, /--credential "\$SMITHERS_API_KEY"/)
    assert.doesNotMatch(page, /(?:--remote |SMITHERS_REMOTE=)http:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/)
  }
  for (const path of [
    "../src/content/docs/docs/guides/control-plane.mdx",
    "../src/content/docs/docs/reference/cli/serve.mdx",
    "../src/content/docs/docs/reference/http-api.mdx"
  ]) {
    assert.match(read(path), /plain HTTP only/, path)
  }
})

test("sync follower guide requires explicit compaction recovery and a restored cursor", () => {
  const guide = readFileSync(new URL("../src/content/docs/docs/guides/sync-followers.mdx", import.meta.url), "utf8")
  assert.doesNotMatch(guide, /The default hook logs the skipped range and continues/)
  assert.doesNotMatch(guide, /`Sync.Read` and `Sync.Subscribe` are the whole wire/)
  assert.match(guide, /fails closed/)
  assert.match(guide, /`compacted`/)
  assert.match(guide, /`invalid_request`/)
  assert.match(guide, /`Sync.Snapshot`/)
  assert.match(guide, /onResync:.*Effect\.gen/s)
  assert.match(guide, /afterSeq: snapshot\.seq/)
  assert.match(guide, /yield\* restoreReadModel\(snapshot, cursor\)\s+return cursor/)
})

test("sync concept frame ceiling agrees with the protocol default", () => {
  const concept = readFileSync(new URL("../src/content/docs/docs/concepts/sync.mdx", import.meta.url), "utf8")
  const protocol = readFileSync(new URL("../../../packages/smithers/flows/sync/src/SyncProtocol.ts", import.meta.url), "utf8")
  const defaultMiB = /defaultMaxFrameBytes = (\d+) \* 1024 \* 1024/.exec(protocol)
  assert.ok(defaultMiB, "protocol declares its frame default in MiB")
  const documentedMiB = /The default frame ceiling is (\d+) MiB/.exec(concept)
  assert.ok(documentedMiB, "concept documents the frame default")
  assert.equal(documentedMiB[1], defaultMiB[1])
})

test("kernel concept lists exactly the closed host tag surface", () => {
  const concept = readFileSync(new URL("../src/content/docs/docs/concepts/kernel.mdx", import.meta.url), "utf8")
  const source = readFileSync(
    new URL("../../../packages/smithers/flows/kernel/src/HostServices.ts", import.meta.url),
    "utf8"
  )
  const declared = /export const HostServiceTags = \[([^\]]*)\]/.exec(source)
  assert.ok(declared, "the kernel declares its closed host tag list")
  const tags = declared[1].split(",").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => entry.replace(/^\w+\./, "").replace(/Port$/, ""))
  const documented = /The host surface is (?:a|the) fixed list[^:]*: (.+?)\. Each is/.exec(concept)
  assert.ok(documented, "the concept documents the closed host tag list")
  assert.deepEqual([...documented[1].matchAll(/`(\w+)`/g)].map((match) => match[1]), tags)
  assert.match(concept, /`Workspace` is not a host service\./)
  assert.match(concept, /`CommandLine` is not one either: it is a pure renderer with no host access/)
})

test("authoring and release claims match supported state", () => {
  const discovery = readFileSync(new URL("../../../packages/smithers/agent/registry/src/Discovery.ts", import.meta.url), "utf8")
  const flowGuide = readFileSync(new URL("../src/content/docs/docs/guides/flow-discovery.mdx", import.meta.url), "utf8")
  const markdownGuide = readFileSync(new URL("../src/content/docs/docs/guides/markdown-flows.mdx", import.meta.url), "utf8")
  const notice = readFileSync(new URL("../../../packages/smthrs-deprecation/docs/notice.md", import.meta.url), "utf8")

  assert.match(discovery, /flow\.ts[\s\S]*flow\.mdx[\s\S]*SKILL\.md/)
  assert.match(flowGuide, /flow\.ts`, `flow\.mdx`, or `SKILL\.md`/)
  assert.match(flowGuide, /chosen authoring direction[\s\S]*migration has not landed[\s\S]*scaffold writes `flow\.mdx`/)
  assert.match(markdownGuide, /scaffold writes `flows\/review\/flow\.mdx`/)
  assert.match(notice, /Neither `smthrs@next` nor `smthrs@1\.0\.0-rc\.1` is an installable\s+notice yet/)
})

test("migrate --scan rows describe the scan pipeline: planned units, nothing written", () => {
  const flow = readFileSync(new URL("../../../packages/smithers/migrate/src/flow/MigrateFlow.ts", import.meta.url), "utf8")
  const scan = readFileSync(new URL("../../../packages/smithers/migrate/src/Scan.ts", import.meta.url), "utf8")
  assert.match(flow, /if \(payload\.options\.mode !== "scan"\) \{\s*yield\* Report\.write/, "scan mode writes no report")
  assert.match(scan, /const planned = Units\.plan\(/, "the scan plans the units")

  const rows = ["../src/content/docs/docs/reference/cli/migrate.mdx", "../src/content/docs/docs/migration/1.0.mdx"]
    .map((page) => {
      const source = readFileSync(new URL(page, import.meta.url), "utf8")
      const row = /^\| `--scan` \|.*$/m.exec(source)
      assert.ok(row, `${page} carries a --scan flag row`)
      return row[0]
    })

  assert.equal(rows[0], rows[1])
  assert.doesNotMatch(rows[0], /write the report|without planning/)
  assert.match(rows[0], /plan/)
})

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

test("durable wait guide agrees with the DurableClock in-memory threshold", () => {
  const guide = readFileSync(new URL("../src/content/docs/docs/guides/durable-waits.mdx", import.meta.url), "utf8")
  const source = readFileSync(new URL("../../../packages/smithers/flows/flow/src/DurableClock.ts", import.meta.url), "utf8")
  const declared = /defaultInMemoryThreshold = Duration\.seconds\((\d+)\)/.exec(source)
  assert.ok(declared, "DurableClock declares its in-memory threshold default in seconds")
  assert.match(source, /Duration\.isLessThanOrEqualTo\(duration, inMemoryThreshold\)/)
  const documented = new RegExp(`at or below \`inMemoryThreshold\`, ${declared[1]} seconds by default`)
  assert.match(guide, documented)
  assert.doesNotMatch(guide, /parks the execution instead of holding a fiber, so the wait outlives the process/)
  assert.match(guide, /inMemoryThreshold: 0/)
  assert.match(guide, /inclusive/)
})
