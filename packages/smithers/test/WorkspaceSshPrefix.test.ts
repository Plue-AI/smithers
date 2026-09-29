import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step()
})

const api = async (answer: object) => {
  const seen: Array<{ url: string | undefined; authorization: string | undefined }> = []
  const server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization })
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())))
  const home = await mkdtemp(join(tmpdir(), "smthrs-ssh-prefix-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    SMITHERS_TOKEN: "smithers_test",
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  return { seen, home, environment }
}

describe("NodeControl.workspaceSshPrefix", () => {
  it("answers ssh with the workspace grant and the advertised host key pinned", async () => {
    const { seen, environment } = await api({
      command: "ssh msb_vm+developer:grant@ssh.example.test",
      host_keys: [{ known_hosts_line: key }]
    })
    const prefix = await NodeControl.workspaceSshPrefix(environment, "owner/repo/ws-1")
    expect(seen).toEqual([{ url: "/api/repos/owner/repo/workspaces/ws-1/ssh", authorization: "token smithers_test" }])
    expect(prefix[0]).toBe("ssh")
    expect(prefix.at(-1)).toBe("msb_vm+developer:grant@ssh.example.test")
    expect(prefix).toContain("StrictHostKeyChecking=yes")
    const knownHosts = prefix.find((arg) => arg.startsWith("UserKnownHostsFile="))!.slice("UserKnownHostsFile=".length)
    expect(await readFile(knownHosts, "utf8")).toBe(`smithers-workspace ${key}\n`)
  })

  it("refuses a reference that names no workspace, and a gateway with no host keys", async () => {
    const { environment } = await api({ command: "ssh vm@ssh.example.test", host_keys: [] })
    await expect(NodeControl.workspaceSshPrefix(environment, "owner/repo")).rejects.toThrow(
      "Expected OWNER/REPO/WORKSPACE_ID"
    )
    await expect(NodeControl.workspaceSshPrefix(environment, "owner/repo/ws-1")).rejects.toThrow(
      "Workspace SSH host keys unavailable"
    )
  })
})
