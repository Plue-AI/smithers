import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { publish } from "../src/internal/rules/NativeArtifactOutput.ts"

const faults = vi.hoisted(() => ({
  lstat: null as null | ((path: string) => Error | null),
  mkdir: null as null | ((path: string) => Error | null)
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    lstat: (path: string, options?: object) => {
      const failure = faults.lstat?.(path)
      return failure === undefined || failure === null ? actual.lstat(path, options as never) : Promise.reject(failure)
    },
    mkdir: (path: string, options?: object) => {
      const failure = faults.mkdir?.(path)
      return failure === undefined || failure === null ? actual.mkdir(path, options as never) : Promise.reject(failure)
    }
  }
})

const sandboxes: Array<string> = []
const oldBytes = Buffer.from("old artifact\n")
const newBytes = Buffer.from("new artifact\n")

const fixture = async () => {
  const sandbox = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-native-output-")))
  sandboxes.push(sandbox)
  const root = Path.join(sandbox, "workspace")
  const external = Path.join(sandbox, "external")
  await Fs.mkdir(root)
  await Fs.mkdir(external)
  return { sandbox, root, external }
}

const write = (root: string, output: string, signal?: AbortSignal) =>
  publish(root, output, async (temporary, checkParent) => {
    await checkParent()
    await Fs.writeFile(temporary, newBytes, { flag: "wx" })
    return "produced"
  }, signal)

afterEach(async () => {
  faults.lstat = null
  faults.mkdir = null
  vi.restoreAllMocks()
  await Promise.all(sandboxes.splice(0).map((sandbox) => Fs.rm(sandbox, { recursive: true, force: true })))
})

