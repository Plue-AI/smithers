import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tui } from "../e2e/tmux.ts"

it("isolates tmux panes, preserves raw UTF-8 input, resizes, and retains the exit status", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-driver-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      command:
        "sh -c 'stty -echo; printf ready; read value; printf \"\\033[38;2;48;200;120m\\n%s\\033[0m\\n\" \"$value\"; exit 7'"
    })
    await tui.until((screen) => screen.includes("ready"))
    await tui.resize(60, 12)
    await tui.press("日本語 🦉\r")
    expect((await tui.waitForExit()).code).toBe(7)
    expect(tui.screen()).toContain("日本語 🦉")
    expect(tui.screen().split("\n")).toHaveLength(12)
    const html = await tui.html()
    const rows = [...html.matchAll(/<div>(.*?)<\/div>/g)].map((match) =>
      match[1]!.replace(/<[^>]*>/g, "").replaceAll("&lt;", "<").replaceAll("&amp;", "&").trimEnd()
    )
    expect(rows).toEqual(tui.screen().split("\n").map((row) => row.trimEnd()))
    expect(html).toContain("color:#30c878")
    expect(readdirSync(root)).toEqual([])
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

it("stops a HUP-resistant pane descendant without touching unrelated processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-driver-cleanup-"))
  const childFile = join(root, "child.pid")
  writeFileSync(
    join(root, "child.cjs"),
    "require(\"node:fs\").writeFileSync(\"child.pid\", String(process.pid));" +
      "process.on(\"SIGHUP\", () => {}); process.on(\"SIGTERM\", () => {});" +
      "setInterval(() => {}, 1000)\n"
  )
  const unrelated = spawn("sleep", ["30"], { stdio: "ignore" })
  let tui: Tui | undefined
  let child: number | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      command: "/bin/sh -c 'node child.cjs & wait'",
      env: { PATH: process.env.PATH ?? "" }
    })
    await tui.until(() => existsSync(childFile), 5_000, "resistant child")
    const pid = Number(readFileSync(childFile, "utf8"))
    child = pid
    expect(() => process.kill(pid, 0)).not.toThrow()
    await tui.stop()
    await Bun.sleep(100)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
  } finally {
    await tui?.stop()
    if (child !== undefined) {
      try {
        process.kill(child, "SIGKILL")
      } catch { /* The driver already stopped it. */ }
    }
    unrelated.kill("SIGKILL")
    rmSync(root, { recursive: true, force: true })
  }
})
