import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const cli = resolve(import.meta.dirname, "../bin/smithers.mjs")
describe("npm CLI in a real jj checkout", () => {
  it("shares change and bookmark state with jj and preserves uncommitted file diffs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-cli-jj-"))
    const env = {
      ...process.env,
      JJ_USER: "CLI test",
      JJ_EMAIL: "cli@example.test",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
    }
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { cwd: directory, env, encoding: "utf8", timeout: 30000 })
    const invoke = (args: string[]) => JSON.parse(run(process.execPath, [cli, ...args, "--json"]))
    try {
      run("jj", ["git", "init"])
      await writeFile(join(directory, "hello.txt"), "hello world\n")
      run("jj", ["describe", "-m", "CLI change"])
      const status = invoke(["change", "status"])
      expect(status.working_copy.description).toBe("CLI change")
      expect(status.files).toContainEqual({ status: "A", path: "hello.txt" })
      expect(invoke(["change", "diff"]).diff).toContain("hello world")
      expect(invoke(["change", "show", "@"]).change_id).toBe(status.working_copy.change_id)
      expect(invoke(["change", "list", "--limit", "1"])[0].description).toBe("CLI change")
      expect(invoke(["change", "files", "@"]).files).toEqual(["hello.txt"])
      expect(invoke(["change", "conflicts", "@"]).conflicts).toEqual([])
      expect(invoke(["bookmark", "create", "cli-test"]).name).toBe("cli-test")
      expect(invoke(["bookmark", "list"])[0].target_change_id).toBe(status.working_copy.change_id)
      expect(invoke(["bookmark", "delete", "cli-test"]).status).toBe("deleted")
      expect(invoke(["bookmark", "list"])).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120000)
})
