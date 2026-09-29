import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const rustc = (() => {
  try {
    const details = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    return {
      host: details.match(/^host: (.+)$/m)?.[1],
      toolchain: execFileSync("rustup", ["show", "active-toolchain"], { encoding: "utf8" }).split(/\s/)[0]
    }
  } catch {
    return { host: undefined, toolchain: undefined }
  }
})()

it.skipIf(!rustc.host || !rustc.toolchain)(
  "runs a Cargo binary tool edge with and without an explicit host target",
  async () => {
    for (const target of [undefined, rustc.host]) {
      const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-cargo-tool-edge-")))
      try {
        await write(
          root,
          "WORKSPACE.ts",
          `import { Smithers as S } from "@smthrs/targets"
const rust = S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: ${JSON.stringify(rustc.toolchain)} })
export const Workspace = S.Workspace("cargo-tool-edge", {
  repository: "git+https://example.invalid/cargo-tool-edge.git",
  cache: S.Cache({ directory: ".flows" }), toolchains: [rust], host: S.Host({ bins: ["cargo"] })
})
`
        )
        await write(
          root,
          "PACKAGE.ts",
          `import { Smithers as S } from "@smthrs/targets"
const build = S.Cargo.Build({ workspace: true, bins: ["review_tool"], ${
            target ? `target: ${JSON.stringify(target)},` : ""
          }
  offline: true, data: [S.file("//Cargo.toml"), S.glob("//src/**")],
  outDirs: ["//target"], sandbox: "none" })
const consume = S.Shell.Run({ bin: build, args: [], sandbox: "none" })
export const Package = S.Package({ targets: { build, consume } })
`
        )
        await write(root, "Cargo.toml", "[package]\nname = \"review_tool\"\nversion = \"0.1.0\"\nedition = \"2021\"\n")
        await write(root, "src/main.rs", "fn main() { println!(\"review-cargo-tool\"); }\n")
        const result = await serve(root, ["run", "//:consume"])
        expect(result.exitCode, result.logs).toBe(0)
        expect(result.logs + result.output).toContain("review-cargo-tool")
        const binary = Path.join(
          root,
          "target",
          ...(target ? [target] : []),
          "debug",
          `review_tool${process.platform === "win32" ? ".exe" : ""}`
        )
        expect(execFileSync(binary, { encoding: "utf8" }).trim()).toBe("review-cargo-tool")
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }
  }
)
