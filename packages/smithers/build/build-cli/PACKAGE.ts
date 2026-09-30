/** Standard package targets for the published build CLI. */
import { Smithers } from "@smthrs/targets"
import { rootInvariantsConfig, rootJSDocConfig } from "../../../../PACKAGE.ts"

const cwd = "packages/smithers/build/build-cli"
const sources = Smithers.glob("src/**/*.ts")
const javascript = Smithers.glob("src/**/*.js")
const tests = Smithers.glob("test/**/*.test.ts")

/**
 * The workspace trees the suites load: PACKAGE.ts and WORKSPACE.ts fixtures,
 * their goldens, and the checked-in files the render suites compare against.
 *
 * They are behavioural input to `PackageExecution`, `MultiRepo`, and the
 * CI-render suites, so they belong in the test target's key. Without them,
 * editing a fixture left the key unchanged and the run reported a cache hit
 * on a result that predated the edit.
 */
const fixtures = Smithers.glob("test/fixtures/**/*")
const routedFixture = Smithers.file("test/fixtures/force-spec/.github/PACKAGE.ts")

/** `Docs.test.ts` reads the package documentation, so it is key material. */
const prose = Smithers.glob("docs/**/*.md")
const readme = Smithers.file("README.md")

/**
 * The W4 package-API sweep harness. `SweepHarness.test.ts` imports its
 * classifiers and reads its expectations fixture, so the module is key
 * material for the suite.
 */
const sweep = Smithers.glob("scripts/package-api-sweep.*")

