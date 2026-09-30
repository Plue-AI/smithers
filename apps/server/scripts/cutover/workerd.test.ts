import { expect, test } from "bun:test"
import { uploadModuleType, wrapperFor } from "./deployment"

test("actual workerd wraps the live edge, retains original DO storage and serves only sealed authorized exports", async () => {
  const build = async (entry: string) => {
    const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true })
    if (!result.success) throw new Error("Workerd test bundle failed")
    return result.outputs[0]!.text()
  }
  // The live entry is the shared edge, whose retained classes answer 410 over the storage they keep.
  const legacy = await build(new URL("../../src/edge.ts", import.meta.url).pathname)
  const helper = await build(new URL("../../src/MaintenanceExport.ts", import.meta.url).pathname)
  const seedLegacy = await Bun.file(new URL("./legacy-state-fixture.mjs", import.meta.url)).text()
  const child = Bun.spawn(["node", new URL("./export-workerd.mjs", import.meta.url).pathname], {
    stdin: new Blob([JSON.stringify({ legacy, seedLegacy, helper, entry: "edge.js", retired: true, wrapper: wrapperFor("edge.js"), legacyMime: uploadModuleType("edge.js", "text/javascript;charset=utf-8", "edge.js") })]), stdout: "pipe", stderr: "pipe"
  })
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(error).toBe("")
  expect(code).toBe(0)
  expect(out).toContain("unchanged read passed")
  expect(out).toContain("inherited RPC and native alarm passed")
}, 60_000)
