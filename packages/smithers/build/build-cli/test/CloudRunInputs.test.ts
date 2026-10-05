import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})
it("keys distribution Go contracts on local Go edits across the package boundary", async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "preview-inputs-"))
  roots.push(root)
  await Fs.cp(Path.join(import.meta.dirname, "fixtures/chain-exec"), root, { recursive: true })
  await Fs.mkdir(Path.join(root, "distribution"))
  const source = Path.resolve(import.meta.dirname, "../../../../../distribution/PACKAGE.ts")
  await Fs.copyFile(source, Path.join(root, "distribution/PACKAGE.ts"))
  for (
    const file of [
      "go.mod",
      "go.sum",
      ".dockerignore",
      "scripts/build-backend.sh",
      "distribution/Dockerfile",
      "distribution/fake-coding-provider.test.mjs",
      "distribution/fake-coding-provider.mjs"
    ]
  ) {
    await Fs.mkdir(Path.dirname(Path.join(root, file)), { recursive: true })
    await Fs.writeFile(Path.join(root, file), "fixture")
  }
  for (const directory of ["packages/backend/postgres", "packages/backend/testkit/testdb"]) {
    const sourceDirectory = Path.resolve(import.meta.dirname, "../../../../..", directory)
    await Fs.mkdir(Path.dirname(Path.join(root, directory)), { recursive: true })
    await Fs.cp(sourceDirectory, Path.join(root, directory), { recursive: true })
  }
  const file = Path.join(root, "distribution/source.go")
  await Fs.writeFile(file, "package distribution")
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  const plan = () =>
    PackageExec.plan({
      index,
      cacheDirectory: ".flows",
      verb: "test",
      patterns: ["//distribution:go"],
      environment: process.env
    })
  const before = (await plan()).workList.find((node) => node.label === "//distribution:go")!
  expect(before).toBeDefined()
  expect(before.refusal).toBeUndefined()
  await Fs.writeFile(file, "package distribution\n// changed")
  const after = (await plan()).workList.find((node) => node.label === "//distribution:go")!
  expect(after.keyPreview).not.toBe(before.keyPreview)
})
