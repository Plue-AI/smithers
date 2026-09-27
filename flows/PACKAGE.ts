/** Repository flows, release workflows, and the retained migration fixtures. */
import { Smithers } from "@smthrs/targets"
import codingProject from "../.smithers/coding-project.json" with { type: "json" }

const pack = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/pack.test.mjs")]),
  srcs: [
    Smithers.glob("//flows/**/flow.mdx"),
    Smithers.glob("//flows/**/flow.ts"),
    Smithers.file("//.smithers/factory.json"),
    Smithers.file("//.smithers/home.json")
  ],
  deps: []
})

const cwd = "flows"
const sources = Smithers.glob("//flows/**/*.ts")
const scripts = Smithers.glob("//scripts/*.mjs")

const check = Smithers.Typecheck({
  srcs: [sources, scripts],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})
const suite = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/content.test.ts"),
    Smithers.file("//flows/test/publication.test.ts"),
    Smithers.file("//flows/test/workflows.test.ts")
  ]),
  srcs: [sources, scripts, Smithers.file("//pnpm-workspace.yaml")],
  deps: [],
  cwd
})

// Lints flow sources; suites and fixtures are formatted, not linted.
const lint = Smithers.EsLint({
  sources: [Smithers.glob("**/*.ts")],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.invariants.js")],
  deps: [],
  maxWarnings: 0,
  fix: false,
  cwd
})
const fmt = Smithers.Dprint({
  sources: [Smithers.glob("**/*.{ts,tsx,js,jsx,mjs,json,md}")],
  config: Smithers.file("dprint.json"),
  deps: [],
  fix: false,
  cwd
})

const recording = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/recording.test.ts")]),
  srcs: [sources],
  deps: [],
  cwd
})
const provider = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/provider-runtime.test.ts")]),
  srcs: [sources],
  deps: [],
  cwd
})

// Source-only dependencies keep the backend graph reactive without building
// every backend package before an uncached coding test. The inventory is checked
// against pnpm workspace membership; each glob retains its owning package boundary.
const codingPackages = [
  // Eighteen repository fixtures import `packages/rpc/src` by relative path.
  // Without the member here those targets cache across an rpc edit.
  "packages/rpc",
  "packages/smithers",
  "packages/smithers/agent",
  "packages/smithers/agent/chain",
  "packages/smithers/agent/evals",
  "packages/smithers/agent/fs",
  "packages/smithers/agent/harness",
  "packages/smithers/agent/harness-detect",
  "packages/smithers/agent/integrations",
  "packages/smithers/agent/memory",
  "packages/smithers/agent/model",
  "packages/smithers/agent/model-host",
  "packages/smithers/agent/plugin",
  "packages/smithers/agent/registry",
  "packages/smithers/agent/scorers",
  "packages/smithers/agent/std",
  "packages/smithers/agent/triggers",
  "packages/smithers/build",
  "packages/smithers/build/build-cli",
  "packages/smithers/build/infra",
  "packages/smithers/build/targets",
  "packages/smithers/control",
  "packages/smithers/create-app",
  "packages/smithers/flows",
  "packages/smithers/flows/artifacts",
  "packages/smithers/flows/canonical",
  "packages/smithers/flows/capability",
  "packages/smithers/flows/core",
  "packages/smithers/flows/crypto",
  "packages/smithers/flows/database",
  "packages/smithers/flows/engine",
  "packages/smithers/flows/engine-store",
  "packages/smithers/flows/flow",
  "packages/smithers/flows/jj",
  "packages/smithers/flows/journal",
  "packages/smithers/flows/kernel",
  "packages/smithers/flows/keys",
  "packages/smithers/flows/observability",
  "packages/smithers/flows/patterns",
  "packages/smithers/flows/plan",
  "packages/smithers/flows/plan-store",
  "packages/smithers/flows/platform-browser",
  "packages/smithers/flows/platform-bun",
  "packages/smithers/flows/platform-node",
  "packages/smithers/flows/run-store",
  "packages/smithers/flows/sandbox",
  "packages/smithers/flows/step-cache",
  "packages/smithers/flows/sync",
  "packages/smithers/flows/time-travel",
  "packages/smithers/gateway",
  "packages/smithers/mcp",
  "packages/smithers/migrate",
  "packages/smithers/notifications",
  "packages/smithers/ui",
  "packages/smithers/ui/ui-styleguide"
] as const
const codingBackend = codingPackages.map((cwd) =>
  Smithers.Filegroup({
    cwd,
    srcs: [Smithers.glob("src/**"), Smithers.file("package.json"), Smithers.file("tsconfig.json")]
  })
)
const codingScripts = Smithers.Filegroup({ cwd: "scripts", srcs: [Smithers.glob("*.mjs")] })
const codingSources = [
  sources,
  Smithers.glob("//flows/**/*.mjs"),
  Smithers.glob("//flows/coding/**/*.md"),
  Smithers.pnpmWorkspace("//pnpm-workspace.yaml"),
  Smithers.file("//pnpm-lock.yaml"),
  Smithers.file("//flows/tsconfig.json")
]
const codingDependencies = [...codingBackend, codingScripts]
// The repository config test reads every wiki page's document and inputs too.
// Declare them so both runtime targets track changes outside their TS sources.
const codingProjectSources = [
  ".smithers/coding-project.json",
  ".smithers/factory.json",
  ...new Set(codingProject.pages.flatMap((page) => [page.document, ...page.inputs]))
].map((path) => Smithers.file(`//${path}`))
const codingProjectInputs = [
  ...codingProjectSources,
  Smithers.glob("//flows/checks/**/flow.mdx"),
  // The built-in authoring bodies the host installs on every workspace.
  Smithers.glob("//flows/create-flow/**/flow.mdx")
]
const node = Smithers.Runtime.Node({ version: ">=26.4.0" })
const bun = Smithers.Runtime.Bun({ version: ">=1.4.0" })

