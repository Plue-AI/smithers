/**
 * The Cloud machine contract.
 *
 * `.smithers/environment.nix` is the NixOS module Smithers Cloud builds this
 * repository's machine image from (owner decision, 2026-09-15). It pins a
 * toolchain that six other files already declare — `.node-version`,
 * `package.json`, `.smithers/WORKSPACE.ts`, `PACKAGE.ts`, `rust-toolchain.toml`
 * and `scripts/ci/cloud.sh` — and a pin that drifts from its declaration is
 * worse than no pin at all: the gate runs, quietly, against the wrong release.
 *
 * So every version here is read from the file that owns it and compared with
 * the expression. Nothing is written twice.
 *
 * Run it with `bun test scripts/ci/environment-nix.test.ts`. It is not yet one
 * of cloud.sh's gates; adding it there is one line in `gate_tools` and one in
 * `run_gate`, in the same shape as `cloud-contract`.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = new URL("../../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")

const environment = read(".smithers/environment.nix")
const packageJson = JSON.parse(read("package.json")) as {
  packageManager: string
  engines: { node: string; bun: string }
}
const workspace = read(".smithers/WORKSPACE.ts")
const rootPackage = read("PACKAGE.ts")
const rustToolchain = read("rust-toolchain.toml")
const cloud = read("scripts/ci/cloud.sh")

/** The `version` of the derivation whose `pname` is `name`. */
const pinned = (name: string) => {
  const pattern = new RegExp(`pname = "${name}";\\s*\\n\\s*version = "([^"]+)";`)
  const match = pattern.exec(environment)
  if (match === null) throw new Error(`.smithers/environment.nix pins no derivation named ${name}`)
  return match[1]!
}

/** The Rust channel, whose derivation takes its version from the enclosing let. */
const rustChannel = (() => {
  const match = /version = "([0-9][0-9.]*)";\s*\n\s*date = "/.exec(environment)
  if (match === null) throw new Error(".smithers/environment.nix pins no Rust channel")
  return match[1]!
})()

/** The first capture of `pattern` in `text`, or a failure naming what was missing. */
const only = (text: string, pattern: RegExp, what: string) => {
  const match = pattern.exec(text)
  if (match === null) throw new Error(`no ${what}`)
  return match[1]!
}

