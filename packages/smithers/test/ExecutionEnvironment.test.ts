import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Environments from "../src/ExecutionEnvironment.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smthrs-environments-")))
  roots.push(root)
  return { root, source: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), PATH: process.env.PATH ?? "" } }
}

describe("persistent execution environments", () => {
  it("persists and removes profiles across independent reads", async () => {
    const { root, source } = await fixture()
    const profile = { name: "dev", transport: "local" as const, directory: root, home: join(root, "native-home") }
    expect(await Environments.list(source)).toEqual([])
    await Environments.add(profile, source)
    expect(await Environments.get("dev", { ...source })).toEqual(profile)
    expect(await Environments.list({ ...source })).toEqual([profile])
    expect(await readFile(join(source.XDG_CONFIG_HOME, "smithers", "environments.json"), "utf8")).toContain("dev")
    await Environments.remove("dev", source)
    expect(await Environments.list(source)).toEqual([])
    await expect(Environments.get("dev", source)).rejects.toThrow()
  })

  it("refuses corrupt persisted state rather than silently replacing it", async () => {
    const { root, source } = await fixture()
    await Environments.add({ name: "dev", transport: "local", directory: root }, source)
    const path = join(source.XDG_CONFIG_HOME, "smithers", "environments.json")
    await writeFile(path, "{broken")
    await expect(Environments.list(source)).rejects.toThrow()
    await expect(Environments.add({ name: "other", transport: "local", directory: root }, source)).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe("{broken")
  })

  it("rejects duplicate names and malformed profiles without changing the registry", async () => {
    const { root, source } = await fixture()
    const profile = { name: "dev", transport: "local" as const, directory: root }
    await Environments.add(profile, source)
    await expect(Environments.add({ ...profile, directory: "/other" }, source)).rejects.toThrow()
    for (
      const invalid of [
        { ...profile, name: "" },
        { ...profile, name: "bad/name" },
        { ...profile, name: "bad", directory: "" },
        { ...profile, name: "bad", transport: { toString: () => "local" } },
        { ...profile, name: "bad", transport: "ssh" },
        { ...profile, name: "bad", transport: "workspace", destination: "owner/repo" }
      ]
    ) await expect(Environments.add(invalid as Environments.Profile, source)).rejects.toThrow()
    expect(await Environments.list(source)).toEqual([profile])
  })

  it("does not launch an already cancelled request", async () => {
    const { root, source } = await fixture()
    const marker = join(root, "must-not-exist")
    const controller = new AbortController()
    controller.abort()
    await expect(
      Environments.run(
        { name: "dev", transport: "local", directory: root },
        [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'started')", marker],
        source,
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    await expect(readFile(marker)).rejects.toThrow()
  })

  it("stops a resistant descendant after its parent exits on cancellation", async () => {
    const { root, source } = await fixture()
    const marker = join(root, "child.pid")
    const controller = new AbortController()
    const running = Environments.run(
      { name: "dev", transport: "local", directory: root },
      ["/bin/sh", "-c", `sh -c 'trap "" TERM; echo $$ > "$1"; exec sleep 60' child "$1" & wait`, "parent", marker],
      source,
      { signal: controller.signal }
    )
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
    // The descendant may briefly remain while its signal is delivered/reaped.
    let alive = true
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 10))
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
  })

  it("runs a real local executable with exact arguments, selected cwd and home, and its exit code", async () => {
    const { root, source } = await fixture()
    const output = join(root, "receipt.json")
    const args = [
      "",
      "two words",
      "'quoted'",
      "\"double\"",
      "中文 🦉",
      "first\nsecond",
      "$(touch injected)",
      "; touch injected",
      "--terminal"
    ]
    const profile = { name: "dev", transport: "local" as const, directory: root, home: root }
    const code = await Environments.run(profile, [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME}));process.exit(23)",
      output,
      ...args
    ], source)
    expect(code).toBe(23)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ args, cwd: root, home: root })
    await expect(readFile(join(root, "injected"))).rejects.toThrow()
  })

  it("cancels a real active child without reporting success", async () => {
    const { root, source } = await fixture()
    const ready = join(root, "ready")
    const controller = new AbortController()
    const running = Environments.run(
      { name: "dev", transport: "local", directory: root },
      [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
        ready
      ],
      source,
      { signal: controller.signal }
    )
    let pid = 0
    for (let i = 0; i < 200; i++) {
      try {
        pid = Number(await readFile(ready, "utf8"))
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    expect(pid).toBeGreaterThan(0)
    controller.abort()
    const outcome = await running.catch(() => -1)
    expect(outcome).not.toBe(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

describe("SSH execution planning", () => {
  it("quotes argv through a real remote shell and keeps credentials off the transport", async () => {
    const { root, source } = await fixture()
    const privateSource = {
      ...source,
      OPENAI_API_KEY: "synthetic-key",
      SMITHERS_TOKEN: "synthetic-token",
      CODEX_HOME: "/private/codex",
      SSH_AUTH_SOCK: "/tmp/fixture-agent"
    }
    const output = join(root, "remote.json")
    const args = [
      "",
      "two words",
      "'",
      "\"",
      "中文",
      "first\nsecond",
      "$(touch injected)",
      "; touch injected",
      "--help"
    ]
    const planned = await Environments.plan({
      name: "remote",
      transport: "ssh",
      destination: "developer@fixture",
      directory: root,
      home: root
    }, [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME}))",
      output,
      ...args
    ], privateSource)
    expect(planned.command).toBe("ssh")
    expect(planned.args).toContain("StrictHostKeyChecking=yes")
    expect(planned.args).toContain("ForwardAgent=no")
    expect(planned.environment.SSH_AUTH_SOCK).toBe("/tmp/fixture-agent")
    for (const key of ["OPENAI_API_KEY", "SMITHERS_TOKEN", "CODEX_HOME"]) {
      expect(planned.environment[key]).toBeUndefined()
    }
    expect(JSON.stringify(planned)).not.toContain("synthetic-key")
    expect(JSON.stringify(planned)).not.toContain("synthetic-token")
    const { spawnSync } = await import("node:child_process")
    // SSH's network boundary is replaced by the actual POSIX shell receiving
    // its command string; quoting and filesystem effects are production ones.
    const executed = spawnSync("/bin/sh", ["-c", planned.args.at(-1)!], {
      cwd: root,
      env: planned.environment as NodeJS.ProcessEnv,
      encoding: "utf8"
    })
    expect(executed.status, executed.stderr).toBe(0)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ args, cwd: root, home: root })
    await expect(readFile(join(root, "injected"))).rejects.toThrow()
  })

  it("requests an actual terminal and restricts forwarding to loopback", async () => {
    const { source } = await fixture()
    const profile = { name: "remote", transport: "ssh" as const, destination: "developer@fixture", directory: "/work" }
    const terminal = await Environments.plan(profile, ["sh"], source, { terminal: true })
    expect(terminal.args).toContain("-tt")
    const forward = await Environments.plan(profile, [], source, { forward: { localPort: 4321, remotePort: 5432 } })
    expect(forward.args).toContain("-N")
    expect(forward.args).toContain("ExitOnForwardFailure=yes")
    expect(forward.args).toContain("127.0.0.1:4321:127.0.0.1:5432")
    expect(forward.args.at(-1)).toBe("developer@fixture")
    for (const port of [0, -1, 65536, 1.5, NaN]) {
      await expect(Environments.plan(profile, [], source, { forward: { localPort: port, remotePort: 5432 } })).rejects
        .toThrow()
      await expect(Environments.plan(profile, [], source, { forward: { localPort: 4321, remotePort: port } })).rejects
        .toThrow()
    }
  })
})

