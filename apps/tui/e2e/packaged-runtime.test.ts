/** Exercise the shipped Node bundle and compiled executable (#1987, #1991, #2006). */
import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const cli = resolve(app, "../../packages/smithers")

for (const runtime of ["node", "compiled"] as const) {
  it(`runs packaged ${runtime}: draw, external editor, chat, leaf and composed flows`, async () => {
    const built = runtime === "node"
      ? spawnSync("node", [join(cli, "scripts/build-tui.mjs")], { encoding: "utf8" })
      : spawnSync("bun", [join(cli, "scripts/build-tui-binaries.mjs"), "--single"], { encoding: "utf8" })
    expect(built.status, built.stderr).toBe(0)
    const root = mkdtempSync(join(tmpdir(), `tui-${runtime}-`))
    const installation = join(root, "installation")
    mkdirSync(installation)
    if (runtime === "node") {
      cpSync(join(cli, "dist/tui"), join(installation, "tui"), { recursive: true })
      // Relocate the host and its installed dependencies. The native package
      // has only its published helper, with no checkout target/ to fall back to.
      const modules = join(installation, "node_modules")
      mkdirSync(modules)
      for (const name of readdirSync(join(cli, "node_modules"))) {
        if (name.startsWith(".")) continue
        if (name.startsWith("@")) {
          mkdirSync(join(modules, name))
          for (const child of readdirSync(join(cli, "node_modules", name))) {
            if (name === "@smthrs" && child === "platform-node") continue
            symlinkSync(realpathSync(join(cli, "node_modules", name, child)), join(modules, name, child))
          }
        } else symlinkSync(realpathSync(join(cli, "node_modules", name)), join(modules, name))
      }
      const native = join(modules, "@smthrs/platform-node")
      const bin = join(native, "bin", `${process.platform}-${process.arch}`)
      mkdirSync(bin, { recursive: true })
      writeFileSync(
        join(native, "package.json"),
        JSON.stringify({ name: "@smthrs/platform-node", exports: { "./package.json": "./package.json" } })
      )
      cpSync(
        process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ?? resolve(cli, "../../target/release/smithers-jj-export"),
        join(bin, "smithers-jj-export")
      )
    } else {cpSync(
        join(cli, `out/tui-binaries/tui-${process.platform}-${process.arch}/bin/smithers-tui`),
        join(installation, "smithers-tui")
      )}
    const project = join(root, "project")
    cpSync(join(app, "test/fixtures/flows-project"), project, {
      recursive: true,
      filter: (path) => !path.includes(".flows") && !path.includes("node_modules")
    })
    symlinkSync(join(app, "node_modules"), join(project, "node_modules"), "dir")
    const interactiveEditor = Bun.which("vim") !== null
    const editor = interactiveEditor ? "vim -u NONE -U NONE -i NONE -n" : `printf ${runtime}-editor-prompt >`
    let tui: Tui | undefined
    try {
      tui = await Tui.start({
        cwd: project,
        command: runtime === "node"
          ? `env -u SMITHERS_WORKSPACE_JJ_EXPORT_BINARY node --experimental-ffi --disable-warning=ExperimentalWarning ${
            join(installation, "tui/main.js")
          } ${project}`
          : `env -u SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ${join(installation, "smithers-tui")} ${project}`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SMITHERS_TUI_REPLAY: join(app, "test/fixtures/pong.jsonl"),
          SMITHERS_TUI_SESSION_DIR: join(root, "sessions"),
          VISUAL: editor,
          EDITOR: editor
        }
      })
      await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 20_000, `${runtime} first draw`)
      await tui.press("\x07")
      if (interactiveEditor) {
        await tui.until(
          (screen) => screen.includes("prompt.md") && !/↑\S+ ↓\S+/.test(screen),
          5_000,
          `${runtime} Vim foreground`
        )
        await tui.resize(80, 20)
        await tui.press(key.ctrlC)
        await tui.press(`i${runtime}-editor-prompt`)
        await tui.press(key.escape)
        await tui.press(":wq" + key.enter)
      }
      await tui.until(
        (screen) => screen.includes(`${runtime}-editor-prompt`),
        10_000,
        `external editor under ${runtime}`
      )
      if (interactiveEditor) {
        await tui.until((screen) => /↑\S+ ↓\S+/.test(screen.split("\n")[19] ?? ""), 5_000, `${runtime} editor resize`)
        await tui.resize(110, 40)
      }
      await tui.press(key.enter)
      await tui.until(
        (screen) => /pong/i.test(screen) && screen.includes("Done") && !screen.includes("esc Interrupt"),
        30_000,
        `${runtime} chat`
      )
      await tui.type(`/flow echo text="${runtime} dynamic flow result"`)
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("✓ echo"), 30_000, "dynamic flow completed")
      await tui.press(key.ctrlBracket + key.ctrlBracket)
      const result = await tui.until(
        (screen) => screen.includes(`${runtime} dynamic flow result`),
        5_000,
        "persisted flow result"
      )
      expect(result).not.toContain("does not drive")
      expect(result).not.toContain("r Resume")
      expect(result).not.toContain("x Stop")
      await tui.press("rx")
      expect(tui.screen()).not.toContain("Only a failed")
      await tui.click("Chat")
      await tui.type("/flow composed")
      await tui.press(key.enter)
      await tui.until((screen) => /[✓✗] composed/.test(screen), 30_000, "composed flow settled")
      await tui.click("composed")
      const composed = await tui.until(
        (screen) => screen.includes("composed action callback output") || screen.includes("composed · failed"),
        5_000,
        "composed flow outcome"
      )
      expect(composed).toContain("composed action callback output")
      expect(composed).toContain("composed · done")
      expect(composed).not.toContain("does not drive")
      expect(composed).not.toContain("✗ composed")
    } catch (error) {
      const log = join(root, "sessions/tui.log")
      throw new Error(`${error}\n${existsSync(log) ? readFileSync(log, "utf8") : "No diagnostic log"}`, {
        cause: error
      })
    } finally {
      await tui?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
}
