import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smthrs-environment-cli-")))
  roots.push(root)
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    PATH: process.env.PATH ?? "",
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 })
  return { root, env, cli }
}

describe("environment CLI process boundary", () => {
  it("reports missing commands and execution directories as actionable launch failures", async () => {
    const { root, cli } = await fixture()
    expect(cli(["environment", "add", "local", "--local", "--directory", root]).status).toBe(0)
    const missing = cli(["environment", "exec", "local", "--", "absent-smithers-release-audit-command"])
    expect(missing.status).toBe(1)
    expect(missing.stdout).toContain("environment_command_not_found")
    expect(missing.stdout).toContain("absent-smithers-release-audit-command")
    expect(missing.stdout).toContain("on PATH")
    expect(missing.stdout).not.toContain("Not your fault")
    const absent = join(root, "absent-directory")
    expect(cli(["environment", "add", "missing", "--local", "--directory", absent]).status).toBe(0)
    const missingDirectory = cli(["environment", "exec", "missing", "--", process.execPath, "--version"])
    expect(missingDirectory.status).toBe(1)
    expect(missingDirectory.stdout).toContain("environment_directory_not_found")
    expect(missingDirectory.stdout).toContain(absent)
    const plain = join(root, "not-executable")
    await writeFile(plain, "#!/bin/sh\n")
    const denied = cli(["environment", "exec", "local", "--", plain])
    expect(denied.status).toBe(1)
    expect(denied.stdout).toContain("environment_command_permission_denied")
    expect(denied.stdout).toContain(plain)
  })

  it("adds, views, lists and removes a local environment across processes", async () => {
    const { root, cli } = await fixture()
    const added = cli(["environment", "add", "dev", "--local", "--directory", root])
    expect(added.status, added.stdout + added.stderr).toBe(0)
    const viewed = cli(["environment", "view", "dev"])
    expect(viewed.status, viewed.stderr).toBe(0)
    expect(viewed.stdout).toContain(root)
    expect(cli(["environment", "list"]).stdout).toContain("dev")
    expect(cli(["environment", "remove", "dev"]).status).toBe(0)
    expect(cli(["environment", "view", "dev"]).status).not.toBe(0)
  })

  it("passes the complete raw exec tail and propagates the child's failure", async () => {
    const { root, cli } = await fixture()
    expect(cli(["environment", "add", "dev", "--local", "--directory", root]).status).toBe(0)
    const output = join(root, "args.json")
    const args = [
      "",
      "--terminal",
      "--help",
      "--verbose",
      "--verbose=false",
      "--format",
      "json",
      "two words",
      "$(touch injected)",
      "; touch injected"
    ]
    const result = cli([
      "environment",
      "exec",
      "dev",
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)));process.exit(19)",
      output,
      ...args
    ])
    expect(result.status, result.stdout + result.stderr).toBe(19)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(args)
    await expect(readFile(join(root, "injected"))).rejects.toThrow()
  })

  it("routes the existing TUI executable through the selected environment", async () => {
    const { root, env, cli } = await fixture()
    const home = join(root, "native-home")
    const executables = join(root, "bin")
    const receipt = join(root, "tui.json")
    await mkdir(executables)
    await writeFile(
      join(executables, "smthrs"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${
        JSON.stringify(receipt)
      },JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME}));process.exit(7)\n`,
      { mode: 0o700 }
    )
    env.PATH = `${executables}:${env.PATH}`
    expect(cli(["environment", "add", "dev", "--local", "--directory", root, "--home", home]).status).toBe(0)
    const result = cli(["tui", "--environment", "dev", "-p", "hello there"])
    expect(result.status, result.stdout + result.stderr).toBe(7)
    const executed = JSON.parse(await readFile(receipt, "utf8"))
    expect(executed.cwd).toBe(root)
    expect(executed.home).toBe(home)
    expect(executed.args[0]).toBe("tui")
    expect(executed.args).toContain("hello there")
    expect(executed.args).not.toContain("--environment")
    expect(executed.args).not.toContain("dev")
  })

  it("rejects missing transport, conflicting transport and invalid forwarding ports", async () => {
    const { root, cli } = await fixture()
    expect(cli(["environment", "add", "remote", "--ssh", "fixture", "--directory", root]).status).toBe(0)
    for (
      const args of [
        ["environment", "add", "dev", "--directory", root],
        ["environment", "add", "dev", "--local", "--ssh", "host", "--directory", root],
        ["environment", "forward", "remote", "--local-port", "0", "--remote-port", "22"],
        ["environment", "forward", "remote", "--local-port", "22", "--remote-port", "65536"]
      ]
    ) expect(cli(args).status, args.join(" ")).not.toBe(0)
  })
})

describe("environment commands through the public parser", () => {
  it("persists each transport, executes shell and forwarding, and reports refusals", async () => {
    const { root, env } = await fixture()
    const { createEnvironmentCli } = await import("../src/cli/EnvironmentCommands.ts")
    const codes: number[] = []
    const binDirectory = join(root, "commands")
    await mkdir(binDirectory)
    const shellReceipt = join(root, "shell.json")
    const sshReceipt = join(root, "ssh.json")
    const shell = join(binDirectory, "login-shell")
    await writeFile(
      shell,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${
        JSON.stringify(shellReceipt)
      },JSON.stringify({cwd:process.cwd(),home:process.env.HOME}));process.exit(4)\n`,
      { mode: 0o700 }
    )
    await writeFile(
      join(binDirectory, "ssh"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${
        JSON.stringify(sshReceipt)
      },JSON.stringify(process.argv.slice(2)));process.exit(3)\n`,
      { mode: 0o700 }
    )
    const source = { ...env, PATH: `${binDirectory}:${env.PATH}`, SHELL: shell }
    const cli = createEnvironmentCli({
      environment: source,
      exit: (code) => {
        codes.push(code)
      }
    })
    const invoke = async (args: string[]) => {
      let output = "", exit = 0
      await cli.serve(args, {
        env: {},
        stdout: (text) => {
          output += text
        },
        exit: (code) => {
          exit = code
        }
      })
      return { output, exit }
    }
    expect((await invoke(["add", "local", "--local", "--directory", root, "--home", root])).exit).toBe(0)
    expect((await invoke(["add", "remote", "--ssh", "fixture", "--directory", "/work"])).exit).toBe(0)
    expect((await invoke(["add", "cloud", "--workspace", "owner/repo/ws", "--directory", "/work"])).exit).toBe(0)
    expect((await invoke(["list"])).output).toContain("cloud")
    expect((await invoke(["view", "remote"])).output).toContain("fixture")
    await invoke(["shell", "local"])
    expect(codes.at(-1)).toBe(4)
    expect(JSON.parse(await readFile(shellReceipt, "utf8"))).toEqual({ cwd: root, home: root })
    await invoke(["exec", "local", "--arg", process.execPath, "--arg=-e", "--arg=process.exit(5)"])
    expect(codes.at(-1)).toBe(5)
    await invoke(["forward", "remote", "--local-port", "4321", "--remote-port", "5432"])
    expect(codes.at(-1)).toBe(3)
    const args = JSON.parse(await readFile(sshReceipt, "utf8"))
    expect(args).toContain("-N")
    expect(args).toContain("127.0.0.1:4321:127.0.0.1:5432")
    expect((await invoke(["remove", "cloud"])).output).toContain("cloud")
    expect((await invoke(["view", "cloud"])).exit).toBe(2)
    expect((await invoke(["add", "bad", "--local", "--ssh", "fixture", "--directory", root])).exit).toBe(2)
  })
})

it("reads configured process environment when no explicit environment is supplied", async () => {
  const { root } = await fixture()
  const { createEnvironmentCli } = await import("../src/cli/EnvironmentCommands.ts")
  const original = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(root, "fallback-config")
  try {
    const cli = createEnvironmentCli({})
    let output = ""
    await cli.serve(["list", "--format", "json"], {
      env: {},
      stdout: (text) => {
        output += text
      },
      exit: () => {}
    })
    expect(JSON.parse(output)).toEqual([])
  } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = original
  }
})

it("cancels the selected TUI child and restores process signal listeners", async () => {
  const { root, env } = await fixture()
  const Environment = await import("../src/ExecutionEnvironment.ts")
  const Tui = await import("../src/commands/Tui.ts")
  const binDirectory = join(root, "cancel-bin")
  const marker = join(root, "tui.pid")
  await mkdir(binDirectory)
  await writeFile(
    join(binDirectory, "smthrs"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${
      JSON.stringify(marker)
    },String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\n`,
    { mode: 0o700 }
  )
  const source = { ...env, PATH: `${binDirectory}:${env.PATH}` }
  await Environment.add({ name: "dev", transport: "local", directory: root }, source)
  const controller = new AbortController()
  const before = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"].map((event) => process.listenerCount(event))
  const running = Tui.run({ environment: "dev", print: "hello" }, source, undefined, undefined, controller.signal)
  let pid = 0
  for (let i = 0; i < 200; i++) {
    try {
      pid = Number(await readFile(marker, "utf8"))
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  expect(pid).toBeGreaterThan(0)
  controller.abort()
  expect(await running).toBe(130)
  expect(() => process.kill(pid, 0)).toThrow()
  expect(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"].map((event) => process.listenerCount(event))).toEqual(before)
})
