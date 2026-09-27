import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import { copy } from "../src/internal/backend/Copy.ts"
import { remote } from "../src/internal/backend/SSH.ts"
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const fixture = async (script = "for last do :; done\nexec /bin/bash -c \"$last\"\n") => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "one-cli-copy-")))
  dirs.push(home)
  await mkdir(join(home, "bin"))
  await writeFile(join(home, "bin/ssh"), "#!/bin/sh\n" + script)
  await chmod(join(home, "bin/ssh"), 0o755)
  const exit = vi.fn()
  const c = new Client({
    environment: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: home,
      PATH: join(home, "bin") + ":" + process.env.PATH,
      SMITHERS_API_ORIGIN: "https://api.example.test",
      COPYFILE_DISABLE: "1"
    },
    exit
  })
  vi.spyOn(c, "request").mockResolvedValue({ ssh_command: "ssh guest" })
  return { c, home, exit }
}
const options = { repo: "owner/repo" }
describe("actual copy transport", () => {
  it("uploads and downloads a file under a new name", async () => {
    const { c, home } = await fixture()
    const source = join(home, "source"), guest = join(home, "guest"), downloaded = join(home, "download")
    await writeFile(source, "file content")
    expect(await copy(c, { src: source, dst: `box:${guest}` }, options)).toMatchObject({
      workspace_id: "box",
      files: 1,
      bytes: 12
    })
    expect(await readFile(guest, "utf8")).toBe("file content")
    expect(await copy(c, { src: `box:${guest}`, dst: downloaded }, options)).toMatchObject({ files: 1, bytes: 12 })
    expect(await readFile(downloaded, "utf8")).toBe("file content")
    expect((await readdir(home)).some((name) => name.startsWith(".smithers-cp-"))).toBe(false)
  })
  it("merges directory contents and replaces an existing ordinary file", async () => {
    const { c, home } = await fixture()
    const source = join(home, "source"), guest = join(home, "guest"), destination = join(home, "destination")
    await mkdir(join(source, "nested"), { recursive: true })
    await mkdir(destination)
    await writeFile(join(source, "nested/item"), "new")
    await writeFile(join(source, "item"), "new")
    await mkdir(join(destination, "nested"))
    await writeFile(join(destination, "item"), "old")
    await copy(c, { src: source + "/.", dst: `box:${guest}/` }, options)
    await copy(c, { src: `box:${guest}/.`, dst: destination }, options)
    expect(await readFile(join(destination, "nested/item"), "utf8")).toBe("new")
    expect(await readFile(join(destination, "item"), "utf8")).toBe("new")
  })
  it("downloads a named directory into an existing directory", async () => {
    const { c, home } = await fixture()
    await mkdir(join(home, "source"))
    await mkdir(join(home, "destination"))
    await writeFile(join(home, "source/item"), "value")
    await copy(c, { src: `box:${home}/source`, dst: join(home, "destination") }, options)
    expect(await readFile(join(home, "destination/source/item"), "utf8")).toBe("value")
  })
  it("refuses to merge through an existing symlink", async () => {
    const { c, home } = await fixture()
    await mkdir(join(home, "source"))
    await mkdir(join(home, "destination"))
    await mkdir(join(home, "outside"))
    await writeFile(join(home, "source/item"), "new")
    await writeFile(join(home, "outside/item"), "keep")
    await symlink(join(home, "outside/item"), join(home, "destination/item"))
    await expect(copy(c, { src: `box:${home}/source/.`, dst: join(home, "destination") }, options)).rejects.toThrow(
      "symlink"
    )
    expect(await readFile(join(home, "outside/item"), "utf8")).toBe("keep")
  })
  it.each([["a", "b"], ["one:/a", "two:/b"], ["one:", "b"]])("rejects invalid endpoints %s -> %s", async (src, dst) => {
    const { c } = await fixture()
    await expect(copy(c, { src, dst }, options)).rejects.toThrow("Exactly one")
  })
  it("keeps a missing remote path visible", async () => {
    const { c, home, exit } = await fixture()
    await expect(copy(c, { src: "box:/no-such-smithers-path", dst: join(home, "out") }, options)).rejects.toThrow(
      "Remote path not found"
    )
    expect(exit).toHaveBeenCalledWith(44)
  })
  it("rejects /. for a file", async () => {
    const { c, home } = await fixture()
    await writeFile(join(home, "file"), "value")
    await expect(copy(c, { src: join(home, "file") + "/.", dst: `box:${home}/out` }, options)).rejects.toThrow(
      "directory"
    )
  })
})

describe("SSH process receipts", () => {
  it("preserves stdout, stderr, stdin, and nonzero status", async () => {
    const { c } = await fixture()
    const result = await remote(c, "ssh guest", "cat; printf error >&2; exit 7", 1000, Readable.from(["input"]))
    expect(result.code).toBe(7)
    expect(result.stdout.toString()).toBe("input")
    expect(result.stderr.toString()).toBe("error")
  })
  it("times out an unresolved remote process", async () => {
    const { c } = await fixture("exec sleep 10\n")
    await expect(remote(c, "ssh guest", "command", 10)).rejects.toThrow("timed out")
  })
  it("streams output without losing the completion receipt", async () => {
    const { c } = await fixture()
    const output = vi.spyOn(c, "output")
    expect((await remote(c, "ssh guest", "printf hello; printf error >&2", 1000, undefined, false, true)).code).toBe(0)
    expect(output).toHaveBeenCalled()
  })
})
