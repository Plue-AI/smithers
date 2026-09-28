/** Standard package targets for the published target authoring surface. */
import { Smithers } from "@smthrs/targets"
import { docsWriter, referenceStyle, rootInvariantsConfig, rootJSDocConfig } from "../../../../PACKAGE.ts"

const cwd = "packages/smithers/build/targets"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")
const testSupportSources = Smithers.glob("test-support/**/*.ts")
const testSupport = Smithers.Filegroup({ srcs: [testSupportSources], cwd })

const lib = Smithers.TsBuild({
  srcs: [sources],
  entries: [Smithers.file("src/index.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "program", entry: Smithers.file("scripts/build.mjs") },
  format: "dual",
  outDir: "dist",
  cwd
})

const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts"), testSupportSources],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const test = Smithers.Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib, testSupport],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

const lint = Smithers.EsLint({
  sources: [sources],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig, rootInvariantsConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

const fmt = Smithers.Dprint({
  sources: [sources, Smithers.glob("test/**/*.ts"), testSupportSources],
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
 * The package's circular-dependency guard, run under the declared runtime.
 *
 * @since 0.1.0
 * @category test
 */
const circular = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("scripts/circular.mjs")),
  srcs: [sources],
  deps: [],
  cwd
})

// --- reference docs pipeline ----------------------------------------------
/** Everything the reference writer may read: sources, README, package docs, the rule table. */
const docsSources = Smithers.Filegroup({
  srcs: [sources, Smithers.file("README.md"), Smithers.glob("docs/*.md")],
  cwd
})

/**
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), matching the filegroup BuildAndCheckTypeScriptPackage emits. The docs-site
 * content sync in `apps/docs/targets/PACKAGE.ts` depends on it by label, the
 * one way an input reaches across a package boundary.
 */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/** The committed reference pages, as a set other packages depend on. */
const referencePages = Smithers.Filegroup({ srcs: [Smithers.glob("docs/reference/*.md")], cwd })

/** Every `ts` fence in the package page compiles under strict tsc. */
const referenceCodeBlocks = Smithers.Markdown.CodeBlocks({
  file: Smithers.file("docs/reference/targets.md"),
  lang: ["ts"]
})

/** Writes `docs/reference/targets.md`, the package page. */
const referenceDocs = Smithers.Agent.Diff({
  agent: docsWriter,
  prompt: Smithers.file("//apps/site/prompts/reference-package.md"),
  data: [docsSources, referenceStyle],
  changes: ["docs/reference/targets.md"],
  gates: [referenceCodeBlocks, check],
  maxRounds: 3
})

/**
 * One rule page per catalog rule. The seed is the hand-maintained page under
 * packages/smithers/build/docs/reference/targets, named as a `//` file input
 * because globs never cross a package boundary.
 */
const rulePage = (slug: string, seed: string) => {
  const page = `docs/reference/${slug}.md`
  const codeBlocks = Smithers.Markdown.CodeBlocks({ file: Smithers.file(page), lang: ["ts"] })
  const write = Smithers.Agent.Diff({
    agent: docsWriter,
    prompt: Smithers.file("//apps/site/prompts/reference-target-rule.md"),
    data: [
      docsSources,
      referenceStyle,
      Smithers.file(`//packages/smithers/build/docs/reference/targets/${seed}`),
      Smithers.file("//packages/smithers/build/targets/docs/rules.md")
    ],
    changes: [page],
    gates: [codeBlocks, check],
    maxRounds: 3
  })
  return { codeBlocks, write }
}

const filegroupRule = rulePage("filegroup", "filegroup.md")
const agentDiffRule = rulePage("agent-diff", "README.md")
const referenceFilegroupCodeBlocks = filegroupRule.codeBlocks
const referenceFilegroupDocs = filegroupRule.write
const referenceAgentDiffCodeBlocks = agentDiffRule.codeBlocks
const referenceAgentDiffDocs = agentDiffRule.write
// --- end reference docs pipeline ------------------------------------------

/**
 * The package's security review: `security` reviews changes against
 * origin/main, and the manual `securityAudit` reviews every source file.
 * These rules run tools, read the workspace, hold secrets, and render CI, so
 * each check below names one trust boundary they must keep.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  checks: [
    {
      id: "tool-argv-injection",
      title: "Tool runs never reach a shell with attacker-shaped text",
      threat:
        "A contributor whose PACKAGE.ts or file names a maintainer builds runs arbitrary commands on that maintainer's machine or CI runner.",
      lookFor: [
        "A spawn or exec that passes shell: true, or builds one command string, from attrs, globs, file names, or git output.",
        "A git, npm, docker, cargo, or go argv where a declared value can start with '-' and is not behind '--' or --end-of-options.",
        "Environment passed to a child that keeps NODE_OPTIONS, GIT_*, or LD_PRELOAD-style injection hooks from the caller."
      ],
      paths: [
        "src/Exec.ts",
        "src/ExecSandbox.ts",
        "src/Shell.ts",
        "src/ToolRun.ts",
        "src/LlmLint.ts",
        "src/Docker.ts",
        "src/Cargo.ts",
        "src/Go.ts",
        "src/PackageManager.ts",
        "src/Runtime.ts"
      ]
    },
    {
      id: "workspace-confinement",
      title: "Reads and writes stay inside the workspace",
      threat:
        "A crafted glob, symlink, or output path makes a build read a maintainer's private files into a prompt or cache, or write outside the workspace.",
      lookFor: [
        "A declared path, glob, or output joined to the root without Input.resolvePath or SafeFs, or with '..' or an absolute path accepted.",
        "A file read that follows symlinks or re-opens a path after checking it (a check-then-use race).",
        "An archive, fetch, or generated-file write whose destination comes from content rather than the declaration.",
        "A Compose generator spawn whose writes are not diffed against its declared changes and stdout write set."
      ],
      paths: [
        "src/SafeFs.ts",
        "src/Input.ts",
        "src/GeneratedFile.ts",
        "src/Fetch.ts",
        "src/Filegroup.ts",
        "src/ToolBuild.ts",
        "src/Compose.ts"
      ]
    },
    {
      id: "secret-handling",
      title: "Declared secrets never leak",
      threat:
        "Anyone who can read build logs, cache entries, or model prompts learns a publish token or cache credential.",
      lookFor: [
        "A secret value, or an env var named by S.Secret, written to a log, an error message, a cache key, an output file, or a prompt.",
        "A child process or model CLI inheriting SMITHERS_CACHE_TOKEN, NPM_TOKEN, or another declared secret it does not need.",
        "A secret-proxy placeholder substituted into a request to a host the declaration did not allow."
      ],
      paths: [
        "src/Secret.ts",
        "src/SecretProxy.ts",
        "src/RemoteCache.ts",
        "src/NpmPublish.ts",
        "src/JsrPublish.ts",
        "src/LlmLint.ts"
      ]
    },
    {
      id: "cache-poisoning",
      title: "Cache keys cover everything a result depends on",
      threat:
        "A contributor or a shared remote cache serves a stale or tampered build result that a maintainer then ships.",
      lookFor: [
        "A cacheable target whose key omits an input the implementation reads: an env var, a tool version, a file outside the declared inputs.",
        "A cached value decoded without the success schema, or a remote-cache response trusted without its digest.",
        "A non-reproducible step, such as a network fetch without a pinned digest or a model call, marked cacheable."
      ],
      paths: ["src/Target.ts", "src/RemoteCache.ts", "src/Fetch.ts", "src/ToolBuild.ts"]
    },
    {
      id: "ci-workflow-injection",
      title: "Generated CI workflows do not execute untrusted text",
      threat:
        "A pull-request author runs code with the repository's CI secrets or write token through a generated GitHub Actions workflow.",
      lookFor: [
        "A declared name, pattern, or step value interpolated into a run: script or a ${{ }} expression without quoting or validation.",
        "A generated job on pull_request_target or with write permissions that checks out and runs pull-request code.",
        "Third-party actions referenced by tag rather than a pinned commit SHA."
      ],
      paths: ["src/GithubCiGen.ts", "src/GithubWorkflow.ts", "src/GithubTarget.ts", "src/CiToolchain.ts"]
    },
    {
      id: "agent-prompt-injection",
      title: "Reviewed file content cannot steer a model or agent run",
      threat:
        "A contributor plants instructions in a file so an agent or model review edits files outside its write set, exfiltrates data, or suppresses findings.",
      lookFor: [
        "A prompt that embeds file bodies without marking them as untrusted data.",
        "An agent target whose declared write set, tools, or network are not enforced after the run.",
        "Model output parsed loosely enough that a planted string changes a verdict, a path, or a command.",
        "A claude or codex argv that drops --tools '', --safe-mode, --strict-mcp-config, or --sandbox read-only, or passes the prompt on argv.",
        "A SecurityReview rubric or finding parser where planted text can drop a check, downgrade an error to a warning, or end the review early."
      ],
      paths: ["src/LlmLint.ts", "src/AgentTarget.ts", "src/SecurityReview.ts", "src/ModelEngine.ts"]
    },
    {
      id: "irreversible-effect-gating",
      title: "Publishes and other outward effects run only once, with their declared secret and approval",
      threat:
        "A build, cache replay, or verification pass publishes a package, pushes a branch, or opens a release on a maintainer's registry or GitHub account without approval.",
      lookFor: [
        "An outward rule that reaches a spawn or transport without calling Outward.refuse, or that treats approval: \"required\" as satisfied by default.",
        "A publish or push run through the retryable Exec action instead of ExecIrreversible, or marked cacheable so a replay re-runs it.",
        "A publish argv that takes the registry, tag, or remote from package content rather than the declaration."
      ],
      paths: [
        "src/Outward.ts",
        "src/Changesets.ts",
        "src/ChangesetsTarget.ts",
        "src/NpmPublish.ts",
        "src/NpmTarget.ts",
        "src/JsrPublish.ts",
        "src/ToolRun.ts",
        "src/GitTarget.ts",
        "src/GithubTarget.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    test,
    testSupport,
    docsSources,
    referenceAgentDiffCodeBlocks,
    referenceAgentDiffDocs,
    referenceCodeBlocks,
    referenceDocs,
    referenceFilegroupCodeBlocks,
    referenceFilegroupDocs,
    referencePages,
    ...securityReview
  }
})
