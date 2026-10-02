/**
 * The gate this package's prose never had.
 *
 * `standard.docs` resolves to `DocsParity`, which checks that a README exists
 * and carries prose. Nothing owned the other seven prose surfaces, so they
 * drifted: five pages described an install flow that had stopped trampolining,
 * a deploy recipe exported a variable nothing read, a trust model claimed a
 * credential split one deployment did not have, and two tables listed managers
 * no declaration can name.
 *
 * Every assertion here reads the claim out of the code it describes, so a
 * source change moves the gate rather than a reviewer's memory of it. Prose
 * that no invariant can be derived from stays outside this file.
 */
import { Flow } from "@smthrs/flow"
import * as FileSet from "@smthrs/plan/FileSet"
import * as Context from "effect/Context"
import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Install from "../src/Install.ts"
import * as PackageManager from "../src/PackageManager.ts"

const packageRoot = NodePath.join(import.meta.dirname, "..")

const read = (relative: string): string => Fs.readFileSync(NodePath.join(packageRoot, relative), "utf8")

/** Every markdown surface this package publishes, `dist/` excluded. */
const proseFiles = (): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (relative: string): void => {
    for (const entry of Fs.readdirSync(NodePath.join(packageRoot, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (["dist", "node_modules", "terraform"].includes(entry.name)) continue
        walk(path)
        continue
      }
      if (entry.name.endsWith(".md")) found.push(path)
    }
  }
  walk("")
  return found
}

/** The first column of every row of one pipe table, by its heading. */
const tableColumn = (markdown: string, heading: string): ReadonlyArray<string> => {
  const lines = markdown.split("\n")
  const start = lines.findIndex((line) => line.trim().toLowerCase().endsWith(heading.toLowerCase()))
  expect(start, `no heading ending in "${heading}"`).toBeGreaterThanOrEqual(0)
  const rows: Array<string> = []
  let seenHeader = false
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("|")) {
      if (rows.length > 0 || seenHeader) break
      continue
    }
    const first = line.split("|")[1]?.trim() ?? ""
    if (first.startsWith("-") || first === "Manager") {
      seenHeader = true
      continue
    }
    rows.push(first)
  }
  return rows
}

