/**
 * `S.Fetch` through the build-system CLI: a PACKAGE.ts that declares a
 * digest-pinned remote file (mirroring force's `//data:schemaPinned`) loads,
 * plans, downloads through a local HTTP fixture, verifies its sha256, and
 * restores its declared output from CAS. The WORKSPACE.ts carries the split
 * read/write remote cache declaration force's `.smithers/WORKSPACE.ts` uses.
 */
import * as FetchTarget from "@smthrs/targets/Fetch"
import * as Target from "@smthrs/targets/Target"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as FetchExec from "../src/FetchExec.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
})

const schemaBytes = Buffer.from("type Query { artwork: String }\n")
const schemaSha256 = createHash("sha256").update(schemaBytes).digest("hex")
let requests = 0
const server = createServer((request, response) => {
  requests += 1
  if (request.url?.startsWith("/missing") === true) {
    response.writeHead(404, { "content-type": "text/plain" })
    response.end("no such schema\n")
    return
  }
  if (request.url?.startsWith("/declared-too-large") === true) {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(FetchExec.maximumFetchBytes + 1)
    })
    response.end("small body")
    return
  }
  if (request.url?.startsWith("/chunked-too-large") === true) {
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.write(Buffer.alloc(8, 0x61))
    response.end(Buffer.alloc(8, 0x62))
    return
  }
  if (request.url?.startsWith("/redirect") === true) {
    response.writeHead(302, { location: "/schema.graphql" })
    response.end()
    return
  }
  response.writeHead(200, { "content-type": "application/octet-stream", "content-length": schemaBytes.byteLength })
  response.end(schemaBytes)
})
await new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})
const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/schema.graphql`

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-fetch-target-"))))

const fetchTemporaries = async (destination: string): Promise<ReadonlyArray<string>> => {
  const names = await Fs.readdir(NodePath.dirname(destination)).catch(() => [])
  const prefix = `${NodePath.basename(destination)}.smthrs-fetch-`
  return names.filter((name) => name.startsWith(prefix))
}

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({
    directory: ".flows",
    remote: S.RemoteCache.make({
      endpoint: "https://build.example.invalid",
      read: S.Secret("FIXTURE_CACHE_READ_TOKEN"),
      write: S.Secret("FIXTURE_CACHE_WRITE_TOKEN"),
    }),
  }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

/**
 * Mirrors force's data/PACKAGE.ts: a declared schema file, the pinned
 * upstream fetch, and a consumer that names the fetch in `data`.
 */
const dataModule = (url = serverUrl, sha256 = schemaSha256, out = "schema.upstream.graphql") =>
  `import { Smithers as S } from "@smthrs/targets"
