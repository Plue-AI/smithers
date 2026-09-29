import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("loads the public CloudSandbox provider without importing the flow engine or NodeControl", () => {
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { registerHooks } from "node:module"
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (/^@smthrs\\/engine(?:-store)?(?:\\/|$)/.test(specifier) || /(?:^|\\/)NodeControl(?:\\.(?:ts|js))?$/.test(specifier)) {
        throw new Error("Cloud transport must load independently of " + specifier)
      }
      return nextResolve(specifier, context)
    } })
    const { make } = await import("@smthrs/cli/CloudSandbox")
    if (typeof make !== "function") throw new Error("Missing provider constructor")
    process.stdout.write("loaded")
  `
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000 })
  expect(output).toBe("loaded")
})
