import * as Filegroup from "@smthrs/targets/Filegroup"
import * as Target from "@smthrs/targets/Target"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { docsText } from "../../site/scripts/docs-text.mjs"
import { launchOptions } from "../scripts/browser.mjs"
import { runtimeInputs, tracked, trackedPath, walk } from "../scripts/inputs.mjs"
import { providerFixture } from "../scripts/provider-fixture.mjs"
import { monitorCell } from "../scripts/scenarios.mjs"
import { parseScripts } from "../scripts/scripts.mjs"
import { sourceFiles } from "../scripts/targets.ts"

test("monitor recording uses HTTP judge", async () => {
  const fixture = await providerFixture({ judge: true })
  try {
    const url = fixture.env.SMITHERS_ACCOUNT_POOL_URL
    const routes = await (await fetch(url + "/routes")).json()
    assert.deepEqual(routes, { routes: ["chatgpt"] })
    const reply = async (body: object) => {
      const response = await fetch(url + "/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
      assert.equal(response.status, 200)
      const stream = await response.text()
      return stream.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "response.output_text.delta")
        .delta as string
    }
    const coordinator = await reply({ input: [] })
    assert.ok(coordinator.includes(monitorCell))
    assert.ok((await reply({ input: [] })).includes(monitorCell))
    const judge = await reply({
      instructions: "Judge the supplied evidence against every question.",
      input: [{
        role: "user",
        content: [{
          text: JSON.stringify({
            questions: { notable: { type: "boolean" } }
          })
        }]
      }]
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
  const indexed = new Set(
    execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 28 }).toString().split("\0")
  )
  for (const file of before) assert(indexed.has(file), `input ${file} is not a tracked file`)
  assert.deepEqual(before, [...before].sort(), "inputs stay sorted")
})

test("recording directory enumeration includes nested files deterministically and excludes Python caches", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-docs-walk-inputs-"))
  try {
    mkdirSync(join(root, "nested", "__pycache__"), { recursive: true })
    writeFileSync(join(root, "z.ts"), "top\n")
    writeFileSync(join(root, "nested", "a.ts"), "nested\n")
    writeFileSync(join(root, "nested", "__pycache__", "compiled.pyc"), "cache\n")
    assert.deepEqual(walk(root), [join(root, "nested", "a.ts"), join(root, "z.ts")])
    assert.deepEqual(walk(join(root, "missing")), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("tracked filesets use repository-relative slash paths on Windows", () => {
  assert.equal(trackedPath("C:\\repo\\src\\a space.ts", "C:\\repo"), "src/a space.ts")
  assert.equal(trackedPath("C:\\repo", "C:\\repo"), ".")
  assert.equal(trackedPath("\\\\server\\repo\\src\\index.ts", "\\\\server\\repo"), "src/index.ts")
  assert.equal(trackedPath("/repo/src/a space.ts", "/repo"), "src/a space.ts")
})

test("tracked inputs preserve Git index membership and NUL-delimited names", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-docs-git-inputs-"))
  try {
    execFileSync("git", ["init", "--quiet", root])
    const directory = join(root, "src")
    mkdirSync(join(directory, "__pycache__"), { recursive: true })
    const names = ["z.ts", "a space.ts", "line\nbreak.ts", "removed.ts", "__pycache__/ignored.pyc"]
    for (const name of names) writeFileSync(join(directory, name), "tracked\n")
    execFileSync("git", ["add", "src"], { cwd: root })
    writeFileSync(join(directory, "stray.ts"), "untracked\n")
    rmSync(join(directory, "removed.ts"))
    const expected = names.slice(0, 3).map((name) => join(directory, name)).sort((a, b) => a.localeCompare(b))
    assert.deepEqual(tracked(directory, root), expected)
    assert.deepEqual(tracked(directory, root), expected)
    assert.deepEqual(tracked(join(directory, "stray.ts"), root), [])
    assert.deepEqual(tracked(join(root, "missing"), root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("non-colocated jj inputs read the existing snapshot without tracking dirty strays", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-docs-jj-inputs-"))
  const jj = (args: string[]) =>
    execFileSync("jj", [
      "--config",
      "user.name=Fixture",
      "--config",
      "user.email=fixture@example.invalid",
      ...args
    ], { cwd: root, encoding: "utf8" })
  try {
    jj(["git", "init", "--no-colocate", "."])
    assert.equal(existsSync(join(root, ".git")), false)
    const directory = join(root, "src")
    mkdirSync(join(directory, "__pycache__"), { recursive: true })
    const names = ["z.ts", "a space.ts", "line\nbreak.ts", "removed.ts", "__pycache__/ignored.pyc"]
    for (const name of names) writeFileSync(join(directory, name), "tracked\n")
    jj(["status"])
    const identity = () => jj(["log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", "commit_id"])
    const before = identity()
    writeFileSync(join(directory, "stray.ts"), "untracked\n")
    rmSync(join(directory, "removed.ts"))
    const expected = names.slice(0, 3).map((name) => join(directory, name)).sort((a, b) => a.localeCompare(b))
    assert.deepEqual(tracked(directory, root), expected)
    assert.deepEqual(tracked(directory, root), expected)
    assert.deepEqual(tracked(join(directory, "stray.ts"), root), [])
    assert.deepEqual(tracked(join(root, "missing"), root), [])
    assert.equal(identity(), before, "enumeration must not mutate the jj snapshot")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("broken jj metadata refuses input enumeration instead of walking files or falling back to Git", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-docs-broken-inputs-"))
  try {
    execFileSync("git", ["init", "--quiet", root])
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "tracked.ts"), "tracked\n")
    execFileSync("git", ["add", "src"], { cwd: root })
    mkdirSync(join(root, ".jj"))
    assert.throws(() => tracked(join(root, "src"), root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("public ci planning discovers unrelated engine-store targets in a non-colocated jj workspace", () => {
  const repository = fileURLToPath(new URL("../../../", import.meta.url))
  const root = mkdtempSync(join(tmpdir(), "tui-docs-jj-plan-"))
  const put = (path: string, content: string | Buffer) => {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  try {
    // Only declarations and the input helper are needed for discovery/planning;
    // no source checkout, dependency installation, or target execution occurs.
    put("package.json", JSON.stringify({ name: "jj-input-fixture", private: true, type: "module" }))
    put("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/smithers/flows/*\n")
    put("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters: {}\n")
    put(".gitignore", "node_modules\n.flows\nhome\n")
    put(
      ".smithers/WORKSPACE.ts",
      `
      import { Smithers as S } from '@smthrs/targets'
      const runtime = S.Runtime.Node({ version: '>=26.4.0' })
      export const Workspace = S.Workspace('jj-input-fixture', {
        repository: 'git+https://example.invalid/fixture.git',
        cache: S.Cache({ directory: '.flows' }), runtime,
        packageManager: S.PackageManager.Pnpm({ version: '11.25.0', runtime }),
        nodeModules: S.Npm.NodeModules({ packageJson: S.file('//package.json'), workspaces: S.file('//pnpm-workspace.yaml') })
      })
    `
    )
    put("apps/tui/package.json", JSON.stringify({ name: "smithers-tui", type: "module", dependencies: {} }))
    put("apps/tui/src/index.ts", "export const fixture = true\n")
    put("apps/tui-docs/package.json", JSON.stringify({ name: "@smithers/tui-docs", type: "module", dependencies: {} }))
    put("apps/tui-docs/scripts/inputs.mjs", readFileSync(join(repository, "apps/tui-docs/scripts/inputs.mjs")))
    put("scripts/workspace-packages.mjs", readFileSync(join(repository, "scripts/workspace-packages.mjs")))
    put(
      "apps/tui-docs/PACKAGE.ts",
      `
      import { Smithers as S } from '@smthrs/targets'
      import { runtimeInputs } from './scripts/inputs.mjs'
      export const Package = S.Package({ targets: { sources: S.Filegroup({ srcs: runtimeInputs().map(p => S.file('//'+p)) }) } })
    `
    )
    const engine = "packages/smithers/flows/engine-store"
    put(engine + "/PACKAGE.ts", `export { Package } from ${JSON.stringify(join(repository, engine, "PACKAGE.ts"))}`)
    put(engine + "/package.json", readFileSync(join(repository, engine, "package.json")))
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir")
    mkdirSync(join(root, "home"))
    execFileSync("jj", ["git", "init", "--no-colocate", "."], { cwd: root })
    execFileSync("jj", ["--config", "user.name=Fixture", "--config", "user.email=fixture@example.invalid", "status"], {
      cwd: root
    })
    assert.equal(existsSync(join(root, ".git")), false)
    const testTarget = "//" + engine + ":test",
      checkTarget = "//" + engine + ":check",
      libTarget = "//" + engine + ":lib"
    const output = execFileSync(process.execPath, [
      join(repository, "packages/smithers/src/bin.ts"),
      "ci",
      testTarget,
      checkTarget,
      "--jobs",
      "2",
      "--no-cache",
      "--plan",
      "--format",
      "json",
      "--verbose"
    ], {
      cwd: root,
      env: { ...process.env, HOME: join(root, "home") },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1 << 24
    })
    const plan = JSON.parse(output)
    assert.equal(plan.verb, "ci")
    assert.deepEqual(plan.roots, [checkTarget, testTarget])
    assert.deepEqual(plan.targets.map((target: { label: string }) => target.label), [
      libTarget,
      checkTarget,
      testTarget
    ])
    assert.deepEqual(plan.edges, [{ from: libTarget, to: checkTarget }, { from: libTarget, to: testTarget }])
    assert.deepEqual(plan.warnings, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("recording browser: CHROME_BIN, then macOS Chrome, then chromium on PATH, then Playwright", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-docs-chromium-"))
  try {
    const empty = join(dir, "empty"), folder = join(dir, "folder"), bin = join(dir, "bin")
    mkdirSync(join(folder, "chromium"), { recursive: true })
    for (const [path, mode] of [[join(empty, "chromium"), 0o644], [join(bin, "chromium"), 0o755]] as const) {
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, "#!/bin/sh\n")
      chmodSync(path, mode)
    }
    const PATH = ["", empty, folder, bin].join(delimiter)
    assert.deepEqual(launchOptions({ CHROME_BIN: "/opt/chrome", PATH }, "linux"), {
      headless: true,
      executablePath: "/opt/chrome"
    })
    assert.deepEqual(launchOptions({ PATH }, "darwin"), {
      headless: true,
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    })
    // A non-executable `chromium` and a `chromium/` directory earlier on PATH are skipped.
    assert.deepEqual(launchOptions({ PATH }, "linux"), { headless: true, executablePath: join(bin, "chromium") })
    assert.deepEqual(launchOptions({ PATH: [empty, folder].join(delimiter) }, "linux"), { headless: true })
    assert.deepEqual(launchOptions({}, "linux"), { headless: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