const schema = S.file("schema.graphql")
const schemaPinned = S.Fetch({
  url: ${JSON.stringify(url)},
  sha256: ${JSON.stringify(sha256)},
  out: ${JSON.stringify(out)},
})
const schemaDrift = S.Shell.Test({
  shell: "diff -q schema.graphql schema.upstream.graphql",
  data: [schemaPinned, schema],
})
export const Package = S.Package({ targets: { schema, schemaPinned, schemaDrift } })
`

const fixtureWorkspace = async (options?: {
  readonly url?: string | undefined
  readonly sha256?: string | undefined
  readonly out?: string | undefined
}): Promise<string> => {
  const root = await temporaryWorkspace()
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "data/PACKAGE.ts", dataModule(options?.url, options?.sha256, options?.out))
  await write(root, "data/schema.graphql", "type Query { ok: Boolean }\n")
  return root
}

describe("S.Fetch in a PACKAGE.ts workspace", () => {
  it("loads without leaving its entry module directory in the OS temp dir", async () => {
    const root = await fixtureWorkspace()
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    expect(loaded.packages.length).toBeGreaterThan(0)
    // Other workers create and remove their own entry directories
    // concurrently, so the proof is that no leftover entry module names
    // this fixture's workspace, not a global count.
    const leftovers: Array<string> = []
    for (const name of await Fs.readdir(Os.tmpdir())) {
      if (!name.startsWith("smthrs-package-entry-")) continue
      const entry = await Fs.readFile(NodePath.join(Os.tmpdir(), name, "entry.mjs"), "utf8").catch(() => "")
      if (entry.includes(root)) leftovers.push(name)
    }
    expect(leftovers).toEqual([])
  })

  it("loads, labels the fetch, classifies the consumer's data edge, and keeps the split remote cache", async () => {
    const root = await fixtureWorkspace()
    const discovery = await PackageDiscovery.discover(root)
    const loaded = await PackageLoader.load(discovery)
    const index = PackageIndex.make(loaded)
    expect(index.targets().map((row) => row.label)).toEqual([
      "//data:schema",
      "//data:schemaDrift",
      "//data:schemaPinned"
    ])
    const [pinned] = index.resolve("//data:schemaPinned")
    const metadata = Target.metadata(pinned!.target)
    expect(metadata.target).toBe("Fetch")
    expect(metadata.kinds).toEqual(["build"])
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["schema.upstream.graphql"] })
    expect(index.edges(index.resolve("//..."))).toContainEqual({
      from: "//data:schemaDrift",
      to: "//data:schemaPinned",
      kind: "data"
    })
    const remote = loaded.workspace.cache.remote
    expect(remote?.endpoint).toBe("https://build.example.invalid")
    expect(remote?.token).toEqual({ _tag: "Secret", env: "FIXTURE_CACHE_READ_TOKEN" })
    expect(remote?.write).toEqual({ _tag: "Secret", env: "FIXTURE_CACHE_WRITE_TOKEN" })
  })

  it("lists the fetch through query --format json with its rule and kinds", async () => {
    const root = await fixtureWorkspace()
    const { exitCode, output } = await serve(root, ["query", "//...", "--format", "json"])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output) as {
      readonly targets: ReadonlyArray<
        { readonly label: string; readonly target: string; readonly kinds: ReadonlyArray<string> }
      >
    }
    expect(parsed.targets).toContainEqual({ label: "//data:schemaPinned", target: "Fetch", kinds: ["build"] })
    expect(parsed.targets).toHaveLength(3)
  })

  it("plans a cacheable package-relative file with intrinsic network access and complete attr keying", async () => {
    const root = await fixtureWorkspace()
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const index = PackageIndex.make(loaded)
    const plan = await PackageExec.plan({
      index,
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//data:schemaPinned"]
    })
    const node = plan.nodes.get("//data:schemaPinned")!
    expect(node.refusal).toBeUndefined()
    expect(node.cacheable).toBe(true)
    expect(node.outFiles).toEqual(["data/schema.upstream.graphql"])
    expect(node.sandbox).toEqual({ network: true })
    expect(node.keyMaterial.capabilities).toContain("net:open")
    expect(node.keyMaterial.capabilities).toContain("fs:write")

    const rendered = await serve(root, ["//data:schemaPinned", "--plan", "--format", "json"])
    expect(rendered.exitCode).toBe(0)
    const report = JSON.parse(rendered.output) as {
      readonly targets: ReadonlyArray<{
        readonly label: string
        readonly rule: string
        readonly key: string
        readonly cacheable: boolean
        readonly sandbox?: unknown
        readonly refusal?: string
      }>
    }
    expect(report.targets).toEqual([
      expect.objectContaining({
        label: "//data:schemaPinned",
        rule: "Fetch",
        cacheable: true,
        sandbox: { network: true }
      })
    ])
    expect(report.targets[0]!.refusal).toBeUndefined()

    const variants = await Promise.all([
      fixtureWorkspace({ url: `${serverUrl}?variant=1` }),
      fixtureWorkspace({ sha256: "0".repeat(64) }),
      fixtureWorkspace({ out: "nested/schema.graphql" })
    ])
    const keys = await Promise.all(variants.map(async (variant) => {
      const variantPlan = await serve(variant, ["//data:schemaPinned", "--plan", "--format", "json"])
      return (JSON.parse(variantPlan.output) as { readonly targets: ReadonlyArray<{ readonly key: string }> })
        .targets[0]!.key
    }))
    expect(new Set([report.targets[0]!.key, ...keys]).size).toBe(4)
  })

  it("refuses outputs that escape package-relative planning", () => {
    expect(
      FetchExec.planAttrs({
        packagePath: "data",
        attrs: { url: serverUrl, sha256: schemaSha256, out: "//outside.graphql" }
      }).refusal
    ).toContain(
      "must be package-relative"
    )
    expect(
      FetchExec.planAttrs({
        packagePath: "data",
        attrs: { url: serverUrl, sha256: schemaSha256, out: "../outside.graphql" }
      }).refusal
    ).toMatch(/leaves/)
    const ordinary = FetchTarget.Fetch({ url: serverUrl, sha256: schemaSha256, out: "schema.graphql" })
    expect(FetchExec.plan({ packagePath: "../outside", target: ordinary }).refusal).toMatch(/leaves|invalid/)
  })

  it("downloads matching bytes, hits, and restores a deleted output byte-for-byte", async () => {
    const root = await fixtureWorkspace()
    const destination = NodePath.join(root, "data/schema.upstream.graphql")
    const requestsBefore = requests
    const first = await serve(root, ["//data:schemaPinned"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain(`fetched ${schemaBytes.byteLength} byte(s)`)
    expect(await Fs.readFile(destination)).toEqual(schemaBytes)
    expect(requests).toBe(requestsBefore + 1)

    const second = await serve(root, ["//data:schemaPinned"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("//data:schemaPinned  hit")
    expect(requests).toBe(requestsBefore + 1)

    const downloadedMode = (await Fs.stat(destination)).mode & 0o777

    await Fs.rm(destination)
    const restored = await serve(root, ["//data:schemaPinned"])
    expect(restored.exitCode).toBe(0)
    expect(restored.logs).toContain("//data:schemaPinned  hit")
    expect(await Fs.readFile(destination)).toEqual(schemaBytes)
    expect(requests).toBe(requestsBefore + 1)
    // The download and the CAS restore agree on mode as well as bytes, so a
    // restrictive umask cannot make a warm tree differ from a cold one.
    expect(downloadedMode).toBe(0o644)
    expect((await Fs.stat(destination)).mode & 0o777).toBe(downloadedMode)
  })

  it("refuses an oversized Content-Length before reading the response body", async () => {
    const root = await temporaryWorkspace()
    const destination = NodePath.join(root, "data/declared.bin")
    const error = await FetchExec.execute({
      root,
      target: FetchTarget.Fetch({
        url: serverUrl.replace("/schema.graphql", "/declared-too-large"),
        sha256: schemaSha256,
        out: "declared.bin"
      }),
      outFile: "data/declared.bin"
    }).then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(FetchExec.FetchError)
    expect(error).toMatchObject({ code: "body_too_large" })
    expect((error as Error).message).toContain("declares")
    await expect(Fs.access(destination)).rejects.toThrow()
    expect(await fetchTemporaries(destination)).toEqual([])
  })

  it("removes the partial file when a chunked response crosses the byte cap", async () => {
    const root = await temporaryWorkspace()
    const destination = NodePath.join(root, "data/chunked.bin")
    const error = await FetchExec.execute({
      root,
      target: FetchTarget.Fetch({
        url: serverUrl.replace("/schema.graphql", "/chunked-too-large"),
        sha256: schemaSha256,
        out: "chunked.bin"
      }),
      outFile: "data/chunked.bin",
      limitBytes: 10
    }).then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(FetchExec.FetchError)
    expect(error).toMatchObject({ code: "body_too_large" })
    expect((error as Error).message).toContain("exceeded the 10 byte limit")
    await expect(Fs.access(destination)).rejects.toThrow()
    expect(await fetchTemporaries(destination)).toEqual([])
  })

  it("publishes a successful fetch through one redirect hop", async () => {
    const root = await temporaryWorkspace()
    const destination = NodePath.join(root, "data/redirected.bin")
    const result = await FetchExec.execute({
      root,
      target: FetchTarget.Fetch({
        url: serverUrl.replace("/schema.graphql", "/redirect"),
        sha256: schemaSha256,
        out: "redirected.bin"
      }),
      outFile: "data/redirected.bin"
    })
    expect(result).toEqual({ bytes: schemaBytes.byteLength, sha256: schemaSha256 })
    expect(await Fs.readFile(destination)).toEqual(schemaBytes)
    expect(await fetchTemporaries(destination)).toEqual([])
  })

  it("reports the HTTP status and the transport reason as typed failures without writing", async () => {
    const missingUrl = `${serverUrl.replace("/schema.graphql", "/missing.graphql")}`
    const root = await fixtureWorkspace({ url: missingUrl })
    const destination = NodePath.join(root, "data/schema.upstream.graphql")
    const executed = await serve(root, ["//data:schemaPinned"])
    expect(executed.exitCode).toBe(1)
    expect(executed.logs).toContain("answered HTTP 404")
    await expect(Fs.access(destination)).rejects.toThrow()

    const status = await FetchExec.execute({
      root,
      target: FetchTarget.Fetch({ url: missingUrl, sha256: schemaSha256, out: "status.graphql" }),
      outFile: "data/status.graphql"
    }).then(() => undefined, (cause: unknown) => cause)
    expect(status).toBeInstanceOf(FetchExec.FetchError)
    expect(status).toMatchObject({ code: "unexpected_status" })

    // A transport failure must name what actually went wrong. Effect's
    // HttpClientError keeps `message` on its prototype, so the reason has to
    // be recovered from the Node error in its `cause` chain.
    const refused = await FetchExec.execute({
      root,
      target: FetchTarget.Fetch({
        url: "http://127.0.0.1:1/schema.graphql",
        sha256: schemaSha256,
        out: "down.graphql"
      }),
      outFile: "data/down.graphql"
    }).then(() => undefined, (cause: unknown) => cause)
    expect(refused).toBeInstanceOf(FetchExec.FetchError)
    expect(refused).toMatchObject({ code: "request_failed" })
    expect((refused as Error).message).toContain("ECONNREFUSED")
    await expect(Fs.access(NodePath.join(root, "data/down.graphql"))).rejects.toThrow()
  })

  it("reports a typed digest mismatch with expected and actual hashes and writes no file", async () => {
    const expected = "0".repeat(64)
    const root = await fixtureWorkspace({ sha256: expected })
    const destination = NodePath.join(root, "data/schema.upstream.graphql")
    const executed = await serve(root, ["//data:schemaPinned"])
    expect(executed.exitCode).toBe(1)
    expect(executed.output).toContain("targets_failed")
    expect(executed.logs).toContain("Fetch sha256 mismatch")
    expect(executed.logs).toContain(`expected ${expected}`)
    expect(executed.logs).toContain(`actual ${schemaSha256}`)
    await expect(Fs.access(destination)).rejects.toThrow()

    await write(root, "data/direct.graphql", "unchanged\n")
    const direct = await FetchExec.execute({
      root,
      target: FetchTarget.Fetch({ url: serverUrl, sha256: expected, out: "direct.graphql" }),
      outFile: "data/direct.graphql"
    }).then(() => undefined, (cause: unknown) => cause)
    expect(direct).toBeInstanceOf(FetchExec.FetchError)
    expect(direct).toMatchObject({
      code: "digest_mismatch",
      expectedSha256: expected,
      actualSha256: schemaSha256
    })
    expect(await Fs.readFile(NodePath.join(root, "data/direct.graphql"), "utf8")).toBe("unchanged\n")
    expect(await fetchTemporaries(NodePath.join(root, "data/direct.graphql"))).toEqual([])
  })
})

describe("fetch failures name the endpoint without its credentials", () => {
  /**
   * The accepted URL grammar admits userinfo and a query, so a signed URL or a
   * `https://user:token@host/...` form used to land verbatim in CLI output,
   * the reporter's stream, and every cached diagnostic.
   */
  it("strips userinfo, query, and fragment", () => {
    expect(FetchExec.redactUrl("https://user:t0ken@cache.example.test/blob?X-Amz-Signature=abc#frag"))
      .toBe("https://<redacted>@cache.example.test/blob?<redacted>")
    expect(FetchExec.redactUrl("https://cache.example.test/blob")).toBe("https://cache.example.test/blob")
    expect(FetchExec.redactUrl("not a url")).toBe("<unparsable url>")
  })

  it("reports an HTTP status against the redacted URL", async () => {
    const target = FetchTarget.Fetch({
      url: serverUrl.replace("http://", "http://user:secret@").replace("/schema.graphql", "/missing"),
      sha256: schemaSha256,
      out: "out.bin"
    })
    const error = await FetchExec.execute({
      root: await temporaryWorkspace(),
      target,
      outFile: "out.bin"
    }).then(() => undefined, (cause: unknown) => cause)
    expect(String((error as Error).message)).not.toContain("secret")
    expect(String((error as Error).message)).toContain("<redacted>@127.0.0.1")
  })
})

