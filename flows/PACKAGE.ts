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
  srcs: [sources, scripts, Smithers.file("//apps/review/src/server/migrations.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})
const suite = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/content.test.ts"),
    Smithers.file("//flows/test/release-redaction.test.ts"),
    Smithers.file("//flows/test/release-io.test.ts"),
    Smithers.file("//flows/test/release-operations.test.ts"),
    Smithers.file("//flows/test/publication.test.ts"),
    Smithers.file("//flows/test/review-flow.test.ts"),
    Smithers.file("//flows/test/registration-calibration.test.ts"),
    Smithers.file("//flows/test/host-jev-routing.test.ts"),
    Smithers.file("//flows/test/workflows.test.ts"),
    Smithers.file("//flows/test/rollout.test.ts"),
    Smithers.file("//flows/test/worker-rollout.test.ts"),
    Smithers.file("//flows/test/notes.test.ts"),
    Smithers.file("//flows/test/telegram.test.ts")
  ]),
  srcs: [
    sources,
    Smithers.file("//flows/register-repository/calibration/corpus.json"),
    Smithers.file("//flows/register-repository/calibration/fit.json"),
    Smithers.file("//flows/test/fixtures/notes-calendar.ics"),
    Smithers.file("//flows/test/fixtures/notes-marketing.md"),
    Smithers.file("//flows/test/fixtures/telegram-getme.json"),
    Smithers.file("//flows/test/fixtures/telegram-updates.json"),
    scripts,
    Smithers.file("//flows/review/flow.mdx"),
    Smithers.file("//pnpm-workspace.yaml"),
    Smithers.file("//flows/rollout/refuse-unqualified.mjs"),
    Smithers.file("//apps/review/package.json"),
    Smithers.file("//apps/bug-worker/package.json"),
    Smithers.file("//apps/review/src/server/migrations.ts")
  ],
  deps: [],
  cwd
})

// Re-fetches pinned public repositories; keep network reproduction out of
// ordinary wildcard CI while retaining an explicit uncached gate (#3071, #2290).
const registrationCalibrationReal = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/registration-calibration-real.test.ts")]),
  srcs: [sources, Smithers.glob("//flows/register-repository/calibration/*.json")],
  deps: [],
  cwd,
  exclusive: true,
  cache: false,
  timeout: "15m"
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
const issueSweep = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//flows/issue-sweep/test/decide.test.ts"),
    Smithers.file("//flows/issue-sweep/test/accounts.test.ts"),
    Smithers.file("//flows/issue-sweep/test/claude.test.ts"),
    Smithers.file("//flows/issue-sweep/test/land.test.ts"),
    Smithers.file("//flows/issue-sweep/test/land-jj.test.ts"),
    Smithers.file("//flows/issue-sweep/test/work.test.ts"),
    Smithers.file("//flows/issue-sweep/test/vm.test.ts"),
    Smithers.file("//flows/issue-sweep/test/github.test.ts"),
    Smithers.file("//flows/issue-sweep/test/host.test.ts"),
    Smithers.file("//flows/issue-sweep/test/verdict.test.ts"),
    Smithers.file("//flows/issue-sweep/test/land-queue.test.ts")
  ]),
  srcs: [sources],
  deps: [],
  cwd
})
// Boots real microVMs; skips itself, naming why, without msb or the snapshot.
const issueSweepVm = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//flows/issue-sweep/test/vm.real.test.ts"),
    Smithers.file("//flows/issue-sweep/test/vm.shared.real.test.ts"),
    Smithers.file("//flows/issue-sweep/test/vm.claude.real.test.ts")
  ]),
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
const codingWiki = Smithers.Filegroup({ cwd: "flows/wiki", srcs: [Smithers.glob("**/*.ts")] })
const codingFiles = [
  sources,
  Smithers.glob("//flows/**/*.mjs"),
  Smithers.glob("//flows/coding/**/*.md"),
  Smithers.glob("//flows/create-flow/**/flow.mdx"),
  Smithers.file("//flows/issue/repro/flow.mdx"),
  Smithers.file("//flows/issue/poc/flow.mdx"),
  Smithers.file("//flows/pr-triage/flow.mdx"),
  Smithers.file("//flows/tsconfig.json")
]
const codingSources = [
  ...codingFiles,
  Smithers.pnpmWorkspace("//pnpm-workspace.yaml"),
  Smithers.file("//pnpm-lock.yaml")
]
const codingDependencies = [...codingBackend, codingScripts, codingWiki]
const codingHostInputs = Smithers.Filegroup({ srcs: [...codingFiles, ...codingDependencies] })
// The repository config test reads every wiki page's document and inputs too.
// Declare them so both runtime targets track changes outside their TS sources.
const codingProjectSources = [
  ".smithers/coding-project.json",
  ".smithers/factory.json",
  ...new Set(codingProject.pages.flatMap((page) => [page.document, ...page.inputs]))
].map((path) => Smithers.file(`//${path}`))
const codingProjectInputs = [
  ...codingProjectSources,
  Smithers.glob("//flows/checks/**/flow.mdx")
]
const node = Smithers.Runtime.Node({ version: ">=26.4.0" })
const bun = Smithers.Runtime.Bun({ version: ">=1.4.0" })

