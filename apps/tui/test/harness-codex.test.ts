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
  const root = mkdtempSync(join(tmpdir(), "tui-harness-codex-"))
  roots.push(root)
  return root
}

test("runs workspace Codex with intact arguments and the workspace's own login environment", () => {
  const home = scratch()
  mkdirSync(join(home, "bin"))
  writeFileSync(
    join(home, "bin", "codex"),
    `#!/bin/sh
printf '%s\\n' "$@" "home=$HOME" "codex=$CODEX_HOME" "key=$OPENAI_API_KEY" "token=$CODEX_AUTH_TOKEN" "chatgpt=$CHATGPT_TOKEN" "smithers=$SMITHERS_TOKEN"
`,
    { mode: 0o755 }
  )
  const command = Harness.remoteCommand(
    ["exec", "say \"hi\" it's", "--json"],
    {
      HOME: "/laptop",
      CODEX_HOME: "/laptop/.codex",
      OPENAI_API_KEY: "local-openai-secret",
      CODEX_AUTH_TOKEN: "local-codex-secret",
      CHATGPT_TOKEN: "local-chatgpt-secret",
      SMITHERS_TOKEN: "local-smithers-secret"
    },
    home,
    "codex"
  )
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } })
  expect(result.status).toBe(0)
  expect(result.stdout.split("\n")).toEqual([
    "exec",
    "say \"hi\" it's",
    "--json",
    `home=${home}`,
    `codex=${home}/.codex`,
    "key=",
    "token=",
    "chatgpt=",
    "smithers=",
    ""
  ])
  expect(command).not.toContain("local-")
  expect(command).not.toContain("/laptop")
  expect(command).not.toContain("auth.json")
})

test("installs executable Codex and Claude wrappers before the original PATH", () => {
  const state = scratch()
  const env = Harness.install({ PATH: "/usr/bin", SMITHERS_TOKEN: "t" }, "acme/app/ws-1", state)
  const bin = join(state, "harness", "acme_app_ws-1", "bin")
  expect(env).toEqual({ PATH: `${bin}${delimiter}/usr/bin`, SMITHERS_TOKEN: "t" })
  for (const vendor of ["codex", "claude"]) {
    expect(statSync(join(bin, vendor)).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(bin, vendor), "utf8")).toContain("'acme/app/ws-1'")
  }
  const missing = spawnSync("bun", [join(import.meta.dir, "../src/harness-cli.ts")], { encoding: "utf8" })
  expect(missing.status).toBe(2)
  expect(missing.stderr).toContain("usage:")
})

test("passes Codex stdin, stderr, stdout and failure exit through the transport", () => {
  const home = scratch()
  mkdirSync(join(home, "bin"))
  writeFileSync(join(home, "bin", "codex"), "#!/bin/sh\ncat\nprintf 'vendor failure\\n' >&2\nexit 7\n", { mode: 0o755 })
  const script = join(scratch(), "run.ts")
  writeFileSync(
    script,
    `import { run } from ${JSON.stringify(join(import.meta.dir, "../src/harness.ts"))}
process.exit(await run(["exec", "--json", "-"], {}, () => Promise.resolve(["/bin/sh", "-c", 'eval "$1"', "box"]), "box", ${
      JSON.stringify(home)
    }, "codex"))
`
  )
  const result = spawnSync("bun", [script], { input: "prompt shaped like --flag\n", encoding: "utf8" })
  expect(result.stdout).toBe("prompt shaped like --flag\n")
  expect(result.stderr).toBe("vendor failure\n")
  expect(result.status).toBe(7)
})

test("forwards cancellation to the Codex transport", async () => {
  const home = scratch()
  mkdirSync(join(home, "bin"))
  writeFileSync(
    join(home, "bin", "codex"),
    `#!/bin/sh
echo $$ > '${home}/pid'
exec sleep 60
`,
    { mode: 0o755 }
  )
  const script = join(scratch(), "run.ts")
  writeFileSync(
    script,
    `import { run } from ${JSON.stringify(join(import.meta.dir, "../src/harness.ts"))}
process.exit(await run([], {}, () => Promise.resolve(["/bin/sh", "-c", 'exec /bin/sh -c "$1"', "box"]), "box", ${
      JSON.stringify(home)
    }, "codex"))
`
  )
  const child = Bun.spawn(["bun", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  let pid = 0
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        pid = Number(readFileSync(join(home, "pid"), "utf8"))
        break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(pid).toBeGreaterThan(0)
    child.kill("SIGTERM")
    expect(await child.exited).toBe(143)
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    child.kill()
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
})