// Existing policy integration uses actual JJ and the Node SQLite fixture.
const coding = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/coding.test.ts"),
    Smithers.file("//flows/test/coding-state.test.ts")
  ]),
  srcs: codingSources,
  deps: codingDependencies,
  cwd
})
const codingPolicy = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/coding-host.test.ts"),
    Smithers.file("//flows/test/coding-runtime-bridge.test.ts"),
    Smithers.file("//flows/test/coding-gates.test.ts"),
    Smithers.file("//flows/test/coding-planning-wiki-prior.test.ts")
  ]),
  // `coding-host.test.ts` loads the checked-in project configuration.
  srcs: [...codingSources, ...codingProjectInputs],
  deps: codingDependencies,
  cwd,
  cache: true
})
const codingRuntime = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/coding-planning-authority.test.ts"),
    Smithers.file("//flows/test/coding-planning-sources.test.ts"),
    Smithers.file("//flows/test/coding-planning-placement.test.ts"),
    Smithers.file("//flows/test/coding-stack-base.test.ts"),
    Smithers.file("//flows/test/coding-project-config.test.ts"),
    Smithers.file("//flows/test/coding-steering.test.ts"),
    Smithers.file("//flows/test/coding-request-coordinator.test.ts"),
    Smithers.file("//flows/test/coding-correction-stall.test.ts"),
    Smithers.file("//flows/test/coding-host-policy.test.ts"),
    Smithers.file("//flows/test/coding-host-modules.test.ts"),
    Smithers.file("//flows/test/coding-wiki-registry.test.ts"),
    Smithers.file("//flows/test/coding-create-flow-registry.test.ts"),
    Smithers.file("//flows/test/coding-jev-check.test.ts"),
    Smithers.file("//flows/test/coding-wiki-memory.test.ts"),
    Smithers.file("//flows/test/coding-catalog-refresh.test.ts"),
    Smithers.file("//flows/test/coding-vibe-evidence.test.ts"),
    Smithers.file("//flows/test/coding-vibe-admission.test.ts"),
    Smithers.file("//flows/test/coding-landing.test.ts"),
    Smithers.file("//flows/test/coding-landing-config.test.ts"),
    Smithers.file("//flows/test/coding-vibe-landing.test.ts"),
    Smithers.file("//flows/test/coding-source-publication.test.ts"),
    Smithers.file("//flows/test/coding-dispatch.test.ts")
  ]),
  srcs: [...codingSources, ...codingProjectInputs],
  deps: codingDependencies,
  cwd,
  cache: true
})
const codingConfigBun = Smithers.NodeTest({
  runtime: bun,
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/coding-project-config.test.ts"),
    Smithers.file("//flows/test/coding-host-policy.test.ts"),
    Smithers.file("//flows/test/coding-host-modules.test.ts"),
    Smithers.file("//flows/test/coding-wiki-registry.test.ts"),
    Smithers.file("//flows/test/coding-vibe-evidence.test.ts"),
    Smithers.file("//flows/test/coding-vibe-admission.test.ts"),
    Smithers.file("//flows/test/coding-landing.test.ts"),
    Smithers.file("//flows/test/coding-landing-config.test.ts"),
    Smithers.file("//flows/test/coding-vibe-landing.test.ts"),
    Smithers.file("//flows/test/coding-source-publication.test.ts")
  ]),
  srcs: [...codingSources, ...codingProjectInputs],
  deps: codingDependencies,
  cwd
})

