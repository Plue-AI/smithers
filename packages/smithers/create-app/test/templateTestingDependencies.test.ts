import { expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

it("ships the testing prerequisites selected by the default chat test", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../template/default/package.json", import.meta.url), "utf8")
  ) as { readonly devDependencies: Readonly<Record<string, string>> }
  const test = readFileSync(new URL("../template/default/flows/chat/flow.e2e.ts", import.meta.url), "utf8")
  expect(test).toContain("\"@smthrs/create-app/testing\"")
  expect(manifest.devDependencies["@effect/platform-node"]).toBe("4.0.0-rc.115")
  expect(manifest.devDependencies["@smthrs/testing"]).toBe("1.0.0-rc.1")
  expect(manifest.devDependencies.vitest).toBe("5.0.0")
  const pageTest = readFileSync(new URL("../template/default/test/page.test.ts", import.meta.url), "utf8")
  expect(pageTest.split("\n")[0]).toBe("// @vitest-" + "environment happy-dom")
  expect(manifest.devDependencies["happy-dom"]).toBe("20.13.2")
  expect(pageTest).toContain("from \"@smthrs/create-app/ui\"")
  expect(pageTest).not.toContain("../../../src/")
  const config = readFileSync(new URL("../template/default/vitest.config.ts", import.meta.url), "utf8")
  expect(config).not.toContain("../../src/")
})
