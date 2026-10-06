import { expect, test } from "bun:test"

// workerd, not Bun: it refuses a main module with non-handler named exports,
// which a Bun-only test cannot see (src/docsRedirectWorker.ts).
test("workerd serves the redirect Worker: slugs answer 301, other hosts pass through", async () => {
  const bundle = await Bun.build({ entrypoints: [new URL("docsRedirectWorker.ts", import.meta.url).pathname], target: "browser" })
  expect(bundle.success).toBe(true)
  const child = Bun.spawn(["node", new URL("../scripts/docs-redirect-workerd.mjs", import.meta.url).pathname], {
    stdin: new Blob([await bundle.outputs[0]!.text()]), stdout: "pipe", stderr: "pipe"
  })
  const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ status, error }).toEqual({ status: 0, error: "" })
  expect(output.trim()).toBe("docs redirect passed")
}, 30_000)
