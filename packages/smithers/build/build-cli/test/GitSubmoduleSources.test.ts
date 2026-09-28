import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GitSubmoduleExec from "../src/GitSubmoduleExec.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

/** A superproject whose committed `.gitmodules` points vendor/one at `url`. */
const workspace = async (url: string): Promise<string> => {
  const root = await temporary("smthrs-submodule-sources-")
  git(root, ["init", "-q"])
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/one`])
  await Fs.writeFile(
    NodePath.join(root, ".gitmodules"),
    `[submodule "one"]\n\tpath = vendor/one\n\turl = ${url}\n`
  )
  return root
}

const planFor = (root: string, environment: Readonly<Record<string, string | undefined>> = {}) =>
  GitSubmoduleExec.plan({
    root,
    packagePath: "",
    rule: "Git.Submodule",
    attrs: { path: "//vendor/one" } as never,
    environment
  })

const allow = (...directories: ReadonlyArray<string>) => ({
  [GitSubmoduleExec.submoduleSourcesVariable]: directories.join(NodePath.delimiter)
})

describe("Git submodule local sources", () => {
  it("admits a local git repository inside the workspace as a sandbox read", async () => {
    const root = await workspace("./mirrors/one")
    const source = NodePath.join(root, "mirrors", "one")
    await Fs.mkdir(source, { recursive: true })
    git(source, ["init", "-q"])
    await Fs.writeFile(
      NodePath.join(root, ".gitmodules"),
      `[submodule "one"]\n\tpath = vendor/one\n\turl = ${source}\n`
    )
    const plan = await planFor(root)
    expect(plan.refusal).toBeUndefined()
    expect(plan.sources).toEqual([source])
  })

  it("refuses a git repository elsewhere under the home directory", async () => {
    const home = await temporary("smthrs-submodule-home-")
    const source = NodePath.join(home, "plue")
    await Fs.mkdir(source)
    git(source, ["init", "-q"])
    const previous = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const plan = await planFor(await workspace(source))
      expect(plan.sources).toEqual([])
      expect(plan.refusal).toContain("outside the workspace")
    } finally {
      if (previous === undefined) delete process.env["HOME"]
      else process.env["HOME"] = previous
    }
  })

  it("admits a bare repository named by a file:// url under an operator-listed directory", async () => {
    const mirrors = await temporary("smthrs-submodule-mirrors-")
    const source = NodePath.join(mirrors, "one.git")
    await Fs.mkdir(source)
    git(source, ["init", "-q", "--bare"])
    const superproject = await workspace(`file://${source}`)
    expect((await planFor(superproject)).refusal).toContain("outside the workspace")
    const plan = await planFor(superproject, allow(mirrors))
    expect(plan.refusal).toBeUndefined()
    expect(plan.sources).toEqual([source])
  })

  it("refuses a committed url naming a directory that is not a repository", async () => {
    const secrets = await temporary("smthrs-submodule-secrets-")
    await Fs.writeFile(NodePath.join(secrets, "id_ed25519"), "secret")
    const plan = await planFor(await workspace(`file://${secrets}`), allow(secrets))
    expect(plan.sources).toEqual([])
    expect(plan.refusal).toContain("is not a git repository")
  })

  it("refuses the filesystem root and the home directory even when listed", async () => {
    for (const url of ["/", Os.homedir(), NodePath.dirname(Os.homedir())]) {
      const plan = await planFor(await workspace(url), allow("/"))
      expect(plan.sources).toEqual([])
      expect(plan.refusal).toContain("root or home directory")
    }
  })
})