describe("environment refusal and recovery", () => {
  it("rejects malformed registry versions, profiles, duplicate names and credential fields", async () => {
    const { root, source } = await fixture()
    const good = { name: "dev", transport: "local", directory: root }
    await Environments.add(good as Environments.Profile, source)
    const path = Environments.registryPath(source)
    const malformed = [
      null,
      [],
      {},
      { version: 2, environments: [] },
      { version: 1, environments: null },
      ...[
        null,
        [],
        "profile",
        { ...good, token: "private" },
        { ...good, transport: "other" },
        { ...good, transport: { toString: () => "local" } },
        { ...good, directory: "relative" },
        { ...good, directory: "/bad\npath" },
        { ...good, home: 3 },
        { ...good, home: "/bad\0home" },
        { ...good, destination: "host" },
        { ...good, transport: "ssh", destination: "-oProxyCommand=evil" },
        { ...good, transport: "ssh", destination: "host;evil" },
        { ...good, transport: "workspace", destination: "owner/repo" }
      ]
        .map((profile) => ({ version: 1, environments: [profile] })),
      { version: 1, environments: [good, good] }
    ]
    for (const value of malformed) {
      const text = JSON.stringify(value)
      await writeFile(path, text)
      await expect(Environments.list(source), text).rejects.toThrow()
      expect(await readFile(path, "utf8")).toBe(text)
    }
  })

  it("preserves profiles on unknown removal and refuses a held lock then recovers", async () => {
    const { root, source } = await fixture()
    const profile = { name: "dev", transport: "local" as const, directory: root }
    await Environments.add(profile, source)
    await expect(Environments.remove("missing", source)).rejects.toThrow("Unknown")
    const { mkdir, readdir } = await import("node:fs/promises")
    const path = Environments.registryPath(source)
    await mkdir(`${path}.lock`)
    await expect(Environments.remove("dev", source)).rejects.toThrow("being changed")
    expect(await Environments.list(source)).toEqual([profile])
    await rm(`${path}.lock`, { recursive: true })
    await Environments.remove("dev", source)
    expect(await Environments.list(source)).toEqual([])
    expect(await readdir(join(source.XDG_CONFIG_HOME, "smithers"))).toEqual(["environments.json"])
  })

  it("reports unreadable registry paths and cannot overwrite them", async () => {
    const { root, source } = await fixture()
    const { mkdir } = await import("node:fs/promises")
    await mkdir(Environments.registryPath(source), { recursive: true })
    await expect(Environments.list(source)).rejects.toThrow()
    await expect(Environments.add({ name: "dev", transport: "local", directory: root }, source)).rejects.toThrow()
  })

  it("rejects invalid executable arguments and unsupported forwards before launching", async () => {
    const { root, source } = await fixture()
    const profile = { name: "dev", transport: "local" as const, directory: root }
    for (const argv of [[], [""], ["-bad"], ["echo", "bad\0argument"]]) {
      await expect(Environments.plan(profile, argv, source)).rejects.toThrow("executable")
    }
    await expect(Environments.plan(profile, [], source, { forward: { localPort: 1, remotePort: 65535 } })).rejects
      .toThrow("requires")
    await expect(
      Environments.plan({ ...profile, transport: "workspace", destination: "owner/repo/ws" }, [], {
        ...source,
        SMITHERS_API_ORIGIN: "http://127.0.0.1:1",
        SMITHERS_TOKEN: "unused-token"
      }, { forward: { localPort: 1, remotePort: 65535 } })
    ).rejects.toThrow("Port forwarding requires an SSH environment")
    const remote = { ...profile, transport: "ssh" as const, destination: "host" }
    const valid = await Environments.plan(remote, [], source, { forward: { localPort: 1, remotePort: 65535 } })
    expect(valid.args).toContain("127.0.0.1:1:127.0.0.1:65535")
    expect(valid.args.filter((arg) => arg.startsWith("ClearAllForwardings="))).toEqual(["ClearAllForwardings=no"])
    await expect(Environments.run(profile, [join(root, "missing-executable")], source)).rejects.toMatchObject({
      code: "ENOENT"
    })
    expect(Environments.registryPath({ HOME: root })).toBe(join(root, ".config/smithers/environments.json"))
    const { homedir } = await import("node:os")
    expect(Environments.registryPath({})).toBe(join(homedir(), ".config/smithers/environments.json"))
  })
})

