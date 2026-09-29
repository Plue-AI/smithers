/**
 * Executable identity at the real workspace, process, and cache seams.
 *
 * @since 0.1.0
 */
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { serve as serveCli } from "./helpers/ServeCli.ts"

const temporary: Array<string> = []
const originalPath = process.env["PATH"]
const helperVariable = "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"
const originalHelper = process.env[helperVariable]
afterEach(async () => {
  process.env["PATH"] = originalPath
  if (originalHelper === undefined) delete process.env[helperVariable]
  else process.env[helperVariable] = originalHelper
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const directory = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-identity-")))
  temporary.push(root)
  return root
}
const write = async (root: string, path: string, text: string): Promise<void> => {
  const file = Path.join(root, path)
  await Fs.mkdir(Path.dirname(file), { recursive: true })
  await Fs.writeFile(file, text, { mode: 0o755 })
}
const fixture = async (target: string, extra = ""): Promise<{ root: string; tools: string }> => {
  const root = await directory()
  const tools = await directory()
  process.env["PATH"] = `${tools}${Path.delimiter}${originalPath ?? ""}`
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("identity", {
  repository: "git+https://example.invalid/identity.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "24" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["identity-compiler", "identity-helper"] }),
  ${extra}
})`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { dist: ${target} } })`
  )
  for (
    const args of [["init", "-q"], ["add", "-A"], [
      "-c",
      "user.email=t@t.t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "fixture"
    ]]
  ) {
    ChildProcess.execFileSync("git", ["-C", root, ...args])
  }
  return { root, tools }
}
/** Builds `//:dist`, requires it green, and returns the standard error log. */
const serve = async (root: string): Promise<string> => {
  const { exitCode, output, logs } = await serveCli(root, ["//:dist"])
  expect(exitCode, logs + output).toBe(0)
  return logs
}
const compiler = (tools: string, value: string): string =>
  `#!/bin/sh
if [ "$1" = --version ] || [ "$2" = --version ]; then echo 1.0.0; exit 0; fi
printf 'dispatch\\n' >> '${tools}/dispatches'
mkdir -p dist
printf '${value}' > dist/value
`
const assertReplacement = async (root: string, tools: string, replace: () => Promise<void>) => {
  expect(await serve(root)).toContain("//:dist  ran")
  expect(await Fs.readFile(Path.join(root, "dist/value"), "utf8")).toBe("first")
  expect(await serve(root)).toContain("//:dist  hit")
  await replace()
  expect(await serve(root)).toContain("//:dist  ran")
  expect(await Fs.readFile(Path.join(tools, "dispatches"), "utf8")).toBe("dispatch\ndispatch\n")
  expect(await Fs.readFile(Path.join(root, "dist/value"), "utf8")).toBe("second")
}

