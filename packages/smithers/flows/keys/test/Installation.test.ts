import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

it.each(["README.md", "docs/installation.md"])("%s names the platform used by its Node example", (path) => {
  const document = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

  expect(manifest.devDependencies["@effect/platform-node"]).toBeDefined()
  expect(document).toContain("import * as NodeCrypto from \"@effect/platform-node/NodeCrypto\"")
  expect(document).toContain("`@effect/platform-node` provides `NodeCrypto`")
  expect(document).toContain("/docs/installation/#use-the-libraries")
})
