/** Execute the docs' scripts in the actual TUI. Cache only after every assertion succeeds. */
import xterm from "@xterm/headless"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { launchOptions } from "./browser.mjs"
import { recordBrowser } from "./browser-record.mjs"
import { runtimeInputs } from "./inputs.mjs"
import { providerFixture } from "./provider-fixture.mjs"
import { prepare } from "./scenarios.mjs"
import { collectScripts, keys } from "./scripts.mjs"
const here = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(here, "../.."),
  tuiRoot = join(root, "apps/tui")
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) =>
    ["node_modules", ".git", ".astro", ".cache", "dist"].includes(e.name)
      ? []
      : e.isDirectory()
      ? walk(join(dir, e.name))
      : [join(dir, e.name)]
  )
const scripts = collectScripts(join(tuiRoot, "docs"))
const output = join(here, "public/recordings"), cache = join(here, ".cache/recordings")
mkdirSync(output, { recursive: true })
mkdirSync(cache, { recursive: true })
const hash = createHash("sha256")
// Source bytes, fixture, lockfile, capture code, and tool versions all invalidate the local artifact cache.
for (
  const file of [
    ...runtimeInputs().map((file) => join(root, file)),
    ...walk(join(here, "scripts")),
    ...walk(join(here, "server")),
    join(here, "astro.config.mjs"),
    join(tuiRoot, "test/fixtures/fix-add.jsonl"),
    join(tuiRoot, "test/fixtures/flows-project/flows/echo/flow.ts"),
    join(tuiRoot, "test/fixtures/flows-project/flows/consequential/flow.ts"),
    join(root, "pnpm-lock.yaml")
  ]
) {
  hash.update(file.slice(root.length))
  hash.update(readFileSync(file))
}
const bun = process.env.SMITHERS_DOCS_BUN || "bun", ffmpeg = process.env.FFMPEG || "ffmpeg"
for (
  const [tool, args] of [[bun, ["--version"]], [ffmpeg, ["-version"]], ["python3", ["--version"]], ["git", [
    "--version"
  ]]]
) {
  const result = spawnSync(tool, args, { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`Recording requires ${tool}`)
  hash.update(result.stdout.split("\n")[0])
}
if (process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY) {
  hash.update(readFileSync(process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY))
}
hash.update(process.version + process.platform + process.arch)
const base = hash.digest("hex")
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Remove assets whose script was removed; retain the committed directory marker.
for (const file of readdirSync(output)) {
  if (file !== ".gitkeep" && !scripts.has(file.replace(/\.(gif|png|txt|json)$/, ""))) rmSync(join(output, file))
}
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]?.split(",") : undefined
let browser
try {
  for (const script of scripts.values()) {
    if (only && !only.includes(script.id)) continue
    if (script.kind === "browser") continue
    const digest = createHash("sha256").update(base).update(JSON.stringify(script)).digest("hex")
    const dir = join(cache, digest), receiptFile = join(dir, "receipt.json")
    const valid = () => {
      if (!existsSync(receiptFile)) return false
      let receipt
      try {
        receipt = JSON.parse(readFileSync(receiptFile, "utf8"))
      } catch {
        return false
      }
      return ["gif", "txt", "png"].every((ext) =>
        existsSync(join(dir, `demo.${ext}`)) &&
        createHash("sha256").update(readFileSync(join(dir, `demo.${ext}`))).digest("hex") === receipt[ext]
      )
    }
    if (!valid()) {
      console.log(`record ${script.id}`)
      const scratch = mkdtempSync(join(tmpdir(), "smithers-docs-")),
        work = join(scratch, "workspace"),
        frames = join(scratch, "frames")
      mkdirSync(work)
      mkdirSync(frames)
      const scenario = script.steps[0]?.kind === "Use" ? script.steps[0].value : "fix-add"
      const setup = prepare(scenario, { root, work, scratch })
      const provider = await providerFixture({ judge: setup.judge })
      let terminal, child, closed, stopped, stderr
      const launch = async (resume = false) => {
        terminal = new xterm.Terminal({ cols: 100, rows: 28, allowProposedApi: true })
        child = spawn("python3", [join(here, "scripts/terminal_capture.py")], { stdio: ["pipe", "pipe", "pipe"] })
        stderr = ""
        stopped = false
        child.stderr.on("data", (b) => {
          stderr += b
        })
        closed = new Promise((resolve) =>
          child.on("exit", () => {
            stopped = true
            resolve()
          })
        )
        const target = terminal
        createInterface({ input: child.stdout }).on(
          "line",
          (line) => target.write(Buffer.from(JSON.parse(line).data, "base64"))
        )
        child.stdin.write(
          JSON.stringify({
            cwd: work,
            argv: [bun, join(tuiRoot, "src/main.tsx"), work, ...setup.args, ...(resume ? ["-c"] : [])],
            env: {
              PATH: process.env.PATH,
              HOME: scratch,
              TMPDIR: scratch,
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
              ...(scenario === "monitor" ? {} : {
                SMITHERS_TUI_REPLAY: setup.replay,
                SMITHERS_TUI_REPLAY_SPEED: "20"
              }),
              SMITHERS_TUI_SESSION_DIR: join(scratch, "sessions"),
              ...(process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
                ? { SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY }
                : {}),
              ...setup.env,
              ...provider?.env
            }
          }) + "\n"
        )
      }
      const stop = async () => {
        child.stdin.end()
        const timer = setTimeout(() => child.kill("SIGTERM"), 5000)
        await closed
        clearTimeout(timer)
        terminal.dispose()
      }
      await launch()
      const screen = () =>
        Array.from(
          { length: 28 },
          (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? ""
        ).join("\n")
      const until = async (text) => {
        const end = Date.now() + 40_000
        while (!screen().includes(text)) {
          if (stopped || Date.now() > end) throw new Error(`Waiting for ${text}: ${stderr}\n${screen()}`)
          await sleep(100)
        }
      }
      const records = () =>
        existsSync(join(scratch, "sessions"))
          ? walk(join(scratch, "sessions")).filter((file) => file.endsWith(".jsonl")).flatMap((file) =>
            readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
              try {
                return [JSON.parse(line)]
              } catch {
                return []
              }
            })
          )
          : []
      const waitReceipt = async (description, check) => {
        const deadline = Date.now() + 60_000
        while (!check(records())) {
          if (stopped || Date.now() > deadline) {
            throw new Error(`Waiting for receipt ${description}: ${stderr}\n${screen()}`)
          }
          await sleep(100)
        }
        await sleep(350)
      }
      const send = (data) => child.stdin.write(JSON.stringify({ input: Buffer.from(data).toString("base64") }) + "\n")
      const captured = []
      try {
        if (scenario !== "print") {
          await until("↑")
          await sleep(1000)
        }
        if (!browser) {
          browser = await chromium.launch(launchOptions())
        }
        const page = await browser.newPage({ viewport: { width: 880, height: 480 }, deviceScaleFactor: 1 })
        const capture = async (label) => {
          await sleep(200)
          const buffer = terminal.buffer.active, rows = []
          for (let row = 0; row < 28; row++) {
            let html = ""
            const line = buffer.getLine(buffer.viewportY + row)
            for (let col = 0; col < 100; col++) {
              const cell = line?.getCell(col)
              if (!cell || cell.getWidth() === 0) continue
              const fg = cell.isFgRGB() ? `#${cell.getFgColor().toString(16).padStart(6, "0")}` : "#d6deeb"
              const bg = cell.isBgRGB() ? `#${cell.getBgColor().toString(16).padStart(6, "0")}` : "transparent"
              html += `<span style="color:${fg};background:${bg}">${escape(cell.getChars() || " ")}</span>`
            }
            rows.push(html)
          }
          await page.setContent(
            `<body style="margin:0;background:#011627;color:#d6deeb"><pre style="margin:0;padding:10px;font:13px/16px Menlo,monospace">${
              rows.join("\n")
            }</pre>`
          )
          await page.screenshot({ path: join(frames, `${String(captured.length).padStart(3, "0")}.png`) })
          captured.push(`${label}\n${screen()}`)
        }
        for (const step of script.steps) {
          if (step.kind === "Type") {
            send(step.value)
            await sleep(150)
          }
          if (step.kind === "Press") {
            send(keys[step.value] ?? step.value)
            await sleep(200)
            if (step.value === "Enter") await capture("Requested")
          }
          if (step.kind === "Wait for") await until(step.value)
          if (step.kind === "Wait for answer") {
            await waitReceipt(
              step.value,
              (rows) =>
                rows.some((row) =>
                  row.type === "outcome" && row.outcome._tag === "done" && row.outcome.answer?.includes(step.value)
                )
            )
          }
          if (step.kind === "Wait for status") {
            await waitReceipt(`${step.subject} ${step.id} ${step.value}`, (rows) => {
              const latest = rows.filter((row) =>
                step.subject === "worker"
                  ? row.type === "tab" && row.tab.id === step.id
                  : row.type === "monitor" && row.monitor.id === step.id
              ).at(-1)
              return (step.subject === "worker" ? latest?.tab.status : latest?.monitor.status) === step.value
            })
          }
          if (step.kind === "Wait") await sleep(step.value)
          if (step.kind === "Expect file") {
            if (
              !/^[a-zA-Z0-9_.-]+$/.test(step.path) || !readFileSync(join(work, step.path), "utf8").includes(step.value)
            ) throw new Error(`File assertion failed: ${step.path} contains ${step.value}`)
          }
          if (step.kind === "Restart") {
            await stop()
            await launch(true)
            await until("↑")
            await sleep(700)
          }
          if (step.kind === "Capture") await capture(step.value)
        }
        if (scenario === "fix-add" && spawnSync(process.execPath, ["check.mjs"], { cwd: work }).status !== 0) {
          throw new Error("The recorded agent did not fix the check")
        }
        if (scenario === "monitor") {
          const rows = records()
          const monitor = rows.filter((row) => row.type === "monitor" && row.monitor.id === "checks").at(-1)?.monitor
          const updates = rows.filter((row) => row.type === "monitor-update" && row.id === "checks" && !row.failed)
          if (JSON.stringify(provider.calls) !== JSON.stringify({ coordinator: 2, judge: 1, luna: 1 }) ||
              updates.length !== 1 || monitor?.updates !== 1 || monitor.status !== "stopped") {
            throw new Error(`Monitor recording receipts: ${JSON.stringify({ calls: provider.calls, updates, monitor })}`)
          }
        }
        if (scenario === "monitor-refusal") {
          const monitor = records().filter((row) => row.type === "monitor" && row.monitor.id === "checks").at(-1)?.monitor
          if (monitor?.status !== "failed" || monitor.failure?._tag !== "JevFailed" ||
              Object.values(provider.calls).some((count) => count !== 0)) {
            throw new Error(`Monitor refusal receipts: ${JSON.stringify({ calls: provider.calls, monitor })}`)
          }
        }
        await page.close()
        const staging = mkdtempSync(join(cache, `${digest}.`))
        const encoded = spawnSync(ffmpeg, [
          "-v",
          "error",
          "-y",
          "-framerate",
          "1/2",
          "-i",
          join(frames, "%03d.png"),
          "-filter_complex",
          "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
          "-loop",
          "0",
          join(staging, "demo.gif")
        ], { encoding: "utf8" })
        if (encoded.status !== 0) throw new Error(encoded.stderr)
        writeFileSync(join(staging, "demo.txt"), captured.join("\n\n"))
        copyFileSync(join(frames, `${String(captured.length - 1).padStart(3, "0")}.png`), join(staging, "demo.png"))
        const receipt = {
          digest,
          script: script.id,
          scenario,
          captions: captured.map((frame) => frame.split("\n")[0]),
          ...Object.fromEntries(
            ["gif", "txt", "png"].map(
              (ext) => [ext, createHash("sha256").update(readFileSync(join(staging, `demo.${ext}`))).digest("hex")]
            )
          )
        }
        writeFileSync(join(staging, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
        rmSync(dir, { recursive: true, force: true })
        renameSync(staging, dir)
      } catch (error) {
        writeFileSync(join(cache, `${script.id}.failure.json`), JSON.stringify(records(), null, 2))
        throw error
      } finally {
        await stop()
        await provider?.close()
        rmSync(scratch, { recursive: true, force: true })
      }
    } else console.log(`cache hit ${script.id}`)
    for (const ext of ["gif", "txt", "png"]) copyFileSync(join(dir, `demo.${ext}`), join(output, `${script.id}.${ext}`))
    copyFileSync(receiptFile, join(output, `${script.id}.json`))
  }
  await recordBrowser({
    scripts: [...scripts.values()].filter((script) => script.kind === "browser" && (!only || only.includes(script.id))),
    base,
    here,
    output,
    cache,
    ffmpeg
  })
} finally {
  await browser?.close()
}