describe("the declared remote cache reaches the build system", () => {
  /**
   * `WorkspaceDeclaration.CacheDeclaration` schema-validates `remote` as a real
   * `RemoteCache`, and the build system used to drop it: both `openCache` calls
   * passed no endpoint and no credentials, so a workspace declaring a shared
   * cache ran local-only with no warning, no refusal, and nothing in the plan.
   */
  it("attempts and reports the declared endpoint instead of running local-only", async () => {
    const root = await fixtureWorkspace()
    const result = await serve(root, ["//data:schemaPinned", "--ui", "plain"])
    expect(result.exitCode, result.logs).toBe(0)
    expect(result.logs).toContain("smthrs: remote cache disabled after a failure")
  }, 120_000)

  /**
   * Resolving the credentials is half the contract; withholding them is the
   * other half. `Executor` passes `credentialEnvNames(...)` to every old-executor
   * target spawn, and the build system resolved the same credentials and then
   * passed nothing, so a `WORKSPACE.ts` name such as `FIXTURE_CACHE_READ_TOKEN`
   * stayed readable by every tool the graph ran.
   */
  it.skipIf(process.platform === "win32")(
    "withholds the workspace-declared cache credentials from a target subprocess",
    async () => {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule)
      await write(
        root,
        "data/PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const credentialProbe = S.Shell.Test({
  shell: 'test -z "$FIXTURE_CACHE_READ_TOKEN" && test -z "$FIXTURE_CACHE_WRITE_TOKEN" && test "$MARKER" = kept',
  env: {
    FIXTURE_CACHE_READ_TOKEN: "leaked-read",
    FIXTURE_CACHE_WRITE_TOKEN: "leaked-write",
    MARKER: "kept",
  },
})
export const Package = S.Package({ targets: { credentialProbe } })
`
      )

      const result = await serve(root, ["//data:credentialProbe", "--ui", "plain"])
      // The probe exits 0 only when both credential names are absent and the
      // ordinary declared variable beside them still arrived.
      expect(result.exitCode, result.logs).toBe(0)
    },
    120_000
  )
})

describe("build-system failures report why, not that", () => {
  /**
   * `SchemaError` and the `Data.TaggedError` family define `message` as a
   * prototype accessor. `Diagnostic.message` reads own data properties only —
   * the right posture at a boundary handed an arbitrary value — so every such
   * failure rendered as the caller's fallback and the reason was lost.
   * `Diagnostic.describe` exists for exactly that, and had one call site in the
   * whole package: the old executor's executor.
   */
  it("carries an Effect schema failure out of a declaration module", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      `import * as Schema from "effect/Schema"\nSchema.decodeUnknownSync(Schema.String)(42)\n`
    )
    await write(root, "data/PACKAGE.ts", dataModule())
    const result = await serve(root, ["query", "//..."])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Expected string")
    expect(result.output).not.toContain("operation failed")
  })
})
