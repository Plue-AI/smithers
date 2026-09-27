import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { parse, stringify } from "yaml"
import { assertExportTargets, assertPackedExportTargets } from "./packed-export-targets.mjs"
import { assertEffectPins, effectDeclarations, effectLockVersions, installedEffectResolutions } from "./check-single-effect-version.mjs"
import {
  assertBuilt,
  defaultBindings,
  dependencyOrder,
  esmOnlyModules,
  packResultFilename,
  publicationManifest,
  stagePackage,
  publishedPackages,
  readWorkspaceManifests,
  releaseGroups,
  sourceRevision,
  workspaceDependencies,
  workspaces
} from "./pack-release.mjs"
import { repoRoot } from "./workspace-packages.mjs"
import { verifyPackagedNativeHelpers } from "./release-native-helpers.mjs"

// `workspaces` reads and validates a workspace tree, so this suite reads the
// real one once and every case below asserts over that single order.
const packedWorkspaces = workspaces()
const releaseVersion = JSON.parse(readFileSync(join(repoRoot, "packages/smithers/package.json"), "utf8")).version
const workflow = (name) => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8")

/**
 * The step blocks of one job in a common YAML spelling. The generated CI
 * quotes keys and values while the handwritten release workflow does not;
 * parsing both preserves every setting without treating quoting as drift.
 */
const jobSteps = (source, job) => {
  const declared = parse(source).jobs?.[job]
  assert.ok(declared !== undefined, `${job} is not a job in this workflow`)
  const steps = declared.steps
  assert.ok(Array.isArray(steps) && steps.length > 0, `${job} declares no steps`)
  return steps.map((step) => stringify([step], { lineWidth: 0 }).trimEnd().split("\n")
    .map((line) => `      ${line}`).join("\n"))
}

/** Every build-graph invocation these steps make, in order. */
const graphCommands = (steps) =>
  steps.flatMap((step) => [...step.matchAll(/pnpm exec (?:smithers-build|smthrs) [^\n]+/g)].map((match) => match[0]))

/** The recursive per-package script runners the target graph replaced. */
const scriptRunners = (source) => [...source.matchAll(/\bpnpm (?:run [a-z][a-z:-]*|test)\b/g)].map((match) => match[0])

/** The `with:` entries of one step, which a copy may extend but not contradict. */
const withEntries = (step) => step.split("\n").filter((line) => line.startsWith("          "))

/** Whether a step invokes an action, independent of its immutable ref. */
const invokes = (step, action) => step.startsWith(`      - uses: ${action}@`)

test("publicationManifest replaces source exports without mutating the input", () => {
  const manifest = {
    name: "@smthrs/example",
    exports: {
      ".": "./src/index.ts"
    },
    publishConfig: {
      access: "public",
      provenance: true,
      exports: {
        ".": {
          types: "./dist/esm/index.d.ts",
          import: "./dist/esm/index.js",
          require: "./dist/cjs/index.js"
        }
      }
    }
  }

  assert.deepEqual(publicationManifest(manifest), {
    name: "@smthrs/example",
    exports: {
      ".": {
        types: "./dist/esm/index.d.ts",
        import: "./dist/esm/index.js",
        require: "./dist/cjs/index.js"
      }
    },
    publishConfig: {
      access: "public",
      provenance: true
    }
  })
  assert.equal(manifest.exports["."], "./src/index.ts")
  assert.ok("exports" in manifest.publishConfig)
})

test("packResultFilename makes pnpm's absolute pack result portable", () => {
  assert.equal(
    packResultFilename(
      { filename: "/tmp/release/smthrs-example-0.1.0.tgz" },
      "@smthrs/example"
    ),
    "smthrs-example-0.1.0.tgz"
  )
  assert.throws(
    () => packResultFilename({}, "@smthrs/example"),
    /pnpm pack returned no filename/
  )
})

test("publicationManifest rejects a package without publication exports", () => {
  assert.throws(
    () => publicationManifest({ name: "@smthrs/example", publishConfig: { access: "public" } }),
    /publishConfig\.exports/
  )
})

