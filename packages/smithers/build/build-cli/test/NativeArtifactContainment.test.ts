import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import { executionPresentation } from "./fixtures/presentation.ts"

const fetched = Buffer.from("pinned native artifact\n")
const digest = createHash("sha256").update(fetched).digest("hex")
const original = Buffer.from("external bytes must survive\n")
const roots: Array<string> = []
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/octet-stream" })
  response.end(fetched)
})
let fetchUrl: string

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  fetchUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/artifact`
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

type Rule = "Fetch" | "Copy" | "Literal"

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("native-artifact-containment", {
  repository: "git+https://example.invalid/native-artifact-containment.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`

const declaration = (rule: Rule, output: string): string => {
  const attrs = rule === "Fetch"
    ? `S.Fetch({ url: ${JSON.stringify(fetchUrl)}, sha256: ${JSON.stringify(digest)}, out: ${JSON.stringify(output)} })`
    : rule === "Copy"
    ? `S.Copy({ from: S.file("//input.txt"), to: ${JSON.stringify(output)} })`
    : `S.Literal({ path: ${JSON.stringify(output)}, content: "literal bytes\\n" })`
  return `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { artifact: ${attrs} } })
`
}

const expected = (rule: Rule): Buffer =>
  rule === "Fetch"
    ? fetched
    : Buffer.from(rule === "Copy" ? "copied bytes\n" : "literal bytes\n")

const fixture = async (rule: Rule, output: string) => {
  const sandbox = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-native-containment-")))
  roots.push(sandbox)
  const root = Path.join(sandbox, "workspace")
  const packageRoot = Path.join(root, "data")
  const external = Path.join(sandbox, "external")
  await Fs.mkdir(packageRoot, { recursive: true })
  await Fs.mkdir(external)
  await Fs.writeFile(Path.join(root, "WORKSPACE.ts"), workspace)
  await Fs.writeFile(Path.join(packageRoot, "PACKAGE.ts"), declaration(rule, output))
  await Fs.writeFile(
    Path.join(root, "package.json"),
    JSON.stringify({
      name: "native-artifact-containment",
      private: true,
      packageManager: "pnpm@11.25.0"
    })
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.writeFile(Path.join(root, "input.txt"), "copied bytes\n")
  return { root, packageRoot, external }
}

const run = async (root: string) => {
  let exitCode = 0
  let output = ""
  const terminal = {
    write: (text: string) => {
      output += text
    },
    isTTY: false as const,
    columns: undefined
  }
  await makeCli({ presentation: executionPresentation, stdout: terminal, stderr: terminal }).serve(
    [...normalizeArgv(["//data:artifact"]), "--workspace", root],
    {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        output += text
      }
    }
  )
  return { exitCode, output }
}

describe.each<Rule>(["Fetch", "Copy", "Literal"])("S.%s native artifact containment", (rule) => {
  it("preserves an existing external destination through a symlinked parent", async () => {
    const { root, packageRoot, external } = await fixture(rule, "out/artifact.txt")
    const destination = Path.join(external, "artifact.txt")
    await Fs.writeFile(destination, original)
    await Fs.symlink(external, Path.join(packageRoot, "out"), "dir")

    const result = await run(root)

    expect(result.exitCode, result.output).toBe(1)
    expect(await Fs.readFile(destination)).toEqual(original)
    expect(await Fs.readdir(external)).toEqual(["artifact.txt"])
  })

  it("does not create an output under an escaping parent", async () => {
    const { root, packageRoot, external } = await fixture(rule, "out/nested/artifact.txt")
    await Fs.symlink(external, Path.join(packageRoot, "out"), "dir")

    const result = await run(root)

    expect(result.exitCode, result.output).toBe(1)
    expect(await Fs.readdir(external)).toEqual([])
  })

  it("preserves an external file named by a leaf symlink", async () => {
    const { root, packageRoot, external } = await fixture(rule, "out/artifact.txt")
    await Fs.mkdir(Path.join(packageRoot, "out"))
    const destination = Path.join(external, "artifact.txt")
    await Fs.writeFile(destination, original)
    await Fs.symlink(destination, Path.join(packageRoot, "out/artifact.txt"), "file")

    const result = await run(root)

    expect(result.exitCode, result.output).toBe(1)
    expect(await Fs.readFile(destination)).toEqual(original)
    expect((await Fs.lstat(Path.join(packageRoot, "out/artifact.txt"))).isSymbolicLink()).toBe(true)
  })

  it("refuses a parent symlink even when it resolves inside the workspace", async () => {
    const { root, packageRoot } = await fixture(rule, "out/artifact.txt")
    await Fs.mkdir(Path.join(packageRoot, "inside"))
    await Fs.symlink(Path.join(packageRoot, "inside"), Path.join(packageRoot, "out"), "dir")

    const result = await run(root)

    expect(result.exitCode, result.output).toBe(1)
    expect(await Fs.readdir(Path.join(packageRoot, "inside"))).toEqual([])
  })

  it("writes an ordinary nested output", async () => {
    const { root, packageRoot } = await fixture(rule, "out/nested/artifact.txt")

    const result = await run(root)

    expect(result.exitCode, result.output).toBe(0)
    expect(await Fs.readFile(Path.join(packageRoot, "out/nested/artifact.txt"))).toEqual(expected(rule))
  })
})
