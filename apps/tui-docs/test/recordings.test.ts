import * as Filegroup from "@smthrs/targets/Filegroup"
import * as Target from "@smthrs/targets/Target"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { docsText } from "../../site/scripts/docs-text.mjs"
import { runtimeInputs, tracked } from "../scripts/inputs.mjs"
import { parseScripts } from "../scripts/scripts.mjs"
import { providerFixture } from "../scripts/provider-fixture.mjs"
import { monitorCell } from "../scripts/scenarios.mjs"
import { sourceFiles } from "../scripts/targets.ts"

test("monitor recording uses HTTP judge", async () => {
  const fixture = await providerFixture({ judge: true })
  try {
    const url = fixture.env.SMITHERS_ACCOUNT_POOL_URL
    const routes = await (await fetch(url + "/routes")).json()
    assert.deepEqual(routes, { routes: ["chatgpt"] })
    const reply = async (body: object) => {
      const response = await fetch(url + "/responses", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      })
      assert.equal(response.status, 200)
      const stream = await response.text()
      return stream.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "response.output_text.delta").delta as string
    }
    const coordinator = await reply({ input: [] })
    assert.ok(coordinator.includes(monitorCell))
    assert.ok((await reply({ input: [] })).includes(monitorCell))
    const judge = await reply({
      instructions: "Judge the supplied evidence against every question.",
      input: [{ role: "user", content: [{ text: JSON.stringify({
        questions: { notable: { type: "boolean" } }
      }) }] }]
    })
    assert.match(judge, /"probability":0\.99/)
    const luna = await reply({
      instructions: "Write one line (at most 120 characters) telling the user the notable update."
    })
    assert.match(luna, /Addition checks passed\./)
    assert.deepEqual(fixture.calls, { coordinator: 2, judge: 1, luna: 1 })
  } finally {
    await fixture.close()
  }
})