/** `>=x.y.z` and `x.y.z` alike, as numbers. */
const parts = (version: string) => {
  const match = /^(?:>=)?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) throw new Error(`unreadable version: ${JSON.stringify(version)}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const
}

/** Whether `release` is at or above the floor of a `>=` requirement. */
const atLeast = (release: string, requirement: string) => {
  const [releaseMajor, releaseMinor, releasePatch] = parts(release)
  const [floorMajor, floorMinor, floorPatch] = parts(requirement)
  if (releaseMajor !== floorMajor) return releaseMajor > floorMajor
  if (releaseMinor !== floorMinor) return releaseMinor > floorMinor
  return releasePatch >= floorPatch
}

describe("the Cloud machine pins what the repository declares", () => {
  test("Node is the release .node-version names, and clears engines.node", () => {
    const node = pinned("nodejs")
    // The repository is adopting `.node-version`; until that file lands the
    // engines floor is the only declaration there is to hold the pin to.
    const nodeVersionFile = fileURLToPath(new URL(".node-version", root))
    if (existsSync(nodeVersionFile)) {
      const declared = readFileSync(nodeVersionFile, "utf8").trim()
      if (declared !== "") expect(node).toBe(declared.replace(/^v/, ""))
    }
    expect(atLeast(node, packageJson.engines.node)).toBe(true)
  })

  test("npm is the certified release PACKAGE.ts names", () => {
    expect(pinned("npm")).toBe(only(rootPackage, /npmRelease: "([^"]+)"/, "npmRelease in PACKAGE.ts"))
  })

  test("pnpm is exactly package.json packageManager", () => {
    expect(`pnpm@${pinned("pnpm")}`).toBe(packageJson.packageManager)
  })

  test("Bun is WORKSPACE.ts's exact release and clears engines.bun", () => {
    const bun = pinned("bun")
    expect(bun).toBe(only(workspace, /bunVersion = "([^"]+)"/, "bunVersion in WORKSPACE.ts"))
    expect(atLeast(bun, packageJson.engines.bun)).toBe(true)
  })

  test("jj is WORKSPACE.ts's exact release, which cloud.sh also demands", () => {
    const jj = pinned("jujutsu")
    expect(jj).toBe(only(workspace, /jjVersion = "([^"]+)"/, "jjVersion in WORKSPACE.ts"))
    // cloud.sh re-downloads jj unless `jj --version` is this string exactly.
    expect(cloud).toContain(`jj ${jj}'`)
  })

  test("Rust is rust-toolchain.toml's channel, components and target", () => {
    expect(rustChannel).toBe(only(rustToolchain, /channel = "([^"]+)"/, "channel in rust-toolchain.toml"))
    const components = only(rustToolchain, /components = \[([^\]]*)\]/, "components in rust-toolchain.toml")
    for (const component of components.matchAll(/"([^"]+)"/g)) {
      expect(environment).toContain(`${component[1]}-\${version}-x86_64-unknown-linux-gnu.tar.xz`)
    }
    const targets = only(rustToolchain, /targets = \[([^\]]*)\]/, "targets in rust-toolchain.toml")
    for (const target of targets.matchAll(/"([^"]+)"/g)) {
      expect(environment).toContain(`rust-std-\${version}-${target[1]}.tar.xz`)
    }
    // `profile = "minimal"` and the wasm byte reproducibility it protects:
    // the rust-src component must stay uninstalled (rust-toolchain.toml's
    // header explains what installing it does to the committed artifact).
    expect(rustToolchain).toContain('profile = "minimal"')
    expect(environment).not.toMatch(/dist "rust-src/)
  })

  test("Go is the release PACKAGE.ts names for the build-cli suite", () => {
    expect(pinned("go")).toBe(only(rootPackage, /CiToolchain\.Go\(\{ release: "([^"]+)" \}\)/, "Go in PACKAGE.ts"))
  })

  test("PostgreSQL is the release PACKAGE.ts names for the storage matrix", () => {
    const release = only(rootPackage, /CiToolchain\.Postgres\(\{ release: "([^"]+)" \}\)/, "Postgres in PACKAGE.ts")
    expect(environment).toContain(`pkgs.postgresql_${release}`)
    expect(cloud).toMatch(/^\s*packages\) echo '[^']*\bpostgres\b[^']*' ;;$/m)
    expect(cloud).toContain("postgres) ensure_postgres")
  })

  test("Foundry is the release cloud.sh and PACKAGE.ts name", () => {
    const foundry = pinned("foundry")
    expect(`v${foundry}`).toBe(
      only(cloud, /foundry-rs\/foundry\/releases\/download\/(v[0-9][0-9.]*)\//, "Foundry release in cloud.sh"))
    expect(`v${foundry}`).toBe(
      only(rootPackage, /CiToolchain\.Foundry\(\{ release: "([^"]+)" \}\)/, "Foundry in PACKAGE.ts"))
  })

  test("the docs gate's recording tools are on the machine", () => {
    // apps/tui-docs/scripts/record.mjs refuses to record without FFmpeg,
    // Python 3 (the base module ships it), Git and Bun. A target run passes
    // only PATH through, so the browser is the `chromium` found there
    // (apps/tui-docs/scripts/browser.mjs).
    const record = read("apps/tui-docs/scripts/record.mjs")
    expect(record).toContain('process.env.FFMPEG || "ffmpeg"')
    expect(environment).toMatch(/^\s*pkgs\.ffmpeg-headless$/m)
    expect(read("apps/tui-docs/scripts/browser.mjs")).toContain('join(dir, "chromium")')
    expect(environment).toMatch(/^\s*pkgs\.chromium$/m)
  })

  test("every download is content-addressed, so a build cannot drift", () => {
    // Each `fetchurl` either carries its own digest or inherits one the caller
    // passes; the Rust components use the second form, one call per tarball.
    const downloads = environment.split("fetchurl {").slice(1)
    expect(downloads.length).toBeGreaterThan(0)
    for (const block of downloads) {
      const head = block.slice(0, block.indexOf("};"))
      expect(head).toMatch(/(?:sha256 = "[0-9a-f]{64}";|hash = "sha256-[^"]+";|inherit sha256;)/)
    }
    for (const [, digest] of environment.matchAll(/\(dist "[^"]+"\s*\n\s*"([^"]*)"\)/g)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(environment).not.toContain('sha256 = ""')
  })
})

/**
 * What the image provides, by the tool name a gate or rule executes. Each
 * value is a pattern that must appear in `.smithers/environment.nix`.
 */
const provided: Record<string, RegExp> = {
  node: /pname = "nodejs";/,
  pnpm: /pname = "pnpm";/,
  bun: /pname = "bun";/,
  jj: /\bjujutsu\b/,
  go: /pname = "go";/,
  cargo: /^\s*rust$/m,
  foundry: /pname = "foundry";/,
  postgres: /pkgs\.postgresql_18\b/,
  bwrap: /pkgs\.bubblewrap\b/,
  sshd: /pkgs\.openssh\b[\s\S]*L\+ \/usr\/sbin\/sshd/,
  rg: /^\s*# ripgrep|ripgrep/m,
}

/** Tools an index rule executes that the image does not provide yet. */
const imageGaps = new Set(["docker"])

/** The tools each target-index rule needs; a new rule fails until it is listed. */
const ruleTools: Record<string, string[]> = {
  "Agent.Diff": [], Filegroup: [], LlmLint: [], NewPackage: [], FactoryProjection: [],
  "Environment.Toolchain": [], TargetIndex: [], Lockfile: [], Tsconfig: [], GithubCiGen: [],
  "Markdown.CodeBlocks": ["node"], DepsLint: ["node"], DocsParity: ["node", "pnpm"],
  Dprint: ["node", "pnpm"], EsLint: ["node", "pnpm"], Vitest: ["node", "pnpm"],
  Typecheck: ["node", "pnpm"], TsBuild: ["node", "pnpm"], NodeTest: ["node", "pnpm"],
  NodeBinary: ["node", "pnpm"], Generate: ["node", "pnpm"], ToolRun: ["node", "pnpm"],
  ToolBuild: ["node", "pnpm"], Install: ["node", "pnpm"],
  "Shell.Test": ["node", "pnpm"], "Shell.Diff": ["node", "pnpm"], "Shell.Build": ["node", "pnpm"], "Shell.Run": ["node", "pnpm"],
  "Go.ModDownload": ["go"], "Cargo.Clippy": ["cargo"], "Cargo.Fmt": ["cargo"], "Cargo.Test": ["cargo"],
  "Docker.Service": ["docker"],
}

describe("the Cloud machine carries every tool the checks execute", () => {
  const index = JSON.parse(read(".smithers/target-index.json")) as { label: string; rule: string }[]

  test("every rule in the target index names the tools it needs", () => {
    const unknown = [...new Set(index.map((target) => target.rule))].filter((rule) => !(rule in ruleTools))
    expect(unknown).toEqual([])
  })

  test("every tool an index rule executes is in the image, or a named gap", () => {
    const needed = new Set(index.flatMap((target) => ruleTools[target.rule] ?? []))
    const missing = [...needed].filter((tool) => !imageGaps.has(tool) && !(provided[tool]?.test(environment) ?? false))
    expect(missing).toEqual([])
    for (const gap of imageGaps) {
      expect(provided[gap]).toBeUndefined()
      expect(needed.has(gap)).toBe(true)
    }
  })

  test("every toolchain cloud.sh gates on is in the image", () => {
    const gates = [...cloud.matchAll(/^\s+[a-z-]+\) echo '([^']+)' ;;$/gm)].flatMap((m) => m[1]!.split(" "))
    const alias: Record<string, string[]> = { js: ["node", "pnpm", "bun"], rust: ["cargo"] }
    const tools = new Set(gates.flatMap((tool) => alias[tool] ?? [tool]))
    expect(tools.size).toBeGreaterThan(4)
    for (const tool of tools) {
      expect(provided[tool], `no image pattern for ${tool}`).toBeDefined()
      expect(environment, `image lacks ${tool}`).toMatch(provided[tool]!)
    }
  })

  test("every apt package a PACKAGE.ts declares has a Nix counterpart", () => {
    const counterpart: Record<string, string> = { bubblewrap: "bwrap", "openssh-server": "sshd" }
    const declared = new Set<string>()
    for (const file of ["PACKAGE.ts"]) {
      for (const [, list] of read(file).matchAll(/CiToolchain\.Apt\(\{ packages: \[([^\]]*)\]/g)) {
        for (const [, name] of list!.matchAll(/"([^"]+)"/g)) declared.add(name!)
      }
    }
    expect([...declared].filter((name) => !(name in counterpart))).toEqual([])
    for (const name of declared) expect(environment).toMatch(provided[counterpart[name]!]!)
  })

  test("the SSH tests find the daemon at the path they name", () => {
    expect(environment).toContain('"d /run/sshd 0755 root root -"')
    expect(read("packages/smithers/test/ExecutionEnvironmentSsh.integration.test.ts")).toContain('"/usr/sbin/sshd"')
  })
})
