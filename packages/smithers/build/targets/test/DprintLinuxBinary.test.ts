/**
 * `pnpm exec dprint` runs the npm `dprint` package, which picks a prebuilt
 * binary per platform. The glibc Linux build names `/lib64/ld-linux-*.so` as
 * its ELF interpreter; a NixOS Cloud guest without that link answered every
 * `dprint check` with `spawnSync … ENOENT` (#3007). `patches/dprint@0.57.1.patch`
 * makes Linux use the static musl build, which needs no interpreter. When its
 * optional package is not installed, dprint fetches it from the registry,
 * verified against the digest the package ships, through HTTPS_PROXY.
 */
import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import os, { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const require = createRequire(import.meta.url)
const packageDirectory = dirname(require.resolve("dprint/package.json"))
const installApi = require("dprint/install_api.cjs") as { getTarget: () => string }
const hashes = require("dprint/hashes.json") as Record<string, string>

afterEach(() => {
  vi.restoreAllMocks()
})

const onPlatform = (platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  vi.spyOn(os, "platform").mockReturnValue(platform)
  vi.spyOn(os, "arch").mockReturnValue(arch)
}

describe("dprint binary selection", () => {
  it.each(["x64", "arm64"] as const)("runs the static musl build on glibc Linux %s", (arch) => {
    onPlatform("linux", arch)
    expect(installApi.getTarget()).toBe(`linux-${arch}-musl`)
    expect(hashes[`linux-${arch}-musl`]).toMatch(/^[0-9a-f]{64}$/)
  })

  it("keeps the native build off Linux", () => {
    onPlatform("darwin", "arm64")
    expect(installApi.getTarget()).toBe("darwin-arm64")
  })
})

/** Runs dprint's installer for linux-x64 in a scratch copy of the package. */
const installThrough = (proxy: string) => {
  const scratch = mkdtempSync(join(tmpdir(), "dprint-install-"))
  for (const file of ["install_api.cjs", "hashes.json", "package.json"]) {
    copyFileSync(join(packageDirectory, file), join(scratch, file))
  }
  const script = `
    const os = require("os")
    os.platform = () => "linux"
    os.arch = () => "x64"
    try {
      require(${JSON.stringify(join(scratch, "install_api.cjs"))}).runInstall()
      process.exit(0)
    } catch (error) {
      console.error(String(error && error.message || error))
      process.exit(3)
    }
  `
  const { npm_config_https_proxy: _a, npm_config_proxy: _b, npm_config_noproxy: _c, ...inherited } = process.env
  const child = spawn(process.execPath, ["-e", script], {
    cwd: scratch,
    env: {
      ...inherited,
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      NO_PROXY: "",
      no_proxy: "",
      npm_config_registry: "https://registry.npmjs.org"
    }
  })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise<{ code: number | null; stderr: string; installed: boolean }>((done) => {
    child.on("close", (code) => {
      const installed = existsSync(join(scratch, "dprint"))
      rmSync(scratch, { recursive: true, force: true })
      done({ code, stderr, installed })
    })
  })
}

describe.skipIf(process.platform === "win32")("dprint static build download", () => {
  it("goes through HTTPS_PROXY and installs nothing when the proxy refuses", async () => {
    const targets: Array<string> = []
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        targets.push(chunk.toString("latin1").split("\r\n", 1)[0]!)
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
      })
    })
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    const { port } = server.address() as { port: number }
    try {
      const result = await installThrough(`http://127.0.0.1:${port}`)
      expect(result.code).toBe(3)
      expect(result.stderr).toContain("@dprint/linux-x64-musl")
      expect(result.installed).toBe(false)
      expect(targets).toEqual(["CONNECT registry.npmjs.org:443 HTTP/1.1"])
    } finally {
      server.close()
    }
  })

  it("fails closed when the proxy is unreachable", async () => {
    const server = createServer()
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    const { port } = server.address() as { port: number }
    await new Promise((closed) => server.close(closed))
    const result = await installThrough(`http://127.0.0.1:${port}`)
    expect(result.code).toBe(3)
    expect(result.installed).toBe(false)
  })
})