// Existing policy integration uses actual JJ and the Node SQLite fixture.
const coding = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/coding.test.ts"),
    Smithers.file("//flows/test/coding-state.test.ts"),
    Smithers.file("//flows/test/coding-learnings.test.ts"),
    // The local landers over a real colocated jj repository and a recording `gh`.
    Smithers.file("//flows/test/coding-local-landing.test.ts")
  ]),
  srcs: codingSources,
  deps: codingDependencies,
  cwd
})
const codingPolicy = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/coding-host.test.ts"),
    Smithers.file("//flows/test/coding-builtin-routes.test.ts"),
    Smithers.file("//flows/test/coding-runtime-bridge.test.ts"),
    Smithers.file("//flows/test/coding-gates.test.ts"),
    Smithers.file("//flows/test/coding-pool-default-model.test.ts"),
    Smithers.file("//flows/test/coding-planning-wiki-prior.test.ts")
  ]),
  // `coding-host.test.ts` and `coding-builtin-routes.test.ts` load the checked-in project configuration.
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
    Smithers.file("//flows/test/coding-project-memory.test.ts"),
    Smithers.file("//flows/test/coding-stack-base.test.ts"),
    Smithers.file("//flows/test/coding-project-config.test.ts"),
    Smithers.file("//flows/test/coding-steering.test.ts"),
    Smithers.file("//flows/test/coding-request-coordinator.test.ts"),
    Smithers.file("//flows/test/factory-todo.test.ts"),
    Smithers.file("//flows/test/coding-correction-stall.test.ts"),
    Smithers.file("//flows/test/coding-host-policy.test.ts"),
    Smithers.file("//flows/test/coding-host-modules.test.ts"),
    Smithers.file("//flows/test/coding-wiki-registry.test.ts"),
    Smithers.file("//flows/test/coding-create-flow-registry.test.ts"),
    Smithers.file("//flows/test/coding-pr-triage-host.test.ts"),
    Smithers.file("//flows/test/coding-jev-check.test.ts"),
    Smithers.file("//flows/test/coding-review-check.test.ts"),
    Smithers.file("//flows/test/coding-security-review-check.test.ts"),
    Smithers.file("//flows/test/coding-wiki-memory.test.ts"),
    Smithers.file("//flows/test/coding-catalog-refresh.test.ts"),
    Smithers.file("//flows/test/coding-vibe-evidence.test.ts"),
    Smithers.file("//flows/test/coding-vibe-admission.test.ts"),
    Smithers.file("//flows/test/coding-landing.test.ts"),
    Smithers.file("//flows/test/coding-landing-config.test.ts"),
    Smithers.file("//flows/test/coding-check-environment.test.ts"),
    Smithers.file("//flows/test/coding-vibe-landing.test.ts"),
    Smithers.file("//flows/test/coding-source-publication.test.ts"),
    Smithers.file("//flows/test/coding-dispatch.test.ts")
  ]),
  srcs: [...codingSources, ...codingProjectInputs],
  deps: codingDependencies,
  cwd,
  cache: true
})
// Agent memory: the dependency-doc import, calibration, the transcript miner
// and the wrapped-harness launch, each over `@smthrs/agent/Memory`.
const memory = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/memory-deps.test.ts"),
    Smithers.file("//flows/test/coding-wiki-import-docs.test.ts"),
    Smithers.file("//flows/test/memory-calibrate.test.ts"),
    Smithers.file("//flows/test/memory-mine.test.ts"),
    Smithers.file("//flows/test/wrapped.test.ts")
  ]),
  srcs: [
    ...codingSources,
    ...codingProjectInputs,
    Smithers.file("//flows/test/fixtures/memory-calibrate-e2e.jsonl")
  ],
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
// opt-in integration cases silently skip. Shell.Test caches a green verdict, so
// the JJ and exporter bytes the gate spawns are key material through `tools`.
const nativeTools = [
  Smithers.Host.bin("jj"),
  Smithers.Host.bin("smithers-jj-export", { env: "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" })
]
const codingNative = Smithers.Shell.Test({
  bin: Smithers.Runtime.bin,
  runtime: node,
  args: ["flows/test/coding-native-gate.mjs", "source"],
  tools: nativeTools,
  data: [...codingSources, ...codingDependencies],
  timeout: "45m"
})

