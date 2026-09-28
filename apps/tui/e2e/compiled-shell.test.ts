/** Shell selection must also work in the standalone compiled runtime (#2056). */
import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

it("runs compiled shell commands with an unset or empty SHELL and no Bash on PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-compiled-shell-"))
  try {
    const binary = join(root, "shell")
    const built = await Bun.build({
      entrypoints: ["probe.ts"],
      files: {
        "probe.ts": `
          import { run } from ${JSON.stringify(resolve(import.meta.dir, "../src/shell.ts"))}
          const result = await run({
            command: "printf '%s 中文 🦉' \\\"$0\\\"",
            cwd: process.cwd(),
            onOutput: () => {}
          }).done
          console.log(JSON.stringify(result))
        `
      },
      compile: {
        outfile: binary,
        autoloadPackageJson: false,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false
      }
    })
    expect(built.success, built.logs.map(String).join("\n")).toBe(true)
    for (const env of [{ PATH: "" }, { PATH: "", SHELL: "" }]) {
      const result = spawnSync(binary, [], { cwd: root, env, encoding: "utf8", timeout: 20_000 })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        exitCode: 0,
        output: "/bin/sh 中文 🦉",
        cancelled: false
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