describe("executable cache identity", () => {
  it.each(["compiler", "@fixture/compiler"])(
    "admits the complete installed %s package but not its siblings",
    async (name) => {
      const { root, tools } = await fixture(
        "S.Shell.Build({ bin: S.Host.bin(\"identity-compiler\"), outDirs: [\"dist\"] })"
      )
      const installation = await directory()
      const packageRoot = Path.join(installation, "node_modules", name)
      const sibling = Path.join(installation, "node_modules/private.txt")
      await write(installation, "node_modules/private.txt", "private sibling")
      await write(packageRoot, "bin/compiler.mjs", "#!/usr/bin/env node\nimport \"../dist/main.mjs\"\n")
      await write(
        packageRoot,
        "dist/main.mjs",
        `import * as fs from "node:fs";
if (process.argv.includes("--version")) { console.log("1.0.0"); } else {
  let readable = false;
  try { fs.readFileSync(${JSON.stringify(sibling)}); readable = true; } catch {}
  if (readable) throw new Error("sibling package data is readable");
  fs.mkdirSync("dist", { recursive: true }); fs.writeFileSync("dist/value", "compiled");
}`
      )
      await Fs.symlink(Path.join(packageRoot, "bin/compiler.mjs"), Path.join(tools, "identity-compiler"))
      const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
      const planned = await PackageExec.plan({
        index: PackageIndex.make(loaded),
        patterns: ["//:dist"],
        cacheDirectory: ".flows",
        verb: "auto"
      })
      const reads = planned.nodes.get("//:dist")?.externalReads
      expect(reads).toContain(packageRoot)
      expect(reads).not.toContain(Path.join(installation, "node_modules"))
      expect(await serve(root)).toContain("//:dist  ran")
      expect(await Fs.readFile(Path.join(root, "dist/value"), "utf8")).toBe("compiled")
    }
  )

  it.each(["host", "command"])("admits the resolved %s tool and interpreter directories read-only", async (kind) => {
    const { root, tools } = await fixture(
      `S.Shell.Build({ ${
        kind === "host" ? "bin: S.Host.bin(\"identity-compiler\")" : "shell: \"identity-compiler\""
      }, outDirs: ["dist"] })`
    )
    const installed = await directory()
    const interpreters = await directory()
    await write(installed, "value", "compiled")
    await write(
      installed,
      "compiler",
      `#!/usr/bin/env identity-shell
if [ "$1" = --version ]; then echo 1.0.0; exit 0; fi
mkdir -p dist
cat '${installed}/value' > dist/value
if printf changed > '${installed}/value' 2>/dev/null; then exit 1; fi
`
    )
    await write(interpreters, "identity-shell", "#!/bin/sh\nexec /bin/sh \"$@\"\n")
    await Fs.symlink(Path.join(installed, "compiler"), Path.join(tools, "identity-compiler"))
    process.env["PATH"] = `${tools}${Path.delimiter}${interpreters}${Path.delimiter}${originalPath ?? ""}`
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const planned = await PackageExec.plan({
      index: PackageIndex.make(loaded),
      patterns: ["//:dist"],
      cacheDirectory: ".flows",
      verb: "auto"
    })
    expect(planned.nodes.get("//:dist")?.externalReads).toEqual(
      expect.arrayContaining([tools, installed, interpreters])
    )
    expect(await serve(root)).toContain("//:dist  ran")
    expect(await Fs.readFile(Path.join(root, "dist/value"), "utf8")).toBe("compiled")
    expect(await Fs.readFile(Path.join(installed, "value"), "utf8")).toBe("compiled")
    expect(await serve(root)).toContain("//:dist  hit")
  })

  it("leaves the executable installation to a declared Docker image", async () => {
    const { root, tools } = await fixture(
      "S.Shell.Build({ shell: \"identity-compiler\", outDirs: [\"dist\"] })",
      "sandboxes: S.Sandboxes({ default: S.Sandbox.Docker({ image: \"node:22-bookworm\" }) }),"
    )
    await write(tools, "identity-compiler", "#!/bin/sh\nexit 0\n")
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const planned = await PackageExec.plan({
      index: PackageIndex.make(loaded),
      patterns: ["//:dist"],
      cacheDirectory: ".flows",
      verb: "auto"
    })
    expect(planned.nodes.get("//:dist")?.externalReads).toEqual([])
  })

  it("admits a tool directly in /tmp without mounting the private temp root", async () => {
    const { root } = await fixture("S.Shell.Build({ shell: \"true\", outDirs: [\"dist\"] })")
    const name = `${Path.basename(root)}.compiler`
    const binary = Path.join("/tmp", name)
    const sibling = `${binary}.private`
    temporary.push(binary, sibling)
    await Fs.writeFile(sibling, "private sibling")
    await write(
      "/tmp",
      name,
      // The tool's own neighbours in the host temp root stay invisible: not
      // readable, and not even named by a listing. Each mechanism denies them
      // its own way, so the probe asks what both must answer rather than how
      // either answers it. Seatbelt leaves `/tmp` a link it may not follow, so
      // the listing fails outright; bubblewrap replaces `/tmp` with a private
      // tmpfs holding this tool and nothing else of the host's.
      `#!/bin/sh
if cat '${sibling}' >/dev/null 2>&1; then exit 41; fi
if ls /tmp 2>/dev/null | grep -q '${Path.basename(sibling)}'; then exit 42; fi
mkdir -p dist
printf compiled > dist/value
`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { dist: S.Shell.Build({ shell: "${binary}", outDirs: ["dist"] }) } })`
    )
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const planned = await PackageExec.plan({
      index: PackageIndex.make(loaded),
      patterns: ["//:dist"],
      cacheDirectory: ".flows",
      verb: "auto"
    })
    expect(planned.nodes.get("//:dist")?.externalReads).toContain(binary)
    expect(planned.nodes.get("//:dist")?.externalReads).not.toContain("/tmp")
    expect(planned.nodes.get("//:dist")?.externalReads).not.toContain(await Fs.realpath("/tmp"))
    expect(await serve(root)).toContain("//:dist  ran")
    expect(await Fs.readFile(Path.join(root, "dist/value"), "utf8")).toBe("compiled")
  })

  it("misses after replacing a declared host executable at the same path and version", async () => {
    const { root, tools } = await fixture(
      "S.Shell.Build({ bin: S.Host.bin(\"identity-compiler\"), outDirs: [\"dist\"], sandbox: \"none\" })"
    )
    await write(tools, "identity-compiler", compiler(tools, "first"))
    await assertReplacement(root, tools, () => write(tools, "identity-compiler", compiler(tools, "second")))
  })

  it.each([true, false])("keys a helper the tool spawns itself only when tools declares it (%s)", async (declared) => {
    const { root, tools } = await fixture(
      `S.Shell.Build({ bin: S.Host.bin("identity-compiler"), ${
        declared ? "tools: [S.Host.bin(\"identity-helper\")], " : ""
      }outDirs: ["dist"], sandbox: "none" })`
    )
    await write(
      tools,
      "identity-compiler",
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.0.0; exit 0; fi\nexec identity-helper \"$@\"\n"
    )
    await write(tools, "identity-helper", compiler(tools, "first"))
    if (declared) {
      await assertReplacement(root, tools, () => write(tools, "identity-helper", compiler(tools, "second")))
      return
    }
    // The undeclared helper is invisible to the key: a replacement replays.
    expect(await serve(root)).toContain("//:dist  ran")
    await write(tools, "identity-helper", compiler(tools, "second"))
    expect(await serve(root)).toContain("//:dist  hit")
    expect(await Fs.readFile(Path.join(root, "dist/value"), "utf8")).toBe("first")
  })

  it("keys the helper a Host.bin variable selects over PATH and hands the process that file", async () => {
    const { root, tools } = await fixture(
      `S.Shell.Build({ bin: S.Host.bin("identity-compiler"), tools: [S.Host.bin("identity-helper", { env: "${helperVariable}" })], outDirs: ["dist"], sandbox: "none" })`
    )
    const selected = await directory()
    await write(
      tools,
      "identity-compiler",
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.0.0; exit 0; fi\nexec "$${helperVariable}" "$@"\n`
    )
    // PATH holds a decoy the variable must win over.
    await write(tools, "identity-helper", "#!/bin/sh\nexit 9\n")
    await write(selected, "identity-helper", compiler(tools, "first"))
    process.env[helperVariable] = Path.join(selected, "identity-helper")
    await assertReplacement(root, tools, () => write(selected, "identity-helper", compiler(tools, "second")))
  })

  it.each([
    ["unset and absent from PATH", undefined, /not present on PATH and SMITHERS_WORKSPACE_JJ_EXPORT_BINARY is unset/],
    ["relative", "identity-helper", /SMITHERS_WORKSPACE_JJ_EXPORT_BINARY must name an absolute path/],
    ["not executable", "missing", /which is not an executable file/]
  ])("refuses a tools helper whose variable is %s", async (_, value, refusal) => {
    const { root, tools } = await fixture(
      `S.Shell.Build({ bin: S.Host.bin("identity-compiler"), tools: [S.Host.bin("identity-helper", { env: "${helperVariable}" })], outDirs: ["dist"], sandbox: "none" })`
    )
    await write(tools, "identity-compiler", compiler(tools, "first"))
    if (value === undefined) delete process.env[helperVariable]
    else process.env[helperVariable] = value === "missing" ? Path.join(tools, "absent-helper") : value
    // A PATH helper never stands in for a variable that names a broken path.
    if (value !== undefined) await write(tools, "identity-helper", compiler(tools, "first"))
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const planned = await PackageExec.plan({
      index: PackageIndex.make(loaded),
      patterns: ["//:dist"],
      cacheDirectory: ".flows",
      verb: "auto"
    })
    expect(planned.nodes.get("//:dist")?.refusal).toMatch(refusal)
    await expect(Fs.access(Path.join(tools, "dispatches"))).rejects.toThrow()
  })

  it("refuses Runtime.npx in tools, which cannot carry its command arguments", async () => {
    const { root, tools } = await fixture(
      `S.Shell.Build({ bin: S.Host.bin("identity-compiler"), tools: [S.Runtime.npx("cowsay@1.6.0")], outDirs: ["dist"], sandbox: "none" })`
    )
    await write(tools, "identity-compiler", compiler(tools, "first"))
    // The launcher resolves under the declared runtime, so declare this one.
    const workspace = Path.join(root, "WORKSPACE.ts")
    await Fs.writeFile(
      workspace,
      (await Fs.readFile(workspace, "utf8")).replace("version: \"24\"", `version: "${process.versions.node}"`)
    )
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const planned = await PackageExec.plan({
      index: PackageIndex.make(loaded),
      patterns: ["//:dist"],
      cacheDirectory: ".flows",
      verb: "auto"
    })
    expect(planned.nodes.get("//:dist")?.refusal).toBe("Runtime.npx references must be used as bin, not in tools")
  })

  it.each(["direct", "env", "env-split"])(
    "misses after replacing the %s shebang interpreter behind a symlink",
    async (kind) => {
      const { root, tools } = await fixture(
        "S.Shell.Build({ bin: S.Host.bin(\"identity-compiler\"), outDirs: [\"dist\"], sandbox: \"none\" })"
      )
      const interpreter = kind === "direct"
        ? `${tools}/identity-interpreter`
        : `/usr/bin/env ${kind === "env-split" ? "-S " : ""}identity-interpreter`
      await write(tools, "identity-compiler", `#!${interpreter}\n# The interpreter supplies the compiler behavior.\n`)
      const install = async (value: string): Promise<void> => {
        if (kind !== "direct") return write(tools, "interpreter", compiler(tools, value))
        // macOS does not accept a script as the direct shebang interpreter.
        // Compile a real executable so this fixture exercises the kernel seam.
        await write(
          tools,
          "interpreter.c",
          `#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) if (strcmp(argv[i], "--version") == 0) { puts("1.0.0"); return 0; }
  FILE *calls = fopen(${JSON.stringify(Path.join(tools, "dispatches"))}, "a");
  fputs("dispatch\\n", calls); fclose(calls);
  mkdir("dist", 0755);
  FILE *out = fopen("dist/value", "w"); fputs(${JSON.stringify(value)}, out); fclose(out);
  return 0;
}`
        )
        ChildProcess.execFileSync("cc", [Path.join(tools, "interpreter.c"), "-o", Path.join(tools, "interpreter")], {
          timeout: 60_000
        })
      }
      await install("first")
      await Fs.symlink("interpreter", Path.join(tools, "identity-interpreter"))
      await assertReplacement(root, tools, () => install("second"))
    }
  )

  it.each(["Nextest", "Deny"])("misses after replacing the Cargo.%s plugin at the same version", async (rule) => {
    const name = `cargo-${rule.toLowerCase()}`
    const { root, tools } = await fixture(
      `S.Cargo.${rule}({ ${
        rule === "Nextest" ? "workspace: true," : "config: S.file(\"//deny.toml\"),"
      } sandbox: "none" })`,
      "toolchains: [S.Rust.Toolchain({ workspace: S.file(\"//Cargo.toml\"), cargo: \"cargo\", channel: \"stable\" })],"
    )
    await write(root, "Cargo.toml", "[workspace]\nmembers = []\n")
    await write(root, "deny.toml", "")
    await write(
      tools,
      "cargo",
      `#!/bin/sh\nif [ "$1" = --version ]; then echo cargo-1; exit 0; fi\nexec ${name} "$@"\n`
    )
    await write(tools, name, compiler(tools, "first"))
    await assertReplacement(root, tools, () => write(tools, name, compiler(tools, "second")))
  })
  it("misses after replacing the Go toolchain selected by a stable launcher", async () => {
    const { root, tools } = await fixture("S.Shell.Build({ bin: S.Go.bin, outDirs: [\"dist\"], sandbox: \"none\" })")
    await write(
      tools,
      "go",
      `#!/bin/sh
if [ "$1" = version ]; then echo go1.26.0; exit 0; fi
if [ "$1" = env ]; then printf '{"GOROOT":"${tools}/sdk","GOTOOLDIR":"${tools}/sdk/pkg/tool"}'; exit 0; fi
exec '${tools}/sdk/bin/go' "$@"
`
    )
    await write(tools, "sdk/bin/go", compiler(tools, "first"))
    await Fs.mkdir(Path.join(tools, "sdk/pkg/tool"), { recursive: true })
    await assertReplacement(root, tools, () => write(tools, "sdk/bin/go", compiler(tools, "second")))
  })

  it("misses after replacing the rustup-selected cargo behind an unchanged proxy", async () => {
    const { root, tools } = await fixture(
      "S.Cargo.Test({ workspace: true, sandbox: \"none\" })",
      "toolchains: [S.Rust.Toolchain({ workspace: S.file(\"//Cargo.toml\"), channel: \"stable\" })],"
    )
    await write(root, "Cargo.toml", "[workspace]\nmembers = []\n")
    await write(root, "deny.toml", "")
    await write(
      tools,
      "rustup",
      `#!/bin/sh
if [ "$1" = which ]; then printf '%s/sdk/%s' '${tools}' "$4"; exit 0; fi
if [ "$1" = --version ]; then echo cargo-1; exit 0; fi
exec '${tools}/sdk/cargo' "$@"
`
    )
    await Fs.symlink("rustup", Path.join(tools, "cargo"))
    await write(tools, "sdk/cargo", compiler(tools, "first"))
    await write(tools, "sdk/rustc", "#!/bin/sh\nexit 0\n")
    await assertReplacement(root, tools, () => write(tools, "sdk/cargo", compiler(tools, "second")))
  })

  it("follows a host executable symlink and rehashes its target on every run", async () => {
    const { root, tools } = await fixture(
      "S.Shell.Build({ bin: S.Host.bin(\"identity-compiler\"), outDirs: [\"dist\"], sandbox: \"none\" })"
    )
    await write(tools, "implementation", compiler(tools, "first"))
    await Fs.symlink("implementation", Path.join(tools, "identity-compiler"))
    await assertReplacement(root, tools, () => write(tools, "implementation", compiler(tools, "second")))
  })

  it("keys the installed NodeModule.Bin entry bytes even when the manifest and lockfile stay fixed", async () => {
    const { root, tools } = await fixture(
      "S.Shell.Build({ bin: S.NodeModule.Bin(\"identity-compiler\"), outDirs: [\"dist\"], sandbox: \"none\" })"
    )
    await write(
      root,
      "node_modules/identity-compiler/package.json",
      JSON.stringify({ name: "identity-compiler", version: "1.0.0", bin: "cli" })
    )
    await write(root, "node_modules/identity-compiler/cli", compiler(tools, "first"))
    await Fs.mkdir(Path.join(root, "node_modules/.bin"), { recursive: true })
    await Fs.symlink("../identity-compiler/cli", Path.join(root, "node_modules/.bin/identity-compiler"))
    await assertReplacement(
      root,
      tools,
      () => write(root, "node_modules/identity-compiler/cli", compiler(tools, "second"))
    )
  })

  it.each(["shell", "generate"])("keys the %s TargetBin after its producer executes", async (kind) => {
    const { root, tools } = await fixture(
      "S.Shell.Build({ shell: \"true\", outDirs: [\"dist\"], sandbox: \"none\" })",
      "toolchains: [S.Rust.Toolchain({ workspace: S.file(\"//Cargo.toml\"), cargo: \"cargo\", channel: \"stable\" })],"
    )
    await write(root, "Cargo.toml", "[workspace]\nmembers = []\n")
    await write(
      tools,
      "cargo",
      `#!/bin/sh
if [ "$1" = --version ]; then echo 1.0.0; exit 0; fi
mkdir -p target/debug
cp '${tools}/compiled' target/debug/compiler
chmod +x target/debug/compiler
`
    )
    await write(tools, "compiled", compiler(tools, "first"))
    const target = kind === "shell"
      ? "S.Shell.Build({ bin: producer, outDirs: [\"dist\"], sandbox: \"none\" })"
      : "S.Generate({ bin: producer, changes: [\"dist/value\"], sandbox: \"none\" })"
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const producer = S.Cargo.Build({ workspace: true, bins: ["compiler"], sandbox: "none" })
export const Package = S.Package({ targets: { producer, dist: ${target} } })`
    )
    if (kind === "shell") {
      await assertReplacement(root, tools, () => write(tools, "compiled", compiler(tools, "second")))
    } else {
      // Check mode records a verdict. The initial generator is a no-op; the
      // replacement must run and detect drift even though its producer key is unchanged.
      await write(tools, "compiled", "#!/bin/sh\nexit 0\n")
      expect(await serve(root)).toContain("//:dist  ran")
      expect(await serve(root)).toContain("//:dist  hit")
      await write(tools, "compiled", "#!/bin/sh\nexit 7\n")
      const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
      const options = {
        index: PackageIndex.make(loaded),
        patterns: ["//:dist"],
        cacheDirectory: ".flows",
        verb: "auto" as const
      }
      const result = await PackageExec.run(options)
      expect("ok" in result && result.ok).toBe(false)
    }
  })

  it.each(["cold", "warm"])("refuses a host tool replaced after planning before a %s cache lookup", async (cache) => {
    const { root, tools } = await fixture(
      "S.Shell.Build({ bin: S.Host.bin(\"identity-compiler\"), outDirs: [\"dist\"], sandbox: \"none\" })"
    )
    await write(tools, "identity-compiler", compiler(tools, "first"))
    if (cache === "warm") await serve(root)
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const options = {
      index: PackageIndex.make(loaded),
      patterns: ["//:dist"],
      cacheDirectory: ".flows",
      verb: "auto" as const
    }
    const planned = await PackageExec.plan(options)
    await write(tools, "identity-compiler", compiler(tools, "second"))
    const result = await PackageExec.execute(planned, options)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain("executable changed since planning")
    expect(await serve(root)).toContain("//:dist  ran")
    expect(await Fs.readFile(Path.join(root, "dist/value"), "utf8")).toBe("second")
  })

  it("does not cache a self-replacement during execution", async () => {
    const { root, tools } = await fixture(
      "S.Shell.Build({ bin: S.Host.bin(\"identity-compiler\"), outDirs: [\"dist\"], sandbox: \"none\" })"
    )
    const script = compiler(tools, "first") + `cp '${tools}/replacement' '${tools}/identity-compiler'\n`
    await write(tools, "replacement", compiler(tools, "second"))
    await write(tools, "identity-compiler", script)
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const options = {
      index: PackageIndex.make(loaded),
      patterns: ["//:dist"],
      cacheDirectory: ".flows",
      verb: "auto" as const
    }
    const result = await PackageExec.run(options)
    expect("ok" in result && result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain("executable changed since planning")
    // Restoring the original bytes must not find a result published by the
    // run that replaced them. Both attempts execute and refuse publication.
    await write(tools, "identity-compiler", script)
    const repeated = await PackageExec.run(options)
    expect("ok" in repeated && repeated.ok).toBe(false)
    expect(await Fs.readFile(Path.join(tools, "dispatches"), "utf8")).toBe("dispatch\ndispatch\n")
  })
  it.each(["go", "rust"])("keys the %s toolchain selected by the target environment", async (kind) => {
    const { root, tools } = await fixture(
      kind === "go"
        ? "S.Shell.Build({ bin: S.Go.bin, env: { GOTOOLCHAIN: \"alternate\" }, outDirs: [\"dist\"], sandbox: \"none\" })"
        : "S.Cargo.Test({ workspace: true, env: { RUSTUP_TOOLCHAIN: \"alternate\" }, sandbox: \"none\" })",
      kind === "go"
        ? ""
        : "toolchains: [S.Rust.Toolchain({ workspace: S.file(\"//Cargo.toml\"), channel: \"stable\" })],"
    )
    await write(root, "Cargo.toml", "[workspace]\nmembers = []\n")
    const executable = kind === "go" ? "bin/go" : "cargo"
    for (const sdk of ["stable", "alternate"]) {
      await write(tools, `${sdk}/${executable}`, compiler(tools, "first"))
      await write(tools, `${sdk}/rustc`, "#!/bin/sh\nexit 0\n")
      await Fs.mkdir(Path.join(tools, sdk, "pkg/tool"), { recursive: true })
    }
    if (kind === "go") {
      await write(
        tools,
        "go",
        `#!/bin/sh
sdk='${tools}/'\${GOTOOLCHAIN:-stable}
if [ "$1" = version ]; then echo 1.0.0; exit 0; fi
if [ "$1" = env ]; then printf '{"GOROOT":"%s","GOTOOLDIR":"%s/pkg/tool"}' "$sdk" "$sdk"; exit 0; fi
exec "$sdk/bin/go" "$@"
`
      )
    } else {
      await write(
        tools,
        "rustup",
        `#!/bin/sh
if [ "$1" = which ]; then printf '%s/%s/%s' '${tools}' "$3" "$4"; exit 0; fi
if [ "$1" = --version ]; then echo 1.0.0; exit 0; fi
exec '${tools}/'\${RUSTUP_TOOLCHAIN:-stable}/cargo "$@"
`
      )
      await Fs.symlink("rustup", Path.join(tools, "cargo"))
    }
    await assertReplacement(root, tools, () => write(tools, `alternate/${executable}`, compiler(tools, "second")))
  })
})
