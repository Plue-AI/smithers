import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { readWorkspaceInventory } from "../readWorkspaceInventory.ts"

describe("coverage conformance", () => {
  const { packagesDir, packages, configs } = readWorkspaceInventory()
  const isFile = (path: string) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  it("finds every package's vitest config", () => {
    const names = configs.map((config) => config.name)
    assert.ok(names.includes("smithers/flows"))
    assert.ok(names.includes("smithers/flows/kernel"))
    assert.ok(names.length >= 11)
  })

  for (const entry of configs) {
    it(`${entry.name} ships a vitest config at all (issue #148)`, () => {
      const { path, source } = entry

      // An empty source means the package exists but has no config file —
      // the exact omission the config-derived universe could never see.
      assert.notEqual(source, "", `${path} is missing`)
    })
  }
  for (const entry of configs) {
    it(`${entry.name} isolates its coverage report directory for each runner`, () => {
      const { name, source } = entry

      if (name === "smithers/flows/platform-bun") {
        // Bun has no V8 inspector. Its Node lane owns a unique private directory,
        // kept through reporting and removed on exit, including failed runs.
        assert.ok(source.includes("const coverageRoot = join(import.meta.dirname, \"coverage\")"))
        assert.ok(source.includes("const reportsDirectory = process.versions.bun ? undefined : (() => {"))
        assert.ok(source.includes("mkdirSync(coverageRoot, { recursive: true, mode: 0o700 })"))
        assert.ok(source.includes("const directory = mkdtempSync(join(coverageRoot, \"run-\"))"))
        assert.ok(source.includes("process.once(\"exit\", () => rmSync(directory, { recursive: true, force: true }))"))
        assert.ok(source.includes("return directory"))
        assert.ok(source.includes("...(reportsDirectory === undefined ? {} : { reportsDirectory })"))
        assert.ok(source.includes("clean: false"))
        assert.ok(source.includes("import { mkdirSync, mkdtempSync, rmSync } from \"node:fs\""))
        assert.ok(source.includes("import { join } from \"node:path\""))
        return
      }
      // The report directory must be derived per process and live outside the
      // package working tree: `join(tmpdir(), \`flows-<pkg>-coverage-${pid}\`)`.
      assert.match(
        source,
        /reportsDirectory:\s*join\(\s*tmpdir\(\),\s*`flows-[a-z-]+-coverage-\$\{process\.pid\}`\s*\)/
      )
      // The derivation only isolates if the real node:os/node:path helpers
      // are in scope.
      assert.ok(source.includes(`import { tmpdir } from "node:os"`))
      assert.ok(source.includes(`import { join } from "node:path"`))
      // The slug is the package's own directory name. A nested package
      // (`flows/canonical`) is named by its path here, and a report directory
      // is one path segment.
      assert.ok(source.includes(`flows-${name.slice(name.lastIndexOf("/") + 1)}-coverage`))
    })
  }

  // No package currently lacks an enabled coverage gate. Keep this explicit
  // set and its inverted assertion so any future temporary deferral remains
  // narrow, reviewable, and self-expiring when the package enables its gate.
  const coverageGateDeferred = new Set<string>()

  // These packages were migrated wholesale from the former agent and smithers build
  // repositories. They already enforce honest measured floors, but did not
  // arrive with complete branch coverage. Treating those floors as if they
  // were 100% made this conformance suite red while every package-local gate
  // was green; simply writing `100` into the configs would make the root gate
  // unusable.
  // The set is explicit and self-expiring: every member must retain a real,
  // non-zero threshold in all four categories and at least one category below
  // 100. Once a package reaches full coverage it must leave this set.
  // `integrations` joins them for the same reason: it was imported wholesale;
  // its floors (branches 94, functions 98, lines
  // 99, statements 98) are the measured coverage of adapters that talk to
  // GitHub, Linear, and Telegram over HTTP, and its own config carries the
  // instruction to raise them as each case closes.
  // `migrate` joins them too: its floors are 70 in all four categories, the
  // measured coverage of a translator whose remaining branches are the 0.x
  // shapes only a live model run reaches, and those three cases are pinned in
  // `scripts/test-pins.md` rather than run by the default gate.
  // `control` and `testing` left the set on 2026-09-01: both now pin 100 in
  // every category (`6b3e0142e4`, `d1012596b6`).
  const coverageFloorDeferred = new Set([
    "smithers",
    "smithers/agent/memory",
    "smithers/agent/std",
    "smithers/build",
    "smithers/build/build-cli",
    "smithers/build/targets",
    "smithers/agent/integrations",
    "smithers/migrate"
  ])

  /**
   * The block a `key: {` opens, or null when the source has no such block or
   * an unbalanced one.
   */
  const block = (source: string, key: string): string | null => {
    // Anchored on the key followed by its brace. `indexOf("coverage:")` finds
    // the word inside the comment that explains why the fault tier runs
    // "without coverage:", and the block read from there is whatever brace
    // happens to come next.
    const at = source.search(new RegExp(`\\b${key}\\s*:\\s*\\{`))
    if (at === -1) return null
    const open = source.indexOf("{", at)
    if (open === -1) return null
    let depth = 0
    for (let index = open; index < source.length; index++) {
      if (source[index] === "{") depth++
      else if (source[index] === "}") {
        depth--
        if (depth === 0) return source.slice(open + 1, index)
      }
    }
    return null
  }

  /**
   * The package one coverage exclusion names, or null when it names none.
   *
   * An exclusion inside the coverage block normally shrinks the production
   * denominator, which is the defect this suite exists to stop. There is one
   * shape that does the opposite: a pattern naming ANOTHER package's tree
   * removes code this package's gate was never responsible for. Two spellings
   * reach one — `<child>/**` for a package nested inside this one, and
   * `../<sibling>/**` for a sibling package — and both are
   * resolved here against a real `package.json`, so the exemption expires the
   * day that package moves or stops existing and can never be spelled to hide
   * this package's own source.
   */
  const excludedPackage = (name: string, pattern: string): string | null => {
    const body = pattern.replace(/\/\*\*$/, "")
    if (body === "" || body.includes("*")) return null
    const candidate = relative(packagesDir, resolve(packagesDir, name, body))
    return candidate !== name && isFile(join(packagesDir, candidate, "package.json")) ? candidate : null
  }

  for (
    const entry of [...configs, {
      name: "smithers/build/infra",
      source: readFileSync(join(packagesDir, "smithers/build/infra/vitest.config.ts"), "utf8")
    }]
  ) {
    it(`${entry.name} uses relative coverage globs for Vitest 5`, () => {
      const { source } = entry

      const coverage = block(source, "coverage") ?? ""
      const globs = [
        ...coverage.matchAll(
          /\b(?:include|exclude):\s*\[[^\]]*\](\.map\(\s*\(pattern\) =>\s*join\(import\.meta\.dirname, pattern\)\s*\))?/g
        )
      ]
      assert.ok(globs.length > 0)
      for (const glob of globs) {
        // Vitest 5 matches paths relative to the project root. Absolute
        // patterns silently measure no files and pass every threshold.
        assert.equal(glob[1], undefined, glob[0])
        for (const [, pattern] of glob[0].matchAll(/"([^"]+)"/g)) {
          assert.ok(!pattern!.startsWith("/") && !/^[A-Za-z]:/.test(pattern!))
        }
      }
    })
  }

  // HostContract executes adapter behavior in testing's suite. This is one
  // exact transfer between two measured gates, not an unowned exclusion.
  const delegatedCoverage = (
    name: string,
    pattern: string,
    destinationSource = configs.find((config) => config.name === "testing")?.source ?? ""
  ): boolean => {
    if (name !== "smithers/flows/kernel" || pattern !== "src/test/HostContract.ts") return false
    const coverage = block(destinationSource, "coverage") ?? ""
    const thresholds = block(coverage, "thresholds") ?? ""
    const categories = [...thresholds.matchAll(/\b(branches|functions|lines|statements):\s*(\d+)/g)]
    const includes = /\binclude\s*:\s*\[([^\]]*)\]/.exec(coverage)?.[1] ?? ""
    return isFile(join(packagesDir, name, pattern)) &&
      /\benabled:\s*true/.test(coverage) && /\bprovider:\s*"v8"/.test(coverage) &&
      !/\bexclude\s*:/.test(coverage) &&
      includes.includes("\"../smithers/flows/kernel/src/test/HostContract.ts\"") &&
      categories.length === 4 && categories.every((match) => match[2] === "100") &&
      thresholds.replace(/\b(?:branches|functions|lines|statements):\s*100\s*,?/g, "").trim() === ""
  }

  const assertCoverageDenominator = (name: string, source: string) => {
    const coverage = block(source, "coverage")
    assert.notEqual(coverage, null, `packages/${name}/vitest.config.ts has no readable coverage block`)
    if (name === "smithers/flows/flow" && coverage!.includes("enabled: coversWholeSuite(")) {
      // Flow's declared full-suite target still enforces coverage. Only an
      // explicitly filtered developer run opts out through the helper whose
      // full-suite behavior is exercised below. Pin the parser and wiring,
      // so an unrelated dynamic expression cannot disable the gate.
      assert.ok(source.includes('import { parseCLI } from "vitest/node"'))
      assert.ok(source.includes('import { coversWholeSuite } from "./test/CoverageGate.ts"'))
      assert.ok(coverage!.includes(
        'enabled: coversWholeSuite(parseCLI(["vitest", ...process.argv.slice(2)], { allowUnknownOptions: true })),\n'
      ))
    } else {
      assert.match(
        coverage!,
        name === "smithers/flows/platform-bun"
          ? /\benabled:\s*!process\.versions\.bun\s*,/
          : /\benabled:\s*true/
      )
    }
    assert.match(coverage!, /\bprovider:\s*"v8"/)
    assert.doesNotMatch(coverage!, /\b(?:include|exclude):\s*\[[^\]]*\]\s*\.map\(/)
    const included = [...(/\binclude\s*:\s*\[([^\]]*)\]/.exec(coverage ?? "")?.[1] ?? "")
      .matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
    assert.equal(included.some((entry) => entry === "src/**" || entry === "src/**/*.ts"), true)
    // Additional positive entries widen the denominator (testing also owns
    // kernel's HostContract). Negated entries would silently subtract files.
    assert.deepEqual(included.filter((entry) => entry.startsWith("!")), [])
    // A test-runner `test.exclude` is legitimate (for example fixture source
    // that is not a test). An exclusion inside the coverage block shrinks the
    // production denominator, with one exception that does the opposite: a
    // nested package's directory. The v8 provider reports every file EXECUTED
    // under the vitest root whatever `include` says, so an enclosing package
    // that imports its nested one would otherwise measure that package's code
    // against ITS OWN gate — code the enclosing suite never covers and the
    // nested suite already covers to 100%. Only a `<dir>/**` naming a real
    // nested package is allowed, so the exemption expires with the nesting and
    // can never be spelled to hide this package's own source.
    const excluded = [
      ...(/\bexclude\s*:\s*\[([^\]]*)\]/.exec(coverage ?? "")?.[1] ?? "").matchAll(/"([^"]+)"/g)
    ].flatMap((match) => match[1] === undefined ? [] : [match[1]])
    assert.equal(
      !/\bexclude\s*:/.test(coverage ?? "") || excluded.length > 0,
      true,
      `packages/${name}/vitest.config.ts declares a coverage exclusion this cell cannot read`
    )
    assert.deepEqual(
      excluded.filter((entry) => excludedPackage(name, entry) === null && !delegatedCoverage(name, entry)),
      [],
      `packages/${name}/vitest.config.ts carries an unowned coverage exclusion; ` +
        "an exclusion must name another package's tree or the checked HostContract handoff"
    )
    assert.doesNotMatch(source, /\bautoUpdate\s*:/)
    assert.doesNotMatch(source, /\ball\s*:/)
    assert.doesNotMatch(source, /\bextension\s*:/)
    assert.doesNotMatch(source, /\bignoreClassMethods\s*:/)
  }

  it("reads coverage settings inside their block and rejects denominator mutations", () => {
    const coverage = `coverage: { enabled: true, provider: "v8", include: ["src/**"] }`
    assert.ok((block(`// without coverage: a comment {\n${coverage}`, "coverage"))!.includes("enabled: true"))
    assert.equal(block("coverage: { enabled: true", "coverage"), null)
    assertCoverageDenominator("testing", coverage)
    assertCoverageDenominator(
      "testing",
      coverage.replace("[\"src/**\"]", "[\"src/**\", \"../smithers/flows/kernel/src/test/HostContract.ts\"]")
    )
    for (
      const mutated of [
        coverage.replace("\"src/**\"", "\"src/One.ts\""),
        coverage.replace("[\"src/**\"]", "[\"src/**\"].map((pattern) => join(import.meta.dirname, pattern))"),
        coverage.replace("[\"src/**\"]", "[\"src/**\", \"!src/Hidden.ts\"]"),
        coverage.replace("enabled: true", "enabled: false"),
        coverage.replace("provider: \"v8\"", "provider: \"istanbul\""),
        coverage.replace(" }", ", exclude: [\"src/Hidden.ts\"] }"),
        coverage.replace(" }", ", exclude: [\"**/testing/**\"] }"),
        coverage.replace(" }", ", exclude: omittedFiles }")
      ]
    ) {
      assert.throws(() => assertCoverageDenominator("testing", `test: { include: ["src/**"] }, ${mutated}`))
    }
  })

  it("keeps flow's parsed full-suite invocations under the coverage gate", async () => {
    const directory = join(packagesDir, "smithers/flows/flow")
    const { coversWholeSuite } = await import(pathToFileURL(join(directory, "test/CoverageGate.ts")).href)
    // Resolve the same parser as the package's config, without loading that
    // config with this Node test runner's own file-selection arguments.
    const { createRequire } = await import("node:module")
    const require = createRequire(join(directory, "package.json"))
    const { parseCLI } = await import(pathToFileURL(require.resolve("vitest/node")).href)
    for (const args of [[], ["run"], ["run", "--maxWorkers=1"], ["run", "--coverage"]]) {
      assert.equal(coversWholeSuite(parseCLI(["vitest", ...args], { allowUnknownOptions: true })), true)
    }
    const source = configs.find((config) => config.name === "smithers/flows/flow")!.source
    assertCoverageDenominator("smithers/flows/flow", source)
    for (const changed of [
      source.replace("enabled: coversWholeSuite(", "enabled: false && coversWholeSuite("),
      source.replace('parseCLI(["vitest", ...process.argv.slice(2)]', 'parseCLI(["vitest", "test/Only.test.ts"]'),
      source.replace('from "./test/CoverageGate.ts"', 'from "./test/AnotherGate.ts"')
    ]) assert.throws(() => assertCoverageDenominator("smithers/flows/flow", changed))
  })

  it("requires the exact HostContract handoff to retain its full destination gate", () => {
    const destination = configs.find((config) => config.name === "testing")!.source
    assert.equal(delegatedCoverage("smithers/flows/kernel", "src/test/HostContract.ts", destination), true)
    assert.equal(delegatedCoverage("smithers/flows/kernel", "src/test/**", destination), false)
    assert.equal(delegatedCoverage("smithers/flows/flow", "src/test/HostContract.ts", destination), false)
    for (
      const mutated of [
        destination.replace("\"../smithers/flows/kernel/src/test/HostContract.ts\"", "\"../another.ts\""),
        destination.replace("enabled: true", "enabled: false"),
        destination.replace("branches: 100", "branches: 99"),
        destination.replace(
          "coverage: {",
          "coverage: { exclude: [\"../smithers/flows/kernel/src/test/HostContract.ts\"],"
        )
      ]
    ) {
      assert.equal(delegatedCoverage("smithers/flows/kernel", "src/test/HostContract.ts", mutated), false)
    }
  })

  /**
   * The aggregate categories inside a `thresholds` block, with any per-file
   * entries removed.
   *
   * A package on the floor list may pin per-file floors beside its aggregate
   * ones, which is the opposite of the #147 hazard: under a 100% gate a
   * per-file key REMOVES its file from the global check, but under a measured
   * floor it adds a second, tighter gate over the modules an aggregate
   * dominated by well-covered code would otherwise hide. `@smthrs/build-cli`
   * pins nine such files over the process-spawning and publishing backends.
   * A `[^{}]*` capture cannot see past the first nested object, so it matched
   * nothing at all there and the cell read as "no thresholds declared". Brace
   * matching the block and then dropping the nested objects leaves exactly
   * the aggregate categories this cell is about. The 100% cell below keeps
   * its flat-only rule, where nesting really is the defect.
   */
  const aggregateThresholds = (source: string): string | null => {
    const key = source.indexOf("thresholds:")
    if (key === -1) return null
    const open = source.indexOf("{", key)
    if (open === -1) return null
    let depth = 0
    for (let index = open; index < source.length; index++) {
      if (source[index] === "{") depth++
      else if (source[index] === "}") {
        depth--
        if (depth > 0) continue
        let body = source.slice(open + 1, index)
        // Innermost-first, repeated until the body stops changing, so a
        // per-file entry that itself nested would still be removed whole.
        while (/\{[^{}]*\}/.test(body)) body = body.replace(/\{[^{}]*\}/g, "")
        return body
      }
    }
    // An unbalanced block is a malformed config, reported as an absent one.
    return null
  }

  it("pins the coverage-gate deferral set to packages that really exist", () => {
    // Guard the deferral the way every other exclusion here is guarded: a
    // renamed or removed package must fail here, not silently widen the set.
    const names = configs.map((config) => config.name)
    for (const name of [...coverageGateDeferred, ...coverageFloorDeferred]) {
      assert.ok(names.includes(name), `${name} is in the deferral set but not in packages/`)
    }
    assert.deepEqual([...coverageGateDeferred].filter((name) => coverageFloorDeferred.has(name)), [])
  })

  for (const entry of configs.filter((config) => coverageGateDeferred.has(config.name))) {
    it(
      "$name has NOT yet enabled the 100% coverage gate (deferred, remove from the set once it does)".replace(
        "$name",
        entry.name
      ),
      () => {
        const { source } = entry

        assert.doesNotMatch(source, /coverage:\s*\{[^]*?enabled:\s*true/)
      }
    )
  }

  for (const entry of configs.filter((config) => coverageFloorDeferred.has(config.name))) {
    it(`${entry.name} enforces an honest measured coverage floor over all of src/**`, () => {
      const { name, source } = entry

      assertCoverageDenominator(name, source)
      const pinned = aggregateThresholds(source)
      assert.notEqual(pinned, null, `packages/${name}/vitest.config.ts declares no thresholds block`)
      const values = [...(pinned ?? "").matchAll(/\b(branches|functions|lines|statements):\s*(\d+)/g)]
      assert.deepEqual(values.map((match) => match[1]).sort(), ["branches", "functions", "lines", "statements"])
      const numbers = values.map((match) => Number(match[2]))
      assert.equal(numbers.every((value) => value > 0 && value <= 100), true)
      assert.equal(numbers.some((value) => value < 100), true)
    })
  }

  for (
    const entry of configs.filter((config) =>
      !coverageGateDeferred.has(config.name) && !coverageFloorDeferred.has(config.name)
    )
  ) {
    it(`${entry.name} enforces 100% coverage over src/** on every run (issue #137)`, () => {
      const { name, source } = entry

      // The thresholds are the primary regression gate, so the gate itself
      // is pinned cross-package: a sibling that drops `enabled: true`,
      // lowers a threshold, or narrows `include` must fail HERE, not go
      // silently un-enforced with its own suite green.
      assertCoverageDenominator(name, source)
      // Both shipped shapes cover every production module: `src/**` and the
      // equivalent `src/**/*.ts`.
      // The thresholds object must be FLAT (issue #147): `[^{}]*` refuses a
      // nested object, because vitest's v8 provider treats a glob key
      // (`"src/risky.ts": { lines: 0 }`) as a per-file override that removes
      // matching files from the global 100% check. The earlier `[^}]*`
      // capture stopped at the nested object's first `}` yet still contained
      // all four pinned categories, so such an override slipped the gate.
      const thresholds = source.match(/thresholds:\s*\{([^{}]*)\}/)
      assert.notEqual(thresholds, null)
      // The capture group always exists when the match does; `?? ""` only
      // satisfies `noUncheckedIndexedAccess`, and an empty body would fail
      // every category assertion below anyway.
      const pinned = thresholds?.[1] ?? ""
      for (const category of ["branches", "functions", "lines", "statements"]) {
        assert.match(pinned, new RegExp(`${category}:\\s*100(?:\\s*,|\\s*\\})?`))
      }
      // And it must contain NOTHING BUT the four pinned categories: any
      // leftover key — a glob override without a nested object, a fifth
      // category at another value — must be widened here in review, never
      // added silently.
      const leftover = pinned.replace(/\b(?:branches|functions|lines|statements):\s*100\s*,?/g, "").trim()
      assert.equal(leftover, "")
      // The gate can also be weakened without touching any pinned field
      // (issue #142): `coverage.exclude` is applied ON TOP of `include`, so
      // one entry removes arbitrary src files from the 100% denominator
      // while every assertion above still passes, and
      // `thresholds.autoUpdate` rewrites the pinned 100s downward on a red
      // run. No shipped config carries either; a package that needs an
      // exclusion must widen this conformance test in review, not add it
      // silently.
      // `coverage.all: false` and a narrowed `coverage.extension` list are
      // the same silent-denominator-shrinking mechanism (issue #152): the
      // v8 provider defaults `all: true`, so every src file no test loads
      // still counts against the 100% thresholds; `all: false` (or an
      // extension list that drops files) restricts the check to files tests
      // happen to load while every pinned assertion above stays green.
      // The provider itself must be pinned to "v8" (issue #157): the whole
      // ignore-directive inventory below is written against the v8 provider's
      // hint grammar, and a silent flip to `provider: "istanbul"` would
      // activate `istanbul ignore` comments under a different parser while
      // every assertion above stays green.
      // `coverage.ignoreClassMethods` subtracts every method with a matching
      // name from the denominator with no per-site comment to inventory —
      // forbid it outright (issue #157).
    })
  }

  it("inventories every coverage-ignore directive against a pinned allowlist (issues #153/#157)", () => {
    // An ignore hint is subtracted from the denominator BEFORE the 100%
    // thresholds are evaluated, so a one-line comment is the cheapest way to
    // ship an uncovered branch with zero test failures. Every directive in
    // any package's src tree must appear here, with its count: adding one —
    // or moving one — means widening this allowlist in review, with the
    // justification the diff forces into the open.
    //
    // The inventory matches the provider's FULL hint grammar (issue #157):
    // the v8 provider parses hints via ast-v8-to-istanbul, whose regex is
    // /^\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file)(?=\W|$)/
    // plus a start/stop range variant — so `c8 ignore next`,
    // `istanbul ignore else`, and `node:coverage ignore file` are all live
    // directives that the earlier literal-`v8 ignore` grep never saw.
    const directive = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file|start|stop)(?=\W|$)/g
    const allowlist: Record<string, number> = {
      // `findMissing` accepts at most 1,000 strict 64-byte digests, so its
      // serialized request cannot reach the 256 KiB protocol ceiling. The
      // assertion remains beside serialization to fail closed if either
      // invariant changes.
      "smithers/flows/artifacts/src/RemoteArtifacts.ts": 1,
      // Gc's closed retention failure contract throws Error values; its
      // fallbacks keep diagnostics total if that dependency widens in the
      // future.
      "smithers/src/Gc.ts": 2,
      // Control's three arms sit behind the mutation boundary: every caller
      // hands `principalOf` a mutation the boundary already decoded into a
      // struct, and an unpaired high or lone low surrogate is refused there
      // before the redaction helper can meet it. TestControl's deterministic
      // runtime derives every identifier from a counter, so the random-byte
      // primitive `Crypto.make` requires is never asked for bytes.
      "smithers/control/src/ControlLive.ts": 3,
      "smithers/control/src/test/TestControl.ts": 1,
      // The rest of control's arms defend invariants its own code establishes:
      // a run is attributed only once one of its three cancellation sources
      // exists, so the trailing zero in `Cancellation` is unreachable; a
      // `Uint8Array` host always has the prototype accessors `Channels`
      // refuses to run without; the runtime's approval and target maps are
      // keyed by the identity they are compared against, and one process
      // writes `fence` and `localFence` together; `planning` is called only by
      // `launch`, which has the run it just started; and `Lineage` has already
      // refused an edge with no parent before `originOf` could answer nothing.
      // The transport classification added in 97c703dc0d brought the rest:
      // `ControlClient` reads a status only off a `StatusCodeError` cause,
      // which always carries a response with a numeric status, and re-raises
      // an interrupt-only cause the fiber never delivers to that operator;
      // the in-memory runtime's plan and approval maps are keyed by the
      // identity they are compared against, so a stored row can only
      // disagree with its key after a reach into private state; and
      // `SqlControlRuntime` has no remaining exclusions: explicit null input
      // round trips through SQL, and sequence, approval-token, and run-key
      // readback failures are exercised with real database triggers.
      "smithers/control/src/Cancellation.ts": 1,
      "smithers/control/src/Channels.ts": 1,
      "smithers/control/src/ControlClient.ts": 4,
      // Both idempotency lookup paths refer to plans retained by the same map.
      "smithers/control/src/ControlRuntime.ts": 6,
      "smithers/control/src/Lineage.ts": 1,
      "smithers/control/src/internal/planning.ts": 1,
      // The agent package's former hints (FlowEngineLike's canonicalization
      // mappers and AgentSession's process-loss fallbacks) were removed with
      // the code that needed them in 81b218ce7; the entries leave with them.
      // Capture reads each own descriptor once and freezes the detached copy
      // it built from those values; the original is never rewritten. Its
      // admission, Proxy refusal and freezing paths are covered without hints.
      // Plan's former walk no longer carries a hint.
      // The YAML parser always attaches a position to parser issues and a
      // mapping always converts to a non-null object. Both guards keep the
      // redacted diagnostic path total across future parser upgrades.
      "smithers/flows/core/src/internal/skillFrontmatter.ts": 2,
      // Guards remaining in the merged PlanScheduler: key material and upstream
      // values already crossed admission and serialization, and acyclic pending
      // work has a ready node.
      "smithers/flows/engine-store/src/PlanScheduler.ts": 2,
      // One `else` arm in recursive enumeration: special entries (symlinks,
      // sockets) are neither materializable leaves nor prunable scaffolding
      // and are intentionally discarded.
      // FileBoundary rejects upward and absolute removal declarations before
      // they reach the sandbox.
      "smithers/flows/engine-store/src/WorkspaceSandbox.ts": 1,
      "smithers/flows/engine-store/src/internal/RunCoordinator.ts": 1,
      // The inert-JSON reducer that admits an action's persisted value asks
      // the language for guarantees the language already makes: a non-proxy
      // array's `length` is a mandatory own data property holding a uint32,
      // a key returned by `Reflect.ownKeys` has a descriptor on a non-proxy
      // object, and the `typeof` switch above covers every value category.
      // Each guard turns a future host-reflection change into a rejected
      // value rather than a thrown persistence path.
      "smithers/flows/engine-store/src/internal/ActionPersistence.ts": 3,
      // The guest runner is resolved beside this module, and only a built
      // `dist` copy answers to the `.js` extension the arm covers.
      "smithers/flows/src/SandboxedFlow.ts": 1,
      // WebCrypto's digest refuses an unknown algorithm NAME, and the guest
      // names none outside `DigestAlgorithm`, so the rejection translation is
      // unreachable from the engine.
      "smithers/flows/src/internal/SandboxedFlowGuest.ts": 1,
      // Projection rows, selectors, cursors, and tags are decoded before the
      // internal frame and snapshot objects are assembled. Re-decoding those
      // same admitted fields cannot fail; the catches remain fail-closed if a
      // future assembly step adds an unvalidated member.
      // The fifth guard belongs to workspace refresh: only stale followed
      // runs enter its Set, admission sets their observed position, and no
      // source is removed until that Set is refreshed once per run. Cache
      // eviction removes verdicts only, never followed sources.
      // Finite encoded string lengths cannot overflow a safe integer.
      "smithers/gateway/src/Projections.ts": 6,
      // The event switch exhausts its discriminated union and assigns its
      // default to `never`; typed journal events cannot enter that fallback.
      "smithers/agent/src/AgentSession.ts": 1,
      // `fenced`'s `info` and `body` groups are mandatory (outside any
      // alternation or quantifier), so they participate in every match; the
      // fallbacks only discharge the optional type on
      // `RegExpMatchArray.groups`.
      "smithers/agent/harness/src/Cell.ts": 2,
      // The lexer's alternation binds exactly one of its two groups on every
      // match, so the fallback only discharges the optional type on a
      // capture.
      "smithers/agent/harness/src/CellTurn.ts": 1,
      // Five defend opening or per-frame limits filled by `withDefaults`
      // and `evaluationLimits`; the sixth handles a compile error whose
      // Error shape QuickJS guarantees. The bridge-drain directive is absent.
      "smithers/agent/harness/src/QuickJSSandbox.ts": 6,
      // One coalesce over `validate`'s closed two-member answer. The five
      // beside it belonged to the same-realm binding — its `with` scope proxy
      // and the host cell's failure path — and left with it when the filing
      // surface was deleted.
      "smithers/agent/harness/src/Sandbox.ts": 1,
      // The first pass already ran the decoder over every entry of the same
      // `events` array and returned on failure, and `decode` is pure, so
      // re-decoding a surviving entry cannot fail; the branch exists because
      // `Result` has no way to carry that proof. Its twin left with the
      // transcript-replacement branch a `continue` used to take.
      "smithers/agent/harness/src/Transcript.ts": 1,
      // Published journal values come from acyclic decoded JSON; synchronous
      // queue size/take cannot disagree while admission is open; and bytes
      // just emitted by the JSON encoder decode immediately. The three guards
      // keep those boundaries fail-closed if an implementation changes.
      "smithers/flows/journal/src/SqlJournal.ts": 3,
      // `FileSet.Entry` is a closed two-member union, so the final
      // comparison arm's `else` and the fallthrough after every pair
      // returned are both unreachable by construction.
      "smithers/flows/plan/src/FileSet.ts": 2,
      // The planned-value placeholder's proxy target is callable only so the
      // `apply` trap fires; the target body itself is unreachable by
      // construction because every application enters the trap.
      "smithers/flows/plan/src/Planned.ts": 1,
      // AttemptStore's insert conflict and row lookup share one serialized
      // write transaction, so the conflicting attempt cannot disappear.
      "smithers/flows/run-store/src/AttemptStore.ts": 1,
      // RunStore's two reflection hints left with the shared JSON admission
      // helper. Its remaining hint covers V8's synthetic generator branch;
      // RunStore.test.ts asserts successful, missing and stale-owner CAS
      // outcomes through the real SQLite adapter.
      "smithers/flows/run-store/src/RunStore.ts": 1,
      // Provider processes can only originate from each provider's `spawn`,
      // which records the opaque handle before returning it. These guards
      // turn a future provenance violation into a typed unknown-process error.
      "smithers/flows/sandbox/src/AwsSandbox/make.ts": 1,
      // Container and Kubernetes now share execSession's process registry.
      // The same spawn-before-kill provenance guarantee needs one hint here.
      "smithers/flows/sandbox/src/internal/execSession.ts": 1,
      // Session paths are absolute beneath an absolute root, so parent
      // creation is skipped only for the filesystem root. The second guard is
      // the same opaque-process provenance check as the remote providers.
      "smithers/flows/sandbox/src/DirectorySandbox/make.ts": 2,
      "smithers/flows/sandbox/src/JustBashSandbox/make.ts": 1,
      "smithers/flows/sandbox/src/MicrosandboxSandbox/make.ts": 1,
      // `spawn` is the only source of a `RemoteProcess`, and it records every
      // one it returns, so the scripted provider's kill lookup cannot miss.
      "smithers/flows/sandbox/src/RemoteChildProcessSpawner/TestRemote.ts": 1,
      // Every runtime this package supports carries Web Crypto, so the
      // `Math.random` fallback the conformance nonce keeps for a host without
      // it is unreachable from any supported host.
      "smithers/flows/sandbox/src/SandboxConformance/posixCommands.ts": 1,
      // Splitting any string yields a first field; the nullish arm only
      // discharges noUncheckedIndexedAccess before the type lookup.
      "smithers/flows/sandbox/src/Sandbox/fileSystem.ts": 1,
      // Bounded inert JSON is exactly `@smthrs/canonical`'s accepted domain,
      // so the encoder's refusal arm is unreachable from an admitted row.
      "smithers/flows/step-cache/src/internal/CacheAdmission.ts": 1,
      // Two conflict arms whose blocking row is read inside the same
      // serialized write transaction that saw the insert fail.
      "smithers/flows/step-cache/src/internal/SqlCacheStore.ts": 2,
      // One defensive normalization for a future `Duration` input that throws,
      // and one path guard that `KeyDigest` already satisfies by excluding
      // every path separator and dot segment.
      "smithers/flows/step-cache/src/RemoteCacheStore.ts": 2,
      // One refusal half in the fault tier's `parentPid`. Every supported
      // platform's `ps` either prints one parent pid or exits non-zero into
      // the catch beside it, so neither empty output nor an unparsable first
      // field can occur; the guard stays because a platform that produced one
      // would otherwise report a parent of 0, which reads as "reparented to
      // init" and is the exact claim the orphan cases assert.
      "testing/src/Faults.ts": 1,
      // The loader's ESM/CJS directory selector is exercised by packed
      // consumers in their own processes. Package-layout resolution and
      // staged-helper exit cleanup remain measured by the unit suite.
      "smithers/flows/platform-node/src/internal/AtomicFileSystemExecutable.ts": 1,
      // The fixture engine's three unreachable arms (`d1012596b6`): registered
      // execution bodies settle only after run or resume arms their
      // settlement, the registered execute function runs every subject flow so
      // the declarative body is never interpreted, and every path to
      // awaitResult arms a settlement after recording execution metadata.
      "testing/src/FlowEngineLike.ts": 3
    }
    const sourceFiles = (directory: string): Array<string> => {
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return []
      }
      return entries.flatMap((entry) =>
        entry.isDirectory()
          ? sourceFiles(join(directory, entry.name))
          : entry.name.endsWith(".ts")
          ? [join(directory, entry.name)]
          : []
      )
    }
    const found: Record<string, number> = {}
    for (const name of packages) {
      for (const path of sourceFiles(join(packagesDir, name, "src"))) {
        const source = readFileSync(path, "utf8")
        const file = relative(packagesDir, path)
        let count = 0
        for (const match of source.matchAll(directive)) {
          const form = match[1]
          // The `file` form drops the ENTIRE file out of the 100%
          // denominator, and start/stop ranges hide arbitrarily large
          // regions behind a single allowlist count — all three are
          // forbidden outright, never allowlisted (issue #157).
          assert.doesNotMatch(
            form!,
            /^(?:file|start|stop)$/,
            `${file} uses the forbidden "ignore ${form}" form: "${match[0]}"`
          )
          count += 1
        }
        if (count > 0) {
          found[file] = count
        }
      }
    }
    // The rule this cell exists to enforce, and the one the diff above is
    // usually reporting: a coverage-ignore hint and the entry that admits it
    // land in the SAME commit, with a comment paraphrasing why the branch is
    // unreachable. Re-derive a moved count from the file on disk rather than
    // from a review note, and read the directive before blessing it: a count
    // pinned against a working tree nobody has committed moves again the next
    // time that lane rebases.
    assert.deepEqual(
      found,
      allowlist,
      "a coverage-ignore hint and its entry here land in the same commit: read each directive, then pin its count"
    )
  })
})
