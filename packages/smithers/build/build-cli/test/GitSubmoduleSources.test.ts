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

const planFor = (root: string) =>
  GitSubmoduleExec.plan({ root, packagePath: "", rule: "Git.Submodule", attrs: { path: "//vendor/one" } as never })

describe("Git submodule local sources", () => {
  it("admits a local git repository as a sandbox read", async () => {
    const source = await temporary("smthrs-submodule-repo-")
    git(source, ["init", "-q"])
    const plan = await planFor(await workspace(source))
    expect(plan.refusal).toBeUndefined()
    expect(plan.sources).toEqual([source])
  })

  it("admits a bare repository named by a file:// url", async () => {
    const source = await temporary("smthrs-submodule-bare-")
    git(source, ["init", "-q", "--bare"])
    const plan = await planFor(await workspace(`file://${source}`))
    expect(plan.refusal).toBeUndefined()
    expect(plan.sources).toEqual([`${source}`])
  })

  it("refuses a committed url naming a directory that is not a repository", async () => {
    const secrets = await temporary("smthrs-submodule-secrets-")
    await Fs.writeFile(NodePath.join(secrets, "id_ed25519"), "secret")
    const plan = await planFor(await workspace(`file://${secrets}`))
    expect(plan.sources).toEqual([])
    expect(plan.refusal).toContain("is not a git repository")
  })

  it("refuses the filesystem root and the home directory", async () => {
    for (const url of ["/", Os.homedir(), NodePath.dirname(Os.homedir())]) {
      const plan = await planFor(await workspace(url))
      expect(plan.sources).toEqual([])
      expect(plan.refusal).toContain("root or home directory")
    }
  })
})