describe("native artifact publication", () => {
  it.each(["../escape.txt", "out/../escape.txt", "out\\..\\escape.txt", ".", "", "/tmp/escape.txt"])(
    "refuses an output outside a named workspace file: %s",
    async (output) => {
      const { root, external } = await fixture()
      const producer = vi.fn(async () => "produced")

      await expect(publish(root, output, producer)).rejects.toThrow(
        /native output must name a file inside the workspace/
      )

      expect(producer).not.toHaveBeenCalled()
      expect(await Fs.readdir(root)).toEqual([])
      expect(await Fs.readdir(external)).toEqual([])
    }
  )

  it.each(["dangling", "internal", "external", "file"] as const)(
    "refuses a %s output parent without invoking the producer",
    async (kind) => {
      const { root, external } = await fixture()
      const parent = Path.join(root, "out")
      const externalFile = Path.join(external, "artifact.txt")
      await Fs.writeFile(externalFile, oldBytes)
      if (kind === "internal") {
        const inside = Path.join(root, "inside")
        await Fs.mkdir(inside)
        await Fs.symlink(inside, parent, "dir")
      } else if (kind === "external") {
        await Fs.symlink(external, parent, "dir")
      } else if (kind === "dangling") {
        await Fs.symlink(Path.join(root, "missing"), parent, "dir")
      } else {
        await Fs.writeFile(parent, oldBytes)
      }
      const producer = vi.fn(async () => "produced")

      await expect(publish(root, "out/artifact.txt", producer)).rejects.toThrow()

      expect(producer).not.toHaveBeenCalled()
      expect(await Fs.readFile(externalFile)).toEqual(oldBytes)
      expect(await Fs.readdir(external)).toEqual(["artifact.txt"])
      if (kind === "internal") expect(await Fs.readdir(Path.join(root, "inside"))).toEqual([])
      if (kind === "file") expect(await Fs.readFile(parent)).toEqual(oldBytes)
    }
  )

  it.each(["dangling", "internal", "external", "directory"] as const)(
    "refuses a %s output leaf without replacing it",
    async (kind) => {
      const { root, external } = await fixture()
      const output = Path.join(root, "artifact.txt")
      const externalFile = Path.join(external, "artifact.txt")
      await Fs.writeFile(externalFile, oldBytes)
      if (kind === "internal") {
        await Fs.writeFile(Path.join(root, "inside.txt"), oldBytes)
        await Fs.symlink(Path.join(root, "inside.txt"), output, "file")
      } else if (kind === "external") {
        await Fs.symlink(externalFile, output, "file")
      } else if (kind === "dangling") {
        await Fs.symlink(Path.join(root, "missing.txt"), output, "file")
      } else {
        await Fs.mkdir(output)
      }
      const producer = vi.fn(async () => "produced")

      await expect(publish(root, "artifact.txt", producer)).rejects.toThrow()

      expect(producer).not.toHaveBeenCalled()
      expect(await Fs.readFile(externalFile)).toEqual(oldBytes)
      expect(await Fs.readdir(external)).toEqual(["artifact.txt"])
      expect((await Fs.lstat(output)).isDirectory()).toBe(kind === "directory")
      if (kind === "internal") expect(await Fs.readFile(Path.join(root, "inside.txt"))).toEqual(oldBytes)
    }
  )

  it("creates missing nested parents and publishes the producer's closed file", async () => {
    const { root } = await fixture()

    await expect(write(root, "out/nested/artifact.txt")).resolves.toBe("produced")

    expect(await Fs.readFile(Path.join(root, "out/nested/artifact.txt"))).toEqual(newBytes)
    expect(await Fs.readdir(Path.join(root, "out/nested"))).toEqual(["artifact.txt"])
  })

  it("publishes a file with a 240-character basename", async () => {
    const { root } = await fixture()
    const name = "a".repeat(240)

    await expect(write(root, name)).resolves.toBe("produced")

    expect(await Fs.readFile(Path.join(root, name))).toEqual(newBytes)
    expect(await Fs.readdir(root)).toEqual([name])
  })

  it("propagates an unexpected parent stat error without invoking the producer", async () => {
    const { root, external } = await fixture()
    const parent = Path.join(root, "out")
    const failure = Object.assign(new Error("parent stat denied"), { code: "EACCES" })
    let observations = 0
    faults.lstat = (path) => path === parent && ++observations === 2 ? failure : null
    const producer = vi.fn(async () => "produced")

    await expect(publish(root, "out/artifact.txt", producer)).rejects.toBe(failure)

    expect(observations).toBe(2)
    expect(producer).not.toHaveBeenCalled()
    expect(await Fs.readdir(root)).toEqual([])
    expect(await Fs.readdir(external)).toEqual([])
  })

  it("propagates an unexpected parent creation error without writing outside the workspace", async () => {
    const { root, external } = await fixture()
    const parent = Path.join(root, "out")
    const failure = Object.assign(new Error("parent creation denied"), { code: "EACCES" })
    faults.mkdir = (path) => path === parent ? failure : null

    await expect(write(root, "out/artifact.txt")).rejects.toBe(failure)

    expect(await Fs.readdir(root)).toEqual([])
    expect(await Fs.readdir(external)).toEqual([])
  })

  it("refuses a missing parent replaced by a symlink before preparation", async () => {
    const { root, external } = await fixture()
    const parent = Path.join(root, "out")
    const outside = Path.join(external, "artifact.txt")
    await Fs.writeFile(outside, oldBytes)

    await expect(publish(root, "out/artifact.txt", async (_temporary, prepareParent) => {
      await Fs.symlink(external, parent, "dir")
      await prepareParent()
    })).rejects.toThrow(/native output parent could not be created/)

    expect(await Fs.readFile(outside)).toEqual(oldBytes)
    expect(await Fs.readdir(external)).toEqual(["artifact.txt"])
    expect((await Fs.lstat(parent)).isSymbolicLink()).toBe(true)
  })

  it("leaves absent admitted parents absent when the producer fails before preparation", async () => {
    const { root, external } = await fixture()
    const failure = new Error("download failed before writing")

    await expect(publish(root, "out/nested/artifact.txt", async () => {
      throw failure
    })).rejects.toBe(failure)

    expect(await Fs.readdir(root)).toEqual([])
    expect(await Fs.readdir(external)).toEqual([])
  })

  it("preserves old bytes and removes the temporary after producer failure", async () => {
    const { root } = await fixture()
    const destination = Path.join(root, "artifact.txt")
    await Fs.writeFile(destination, oldBytes)
    const failure = new Error("producer failed")

    await expect(publish(root, "artifact.txt", async (temporary) => {
      await Fs.writeFile(temporary, newBytes, { flag: "wx" })
      throw failure
    })).rejects.toBe(failure)

    expect(await Fs.readFile(destination)).toEqual(oldBytes)
    expect(await Fs.readdir(root)).toEqual(["artifact.txt"])
  })

  it("cancels before publication and removes the temporary", async () => {
    const { root } = await fixture()
    const destination = Path.join(root, "artifact.txt")
    await Fs.writeFile(destination, oldBytes)
    const controller = new AbortController()
    const cancellation = new Error("cancel publication")

    await expect(publish(root, "artifact.txt", async (temporary) => {
      await Fs.writeFile(temporary, newBytes, { flag: "wx" })
      controller.abort(cancellation)
    }, controller.signal)).rejects.toBe(cancellation)

    expect(await Fs.readFile(destination)).toEqual(oldBytes)
    expect(await Fs.readdir(root)).toEqual(["artifact.txt"])
  })

  it("refuses a parent swapped while the producer awaits and leaves the external tree untouched", async () => {
    const { root, external } = await fixture()
    const parent = Path.join(root, "out")
    const detached = Path.join(root, "detached")
    const externalFile = Path.join(external, "artifact.txt")
    await Fs.mkdir(parent)
    await Fs.writeFile(externalFile, oldBytes)
    let resume!: () => void
    const waiting = new Promise<void>((resolve) => {
      resume = resolve
    })
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const publication = publish(root, "out/artifact.txt", async (temporary) => {
      await Fs.writeFile(temporary, newBytes, { flag: "wx" })
      ready()
      await waiting
    })

    await started
    await Fs.rename(parent, detached)
    await Fs.symlink(external, parent, "dir")
    resume()

    await expect(publication).rejects.toThrow(/native output parent/)
    expect(await Fs.readFile(externalFile)).toEqual(oldBytes)
    expect(await Fs.readdir(external)).toEqual(["artifact.txt"])
    expect(await Fs.readdir(detached)).toHaveLength(1)
  })

  it("replaces a hardlinked destination without changing the external file", async () => {
    const { root, external } = await fixture()
    const destination = Path.join(root, "artifact.txt")
    const externalFile = Path.join(external, "artifact.txt")
    await Fs.writeFile(externalFile, oldBytes)
    await Fs.link(externalFile, destination)

    await expect(write(root, "artifact.txt")).resolves.toBe("produced")

    expect(await Fs.readFile(destination)).toEqual(newBytes)
    expect(await Fs.readFile(externalFile)).toEqual(oldBytes)
    expect(await Fs.readdir(root)).toEqual(["artifact.txt"])
  })

  it("does not clean up through a parent that appeared during a failed download", async () => {
    const { root, external } = await fixture()
    let outsideTemporary = ""
    const failure = new Error("HTTP response failed")

    await expect(publish(root, "out/artifact.txt", async (temporary) => {
      outsideTemporary = Path.join(external, Path.basename(temporary))
      await Fs.writeFile(outsideTemporary, oldBytes)
      await Fs.symlink(external, Path.join(root, "out"), "dir")
      throw failure
    })).rejects.toBe(failure)

    expect(await Fs.readFile(outsideTemporary)).toEqual(oldBytes)
    expect(await Fs.readdir(external)).toEqual([Path.basename(outsideTemporary)])
  })

  it("refuses a temporary replaced by a symlink before publication", async () => {
    const { root, external } = await fixture()
    const outside = Path.join(external, "artifact.txt")
    await Fs.writeFile(outside, oldBytes)
    await Fs.writeFile(Path.join(root, "artifact.txt"), oldBytes)

    await expect(publish(root, "artifact.txt", async (temporary) => {
      await Fs.symlink(outside, temporary, "file")
    })).rejects.toThrow(/native output temporary is a symbolic link/)

    expect(await Fs.readFile(outside)).toEqual(oldBytes)
    expect(await Fs.readFile(Path.join(root, "artifact.txt"))).toEqual(oldBytes)
    expect(await Fs.readdir(root)).toEqual(["artifact.txt"])
  })

  it("publishes concurrent outputs whose common parent was absent at admission", async () => {
    const { root } = await fixture()
    let ready = 0
    let resume!: () => void
    const bothAdmitted = new Promise<void>((resolve) => {
      resume = resolve
    })
    await Promise.all(
      ["a.txt", "b.txt"].map((name) =>
        publish(root, `out/nested/${name}`, async (temporary, prepareParent) => {
          ready += 1
          if (ready === 2) resume()
          await bothAdmitted
          await prepareParent()
          await Fs.writeFile(temporary, name, { flag: "wx" })
        })
      )
    )

    for (const name of ["a.txt", "b.txt"]) {
      expect(await Fs.readFile(Path.join(root, "out/nested", name), "utf8")).toBe(name)
    }
    expect((await Fs.readdir(Path.join(root, "out/nested"))).sort()).toEqual(["a.txt", "b.txt"])
  })
})
