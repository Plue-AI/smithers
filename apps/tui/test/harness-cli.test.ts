import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const entry = join(import.meta.dir, "../src/harness-cli.ts")
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"

test("the vendor entry refuses missing workspace and unknown vendor before opening a connection", async () => {
  for (const args of [[], ["codex"], ["unknown", "owner/repo/ws"]]) {
    const child = Bun.spawn([process.execPath, entry, ...args], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain("claude|codex owner/repo/workspace-id")
  }
})

test("the vendor entry resolves a pinned workspace and carries arguments, stdin and exit status through SSH", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-entry-"))
  roots.push(root)
  const bin = join(root, "bin")
  mkdirSync(bin)
  const argvPath = join(root, "ssh-argv")
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvPath}'\ncat\necho 'transport failure' >&2\nexit 7\n`,
    { mode: 0o755 }
  )
  const requests: Array<{ url: string | undefined; authorization: string | undefined }> = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization })
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      command: "ssh developer@workspace.example.test",
      host_keys: [{ known_hosts_line: key }]
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    for (const vendor of ["claude", "codex"]) {
      const child = Bun.spawn([process.execPath, entry, vendor, "owner/repo/ws", "exec", "say hi's", "-"], {
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: join(root, ".config"),
          PATH: `${bin}:/usr/bin:/bin`,
          SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          SMITHERS_TOKEN: "local-owner-token",
          SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
          OPENAI_API_KEY: "local-api-secret"
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
      child.stdin.write("prompt input\n")
      child.stdin.end()
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      expect(code).toBe(7)
      expect(stdout).toBe("prompt input\n")
      expect(stderr).toBe("transport failure\n")
      const argv = readFileSync(argvPath, "utf8").split("\0").filter(Boolean)
      expect(argv).toContain("StrictHostKeyChecking=yes")
      expect(argv.at(-2)).toBe("developer@workspace.example.test")
      const command = argv.at(-1)!
      expect(command).toContain(`exec ${vendor} 'exec' 'say hi'"'"'s' '-'`)
      expect(command).not.toContain("local-api-secret")
      expect(command).not.toContain("local-owner-token")
    }
    expect(requests).toEqual(
      [0, 1].map(() => ({ url: "/api/repos/owner/repo/workspaces/ws/ssh", authorization: "token local-owner-token" }))
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
