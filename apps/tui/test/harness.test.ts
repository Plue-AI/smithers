import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import * as Harness from "../src/harness.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "tui-harness-"))
  roots.push(root)
  return root
}

test("runs the workspace's claude with its own login, the arguments intact, and the SDK's settings", () => {
  const home = scratch()
  mkdirSync(join(home, "bin"))
  // A claude that reports what it was given.
  writeFileSync(
    join(home, "bin", "claude"),
    `#!/bin/sh\nprintf '%s\\n' "$@" "config=$CLAUDE_CONFIG_DIR" "home=$HOME" "entry=$CLAUDE_CODE_ENTRYPOINT" "key=$ANTHROPIC_API_KEY" "oauth=$CLAUDE_CODE_OAUTH_TOKEN"\n`,
    { mode: 0o755 }
  )
  const command = Harness.remoteCommand(
    ["-p", "say \"hi\" it's", "--output-format", "stream-json"],
    {
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CONFIG_DIR: "/laptop/.claude",
      ANTHROPIC_API_KEY: "sk-local",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-local"
    },
    home
  )
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } })
  expect(result.stdout.split("\n")).toEqual([
    "-p",
    "say \"hi\" it's",
    "--output-format",
    "stream-json",
    `config=${home}/.claude`,
    `home=${home}`,
    "entry=sdk-ts",
    "key=",
    "oauth=",
    ""
  ])
  expect(command).not.toContain("sk-ant-oat-local")
})

test("puts a claude that reaches the workspace first on PATH", () => {
  const state = scratch()
  const environment = Harness.install({ PATH: "/usr/bin", SMITHERS_TOKEN: "t" }, "acme/app/ws-1", state)
  const bin = join(state, "harness", "acme_app_ws-1", "bin")
  expect(environment).toEqual({ PATH: `${bin}${delimiter}/usr/bin`, SMITHERS_TOKEN: "t" })
  expect(statSync(join(bin, "claude")).mode & 0o111).not.toBe(0)
  expect(readFileSync(join(bin, "claude"), "utf8")).toMatch(
    /^#!\/bin\/sh\nexec bun '.+\/harness-claude\.ts' 'acme\/app\/ws-1' "\$@"\n$/
  )
})

test("passes stdin, stdout and the exit code through the workspace transport", async () => {
  const home = scratch()
  mkdirSync(join(home, "bin"))
  // A claude that echoes its input and exits 7.
  writeFileSync(join(home, "bin", "claude"), "#!/bin/sh\ncat\nexit 7\n", { mode: 0o755 })
  const script = join(scratch(), "run.ts")
  writeFileSync(
    script,
    `import { run } from ${JSON.stringify(join(import.meta.dir, "../src/harness.ts"))}\n` +
      `process.exit(await run([], {}, () => Promise.resolve(["/bin/sh", "-c", 'eval "$1"', "box"]), "box", ${
        JSON.stringify(home)
      }))\n`
  )
  const result = spawnSync("bun", [script], { input: "stream-json line\n", encoding: "utf8" })
  expect(result.stdout).toBe("stream-json line\n")
  expect(result.status).toBe(7)
  const logs = scratch()
  const lost = spawnSync("bun", [
    "-e",
    `import { run } from ${JSON.stringify(join(import.meta.dir, "../src/harness.ts"))}
process.exit(await run([], {}, () => Promise.reject(new Error("503 from the workspace API")), "box"))`
  ], { encoding: "utf8", env: { ...process.env, SMITHERS_TUI_SESSION_DIR: logs } })
  expect(lost.status).toBe(255)
  // One sentence and where the detail is; the raw cause goes only to the log.
  expect(lost.stderr).toBe(`box could not be reached. Details: ${join(logs, "tui.log")}\n`)
  expect(readFileSync(join(logs, "tui.log"), "utf8")).toContain("503 from the workspace API")
})

test("sends a SIGTERM it receives to the transport and exits 143", async () => {
  const home = scratch()
  mkdirSync(join(home, "bin"))
  writeFileSync(join(home, "bin", "claude"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 })
  const script = join(scratch(), "run.ts")
  writeFileSync(
    script,
    `import { run } from ${JSON.stringify(join(import.meta.dir, "../src/harness.ts"))}\n` +
      `process.exit(await run([], {}, () => Promise.resolve(["/bin/sh", "-c", 'exec /bin/sh -c "$1"', "box"]), "box", ${
        JSON.stringify(home)
      }))\n`
  )
  const child = Bun.spawn(["bun", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  child.kill("SIGTERM")
  expect(await child.exited).toBe(143)
  // The transport, and the claude it ran, are gone.
  expect(spawnSync("pgrep", ["-f", `${home}/bin/claude`]).status).not.toBe(0)
})