test("installation page on noexec temp", () => {
  const site = new URL("../../site/", import.meta.url)
  const read = (path: string) => readFileSync(new URL(path, site), "utf8")
  const versions = JSON.parse(read("src/data/versions.json"))
  const installation = docsText(read("src/content/docs/docs/installation.mdx"), { versions })
  const tuiCli = docsText(read("src/content/docs/docs/tui/cli.mdx"), { versions })
  const cliHelp = docsText(read("src/content/docs/docs/reference/cli/tui.mdx"), {
    raw: { help0: read("src/data/help/tui.txt") },
    versions
  })

  assert.match(cliHelp, /--help/)
  assert.match(cliHelp, /--print/)
  assert.ok(
    /writable[^\n]*executable[^\n]*TMPDIR/i.test(installation),
    "installation names a writable, executable TMPDIR"
  )
  const directory = installation.match(/mkdir -p\s+(["']?)([^\s"']+)\1/)
  assert.ok(directory, "installation gives a command to create an executable writable temp directory")
  assert.ok(
    installation.includes(`export TMPDIR=${directory[1]}${directory[2]}${directory[1]}`),
    "installation exports the directory it created as TMPDIR"
  )
  assert.ok(/noexec/i.test(installation), "installation identifies a noexec temp mount")
  const openTuiFailure = /OpenTUI[\s\S]{0,200}Operation not permitted|Operation not permitted[\s\S]{0,200}OpenTUI/i
  assert.ok(openTuiFailure.test(installation), "installation maps the OpenTUI error to noexec temp")
  assert.ok(/noexec/i.test(tuiCli), "TUI CLI docs identify a noexec temp mount")
  assert.ok(openTuiFailure.test(tuiCli), "TUI CLI docs map the OpenTUI error to noexec temp")
  const runtime = tuiCli.split("## Runtime\n")[1]?.split("\n## ")[0] ?? ""
  assert.ok(
    /--help[\s\S]{0,300}--print|--print[\s\S]{0,300}--help/.test(runtime),
    "runtime explains both help and print"
  )
  assert.ok(
    /(?:--help|--print)[\s\S]{0,300}(?:without|does not|do not)[\s\S]{0,120}(?:interactive|OpenTUI)/i.test(runtime),
    "runtime says help and print avoid interactive startup"
  )
  assert.ok(
    /interactive[\s\S]{0,200}(?:starts|loads|initializes)[\s\S]{0,120}OpenTUI/i.test(runtime),
    "runtime says interactive startup loads OpenTUI"
  )
})

test("Markdown grammar rejects unsupported instructions and escaping recording IDs", () => {
  const source = "```tui-script addition\nType \"fix\"\nPress Enter\nWait for \"Fixed\"\nCapture \"done\"\n```"
  assert.equal(parseScripts(source)[0].steps.length, 4)
  assert.throws(() => parseScripts(source.replace("Press Enter", "Run rm -rf /")), /Invalid recording instruction/)
  assert.throws(() => parseScripts(source.replace("addition", "../elsewhere")), /Invalid recording id/)
  assert.throws(() => parseScripts(source.replace("Capture \"done\"\n", "")), /needs Capture/)
})

test("scripts distinguish durable answers from text and bound timing and setup", () => {
  const script = parseScripts(
    "```tui-script receipt\nUse \"basic\"\nWait for answer \"Ready.\"\nWait for worker \"review\" status \"done\"\nRestart\nCapture \"Recovered\"\n```"
  )[0]
  assert.equal(script.steps[1].kind, "Wait for answer")
  assert.equal(script.steps[2].subject, "worker")
  assert.throws(() => parseScripts("```tui-script wrong\nCapture \"x\"\nUse \"basic\"\n```"), /Use must be first/)
  assert.throws(
    () => parseScripts("```tui-script wrong\nWait 10001 ms\nCapture \"x\"\n```"),
    /Invalid recording instruction/
  )
  assert.throws(() => parseScripts("```tui-script wrong\nClick \"Run\"\nCapture \"x\"\n```"), /unsupported/)
  assert.throws(() => parseScripts("```browser-script wrong\nRestart\nCapture \"x\"\n```"), /unsupported/)
  assert.throws(
    () => parseScripts("```tui-script wrong\nExpect file \"../key\" contains \"x\"\nCapture \"x\"\n```"),
    /Invalid fixture path/
  )
})

test("recording and graph inputs include the shipped native runtime and every manifest artifact", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const prefix = "packages/smithers/vendor/opentui-native/"
  const manifest = JSON.parse(readFileSync(root + prefix + "manifest.json", "utf8")) as {
    targets: Record<string, { file: string }>
  }
  const expected = [
    "manifest.json",
    "runtime.bun.mjs",
    "runtime.node.mjs",
    "runtime.d.ts",
    "target.mjs",
    ...Object.entries(manifest.targets).flatMap(([target, artifact]) => [
      `${target}/index.bun.mjs`,
      `${target}/${artifact.file}`
    ])
  ].map((file) => prefix + file)
  const inputs = runtimeInputs()
  const graph = Filegroup.sources(Target.metadata(sourceFiles).attrs as Filegroup.Attrs)
  for (const file of expected) {
    assert(inputs.includes(file), `Recording digest omits native input ${file}`)
    assert(graph.some((source) => source._tag === "File" && source.path === file), `Target graph omits ${file}`)
    assert(readFileSync(root + file).length > 0, `Shipped native input is empty: ${file}`)
  }
  assert.equal(new Set(inputs).size, inputs.length, "Native inputs must remain deduplicated")
})

test("source inputs are the tracked files: an untracked stray never enters the row", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const before = runtimeInputs()
  const sample = before.find((file) => file.includes("/src/"))!
  const stray = root + sample.slice(0, sample.lastIndexOf("/") + 1) + `zz-stray-${process.pid}.ts`
  writeFileSync(stray, "export {}\n")
  try {
    assert.deepEqual(runtimeInputs(), before)
    assert.deepEqual(tracked(stray), [], "an absent-from-index path lists nothing")
  } finally {
    rmSync(stray, { force: true })
  }
  const indexed = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 28 }).toString().split("\0"))
  for (const file of before) assert(indexed.has(file), `input ${file} is not a tracked file`)
  assert.deepEqual(before, [...before].sort(), "inputs stay sorted")
})