test("workspaces covers every non-private engine and agent package under packages/", () => {
  // Recomputed here rather than imported, so a change to the derivation in
  // pack-release.mjs has to agree with an independent reading of packages/.
  // The reading descends: a package nested inside the product package it
  // belongs to (`packages/smithers/flows/canonical`) publishes the same name it always
  // did, and a derivation that stopped at the first directory level would
  // quietly drop it from the release while every assertion here stayed green.
  const packagesRoot = join(repoRoot, "packages")
  const directories = (parent) =>
    readdirSync(join(packagesRoot, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .flatMap((entry) => {
        const directory = parent === "" ? entry.name : `${parent}/${entry.name}`
        return existsSync(join(packagesRoot, directory, "package.json"))
          ? [directory, ...directories(directory)]
          : []
      })
  const manifests = directories("")
    .map((directory) => [
      `packages/${directory}`,
      JSON.parse(readFileSync(join(packagesRoot, directory, "package.json"), "utf8"))
    ])
  const published = manifests
    .filter(([, manifest]) => !manifest.private && releaseGroups.has(manifest.smthrs?.group))
    .map(([name]) => name)

  assert.deepEqual([...releaseGroups].sort(), ["agent", "engine", "tooling"])
  assert.deepEqual([...packedWorkspaces].sort(), published.sort())
  // The build runtime is public because the CLI requires it. Infrastructure
  // deployment and repository-local policy remain private and cannot enter
  // the tarball set by accident.
  const tooling = manifests.filter(([, manifest]) => manifest.smthrs?.group === "tooling")
  assert.ok(tooling.length > 0)
  assert.deepEqual(
    tooling.filter(([, manifest]) => manifest.private !== true).map(([, manifest]) => manifest.name).sort(),
    ["@smthrs/build", "@smthrs/build-cli", "@smthrs/create-app", "@smthrs/targets"]
  )
  assert.deepEqual(
    tooling.filter(([, manifest]) => manifest.private === true).map(([, manifest]) => manifest.name).sort(),
    ["@smthrs/build-infra", "@smthrs/repo-targets", "@smthrs/rpc"]
  )
})

test("importing the release scripts reads no workspace tree", async () => {
  // Every exported helper takes a `root` or a `manifests` argument, so an
  // importer that only wants `dependencyOrder` never asked this module to look
  // at a workspace at all. While the packed order was a module-level constant,
  // importing build-release.mjs — or restore-release.mjs, or
  // check-single-effect-version.mjs — read the colocated tree and threw the
  // roster error before the importer could call anything.
  const fixture = await mkdtemp(join(tmpdir(), "smithers-pack-release-import-"))
  try {
    await mkdir(join(fixture, "scripts"), { recursive: true })
    for (const file of ["workspace-packages.mjs", "pack-release.mjs", "publish-release.mjs", "packed-export-targets.mjs", "build-release.mjs", "release-native-helpers.mjs"]) {
      await cp(join(repoRoot, "scripts", file), join(fixture, "scripts", file))
    }
    // A workspace whose only member is a valid engine package: a roster the
    // release check rejects, so an eager read cannot pass unnoticed.
    await writeFile(join(fixture, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")
    await mkdir(join(fixture, "packages/kernel"), { recursive: true })
    await writeFile(
      join(fixture, "packages/kernel/package.json"),
      JSON.stringify({ name: "@smthrs/kernel", version: "1.0.0", smthrs: { group: "engine" } })
    )

    const module = await import(pathToFileURL(join(fixture, "scripts/build-release.mjs")).href)
    assert.equal(typeof module.buildRelease, "function")

    // The check did not move, it only stopped running at import.
    assert.throws(() => workspaces(fixture), /does not match publishedPackages/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("the packed set is exactly the 50 names the RC contract publishes", () => {
  // `publishedPackages` is the release decision; group membership is
  // only how it is enforced. Restating the roster here means a package that
  // joins or leaves the release has to change both files in one diff.
  const manifests = readWorkspaceManifests()
  const packed = packedWorkspaces.map((directory) => manifests.get(directory).name)

  assert.equal(publishedPackages.length, 50)
  assert.deepEqual([...packed].sort(), [...publishedPackages].sort())
  assert.ok(publishedPackages.includes("smthrs"), "the unscoped deprecation notice publishes with the RC")
})

test("every packed manifest carries the candidate version and the safe default dist-tag", () => {
  // A prerelease published to `latest` would upgrade every `smthrs`-adjacent
  // install that tracks the tag, so the tag is pinned per manifest as well as
  // on the publish command (the release runbook in Smithers-Ops).
  const manifests = readWorkspaceManifests()
  for (const directory of packedWorkspaces) {
    const manifest = manifests.get(directory)
    assert.equal(manifest.version, releaseVersion, `${manifest.name} version`)
    assert.equal(manifest.publishConfig.tag, "next", `${manifest.name} publishConfig.tag`)
    assert.equal(manifest.publishConfig.access, "public", `${manifest.name} publishConfig.access`)
    assert.equal(manifest.publishConfig.provenance, true, `${manifest.name} publishConfig.provenance`)
  }
})

test("pack-release lists workspace directories and package names in publication order", () => {
  const list = execFileSync(process.execPath, ["scripts/pack-release.mjs", "--list"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
  const names = execFileSync(process.execPath, ["scripts/pack-release.mjs", "--names"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
  const manifests = readWorkspaceManifests()

  assert.deepEqual(list.trim().split("\n"), packedWorkspaces)
  assert.deepEqual(names.trim().split("\n"), packedWorkspaces.map((directory) => manifests.get(directory).name))
})

test("pack-release order is a topological order of the workspace dependency graph", () => {
  const dependencies = workspaceDependencies(readWorkspaceManifests())
  const position = new Map(packedWorkspaces.map((name, index) => [name, index]))
  const unordered = []
  for (const [workspace, edges] of dependencies) {
    for (const edge of edges) {
      if (position.get(edge) > position.get(workspace)) unordered.push(`${workspace} -> ${edge}`)
    }
  }

  assert.deepEqual(unordered, [])
})

test("release.yml publishes exactly the packed workspaces, in the packed order", () => {
  const release = workflow("release.yml")

  // The publish step reads the pack manifest, so the published set is the
  // packed set and the published order is the packed order by construction.
  assert.match(release, /manifest\.json/)
  assert.match(release, /entry\.name \+ " " \+ entry\.filename/)
  assert.deepEqual([...release.matchAll(/@smthrs\/[\w-]+/g)].map((match) => match[0]), [])
})

test("every gate in ci.yml also runs in release.yml", () => {
  // ci.yml states its gates as build-graph invocations, so this reads those
  // rather than the `pnpm run <script>` strings the graph replaced. The old
  // form of this case matched only script runners, which ci.yml stopped using;
  // it went vacuous, and the release workflow then drifted onto `pnpm test`
  // undetected until the 1.0.0-rc.0 dry run failed on @smthrs/std.
  const ci = workflow("ci.yml")

  // The roster is pinned so a new CI job forces a decision here instead of
  // silently landing outside the release's proof. The jobs release.yml
  // does not mirror: `cache-publish` re-runs `ci '//packages/...'` on main
  // pushes only to publish its results to the remote cache, and `test`
  // already carries that gate; `browser` runs `//scripts:webBundleContract`, which
  // `//scripts/...` already covers; `packages` runs `test '//packages/...'`,
  // which `ci '//packages/...'` already covers; `apps-e2e` needs the runner's
  // Chrome; the native Rust crate remains in `rust`, while the shipped FFI
  // and Go backend jobs are mirrored. Release mirrors `wasm-repro` so the
  // committed artifact is rebuilt and byte-compared before packing.
  const jobs = Object.keys(parse(ci).jobs)
  assert.deepEqual(jobs, [
    "cache-publish",
    "test",
    "apps-e2e",
    "rust",
    "rust-ffi",
    "wasm-repro",
    "e2e-faults",
    "browser",
    "packages",
    "go-backend",
    "review-lints"
  ])

  const mirrored = ["test", "rust-ffi", "e2e-faults", "wasm-repro", "go-backend"]
  const isGate = (step) => graphCommands([step]).length > 0
  // ci.yml passes the known-red list; the release does not, so every target a
  // release mirrors must be green there, including those main tolerates.
  const expected = mirrored.flatMap((job) => jobSteps(ci, job)).filter(isGate)
    .map((step) => step.replace(/ --known-red '[^']+'/g, ""))
  const actual = jobSteps(workflow("release.yml"), "publish").filter(isGate)

  // The gates the release adds on top of the mirrored jobs, pinned so an
  // extra step is a decision here rather than a silent addition. The apps/app
  // and apps/tui gates mirror the `apps-e2e` job without its browser suite; the other two
  // are release-only targets the roster comment in release.yml explains. The
  // 2026-09-05 rename added `smthrs` copies of two gates beside their older
  // `smithers-build` twins, and the subset check this case used to be could
  // not see the duplicates, the dropped cache env on two gates, or a step
  // ci.yml gained that the release never mirrored.
  const releaseOnly = [
    "pnpm exec smthrs build '//apps/app:check' --verbose",
    "pnpm exec smthrs test '//apps/app:unitTests' --verbose",
    "pnpm exec smthrs test '//apps/app:conformance' --verbose",
    "pnpm exec smthrs ci '//apps/tui/...' --verbose",
    "pnpm exec smthrs test '//packages/smithers/flows/engine-store:disasterRecovery' --verbose",
    "pnpm exec smthrs test '//scripts:releaseVersion' --verbose"
  ]
  const command = (step) => graphCommands([step])[0]
  const copied = actual.filter((step) => !releaseOnly.includes(command(step)))

  assert.ok(expected.length > 15, `${expected.length} gates is too few to be the required CI roster`)
  assert.deepEqual(actual.filter((step) => releaseOnly.includes(command(step))).map(command), releaseOnly)
  // Whole blocks, in order: the same command with a different env, a gate
  // ci.yml dropped, or one it gained all fail here, not only a missing one.
  assert.deepEqual(copied.map(command), expected.map(command))
  assert.deepEqual(copied, expected)
  assert.doesNotMatch(workflow("release.yml"), /--known-red/)
})

test("release.yml's publish job names every step once", () => {
  // release-rehearsal.test.mjs looks steps up by name and the rehearsal
  // driver selects them by `--only` and `--skip` fragments, so a duplicated
  // name is an ambiguous step, not a second gate.
  const names = jobSteps(workflow("release.yml"), "publish")
    .map((step) => /^ {6}- name: (.+)$/m.exec(step)?.[1])
    .filter((name) => name !== undefined)
  const duplicated = names.filter((name, index) => names.indexOf(name) !== index)
  assert.ok(names.length > 30, `${names.length} named steps is too few to be the publish job`)
  assert.deepEqual(duplicated, [])
})

test("every toolchain step in ci.yml's required test job also runs in release.yml", () => {
  // The gate above proves the release runs the same commands. This proves the
  // release gives them the same machine. ci.yml installs ripgrep, bubblewrap,
  // Go, Foundry, and the containerd image store from the `CiToolchain.Needs`
  // declaration in the root PACKAGE.ts; release.yml is hand-written and copies
  // the rendered steps. Comparing the rendered text is what keeps a toolchain
  // bump a one-line copy: the generator moves ci.yml, and this fails until
  // release.yml carries the same bytes.
  const ciSteps = jobSteps(workflow("ci.yml"), "test")
  const releaseSource = workflow("release.yml")
  const releaseSteps = jobSteps(releaseSource, "publish")
  const declared = new Set(releaseSteps)

  // Two steps the release deliberately extends rather than copies: it checks
  // out the full history the changelog gate reads, and it points npm at the
  // registry it publishes to. Release also proves its Node 26.4 support floor;
  // the smoke step checks the actual version before it packs.
  // Their settings and action pins are checked below.
  const extended = ["actions/checkout", "actions/setup-node"]
  const toolchain = ciSteps.filter((step) => !/(?:smithers-build|smthrs)/.test(step))
  const missing = toolchain
    .filter((step) => !extended.some((action) => invokes(step, action)))
    .filter((step) => !declared.has(step))

  assert.ok(toolchain.length > 5, `${toolchain.length} steps is too few to be the CI toolchain`)
  assert.deepEqual(missing, [], "these ci.yml toolchain steps are missing from release.yml")

  for (const action of extended) {
    const source = toolchain.find((step) => invokes(step, action))
    const copy = releaseSteps.find((step) => invokes(step, action))
    assert.ok(source !== undefined, `ci.yml has no ${action} step`)
    assert.ok(copy !== undefined, `release.yml has no ${action} step`)
    assert.equal(
      source.split("\n")[0],
      copy.split("\n")[0],
      `release.yml's ${action} step uses a different action pin`
    )
    const sourceEntries = withEntries(source)
    const copiedEntries = withEntries(copy)
    const floorSubstitution = "          node-version-file: .node-version"
    if (action === "actions/setup-node") {
      assert.ok(sourceEntries.includes(floorSubstitution), "CI selects the repository's Node version file")
      assert.ok(copiedEntries.includes("          node-version: 26.4.0"), "release proves its Node support floor")
    }
    assert.deepEqual(
      sourceEntries.filter((entry) => !(action === "actions/setup-node" && entry === floorSubstitution)
        && !copiedEntries.includes(entry)),
      [],
      `release.yml's ${action} step drops a toolchain setting ci.yml declares`
    )
  }
})

test("release.yml drives the target graph, never a recursive package script", () => {
  // `pnpm test` and its siblings run each package's own script, which needs
  // none of the toolchain the graph's targets declare. That is the shape of
  // the drift the two cases above exist to catch, stated once more as a ban.
  assert.deepEqual(scriptRunners(workflow("release.yml")), [])
  assert.deepEqual(scriptRunners(workflow("ci.yml")), [])
})

test("dependencyOrder is a topological order with an alphabetical tiebreak", () => {
  assert.deepEqual(
    dependencyOrder(new Map([["z", new Set()], ["a", new Set(["z"])], ["m", new Set()]])),
    ["m", "z", "a"]
  )
})

test("dependencyOrder rejects cycles", () => {
  assert.throws(
    () => dependencyOrder(
      new Map([
        ["b", new Set(["c"])],
        ["c", new Set(["b"])],
        ["a", new Set(["b", "c"])],
        ["d", new Set()]
      ])
    ),
    /cyclic workspace dependencies/
  )
})

/**
 * Whether an npm `files` entry packs one path. A bare directory packs
 * everything under it; `**` crosses directory boundaries and `*` does not.
 */
const packsPath = (pattern, path) => {
  if (!pattern.includes("*")) return pattern === path || path.startsWith(`${pattern}/`)
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*")
  return new RegExp(`^${source}$`).test(path)
}

test("every published manifest packs the module-type marker its build writes", () => {
  // scripts/build.mjs writes `{"type":"commonjs"}` to dist/cjs/package.json so
  // Node reads the CJS output as CommonJS inside a "type": "module" package. A
  // `files` array whose globs miss that path drops the marker from the tarball
  // while every other package ships it, which is how `smthrs` shipped without
  // it. `dist/**/*` packs it and `dist/**/*.js` does not, so the claim is
  // checked against the path, not against one spelling of the glob.
  const manifests = readWorkspaceManifests()
  const missing = packedWorkspaces.filter((directory) =>
    !(manifests.get(directory).files ?? []).some((pattern) => packsPath(pattern, "dist/cjs/package.json"))
  )

  assert.deepEqual(missing, [], "these manifests do not pack dist/cjs/package.json")
})

test("packsPath reads npm files globs the way npm packs them", () => {
  assert.equal(packsPath("dist/**/*", "dist/cjs/package.json"), true)
  assert.equal(packsPath("dist/**/package.json", "dist/cjs/package.json"), true)
  assert.equal(packsPath("dist/**/*.js", "dist/cjs/package.json"), false)
  assert.equal(packsPath("dist/*", "dist/cjs/package.json"), false)
  assert.equal(packsPath("dist", "dist/cjs/package.json"), true)
  assert.equal(packsPath("src/**/*.sql", "src/migrations/0001_memory.sql"), true)
  assert.equal(packsPath("src/**/*.ts", "src/migrations/0001_memory.sql"), false)
})


test("every published library exposes the one Effect runtime as a peer", () => {
  const manifests = readWorkspaceManifests()
  const published = packedWorkspaces.map((directory) => manifests.get(directory))
  const pins = new Set(published.flatMap((manifest) =>
    [manifest.dependencies?.effect, manifest.peerDependencies?.effect].filter((range) => typeof range === "string")
  ))
  assert.deepEqual([...pins], ["4.0.0-rc.115"], "one effect pin across the published set")
  const misplaced = published
    .filter((manifest) => manifest.bin === undefined && manifest.dependencies?.effect !== undefined)
    .map((manifest) => manifest.name)
  assert.deepEqual(misplaced, [], "library packages must not install a private Effect runtime")
})

test("published adapters remain optional while executable SQLite and Bun host prerequisites are required", () => {
  const byName = new Map([...readWorkspaceManifests().values()].map((manifest) => [manifest.name, publicationManifest(manifest)]))
  const optional = {
    "@smthrs/database": { "@effect/sql-sqlite-node": "4.0.0-rc.115" },
    "@smthrs/gateway": { "@effect/platform-node": "4.0.0-rc.115", "@effect/platform-bun": "4.0.0-rc.115" },
    "@smthrs/flows": { "@smthrs/platform-node": releaseVersion, "@effect/platform-node": "4.0.0-rc.115" },
    "@smthrs/create-app": { "@smthrs/testing": releaseVersion },
    "@smthrs/observability": {
      "@opentelemetry/exporter-logs-otlp-http": "0.222.0", "@opentelemetry/exporter-metrics-otlp-http": "0.222.0",
      "@opentelemetry/exporter-trace-otlp-http": "0.222.0", "@opentelemetry/sdk-trace-base": "2.11.0",
      "@opentelemetry/sdk-trace-node": "2.11.0", "@opentelemetry/sdk-trace-web": "2.11.0"
    }
  }
  for (const [name, peers] of Object.entries(optional)) {
    const manifest = byName.get(name)
    for (const [peer, version] of Object.entries(peers)) {
      assert.equal(manifest.dependencies?.[peer], undefined, name + " must not force " + peer)
      assert.equal(manifest.peerDependencies[peer], version)
      assert.deepEqual(manifest.peerDependenciesMeta[peer], { optional: true })
      assert.equal(manifest.devDependencies[peer], version)
    }
  }
  for (const [name, peer, version] of [
    ["@smthrs/cli", "@effect/sql-sqlite-node", "4.0.0-rc.115"],
    ["@smthrs/platform-bun", "@smthrs/platform-node", releaseVersion],
    ["@smthrs/platform-bun", "@effect/platform-node", "4.0.0-rc.115"]
  ]) {
    assert.equal(byName.get(name).peerDependencies[peer], version)
    assert.notEqual(byName.get(name).peerDependenciesMeta?.[peer]?.optional, true)
  }
  assert.equal(byName.get("@smthrs/observability").dependencies["@opentelemetry/sdk-logs"], "0.222.0")
  assert.equal(byName.get("@smthrs/observability").dependencies["@opentelemetry/sdk-metrics"], "2.11.0")
  assert.equal(byName.get("@smthrs/agent").dependencies["@smthrs/platform-browser"], undefined)
})

test("runtime evaluation owns scorers while testing delegates to the same pure grading package", () => {
  const manifests = readWorkspaceManifests()
  const evals = manifests.get("packages/smithers/agent/evals")
  const testing = manifests.get("packages/testing")
  assert.equal(evals.dependencies["@smthrs/testing"], undefined)
  assert.equal(evals.dependencies["@smthrs/scorers"], releaseVersion)
  assert.equal(testing.dependencies["@smthrs/scorers"], releaseVersion)
})

test("the Effect checker refuses ranges and mismatched RCs in every dependency field", () => {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of ["effect", "@effect/platform-node", "@effect/sql-sqlite-node", "@effect/new-adapter"]) {
      for (const version of ["4.0.0-rc.111", "^4.0.0-rc.115", "~4.0.0-rc.115", "4.0.0-rc.113"]) {
        const records = effectDeclarations({ [section]: { [name]: version } }, "fixture")
        assert.equal(records.length, 1)
        assert.throws(() => assertEffectPins(records), /Expected exact Effect-family RC/)
      }
      assert.doesNotThrow(() => assertEffectPins(effectDeclarations({ [section]: { [name]: "4.0.0-rc.115" } }, "fixture")))
    }
  }
})

test("the Effect checker reads scoped and duplicate lock entries independently of declarations", () => {
  const pnpm = "packages:\n  effect@4.0.0-rc.115:\n  '@effect/platform-node@4.0.0-rc.111':\n" +
    "snapshots:\n  '@effect/platform-node@4.0.0-rc.111(effect@4.0.0-rc.115)':\n"
  assert.deepEqual(effectLockVersions(pnpm, "pnpm").map(({ name, version }) => [name, version]), [
    ["effect", "4.0.0-rc.115"], ["@effect/platform-node", "4.0.0-rc.111"], ["@effect/platform-node", "4.0.0-rc.111"]
  ])
  const bun = '"effect": ["effect@4.0.0-rc.115", ""], "@effect/platform-bun": ["@effect/platform-bun@4.0.0-rc.113", ""]'
  assert.deepEqual(effectLockVersions(bun, "bun").map(({ name, version }) => [name, version]), [
    ["effect", "4.0.0-rc.115"], ["@effect/platform-bun", "4.0.0-rc.113"]
  ])
  assert.throws(() => assertEffectPins(effectLockVersions(pnpm, "pnpm")), /platform-node@4.0.0-rc.111/)
  assert.throws(() => assertEffectPins(effectLockVersions(bun, "bun")), /platform-bun@4.0.0-rc.113/)
})

test("installed package checks reject missing, malformed and same-version private Effect copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-k-effect-resolution-"))
  try {
    await writeFile(join(root, "package.json"), "{}")
    const directory = "library"
    const library = { name: "@smthrs/fixture", peerDependencies: { effect: "4.0.0-rc.115" } }
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, directory, "package.json"), JSON.stringify(library))
    const manifests = new Map([[directory, library]])
    assert.throws(() => installedEffectResolutions(root, manifests), /Cannot find module/)
    await mkdir(join(root, "node_modules/effect"), { recursive: true })
    await writeFile(join(root, "node_modules/effect/package.json"), JSON.stringify({ name: "effect", version: "4.0.0-rc.115" }))
    assert.equal(installedEffectResolutions(root, manifests).length, 1)
    // Each installation has its own importer. Node caches prior resolutions,
    // so changing a previously resolved directory would test that cache.
    await mkdir(join(root, "duplicate/node_modules/effect"), { recursive: true })
    await writeFile(join(root, "duplicate/package.json"), JSON.stringify(library))
    await writeFile(join(root, "duplicate/node_modules/effect/package.json"), JSON.stringify({ name: "effect", version: "4.0.0-rc.115" }))
    assert.throws(() => installedEffectResolutions(root, new Map([["duplicate", library]])), /different physical Effect instance/)
    await mkdir(join(root, "malformed/node_modules/effect"), { recursive: true })
    await writeFile(join(root, "malformed/package.json"), JSON.stringify(library))
    await writeFile(join(root, "malformed/node_modules/effect/package.json"), "{ invalid")
    assert.throws(() => installedEffectResolutions(root, new Map([["malformed", library]])))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("every published package packs the markdown inside the source tree it ships", () => {
  // The `@smthrs/memory` rule stated once for every package instead of once per
  // file: a package that ships `src/**/*.ts` ships its source as the thing a
  // reader reads, so the prose filed beside that source belongs in the same
  // tarball. `packages/smithers/flows/keys/src/README.md` is the file that named the gap.
  const manifests = readWorkspaceManifests()
  const unpacked = []
  for (const directory of packedWorkspaces) {
    const source = join(repoRoot, directory, "src")
    if (!existsSync(source)) continue
    const files = manifests.get(directory).files ?? []
    for (const entry of readdirSync(source, { recursive: true })) {
      const relative = `src/${String(entry).split(sep).join("/")}`
      if (!relative.endsWith(".md")) continue
      if (!files.some((pattern) => packsPath(pattern, relative))) unpacked.push(`${directory}/${relative}`)
    }
  }

  assert.deepEqual(unpacked, [], "these markdown files sit in a packed source tree and no files glob packs them")
})

test("the CLI install line needs no dependency workaround", () => {
  for (const relative of ["README.md"]) {
    const source = readFileSync(join(repoRoot, relative), "utf8")
    const installLines = source
      .split("\n")
      .filter((line) => /^(pnpm add|npm install|npm i|bun add|yarn add) /.test(line))
      .filter((line) => /@smthrs\/cli@/.test(line))
    // Until publication the README installs from the source checkout and says
    // so (e312ca0cf); once it drops that sentence it must name @smthrs/cli again.
    if (!/release candidate is not on npm/.test(source)) {
      assert.ok(installLines.length > 0, `${relative} must show an install command naming @smthrs/cli`)
    }
    assert.ok(installLines.every((line) => !line.includes("@effect/platform-node")))
    assert.ok(installLines.every((line) => !line.includes("@effect/platform-node-shared")))
    assert.doesNotMatch(source, /\boverrides\b/, `${relative} must not require dependency overrides`)
  }
})

test("an export with no require condition is the only thing that exempts a module from the CommonJS check", () => {
  const manifest = {
    publishConfig: {
      exports: {
        "./package.json": "./package.json",
        ".": { types: "./dist/esm/index.d.ts", import: "./dist/esm/index.js", require: "./dist/cjs/index.js" },
        "./Vitest": { types: "./dist/esm/Vitest.d.ts", import: "./dist/esm/Vitest.js" },
        "./*": { types: "./dist/esm/*.d.ts", import: "./dist/esm/*.js" },
        "./internal/*": null
      }
    }
  }
  assert.deepEqual([...esmOnlyModules(manifest)], ["Vitest"])
  assert.deepEqual([...esmOnlyModules({})], [])
  assert.deepEqual([...esmOnlyModules({ publishConfig: { exports: { ".": "./dist/esm/index.js" } } })], [])
})

test("every ESM-only export in the workspace names one concrete module its build program can skip", () => {
  for (const [directory, manifest] of readWorkspaceManifests()) {
    for (const [subpath, conditions] of Object.entries(manifest.publishConfig?.exports ?? {})) {
      if (typeof conditions !== "object" || conditions === null || "require" in conditions) continue
      if (typeof conditions.import !== "string") continue
      assert.equal(
        conditions.import.includes("*"),
        false,
        `${directory} publishes ${subpath} without a require condition through a pattern; the CommonJS check cannot exempt a pattern`
      )
      assert.equal(
        esmOnlyModules(manifest).has(conditions.import.replace(/^\.\/dist\/esm\//, "").replace(/\.js$/, "")),
        true,
        `${directory} publishes ${subpath} import-only but the pack script does not recognise it as ESM-only`
      )
    }
  }
})

test("defaultBindings reports the default import and export sites and nothing spelled inside a string or comment", () => {
  const source = [
    "/**",
    " * import skeleton from \"./Skeleton.ts\"",
    " * export default skeleton",
    " */",
    "import * as Layer from \"effect/Layer\"",
    "import React from \"react\"",
    "import type Shape from \"./Shape.ts\"",
    "import initial from \"./migrations/0001_initial.ts\"",
    "import lineage, { later } from \"../migrations/0002_lineage.ts\"",
    "// import commented from \"./Commented.ts\"",
    "const fence = \"```ts\"",
    "export const template = `\"use server\"",
    "",
    "export default Flow.make({ name: ${JSON.stringify(\"x\")} })",
    "`",
    "export const named = initial",
    "export default named"
  ].join("\n")

  assert.deepEqual(defaultBindings(source), [
    { line: 8, kind: "import", text: "import initial from \"./migrations/0001_initial.ts\"" },
    { line: 9, kind: "import", text: "import lineage, { later } from \"../migrations/0002_lineage.ts\"" },
    { line: 17, kind: "export", text: "export default named" }
  ])
  assert.deepEqual(defaultBindings("export const set = {}\n"), [])
})

test("no published source module default-imports a sibling or exports a default", () => {
  // scripts/build.mjs converts every src file to CommonJS with esbuild
  // (bundle: false) inside a "type": "module" package. For `import x from
  // "./y.ts"` esbuild emits `__toESM(require("./y.js"), 1)` and reads
  // `.default`, which in Node mode is the whole exports object, not the value.
  // `initial.pipe(...)` then threw at module init in the CommonJS entries of
  // @smthrs/control, @smthrs/gateway, and @smthrs/cli while the ESM build was
  // fine, which is how the release smoke found it. The convention that keeps
  // it out is named exports only, and this walk is what holds the convention.
  //
  // The walk covers exactly the packages the RC contract publishes, and only
  // their `src`: private workspaces, tests, and docs are never read.
  const manifests = readWorkspaceManifests()
  assert.equal(manifests.size, publishedPackages.length)
  const sites = []
  let modules = 0
  for (const directory of manifests.keys()) {
    const source = join(repoRoot, directory, "src")
    if (!existsSync(source)) continue
    for (const entry of readdirSync(source, { recursive: true })) {
      const relative = `src/${String(entry).split(sep).join("/")}`
      if (!relative.endsWith(".ts")) continue
      const path = join(source, String(entry))
      if (!statSync(path).isFile()) continue
      modules += 1
      for (const site of defaultBindings(readFileSync(path, "utf8"))) {
        sites.push(`${directory}/${relative}:${site.line}  ${site.text}`)
      }
    }
  }

  assert.ok(modules > 100, `the walk read ${modules} modules, too few to be the published set`)
  assert.deepEqual(
    sites,
    [],
    "these published modules default-import a relative module or declare `export default`, and esbuild's " +
      "CommonJS pass (scripts/build.mjs, bundle: false, in a \"type\": \"module\" package) rewrites such an import " +
      "to `__toESM(require(...), 1).default`, which in Node mode is the whole exports object instead of the " +
      "exported value, so the published CommonJS entry throws at module init; use a named export and a named import"
  )
})

test("the real staging and tarball retain authored template config and exclude runtime debris", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-pack-template-"))
  try {
    const source = join(directory, "source")
    const staged = join(directory, "staged")
    const config = join(source, "template/default/.smithers")
    await mkdir(config, { recursive: true })
    const templateRoot = join(repoRoot, "packages/smithers/create-app/template/default")
    await cp(templateRoot, join(source, "template/default"), { recursive: true })
    await mkdir(join(source, ".smithers"), { recursive: true })
    await writeFile(join(source, ".smithers", "state.db"), "runtime state")
    await writeFile(join(config, "credentials.json"), "fixture credential")
    await writeFile(join(config, "cache.db"), "runtime state")
    const manifest = { name: "smithers-pack-template-fixture", version: "1.0.0", files: ["template/default/**"], publishConfig: { exports: { "./package.json": "./package.json" } } }
    await writeFile(join(source, "package.json"), JSON.stringify(manifest))
    await stagePackage(source, staged, manifest)
    const packed = JSON.parse(execFileSync("pnpm", ["pack", "--json", "--config.ignore-scripts=true", "--pack-destination", directory], { cwd: staged, encoding: "utf8" }))
    const file = packed[0]?.filename ?? packed.filename
    assert.deepEqual(assertPackedExportTargets(resolve(directory, file)), { name: manifest.name, literalTargets: 1 })
    const entries = execFileSync("tar", ["-tzf", resolve(directory, file)], { encoding: "utf8" }).split("\n")
    for (const name of ["WORKSPACE.ts", "agents.ts", "sandbox.ts"]) {
      const entry = `package/template/default/.smithers/${name}`
      assert.ok(entries.includes(entry), `${entry} absent from the actual tarball`)
      assert.equal(execFileSync("tar", ["-xOf", resolve(directory, file), entry], { encoding: "utf8" }), readFileSync(join(templateRoot, ".smithers", name), "utf8"))
    }
    assert.ok(!entries.some((entry) => /(?:state\.db|cache\.db|credentials\.json)$/.test(entry)))
    // The import closure beside .smithers is retained too.
    assert.ok(entries.includes("package/template/default/PACKAGE.ts"))
    assert.ok(entries.includes("package/template/default/TOOLS.ts"))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("the platform package tarball carries all five native helpers including the Windows executable", async () => {
  const publishedManifest = JSON.parse(readFileSync(join(repoRoot, "packages/smithers/flows/platform-node/package.json"), "utf8"))
  assert.ok(publishedManifest.files.includes("bin/**"))
  const directory = await mkdtemp(join(tmpdir(), "smithers-pack-native-"))
  try {
    const source = join(directory, "source")
    const staged = join(directory, "staged")
    const helpers = join(directory, "helpers")
    await mkdir(source)
    const manifest = {
      name: "@smthrs/platform-node", version: "1.0.0", files: ["bin/**"],
      publishConfig: { exports: { "./package.json": "./package.json" } }
    }
    await writeFile(join(source, "package.json"), JSON.stringify(manifest))
    const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]
    for (const platform of platforms) {
      const parent = join(helpers, platform)
      await mkdir(parent, { recursive: true })
      const binary = join(parent, platform === "win32-x64" ? "smithers-jj-export.exe" : "smithers-jj-export")
      await writeFile(binary, platform === "win32-x64" ? "MZwindows-fixture" : `#!/bin/sh\necho ${platform}\n`)
      await chmod(binary, 0o755)
    }
    await stagePackage(source, staged, manifest, helpers)
    const packed = JSON.parse(execFileSync("pnpm", ["pack", "--json", "--config.ignore-scripts=true", "--pack-destination", directory], { cwd: staged, encoding: "utf8" }))
    const file = resolve(directory, packed[0]?.filename ?? packed.filename)
    const entries = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).split("\n")
    execFileSync("tar", ["-xzf", file, "-C", directory])
    for (const platform of platforms) {
      const filename = platform === "win32-x64" ? "smithers-jj-export.exe" : "smithers-jj-export"
      assert.ok(entries.includes(`package/bin/${platform}/${filename}`))
      assert.ok(statSync(join(directory, "package/bin", platform, filename)).isFile())
    }
    assert.equal(await verifyPackagedNativeHelpers(join(directory, "package"), true), true)
    const windows = join(directory, "package/bin/win32-x64/smithers-jj-export.exe")
    assert.equal(readFileSync(windows, "utf8"), "MZwindows-fixture")
    await rm(windows)
    await assert.rejects(verifyPackagedNativeHelpers(join(directory, "package"), true), { code: "ENOENT" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("native smoke distinguishes an early rehearsal from a missing or incomplete release bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-smoke-native-"))
  try {
    assert.equal(await verifyPackagedNativeHelpers(directory), false)
    await assert.rejects(verifyPackagedNativeHelpers(directory, true), { code: "ENOENT" })
    const first = join(directory, "bin/darwin-arm64/smithers-jj-export")
    await mkdir(join(directory, "bin/darwin-arm64"), { recursive: true })
    await writeFile(first, "helper")
    await assert.rejects(verifyPackagedNativeHelpers(directory), { code: "ENOENT" })
    await rm(first)
    await mkdir(first)
    await assert.rejects(verifyPackagedNativeHelpers(directory), /not a regular file/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("packed exports traverse nested conditions and arrays while preserving null and ESM-only entries", () => {
  const manifest = { name: "fixture", exports: {
    ".": { types: "./index.d.ts", node: { import: "./index.js", require: "./index.cjs" }, default: [null, "./fallback.js"] },
    "./Vitest": { import: "./Vitest.js" },
    "./internal/*": null,
    "./space": "./directory with spaces/entry.js"
  } }
  const files = new Set(["index.d.ts", "index.js", "index.cjs", "fallback.js", "Vitest.js", "directory with spaces/entry.js"].map((path) => `package/${path}`))
  assert.equal(assertExportTargets(manifest, files), 6)
  for (const missing of files) {
    assert.throws(() => assertExportTargets(manifest, new Set([...files].filter((file) => file !== missing)), "fixture.tgz"), (error) => {
      assert.match(error.message, /fixture exports/)
      assert.ok(error.message.includes(missing.replace(/^package\//, "./")))
      assert.match(error.message, /missing or is not a regular file.*fixture\.tgz/)
      return true
    })
  }
})

test("packed export targets refuse unsafe paths and malformed leaves", () => {
  for (const target of ["../outside.js", "./../outside.js", "/absolute.js", "./node_modules/other.js", "./nested/../outside.js", "./nested\\outside.js", "./*.js", "./encoded%2fpath.js", "./query.js?x", "./hash.js#x", "./line\nbreak.js", "./", 42, undefined]) {
    assert.throws(() => assertExportTargets({ name: "unsafe", exports: { "./deep": { node: { import: target } } } }, new Set()), /unsafe exports\["\.\/deep"\]\["node"\]\["import"\] target/)
  }
})

test("actual pnpm tarballs reject a declared deep export omitted by files despite built files and valid root exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-packed-export-targets-"))
  try {
    const source = join(directory, "source")
    const staged = join(directory, "staged")
    await mkdir(join(source, "dist/esm/deep"), { recursive: true })
    for (const file of ["index.js", "index.d.ts", "deep/Forgotten.js"]) await writeFile(join(source, "dist/esm", file), "export {}\n")
    const manifest = { name: "smithers-missing-deep-export", version: "1.0.0", files: ["dist/esm/index.js", "dist/esm/index.d.ts"], publishConfig: { exports: {
      ".": { types: "./dist/esm/index.d.ts", import: "./dist/esm/index.js" },
      "./deep/Forgotten": { node: { import: "./dist/esm/deep/Forgotten.js" } }
    } } }
    await writeFile(join(source, "package.json"), JSON.stringify(manifest))
    await stagePackage(source, staged, manifest)
    assert.equal(existsSync(join(staged, "dist/esm/deep/Forgotten.js")), true)
    const packed = JSON.parse(execFileSync("pnpm", ["pack", "--json", "--config.ignore-scripts=true", "--pack-destination", directory], { cwd: staged, encoding: "utf8" }))
    const file = packed[0]?.filename ?? packed.filename
    assert.throws(() => assertPackedExportTargets(resolve(directory, file)), /smithers-missing-deep-export exports\["\.\/deep\/Forgotten"\]\["node"\]\["import"\] target "\.\/dist\/esm\/deep\/Forgotten\.js" is missing/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("a directory or symbolic link in a real tarball cannot satisfy an exported file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-export-file-type-"))
  try {
    const packageRoot = join(directory, "package")
    await mkdir(join(packageRoot, "directory.js"), { recursive: true })
    await writeFile(join(packageRoot, "real.js"), "export {}\n")
    await writeFile(join(packageRoot, "file with spaces.js"), "export {}\n")
    await symlink("real.js", join(packageRoot, "link.js"))
    const tarball = join(directory, "fixture.tgz")
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "space-entry", exports: { ".": "./file with spaces.js" } }))
    execFileSync("tar", ["-czf", tarball, "-C", directory, "package"])
    assert.deepEqual(assertPackedExportTargets(tarball), { name: "space-entry", literalTargets: 1 })
    for (const target of ["./directory.js", "./link.js"]) {
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "wrong-entry-kind", exports: { ".": target } }))
      execFileSync("tar", ["-czf", tarball, "-C", directory, "package"])
      assert.throws(() => assertPackedExportTargets(tarball), /wrong-entry-kind exports\["\."\] target.*is missing or is not a regular file/)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

// Complete artifacts alone cannot establish that source edits were compiled.
const staleBuildFixture = async (body) => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-pack-stale-"))
  try {
    const manifest = {
      name: "smithers-pack-stale-fixture", version: "1.0.0", type: "module",
      packageManager: "pnpm@11.25.0",
      scripts: { build: "node build.mjs" },
      publishConfig: { exports: { ".": {
        types: "./dist/esm/index.d.ts", import: "./dist/esm/index.js", require: "./dist/cjs/index.js"
      } } }
    }
    await mkdir(join(directory, "src"))
    await mkdir(join(directory, "dist/esm"), { recursive: true })
    await mkdir(join(directory, "dist/cjs"), { recursive: true })
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest))
    await writeFile(join(directory, "src/index.ts"), "export const reason = 'redacted'\n")
    for (const file of ["esm/index.js", "esm/index.d.ts", "cjs/index.js"]) {
      await writeFile(join(directory, "dist", file), "export const reason = 'secret'\n")
    }
    execFileSync("pnpm", ["install", "--offline", "--ignore-scripts"], { cwd: directory, stdio: "pipe" })
    await body(directory, manifest)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("pack boundary refuses complete stale artifacts when rebuilding fails", () => staleBuildFixture(async (directory, manifest) => {
  await writeFile(join(directory, "build.mjs"), "process.exit(23)")
  await assert.rejects(assertBuilt(directory, manifest), /build failed \(exit 23\)/)
}))

test("pack boundary rebuilds complete stale artifacts from current source", () => staleBuildFixture(async (directory, manifest) => {
  await writeFile(join(directory, "build.mjs"), [
    'import assert from "node:assert/strict"',
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"',
    'assert.equal(existsSync("dist"), false, "packing must clean stale output")',
    'mkdirSync("dist/esm", { recursive: true })',
    'mkdirSync("dist/cjs", { recursive: true })',
    'for (const file of ["esm/index.js", "esm/index.d.ts", "cjs/index.js"]) writeFileSync("dist/" + file, readFileSync("src/index.ts"))'
  ].join("\n"))
  await assertBuilt(directory, manifest)
  for (const file of ["esm/index.js", "esm/index.d.ts", "cjs/index.js"]) {
    assert.equal(readFileSync(join(directory, "dist", file), "utf8"), readFileSync(join(directory, "src/index.ts"), "utf8"))
  }
}))

test("pack boundary refuses stale artifacts without a build script", () => staleBuildFixture(async (directory, manifest) => {
  delete manifest.scripts.build
  await assert.rejects(assertBuilt(directory, manifest), /release package has no build script/)
}))

const jjAvailable = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/**
 * A lane made with `jj workspace add` has `.jj` and no `.git`, so asking git
 * for HEAD failed there (or answered for an unrelated ancestor repository).
 * Its HEAD is `@-`, the same commit a colocated checkout's git HEAD names.
 */
test("the release source revision reads a jj workspace without .git as git reads the colocated checkout", { skip: !jjAvailable }, async () => {
  const base = await mkdtemp(join(tmpdir(), "smthrs-pack-revision-"))
  try {
    const colocated = join(base, "colocated")
    const lane = join(base, "lane")
    await mkdir(colocated)
    const env = { ...process.env, JJ_USER: "Release Test", JJ_EMAIL: "release@example.invalid", JJ_CONFIG: join(base, "jj-config.toml") }
    const jj = (cwd, ...args) => execFileSync("jj", args, { cwd, env, encoding: "utf8" })
    jj(colocated, "git", "init", "--colocate")
    await writeFile(join(colocated, "a.txt"), "a\n")
    jj(colocated, "commit", "-m", "one")
    jj(colocated, "workspace", "add", lane)
    assert.equal(existsSync(join(lane, ".git")), false)

    const head = sourceRevision(colocated)
    assert.match(head.sha, /^[0-9a-f]{40}$/)
    assert.deepEqual(head, { sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: colocated, encoding: "utf8" }).trim(), dirty: false })
    assert.deepEqual(sourceRevision(lane), head)

    await writeFile(join(lane, "b.txt"), "b\n")
    assert.deepEqual(sourceRevision(lane), { sha: head.sha, dirty: true })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("the release source revision refuses a tree with neither .git nor .jj", async () => {
  const base = await mkdtemp(join(tmpdir(), "smthrs-pack-revision-"))
  try {
    assert.throws(() => sourceRevision(base), /neither \.git nor \.jj/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