// The target index runs this inventory before accepting a declaration set.
const testCoverage = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/target-coverage.test.ts")]),
  srcs: [sources, Smithers.file("//flows/PACKAGE.ts"), Smithers.file("//flows/test/coding-native-gate.mjs")],
  deps: [],
  cwd
})
const codingNativeBun = Smithers.Shell.Test({
  bin: Smithers.Runtime.bin,
  runtime: bun,
  args: ["flows/test/coding-native-gate.mjs", "source"],
  tools: nativeTools,
  data: [...codingSources, ...codingDependencies],
  timeout: "45m"
})
const codingBundle = Smithers.Shell.Test({
  bin: Smithers.Runtime.bin,
  runtime: node,
  args: ["flows/test/coding-native-gate.mjs", "bundle"],
  tools: nativeTools,
  data: [...codingSources, ...codingDependencies],
  timeout: "45m"
})
const codingBundleBun = Smithers.Shell.Test({
  bin: Smithers.Runtime.bin,
  runtime: bun,
  args: ["flows/test/coding-native-gate.mjs", "bundle"],
  tools: nativeTools,
  data: [...codingSources, ...codingDependencies],
  timeout: "45m"
})
const wiki = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/wiki.test.ts")]),
  srcs: [sources],
  deps: [],
  cwd
})

// Subscription judges share the native resolver and use the configured proxy.
// The fixtures serve a local account pool and refuse a proxy tunnel, so no
// live subscription or provider credential is needed.
const egress = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/repository-jev-egress.test.ts"),
    Smithers.file("//flows/test/subscription-judge.test.ts")
  ]),
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
  "approved-text",
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
  "intake-bounds",
  "jev-checks",
  "jev-duplicates",
  "jev-observation",
  "jev-reproduction",
  "jev-score",
  "native-error",
  "pause-integrity",
  "policy-identity",
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
    fixture("coding-fault.test.ts"),
    fixture("run-record.test.ts"),
    fixture("canary-coding-setup.test.mjs"),
    fixture("invoke-native-host.test.ts"),
    fixture("decide-with-jev-docs.test.ts"),
    fixture("register-repository.test.ts")
  ]),
  // `decide-with-jev-docs` reads the guide.
  srcs: [
    ...codingSources,
    Smithers.file("//docs/api/failure-codes.json"),
    Smithers.file("//packages/smithers/agent/model/docs/guides/decide-with-jev.md")
  ],
  deps: codingDependencies,
  cwd,
  timeout: "20m"
})