// Explicit slow gates: preflight refuses missing native tools instead of letting
// opt-in integration cases silently skip. Shell.Test caches a green verdict; the
// JJ and helper bytes it spawns are bound by the coding check cache partition.
const codingNative = Smithers.Shell.Test({
  bin: Smithers.Runtime.bin,
  runtime: node,
  args: ["flows/test/coding-native-gate.mjs", "source"],
  data: [...codingSources, ...codingDependencies],
  timeout: "45m"
})
const codingNativeBun = Smithers.Shell.Test({
  bin: Smithers.Runtime.bin,
  runtime: bun,
  args: ["flows/test/coding-native-gate.mjs", "source"],
  data: [...codingSources, ...codingDependencies],
  timeout: "45m"
})
const codingBundle = Smithers.Shell.Test({
  bin: Smithers.Runtime.bin,
  runtime: node,
  args: ["flows/test/coding-native-gate.mjs", "bundle"],
  data: [...codingSources, ...codingDependencies],
  timeout: "45m"
})
const codingBundleBun = Smithers.Shell.Test({
  bin: Smithers.Runtime.bin,
  runtime: bun,
  args: ["flows/test/coding-native-gate.mjs", "bundle"],
  data: [...codingSources, ...codingDependencies],
  timeout: "45m"
})
const wiki = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/wiki.test.ts")]),
  srcs: [sources],
  deps: [],
  cwd
})

// The judge the coding host installs reaches the gateway through the proxy its
// environment names. The host judges inside a default-deny microsandbox whose
// only way out is that proxy, so a direct dial is dropped and every completion
// comes back unjudged; the case asserts the proxy was asked to open the tunnel,
// never merely that the call failed.
//
// On the pass path nothing leaves the loopback interface: the judge asks the
// test's own proxy for a tunnel and the proxy refuses it. A regression is what
// dials `ai-gateway.vercel.sh` for real, which is the behaviour being banned,
// so the target is not hermetic on the failure path and must not be declared as
// if it were.
const egress = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([Smithers.file("//flows/test/repository-jev-egress.test.ts")]),
  srcs: codingSources,
  deps: codingDependencies,
  cwd
})

// The repository flows' offline fixtures, on `egress`'s key material. Before
// this target `egress` was the only one of its family declared anywhere, so the
// rest ran under bare `pnpm test`, which no workflow invokes.
//
// Legacy Plue adapter fixtures were removed with the Python adapter.
const fixture = (name: string) => Smithers.file(`//flows/test/${name}`)
const repositoryFixtures = [
  "apply-proof",
  "budget",
  "check-context",
  "check-receipt",
  "checks",
  "chore-events",
  "ci-policy",
  "consolidated-reply",
  "evaluation",
  "feature-issue-mode",
  "heldout",
  "inspection-sources",
  "intake-screen",
  "jev-checks",
  "jev-duplicates",
  "jev-observation",
  "jev-reproduction",
  "jev-score",
  "native-error",
  "pause-integrity",
  "proposal-review",
  "push",
  "remote-source",
  "reply-trust",
  "retention",
  "review-eval",
  "selection",
  "setup-policy",
  "setup-suggestion",
  "sources",
  "stored-registration",
  "trial-checks",
  "trial-registration",
  "trigger-resume"
] as const
const repository = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner(
    repositoryFixtures.map((name) => fixture(`repository-${name}.test.ts`)) as [
      Smithers.Input.File,
      ...Array<Smithers.Input.File>
    ]
  ),
  srcs: codingSources,
  deps: codingDependencies,
  cwd,
  timeout: "20m"
})

// The wiki, release-content and canary fixtures, also in no target until now.
// Grouped by the inputs they read, as `suite` and `codingRuntime` are: each
// reaches a backend package, so none fits `suite` or `wiki`, which declare no
// dependency. `wiki-reuse` replays a whole reuse pass, two minutes on a loaded
// machine, so the group carries an explicit deadline.
const fixtures = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([
    fixture("wiki-reuse.test.ts"),
    fixture("wiki-jev-citations.test.ts"),
    fixture("content-jev-template.test.ts"),
    fixture("run-record.test.ts"),
    fixture("canary-coding-setup.test.mjs"),
    fixture("invoke-native-host.test.ts"),
    fixture("decide-with-jev-docs.test.ts"),
    fixture("register-repository.test.ts")
  ]),
  // `decide-with-jev-docs` reads the guide.
  srcs: [...codingSources, Smithers.file("//packages/smithers/agent/model/docs/guides/decide-with-jev.md")],
  deps: codingDependencies,
  cwd,
  timeout: "20m"
})

export const Package = Smithers.Package({
  targets: {
    coding,
    codingPolicy,
    codingRuntime,
    codingConfigBun,
    codingNative,
    codingNativeBun,
    codingBundle,
    codingBundleBun,
    egress,
    fixtures,
    pack,
    check,
    lint,
    fmt,
    repository,
    suite,
    recording,
    provider,
    wiki
  }
})