const lib = Smithers.TsBuild({
  srcs: [sources, javascript],
  entries: [Smithers.file("src/index.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "program", entry: Smithers.file("scripts/build.mjs") },
  format: "dual",
  outDir: "dist",
  cwd
})

const check = Smithers.Typecheck({
  srcs: [sources, javascript, Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const test = Smithers.Vitest({
  tests: [tests],
  sources: [sources, javascript, fixtures, routedFixture, prose, readme, sweep],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  // The serial suite reached 93 completed files before the default 20 minute
  // target bound on the release runner. On a loaded 16-core macOS host
  // (2026-09-30, #2593) it took 1304 s without coverage and 2063 s with this
  // configuration's coverage, so 30 minutes could not finish; an hour keeps
  // the run finite with 1.7x headroom.
  timeoutMs: 3_600_000,
  cwd
})

const lint = Smithers.EsLint({
  sources: [sources, javascript],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig, rootInvariantsConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

const fmt = Smithers.Dprint({
  sources: [sources, javascript, Smithers.glob("test/**/*.ts")],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd
})

const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})

/**
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), matching the filegroup BuildAndCheckTypeScriptPackage emits. The docs-site
 * content sync in `apps/docs/build-cli/PACKAGE.ts` depends on it by label,
 * the one way an input reaches across a package boundary.
 */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/**
 * The package's circular-dependency guard, run under the declared runtime.
 *
 * @since 0.1.0
 * @category test
 */
const circular = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("scripts/circular.mjs")),
  srcs: [sources, javascript],
  deps: [],
  cwd
})

/**
 * The package's security review: `security` reviews changes against
 * origin/main, and the manual `securityAudit` reviews every source file.
 * PACKAGE.ts and WORKSPACE.ts are trusted code evaluated in process
 * (`PackageLoader.ts`), so no check treats a declaration author as the
 * attacker. The boundaries are the sandboxed actions, child repositories,
 * cache entries, downloads, file names and refs, agent runs, and the
 * rendered hooks and workflows.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "child-process-argv",
      title: "Spawned tools never reach a shell or take a declared value as an option",
      threat:
        "Whoever controls a file name, git ref, --base value, or child-repository label changes what git or a tool does on a maintainer's machine or CI runner, for example through --output or --upload-pack.",
      lookFor: [
        "A spawn, execFile, or ScopedProcess call with shell: true or a single command string built from labels, file names, or refs.",
        "A git, go, docker, or nix argv where a file name, path, or ref can begin with '-' and is not behind '--' or '--end-of-options'.",
        "A Repo.Target label or args forwarded to the child CLI without the label grammar check."
      ],
      paths: [
        "src/RepoResolution.ts",
        "src/AgentSession.ts",
        "src/GoExec.ts",
        "src/DockerExec.ts",
        "src/NixExec.ts",
        "src/GitCommit.ts",
        "src/StampExec.ts",
        "src/PackageTree.ts",
        "src/GitSubmoduleExec.ts",
        "src/Owners.ts",
        "src/internal/PackagePlanner.ts",
        "src/internal/ContainedProcess.ts"
      ]
    },
    {
      id: "child-env-credentials",
      title: "Cache and declared credentials are withheld from every child process",
      threat:
        "A tool, agent CLI, service, or child repository run by the build reads SMITHERS_CACHE_TOKEN or a declared secret and exfiltrates it or poisons the shared cache.",
      lookFor: [
        "A child env built from { ...process.env } that does not delete SMITHERS_CACHE_URL, SMITHERS_CACHE_TOKEN, and the workspace's declared credential names.",
        "A git child that keeps GIT_* or reads global config, or any child that keeps NODE_OPTIONS or NODE_PATH.",
        "A service environment that copies host variables beyond the inherited allowlist, or receives a real secret value instead of a proxy placeholder."
      ],
      paths: [
        "src/AgentSession.ts",
        "src/RepoResolution.ts",
        "src/ServiceSupervisor.ts",
        "src/Workspace.ts",
        "src/Cli.ts"
      ]
    },
    {
      id: "remote-cache-trust",
      title: "Remote cache entries are authenticated, bound to their key, and never hide a credential",
      threat:
        "A network attacker, an untrusted CI job, or a hostile cache server serves another action's result to a trusted build, or learns the cache token.",
      lookFor: [
        "A remote GET or PUT that follows redirects, accepts plain HTTP off loopback, or puts credentials in the URL.",
        "A fetched entry used without checking keyDigest equals the requested key and without decoding through the result schema.",
        "A publication from a SMITHERS_CACHE_NAMESPACE job written under the bare trusted key.",
        "A warning, error, or degrade message that prints the read or write token unredacted.",
        "A local cache key or entry path that can contain '/' or '..' and escape the cache directory."
      ],
      paths: ["src/Cache.ts", "src/CacheAdmin.ts"]
    },
    {
      id: "fetch-integrity",
      title: "A Fetch output exists only after its sha256 matches the declaration",
      threat:
        "A compromised mirror or on-path attacker substitutes a downloaded file that a later build step executes or ships.",
      lookFor: [
        "A download renamed onto its output path before the digest comparison, or left behind after a mismatch.",
        "An out path that is absolute, contains '..', or resolves outside the package's output directory.",
        "A response body read without the byte limit or deadline, or a URL with credentials printed without redactUrl."
      ],
      paths: [
        "src/FetchExec.ts",
        "src/internal/rules/FetchExecutor.ts",
        "src/internal/rules/FetchPlan.ts",
        "src/internal/rules/FetchRule.ts"
      ]
    },
    {
      id: "generated-scripts-injection",
      title: "Generated git hooks and GitHub workflows cannot execute declared text",
      threat:
        "A pull-request author runs code with the repository's CI secrets, or on a maintainer's machine at commit time, through a rendered hook or workflow.",
      lookFor: [
        "A label, input name, env name, or event name interpolated into a hook script or run: line without the labelPattern, environmentName, or eventName check.",
        "A ${{ }} expression, including a secrets or inputs reference, placed inside a run: script instead of an env: binding.",
        "A github.event field a pull-request author controls (head_ref, title, body, branch name) interpolated into a run: line.",
        "A pull_request_target workflow that checks out and runs the pull request head.",
        "Hooks installed through a core.hooksPath that resolves outside the repository."
      ],
      paths: ["src/GitHooks.ts", "src/GithubRender.ts"]
    },
    {
      id: "workspace-path-confinement",
      title: "CLI reads and writes stay inside the workspace",
      threat:
        "A committed symlink, a create-app name typed by a user, or a known-red or overlay file path makes the CLI read a maintainer's private files or overwrite files outside the workspace.",
      lookFor: [
        "A declared path, overlay target, or output joined to the root without rejecting '..', absolute paths, and symlinks that resolve outside.",
        "A create-app directory name or template entry name that escapes the target directory, or a scaffold that overwrites existing files.",
        "A symlink inside the workspace followed by a read or write that then lands outside the root.",
        "A Workspace repos path or cache directory that resolves outside the workspace root and is still used."
      ],
      paths: [
        "src/CreateApp.ts",
        "src/OverlayExec.ts",
        "src/PackageDiscovery.ts",
        "src/KnownRed.ts",
        "src/RepoResolution.ts",
        "src/internal/Path.ts",
        "src/internal/Fs.ts"
      ]
    },
    {
      id: "agent-session-confinement",
      title: "Agent and model runs stay inside their declared write set and treat files as data",
      threat:
        "A contributor plants instructions in a reviewed file so an agent run edits files outside its write set, reads secrets, or suppresses a failure.",
      lookFor: [
        "A prompt that embeds file or diff bodies without marking them as untrusted data.",
        "Files changed by an agent run that are not compared against the declared write set after the run.",
        "Agent output parsed loosely enough that a planted string changes a verdict, a path, or a command.",
        "An MCP or server URL probed with fetch that a declaration can point at an internal host."
      ],
      paths: ["src/AgentSession.ts", "src/AgentFake.ts", "src/internal/PackageRunner.ts"]
    },
    {
      id: "service-secret-proxy",
      title: "Service secrets reach only their declared audiences",
      threat:
        "A service started by a test target sends a real credential to a host its declaration did not name, or another local process reads it.",
      lookFor: [
        "A placeholder substituted into a request whose host is not in the secret's audiences.",
        "A secret proxy or service port bound to a non-loopback address.",
        "A real secret value written into a service's env, argv, log, or the service spec digest."
      ],
      paths: ["src/ServiceSupervisor.ts"]
    },
    {
      id: "cache-restore-confinement",
      title: "A restored cache entry writes only inside its target's declared outputs",
      threat:
        "Whoever can write a remote or local cache entry plants files outside the output directory, such as a git hook or shell profile, on every machine that restores it.",
      lookFor: [
        "A manifest outDir or entry path materialized without decodeManifest's confinement and without binding outDir to a declared output root.",
        "A manifest symlink entry materialized before a later file entry is written through it.",
        "A restored file marked executable or overwriting a tracked source file the target did not declare as output."
      ],
      paths: ["src/PackageTree.ts", "src/internal/PackageRunner.ts", "src/Cache.ts"]
    },
    {
      id: "sandbox-grant-confinement",
      title: "An action's sandbox grants only its declared reads, writes, and network",
      threat:
        "A test, tool, or bundler body run by the build reads a maintainer's private files, writes undeclared workspace files, or reaches the network because the planner granted more than the target declared.",
      lookFor: [
        "An externalReads entry derived from repository data, such as an absolute or file:// .gitmodules url, that admits an arbitrary host directory.",
        "An executable identity whose dirname admits a broad directory such as the home directory or '/'.",
        "A write-set pattern whose static prefix is empty or '.', which makes the whole workspace writable.",
        "A sandbox policy of 'none' or network: true chosen by default instead of by the declaration."
      ],
      paths: [
        "src/GitSubmoduleExec.ts",
        "src/internal/PackagePlanner.ts",
        "src/internal/PackageRunner.ts",
        "src/internal/RulePolicy.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
