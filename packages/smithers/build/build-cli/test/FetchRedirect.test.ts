import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as FetchExecutor from "../src/internal/rules/FetchExecutor.ts"

const payload = Buffer.from("redirected payload")
const digest = createHash("sha256").update(payload).digest("hex")
let origin: string
let root: string
const server = createServer((request, response) => {
  if (request.url === "/payload") {
    response.end(payload)
  } else if (request.url === "/same-origin") {
    response.writeHead(302, { location: "/payload" })
    response.end()
  } else if (request.url === "/to-file") {
    response.writeHead(302, { location: "file:///etc/passwd" })
    response.end()
  } else {
    response.writeHead(302, { location: request.url ?? "/" })
    response.end()
  }
})
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})
beforeEach(async () => {
  root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-fetch-redirect-"))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("Fetch redirect policy", () => {
  it("refuses a redirect that downgrades https to http", () => {
    expect(() => FetchExecutor.redirectTarget("https://releases.example/a?sig=secret", "http://internal.example/b"))
      .toThrow(expect.objectContaining({ code: "insecure_redirect" }))
  })

  it("refuses a redirect to a non-http scheme", () => {
    expect(() => FetchExecutor.redirectTarget("http://releases.example/a", "file:///etc/passwd"))
      .toThrow(expect.objectContaining({ code: "insecure_redirect" }))
  })

  it("follows https hops across hosts and relative locations", () => {
    expect(FetchExecutor.redirectTarget("https://github.com/o/r/releases/x", "https://objects.example/blob"))
      .toBe("https://objects.example/blob")
    expect(FetchExecutor.redirectTarget("http://127.0.0.1:1/a", "/b")).toBe("http://127.0.0.1:1/b")
  })

  it("downloads through a same-origin redirect", async () => {
    const result = await FetchExecutor.download({
      root,
      url: `${origin}/same-origin`,
      sha256: digest,
      outFile: "out.bin"
    })
    expect(result.sha256).toBe(digest)
    expect(await Fs.readFile(Path.join(root, "out.bin"))).toEqual(payload)
  })

  it("refuses a server redirect off http(s) and leaves no output", async () => {
    await expect(FetchExecutor.download({ root, url: `${origin}/to-file`, sha256: digest, outFile: "out.bin" }))
      .rejects.toMatchObject({ _tag: "smithers-build/FetchError", code: "insecure_redirect" })
    await expect(Fs.access(Path.join(root, "out.bin"))).rejects.toThrow()
  })

  it("stops after the redirect cap and reports the redirect status", async () => {
    await expect(FetchExecutor.download({ root, url: `${origin}/loop`, sha256: digest, outFile: "out.bin" }))
      .rejects.toMatchObject({ code: "unexpected_status" })
  })
})