describe("packages/smithers/build prose", () => {
  it("describes target discovery through the named Package map", () => {
    const loader = read("build-cli/src/PackageLoader.ts")
    expect(loader).toContain("\"naked_target_export\"")
    expect(loader).toContain("\"package_export_missing\"")
    const page = read("docs/concepts/targets.md")
    expect(page).toContain("export const Package = Smithers.Package({")
    expect(page).toContain("//<packagePath>:<targetKey>")
    expect(page).not.toContain("//<packagePath>:<exportName>")
    expect(page).not.toContain("Everything else is ignored")
  })

  it("does not export naked targets in reference examples", () => {
    // These constructors return shared configuration or manifest declarations,
    // not targets. They may remain module exports alongside Package.
    const declarations = new Set([
      "Package",
      "Runtime.Node",
      "PackageManager.Pnpm",
      "Rust.Pinned",
      "PackageJsonTemplate.make",
      "PackageJson"
    ])
    const naked: Array<string> = []
    for (const file of proseFiles().filter((file) => file.startsWith("docs/reference/targets/"))) {
      for (const fence of read(file).matchAll(/```ts[^\n]*\n([\s\S]*?)```/g)) {
        for (const exported of fence[1]!.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:Smithers|S)\.([\w.]+)\s*\(/g)) {
          if (!declarations.has(exported[2]!)) naked.push(`${file}: ${exported[1]}`)
        }
      }
    }
    expect(naked, "targets must be declared in the exported Package map").toEqual([])
  })

  it("documents the opt-in cache default used by Target.make", () => {
    const source = read("targets/src/Target.ts")
    const defaultValue = source.match(/options\.cache \?\? (true|false)/)?.[1]
    expect(defaultValue).toBe("false")
    const page = read("docs/concepts/targets.md")
    expect(page).toMatch(new RegExp("`cacheable` is resolved:[\\s\\S]*?defaulting\\s+to `" + defaultValue + "`"))
    expect(page).toContain("../workspace/caching.md#cacheability")
  })

  it("names only managers a declaration can select", () => {
    const declarable = new Set(PackageManager.Name.literals.map((name) => name.toLowerCase()))
    expect(declarable).toEqual(new Set(["pnpm", "bun"]))
    for (const [file, heading] of [["DESIGN.md", "Manager support"], ["docs/concepts/install.md", "Manager support"]]) {
      const managers = tableColumn(read(file!), heading!)
      expect(managers.length).toBeGreaterThan(0)
      for (const manager of managers) {
        expect(declarable, `${file} lists ${manager} as a selectable manager`).toContain(manager.toLowerCase())
      }
    }
  })

  it("describes the install flow with the number of rounds it runs", () => {
    expect(Install.Install.maxRounds).toBe(1)
    // A page may say the flow used to trampoline: that history is why the
    // measure result is an ordinary settled reference. What it may not do is
    // describe a second round in the present tense.
    const history = /\bused to\b|\bno longer\b|\bonce\b|\bstopped\b/i
    for (const file of proseFiles()) {
      for (const line of read(file).split("\n")) {
        if (!/\btwo[- ]rounds?\b|two trampoline rounds|second trampoline round/i.test(line)) continue
        expect(line, `${file} describes a round the flow no longer runs`).toMatch(history)
      }
    }
  })

  for (const action of [Install.Measure, Install.FetchPnpm, Install.Link]) {
    it(`documents the declared boundary of ${action.name}`, () => {
      const declaration = Context.getUnsafe(action.annotations, Flow.EffectsDeclaration)
      const code = (value: string): string => "`" + value + "`"
      const entries = (values: ReadonlyArray<FileSet.Entry>): string =>
        values.length === 0 ? "none" : values.map((entry) => {
          if (typeof entry === "string") return code(entry)
          if (entry._tag === "TreeArtifact") return `${code(entry._tag)} at ${code(entry.path)}`
          const excludes = entry.exclude?.length ? ` (exclude ${entry.exclude.map(code).join(", ")})` : ""
          return `${code(entry._tag)}: ${entry.include.map(code).join(", ")}${excludes}`
        }).join("; ")
      const page = read("docs/concepts/actions-and-boundaries.md").split("## The install boundaries\n")[1]?.split(
        "\n## "
      )[0]
      expect(page, "install boundaries section").toBeDefined()
      const rows = page!.split("\n").filter((line) => line.split("|")[1]?.trim() === code(action.name))
      expect(rows, `one boundary row for ${action.name}`).toHaveLength(1)
      expect(rows[0]!.split("|").slice(1, -1).map((cell) => cell.trim())).toEqual([
        code(action.name),
        code(action.tier),
        code(declaration.boundaryMode),
        entries(FileSet.expandReads(declaration.reads)),
        entries(FileSet.expand(declaration.writes)),
        "No"
      ])
    })
  }

  it("does not describe Measure as reporting a host manager version", () => {
    expect(Object.keys(Install.Content.fields)).not.toContain("version")
    for (const paragraph of read("docs/concepts/actions-and-boundaries.md").split(/\n{2,}/)) {
      if (!/\bmeasure\b/i.test(paragraph)) continue
      expect(paragraph).not.toMatch(/reports?\s+(?:the\s+)?(?:host['’]s\s+)?package[- ]manager(?:['’]s)?\s+version/i)
    }
  })

  it("does not explain Link cache exclusion by an absent write declaration", () => {
    expect(Context.getUnsafe(Install.Link.annotations, Flow.EffectsDeclaration).writes.length).toBeGreaterThan(0)
    expect(read("docs/concepts/actions-and-boundaries.md")).not.toMatch(/link\s+declares?\s+no\s+writes?/i)
  })

  for (
    const file of [
      "docs/about/faq.md",
      "docs/about/what-is-smithers-build.md",
      "docs/concepts/actions-and-boundaries.md",
      "README.md"
    ]
  ) {
    it(`qualifies native confinement and host access in ${file}`, () => {
      // Native confinement changed to an allowlist. Keep the prose tied to
      // that implementation, including the runtime and external-read grants.
      expect(read("targets/src/ExecSandbox.ts")).toContain("ProcessSandbox.plan(lower(request), location, hostFacts)")
      const source = read("../flows/platform-node/src/ProcessSandbox.ts")
      expect(source).toContain("\"--tmpfs\",\n    \"/\"")
      expect(source).toContain("(deny file-read*)")
      expect(source).toContain("runtimeReads(hostFacts)")
      expect(source).toContain("confinement.externalReads")
      const page = read(file).replace(/\s+/g, " ")
      expect(page).toContain("ExecSandbox")
      expect(page).toMatch(/enumerated (?:system\/)?runtime paths/i)
      expect(page).toMatch(/explicit external[- ]read grants/i)
      expect(page).toMatch(/credentials.*(?:denied|closed).*unless explicitly granted/i)
      expect(page).toMatch(/not blanket host-file isolation/i)
      expect(page).toMatch(/Docker.*image.*toolchain/i)
      expect(page).toMatch(/fails? (?:the target )?closed/i)
      expect(page).not.toMatch(/this is not a sandbox|tools run directly in the workspace/i)
      expect(page).not.toMatch(
        /does not hide host files|leave host files outside the workspace readable|reads outside the workspace are not scoped|remain readable|(?:all|any) host files (?:are |stay )?(?:hidden|inaccessible)/i
      )
    })
  }

  it("keeps the deploy recipe on the variable names the deployment reads", () => {
    // The verifier pair moved from `alchemy.run.ts` into `deployment.ts`, so
    // the names are read where `cacheCredentialVerifiers` declares them.
    const deployment = read("infra/deployment.ts")
    const names = [...deployment.matchAll(/cacheTokenVerifier\("([A-Z_]+)"\)/g)].map((match) => match[1]!)
    expect(names).toEqual(["SMITHERS_CACHE_READ_TOKEN", "SMITHERS_CACHE_WRITE_TOKEN"])
    const page = read("docs/workspace/remote-caching.md")
    for (const name of names) expect(page, `remote-caching.md never names ${name}`).toContain(name)
  })

  it("installs and deploys infra with the workspace's package manager", () => {
    // `infra/` is a workspace package with no lockfile of its own, so the
    // recipe's old `npm ci` step failed on every fresh checkout, and `npx`
    // would fetch alchemy from the registry instead of the pinned install.
    expect(Fs.existsSync(NodePath.join(packageRoot, "infra/package-lock.json"))).toBe(false)
    expect(JSON.parse(read("infra/package.json")).scripts).toHaveProperty("deploy")
    const page = read("docs/workspace/remote-caching.md")
    expect(page).toContain("pnpm install --frozen-lockfile --offline")
    expect(page).toContain("CI=1 pnpm exec alchemy plan alchemy.run.ts --stage prod")
    expect(page).toContain("CI=1 pnpm run deploy -- --yes")
    // `npx` matches in command position only: `Runtime.npx` is an accessor
    // `targets/docs/reference/targets.md` documents, not a recipe step.
    for (const file of proseFiles()) {
      expect(read(file), `${file} runs infra through npm`).not.toMatch(/\bnpm ci\b|(?<![.\w-])npx\b/)
    }
  })

  it("states the credential split both deployments enforce", () => {
    // Both implementations refuse two equal digests, so no page may still
    // describe the self-hosted tier as single-credential or offer one secret
    // for both directions as a rollout step.
    expect(read("terraform/modules/cache/service/config.js")).toContain("SMITHERS_CACHE_READ_TOKEN")
    expect(read("infra/CACHE-TRUST.md")).not.toMatch(/still\s+has one credential/i)
    for (const file of proseFiles()) {
      expect(read(file), `${file} still offers one secret for both directions`).not.toMatch(
        /set \*\*both to the current/i
      )
    }
  })

  it("documents every command the CLI registers", () => {
    // The CLI reference restated `@smthrs/build-cli`'s command surface and
    // then drifted: three commands shipped with no row here. The inventory is
    // read out of the registration calls, so a new command moves this gate.
    const source = read("build-cli/src/Cli.ts")
    const names = [...source.matchAll(/\.command\("([^"]+)"/g)].map((match) => match[1]!)
    expect(names.length).toBeGreaterThanOrEqual(10)
    const page = read("docs/reference/cli.md")
    for (const name of names) {
      expect(page, `reference/cli.md never documents the ${name} command`).toContain(name)
    }
  })

  it("does not claim the CLI lacks irreversible execution", () => {
    expect(read("build-cli/src/TargetExecution.ts")).toContain("ExecIrreversibleLive({ workspaceRoot })")
    const absentLayer =
      /does not (?:provide|supply)\s+`?ExecIrreversibleLive|does not supply the irreversible-exec|irreversible(?:-exec)? (?:layer|implementation) is (?:intentionally )?absent|(?:absent|lacks the) irreversible-exec layer|ExecIrreversibleLive[\s\S]{0,160}intentionally absent/i
    const stale = proseFiles().filter((file) => file.startsWith("docs/") && absentLayer.test(read(file)))
    expect(stale, "pages claiming the CLI lacks irreversible execution").toEqual([])
  })

  it("describes the current Changesets namespace", () => {
    const source = read("targets/src/ChangesetsTarget.ts")
    const page = read("docs/reference/targets/changesets.md")
    for (const name of ["Version", "Publish"]) {
      expect(source).toContain(`Target.make("Changesets.${name}"`)
      expect(page).toContain(`Changesets.${name}`)
    }
    expect(page).not.toContain("Smithers.Changesets({")
  })

  it("keeps prose on the kinds ci actually merges", () => {
    // `ciKinds` gained "docs" with the workspace import, so pages carried over
    // from the standalone repo still claimed the docs verb stays out of ci.
    const source = read("build-cli/src/Cli.ts")
    const literal = source.match(/const ciKinds = \[([^\]]*)\]/)
    expect(literal, "Cli.ts no longer declares ciKinds").not.toBeNull()
    const kinds = [...literal![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
    expect(kinds).toContain("docs")
    const running = read("docs/workspace/running-targets.md")
    const ciRow = running.split("\n").find((line) => /^\|\s*`ci`\s*\|/.test(line))
    expect(ciRow, "running-targets.md has no ci selection row").toBeDefined()
    for (const kind of kinds) expect(ciRow, `ci selection omits ${kind}`).toContain(kind)
    // The claims wrap across lines, so the scan is per paragraph: one that
    // speaks of documentation may not also call it excluded from ci.
    const exclusion = /(?:\bnot\b|\bnever\b)[\s\S]{0,60}?(?:part of|merged into|folded into)[\s\S]{0,60}?\bci\b/i
    for (const file of proseFiles()) {
      for (const paragraph of read(file).split(/\n{2,}/)) {
        if (!/\bdocs\b|\bdocumentation\b/i.test(paragraph)) continue
        expect(paragraph, `${file} claims the docs verb stays out of ci`).not.toMatch(exclusion)
      }
    }
  })

  it("does not exclude the docs gate from ci in the running guide", () => {
    expect(read("docs/workspace/running-targets.md")).not.toMatch(
      /`docs`[^.]*\boutside `ci`/i
    )
  })

  it("does not promise a declared-manager check the actions no longer make", () => {
    // `d191c9dfcf` deleted `checkDeclaredManager`. A sealed action receives the
    // layer and never the declaration, so prose promising the comparison
    // describes a guard that cannot run.
    expect(read("src/Install.ts")).not.toContain("checkDeclaredManager")
    for (const file of proseFiles()) {
      expect(read(file), `${file} promises a declared-manager check that was deleted`).not.toMatch(
        /the manager the workspace declared, the manager the composition provided/i
      )
    }
  })
})