// Security review over the files this package owns. `wiki/` is a nested
// package with its own review; suites, fixtures and installs are excluded.
const securityReview = Smithers.SecurityReview({
  cwd,
  include: [
    Smithers.glob("**/*.{ts,mjs,js,mdx}", {
      exclude: ["wiki/**", "test/**", "node_modules/**", "migrate-smithers-v1/test/**", "**/*.test.ts", "pack.test.mjs"]
    })
  ],
  checks: [
    {
      id: "repository-credential-containment",
      title: "The reserved repository token and gateway credential never reach tools, models, logs or child processes",
      threat:
        "A prompt-injected agent or approved shell tool reads SMITHERS_JJHUB_TOKEN or the gateway credential and acts as the workspace on its repository.",
      lookFor: [
        "SMITHERS_JJHUB_TOKEN read from process.env anywhere other than coding/landing-config.ts, or read before it is deleted there.",
        "A spawned process or check environment built from process.env instead of the PATH/HOME/proxy allowlist in coding/check-environment.ts.",
        "SMITHERS_CACHE_TOKEN or SMITHERS_CACHE_URL left in process.env after coding/check-environment.ts consumes them, or given to anything but repository checks (repositoryCheckEnvironment).",
        "A token or credential passed to a model prompt, a run output, a receipt, an error message, or Redacted.value outside the HTTP bearer header.",
        "invoke/serve.ts rpc or serve paths that print or journal the credential file contents."
      ],
      paths: [
        "coding/serve.ts",
        "coding/check-environment.ts",
        "coding/landing-config.ts",
        "coding/landing.ts",
        "coding/host.ts",
        "invoke/**",
        "repository/remote.ts",
        "repository/check-receipt.ts",
        "register-repository/host.ts"
      ]
    },
    {
      id: "remote-url-construction",
      title: "Repository API URLs are built only from validated, encoded identifiers",
      threat:
        "A repository event, PR body or server response steers a credentialed request to another repository, gateway or host.",
      lookFor: [
        "A path segment interpolated into a URL without encodeURIComponent or a pattern check (job keys like flow:<slug>, change ids from a landing response, fullName from repository-source).",
        "The github(path) proxy accepting a path that githubReadable does not fully anchor, or fullName taken from event text instead of repository-source metadata.",
        "apiBaseUrl accepted over plain http: outside a loopback test host while carrying a bearer token.",
        "A PR link parsed from comment text used to pick the repository whose source is retained or reviewed."
      ],
      paths: ["repository/remote.ts", "repository/check-receipt.ts", "coding/landing.ts", "register-repository/**"]
    },
    {
      id: "source-tree-confinement",
      title: "Every read, write and process cwd stays inside its captured source tree",
      threat:
        "A model-authored reproduction fixture, prompt-named path or repository symlink reads or overwrites host files outside the isolated checkout.",
      lookFor: [
        "A path from a model, event or repository joined to a root without normalizePath plus realPath containment (admitSourcePath, contained, inside).",
        "A check done on the path string but the write or read done through a symlinked ancestor created after the check (TOCTOU).",
        "Reproduction fixtures written without flag wx or able to overwrite existing source; repro.cwd resolved outside root.",
        "Reads of .smithers/repository-jobs or other host-private paths through a symlink that repositorySourceReader does not re-check.",
        "release-support atomicWrite/inside accepting an absolute, backslash or .. path."
      ],
      paths: [
        "repository/source.ts",
        "repository/execution.ts",
        "repository/inspection.ts",
        "repository/checks.ts",
        "repository/check-context.ts",
        "coding/filesystem.ts",
        "coding/immutable-source.ts",
        "coding/snapshots.ts",
        "release-support/io.ts",
        "register-repository/tree.ts"
      ]
    },
    {
      id: "process-exec-argv",
      title: "Spawned commands use fixed programs and argv arrays, never shell strings built from untrusted text",
      threat:
        "An issue author or model output runs arbitrary commands on the coding or release host with its credentials.",
      lookFor: [
        "ChildProcess.make or spawn with a shell (sh -c, shell: true) whose string includes event, model or repository text.",
        "jj revsets or templates built by interpolating a commit id or ref that is not pattern-checked to hex first.",
        "A model-authored argv (repro.argv, check commands) run without a timeout, output bound, or the isolated source cwd.",
        "A flow.mdx/flow.ts capability grant `proc:spawn:<cmd> *` broader than the commands the body runs."
      ],
      paths: ["repository/**", "coding/**", "release-support/**", "register-repository/**", "**/flow.mdx", "**/flow.ts"]
    },
    {
      id: "check-command-provenance",
      title:
        "Shell check commands come only from the pinned, reviewed repository CI policy and run without credentials",
      threat:
        "A change author or issue author gets arbitrary shell text run by /bin/sh -c on the coding host, or reads host credentials from inside a check.",
      lookFor: [
        "executeCommand's check.rule reaching /bin/sh -eu -c from the candidate tree, event payload, model output or an unpinned policy instead of readCiPolicy's pinned registration.",
        "composeCiChecks or rawCheckId letting a local check reuse the inherited CI namespace, or a policy revision/digest change not refused by assertCiPolicyCurrent before execution.",
        "checkEnvironment or ImmutableSourceOptions.environment carrying SMITHERS_JJHUB_TOKEN, a gateway credential or process.env instead of an explicit allowlist (runSourceProcess uses extendEnv: false).",
        "A command check run with no deadline, or outside the scoped immutable export root."
      ],
      paths: [
        "repository/checks.ts",
        "repository/ci-policy.ts",
        "repository/changes.ts",
        "coding/immutable-source.ts",
        "coding/host.ts",
        "coding/serve.ts"
      ]
    },
    {
      id: "untrusted-event-prompt-injection",
      title: "Issue, PR and comment text is treated as data and cannot authorize actions",
      threat:
        "An outside GitHub user writes an issue or comment that makes an agent land code, publish a reply, approve a step or exfiltrate repository content.",
      lookFor: [
        "Event author text concatenated into a prompt without the untrusted-content framing in repository/intake.ts.",
        "A publish, land, approve or pause decision keyed on text the event author controls rather than a verified role or approved digest (approved-text.ts, reply-trust).",
        "A steering or correction message accepted from someone other than the run owner.",
        "Withheld or hidden fields from the intake screen still reaching a later model step."
      ],
      paths: [
        "repository/intake.ts",
        "repository/replies.ts",
        "repository/approved-text.ts",
        "repository/triggers.ts",
        "repository/delivery.ts",
        "repository/jev-*.ts",
        "coding/steering.ts",
        "coding/correction.ts",
        "coding/feedback.ts",
        "issue-triage/**",
        "pr-triage/**",
        "review/**"
      ]
    },
    {
      id: "pinned-invocation-integrity",
      title: "An invocation runs only the approved flow bytes under its own tag",
      threat:
        "A repository author swaps the body of an approved flow via a sibling module or node_modules alias and runs it with the invocation credential.",
      lookFor: [
        "invoke/host.ts digest covering only flow.ts while relative imports run live.",
        "registerPinnedLibraries replacing or trusting an existing repository node_modules entry.",
        "A flow name with ./.. or backslash segments accepted by options.flow.",
        "A descriptor registered whose declaredTag differs from its path-derived name."
      ],
      paths: [
        "invoke/**",
        "coding/host-modules.ts",
        "coding/host-modules-build.mjs",
        "coding/build.mjs",
        "repository/registry.ts"
      ]
    },
    {
      id: "landing-authority",
      title: "Landing and publication write only the approved change to the bound repository",
      threat:
        "A coding run pushes unreviewed commits, rewrites main, or publishes to a repository or ref it was not bound to.",
      lookFor: [
        "A push or land call whose target ref, repository id or commit is not the one recorded in the approved plan or receipt.",
        "Force pushes, deletes or ref updates outside refs/smithers/workspaces/<workspaceId>/.",
        "A landing that proceeds when checks or the completion receipt are missing or failed.",
        "vibe-cleanup deleting refs or files it did not create."
      ],
      paths: [
        "coding/landing.ts",
        "coding/vibe-*.ts",
        "coding/source-*.ts",
        "repository/delivery.ts",
        "repository/changes.ts",
        "repository/retention.ts"
      ]
    },
    {
      id: "release-secret-redaction",
      title: "Release and publishing steps never leak registry or social credentials",
      threat:
        "A release failure prints NPM or X tokens into logs, run outputs or public release notes that anyone can read.",
      lookFor: [
        "Diagnostics that redact only env keys matching token|secret|password|api.?key, missing names like *_AUTH, *_PAT or CREDENTIAL.",
        "Output truncated before redaction so a partial secret survives the split/join.",
        "Release notes or tweets built from model output without review before publishing.",
        "npm publish, tag push or X post reachable without the release approval step."
      ],
      paths: ["release/**", "release-support/**", "release-content/**", "release-notes/**", "rollout/**"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    codingHostInputs,
    coding,
    codingPolicy,
    codingRuntime,
    memory,
    codingConfigBun,
    codingNative,
    testCoverage,
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
    registrationCalibrationReal,
    recording,
    issueSweep,
    issueSweepVm,
    provider,
    wiki,
    ...securityReview
  }
})
