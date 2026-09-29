import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import * as tar from "tar"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import { archiveFilter, copyEndpoint, copyScript } from "../src/internal/backend/Copy.ts"
import { durable, hostKeys, quote, sshArgs } from "../src/internal/backend/SSH.ts"
const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
import { workspaceBody } from "../src/internal/backend/Workspaces.ts"
const run = promisify(execFile)
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "smithers-transport-"))
  dirs.push(home)
  return {
    home,
    client: new Client({
      environment: { ...process.env, HOME: home, XDG_STATE_HOME: home },
      stderr: { write: () => {}, isTTY: false, columns: 80 }
    })
  }
}

describe("workspace SSH boundary", () => {
  it.each([
    "ssh -oProxyCommand=cat host",
    "ssh -o LocalCommand=evil host",
    "sh -c evil",
    "ssh host command",
    "ssh -- host",
    "ssh -p 70000 host",
    "ssh -l ../root host",
    "ssh host;evil",
    "ssh -oStrictHostKeyChecking=no host",
    "ssh -i 'unterminated"
  ])("refuses backend command injection: %s", async (command) => {
    const { client } = await fixture()
    await expect(sshArgs(client, { command, hostKeys: [hostKey] })).rejects.toThrow()
  })
  it("preserves allowed connection options and pins the advertised host keys", async () => {
    const { client } = await fixture(),
      args = await sshArgs(client, {
        command: "ssh -p 2222 -i \"/tmp/key file\" -o ConnectTimeout=3 developer@guest",
        hostKeys: [hostKey]
      })
    expect(args).toContain("StrictHostKeyChecking=yes")
    expect(args).toContain("HostKeyAlias=smithers-workspace")
    expect(args).toContain("GlobalKnownHostsFile=/dev/null")
    const knownHosts = args.find((arg) => arg.startsWith("UserKnownHostsFile="))!.slice("UserKnownHostsFile=".length)
    expect(await readFile(knownHosts, "utf8")).toBe(`smithers-workspace ${hostKey}\n`)
    expect(args.slice(-7)).toEqual(["-p", "2222", "-i", "/tmp/key file", "-o", "ConnectTimeout=3", "developer@guest"])
  })
  it("never trusts a workspace host on first use", async () => {
    const { client } = await fixture()
    await expect(sshArgs(client, { command: "ssh developer@guest", hostKeys: [] })).rejects.toThrow("host keys")
  })
  it("reads advertised host keys and refuses malformed ones", () => {
    expect(hostKeys([{ algorithm: "ssh-ed25519", public_key: hostKey.split(" ")[1] }, { known_hosts_line: hostKey }]))
      .toEqual([hostKey, hostKey])
    expect(hostKeys(undefined)).toEqual([])
    for (
      const bad of [{}, { known_hosts_line: "guest ssh-ed25519 AAAA" }, {
        algorithm: "ssh-ed25519",
        public_key: "a\nb"
      }]
    ) {
      expect(() => hostKeys([bad])).toThrow("host key")
    }
  })
  it("quotes metacharacters as data", async () => {
    const input = "a'$(echo nope); b\nhello"
    expect((await run("bash", ["-c", `printf %s ${quote(input)}`])).stdout).toBe(input)
  })
  it("reattaches after a dropped launch response without executing the guest command twice", async () => {
    const { home, client } = await fixture(),
      file = join(home, "count"),
      script = `printf x >> ${quote(file)}; printf hello; printf error >&2; exit 7`
    let calls = 0
    const transport = async (request: string) => {
      // Test state is confined to this fixture even on hosts with getent.
      const command = request.replace(
        /smithers_login_home=\$\(getent passwd[^;]+;/g,
        `smithers_login_home=${quote(home)};`
      )
      const result = await run("bash", ["-c", command], { env: { ...process.env, HOME: home } })
      if (++calls === 1) throw new Error("connection dropped after launch")
      return result.stdout
    }
    const result = await durable(client, "test-reattach", script, transport, 5000, 10)
    expect(result.code).toBe(7)
    expect(result.stdout.toString()).toBe("hello")
    expect(result.stderr.toString()).toBe("error")
    expect(await readFile(file, "utf8")).toBe("x")
    const attached = await durable(client, "test-reattach", script, transport, 5000, 10)
    expect(attached.code).toBe(7)
    expect(await readFile(file, "utf8")).toBe("x")
    await expect(durable(client, "test-reattach", "another command", transport, 5000, 10)).rejects.toThrow(
      "another command"
    )
  })
  it("reports lost guest receipts without rerunning a possibly completed command", async () => {
    const { client } = await fixture()
    await expect(
      durable(client, "lost", "true", async () => "SMITHERS_EXEC_V1\nlost:guest_restarted\n\n\nEND\n", 1000, 1)
    ).rejects.toThrow("exec_outcome_lost")
  })
  it("drains output after the exit receipt and rejects malformed receipts", async () => {
    const { client } = await fixture(), chunk = Buffer.alloc(65536, 120)
    let count = 0
    const result = await durable(
      client,
      "drain",
      "true",
      async () => `SMITHERS_EXEC_V1\n0\n${++count === 1 ? chunk.toString("base64") : ""}\n\nEND\n`,
      1000,
      1
    )
    expect(result.stdout).toEqual(chunk)
    expect(count).toBe(2)
    await expect(durable(client, "malformed", "true", async () => "SMITHERS_EXEC_V1\n0\n$bad\n\nEND\n", 1000, 1))
      .rejects.toThrow("Invalid exec output")
  })
})

describe("workspace archive boundaries", () => {
  it.each(
    [["ws:/tmp/out", true, ""], [":/tmp/out", true, ""], ["abc:/tmp/out", true, "abc"], ["C:\\src", false, ""], [
      "./a:b",
      false,
      ""
    ], ["/tmp/a:b", false, ""]] as const
  )("parses %s", (path, remote, id) => expect(copyEndpoint(path)).toMatchObject({ remote, id }))
  it("round trips files through the actual tar streams and upload/download scripts", async () => {
    const { home } = await fixture(),
      source = join(home, "source"),
      remote = join(home, "remote"),
      output = join(home, "output")
    await mkdir(source)
    await mkdir(output)
    await writeFile(join(source, "hello"), "hello")
    const archive = join(home, "archive.tar")
    await tar.c({ cwd: home, file: archive }, ["source"])
    await run("bash", ["-c", `${copyScript(true, remote, "source", false)} < ${quote(archive)}`])
    expect(await readFile(join(remote, "hello"), "utf8")).toBe("hello")
    await run("bash", ["-c", `${copyScript(false, remote, "remote", false)} > ${quote(archive)}`], {
      env: { ...process.env, COPYFILE_DISABLE: "1" }
    })
    await tar.x({ cwd: output, file: archive, strict: true, filter: archiveFilter("remote") })
    expect(await readFile(join(output, "remote", "hello"), "utf8")).toBe("hello")
  })
  it("refuses siblings, traversal and hard links outside the requested archive root", () => {
    const filter = archiveFilter("requested")
    for (const path of ["../outside", "/outside", "sibling", "requested/../../outside"]) {
      expect(() => filter(path, { type: "File" } as tar.ReadEntry)).toThrow()
    }
    expect(() => filter("requested/link", { type: "Link", linkpath: "sibling" } as tar.ReadEntry)).toThrow()
    expect(filter("requested/file", { type: "File" } as tar.ReadEntry)).toBe(true)
  })
  it("refuses archive writes through a symlink", async () => {
    const { home } = await fixture(),
      source = join(home, "source"),
      output = join(home, "output"),
      outside = join(home, "outside")
    await mkdir(source)
    await mkdir(output)
    await mkdir(outside)
    await symlink(outside, join(output, "source"))
    await writeFile(join(source, "file"), "attack")
    await expect(
      pipeline(
        tar.c({ cwd: home }, ["source/file"]),
        tar.x({ cwd: output, strict: true, filter: archiveFilter("source") })
      )
    ).rejects.toThrow()
    await expect(readFile(join(outside, "file"))).rejects.toThrow()
  })
})

describe("workspace resource payload", () => {
  it("preserves the TB4 51200-MB disk request in the workspace payload", () => {
    expect(
      workspaceBody({
        name: "dev",
        cpus: 4,
        memory: 4096,
        disk: 51200,
        allow: ["github.com,nodejs.org"],
        idleTimeout: 0,
        service: ["web=npm start"]
      })
    ).toEqual({
      name: "dev",
      resources: { cpus: 4, memory_mb: 4096, disk_mb: 51200 },
      network: { mode: "allowlist", allow: ["github.com", "nodejs.org"] },
      idle_timeout_seconds: 0,
      services: [{ name: "web", mode: "service", exec: ["/bin/sh", "-lc", "npm start"] }]
    })
  })
  it.each([{ cpus: -1 }, { network: "none", allow: ["example.com"] }, { service: ["web=a", "web=b"] }, {
    idleTimeout: -1
  }])("refuses invalid resource selection %j", (options) => expect(() => workspaceBody(options)).toThrow())
})