describe("Cloud execution environment authentication", () => {
  it("obtains fresh grants from its own authenticated API and pins the advertised key", async () => {
    const { root, source } = await fixture()
    const { createServer } = await import("node:http")
    const seen: Array<{ url: string | undefined; authorization: string | undefined }> = []
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
    const server = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization })
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          command: `ssh developer:grant-${seen.length}@fixture -p 2222 -o Compression=yes`,
          host_keys: [{ known_hosts_line: key }]
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address() as import("node:net").AddressInfo
      const env = {
        ...source,
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
        SMITHERS_TOKEN: "synthetic-owner-session",
        SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
      }
      const profile = {
        name: "cloud",
        transport: "workspace" as const,
        destination: "owner/repo/ws-1",
        directory: "/work"
      }
      const first = await Environments.plan(profile, ["smthrs", "tui"], env)
      const second = await Environments.plan(profile, ["codex", "login"], env, { terminal: true })
      expect(seen).toEqual(
        [1, 2].map(() => ({
          url: "/api/repos/owner/repo/workspaces/ws-1/ssh",
          authorization: "token synthetic-owner-session"
        }))
      )
      expect(first.args).toContain("developer:grant-1@fixture")
      expect(second.args).toContain("developer:grant-2@fixture")
      expect(first.args.at(-2)).toBe("developer:grant-1@fixture")
      expect(first.args.slice(first.args.indexOf("-p"), first.args.indexOf("-p") + 2)).toEqual(["-p", "2222"])
      expect(first.args).toContain("Compression=yes")
      expect(second.args).toContain("-tt")
      expect(first.args).toContain("StrictHostKeyChecking=yes")
      const knownHosts = first.args.find((arg) => arg.startsWith("UserKnownHostsFile="))!.slice(
        "UserKnownHostsFile=".length
      )
      expect(await readFile(knownHosts, "utf8")).toBe(`smithers-workspace ${key}\n`)
      expect(JSON.stringify(first)).not.toContain("synthetic-owner-session")
      expect(first.environment.HOME).toBe(root)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("cancels while the authenticated endpoint has not answered", async () => {
    const { source } = await fixture()
    const { createServer } = await import("node:http")
    let received!: () => void
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve
    })
    const server = createServer(() => {
      received()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const controller = new AbortController()
    try {
      const address = server.address() as import("node:net").AddressInfo
      const planned = Environments.plan(
        { name: "cloud", transport: "workspace", destination: "owner/repo/ws-1", directory: "/work" },
        ["codex"],
        {
          ...source,
          SMITHERS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
          SMITHERS_TOKEN: "synthetic-owner-session",
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
        },
        { signal: controller.signal }
      )
      const settled = planned.then(() => "success", () => "cancelled")
      await requestReceived
      controller.abort()
      expect(await settled).toBe("cancelled")
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe("process lifecycle boundaries", () => {
  it("retains native signal exit codes and cancels a terminal child", async () => {
    const { root, source } = await fixture()
    const profile = { name: "dev", transport: "local" as const, directory: root }
    expect(await Environments.run(profile, [process.execPath, "-e", "process.kill(process.pid,'SIGTERM')"], source))
      .toBe(143)
    const ready = join(root, "terminal.pid")
    const controller = new AbortController()
    const running = Environments.run(
      profile,
      [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
        ready
      ],
      source,
      { terminal: true, signal: controller.signal }
    )
    let pid = 0
    for (let i = 0; i < 200; i++) {
      try {
        pid = Number(await readFile(ready, "utf8"))
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    expect(pid).toBeGreaterThan(0)
    controller.abort()
    expect(await running).toBe(130)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

it.skipIf(process.getuid?.() === 0)("reports a real filesystem lock permission failure and recovers", async () => {
  const { root, source } = await fixture()
  const { chmod } = await import("node:fs/promises")
  const profile = { name: "dev", transport: "local" as const, directory: root }
  await Environments.add(profile, source)
  const directory = join(source.XDG_CONFIG_HOME, "smithers")
  await chmod(directory, 0o500)
  try {
    await expect(Environments.remove("dev", source)).rejects.toMatchObject({ code: "EACCES" })
    expect(await Environments.list(source)).toEqual([profile])
  } finally {
    await chmod(directory, 0o700)
  }
  await Environments.remove("dev", source)
  expect(await Environments.list(source)).toEqual([])
})

it("canonicalizes validated Cloud SSH options before its destination", async () => {
  const { root, source } = await fixture()
  const { Client } = await import("../src/internal/backend/Client.ts")
  const { sshArgs } = await import("../src/internal/backend/SSH.ts")
  const client = new Client({ environment: source }, false)
  const command = "ssh developer@fixture -p 2222 -o Compression=yes"
  const args = await sshArgs(client, {
    command,
    hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"]
  })
  expect(args.at(-1)).toBe("developer@fixture")
  expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "2222"])
  expect(args.indexOf("Compression=yes")).toBeLessThan(args.indexOf("developer@fixture"))
  const { spawnSync } = await import("node:child_process")
  // The real OpenSSH parser accepts the corrected host/options placement.
  const config = join(root, "ssh-config")
  await writeFile(config, "Host *\n  ControlMaster auto\n  ControlPath /tmp/reused-gateway\n")
  const resolved = spawnSync("ssh", ["-G", "-F", config, ...args], { env: source, encoding: "utf8" })
  expect(resolved.status, resolved.stderr).toBe(0)
  expect(resolved.stdout).toMatch(/^hostname fixture$/m)
  expect(resolved.stdout).toMatch(/^port 2222$/m)
  expect(resolved.stdout).toMatch(/^compression yes$/m)
  expect(resolved.stdout).toMatch(/^controlmaster false$/m)
  expect(resolved.stdout).not.toMatch(/^controlpath \/tmp\/reused-gateway$/m)
  expect(args).toContain("ControlPath=none")
  const plain = await Environments.plan(
    { name: "remote", transport: "ssh", destination: "developer@fixture", directory: root },
    ["true"],
    source
  )
  const plainConfig = spawnSync("ssh", ["-G", "-F", config, ...plain.args.slice(0, -1)], {
    env: source,
    encoding: "utf8"
  })
  expect(plainConfig.status, plainConfig.stderr).toBe(0)
  expect(plainConfig.stdout).toMatch(/^controlmaster auto$/m)
  expect(plainConfig.stdout).toMatch(/^controlpath \/tmp\/reused-gateway$/m)
})
