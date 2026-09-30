import { expect, test } from "bun:test"

test("real workerd exports, reopens and validates more than 50,000 rows and 8 MB with refusal controls", async () => {
  const build = async (entry: string, target: "browser" | "node") => {
    const result = await Bun.build({ entrypoints: [new URL(entry, import.meta.url).pathname], target, format: "esm", minify: true })
    if (!result.success || result.outputs.length !== 1) throw new Error("Paged workerd bundle failed")
    return result.outputs[0]!.text()
  }
  const exporter = await build("../../src/MaintenanceExport.ts", "browser")
  const validator = await build("./paged.ts", "node")
  const reader = await build("./sealed.ts", "node")
  const child = Bun.spawn(["node", new URL("./paged-workerd.mjs", import.meta.url).pathname], {
    stdin: new Blob([JSON.stringify({ exporter, validator, reader })]), stdout: "pipe", stderr: "pipe"
  })
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(error).toBe("")
  expect(code).toBe(0)
  expect(out).toContain("50003 exact rows")
  expect(out).toContain("refusal controls passed")
  console.log(out.trim())
}, 300_000)
