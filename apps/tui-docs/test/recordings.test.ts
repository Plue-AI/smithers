import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { docsText } from "../../site/scripts/docs-text.mjs"
import { parseScripts } from "../scripts/scripts.mjs"

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
