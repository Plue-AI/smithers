import { Smithers } from "@smthrs/targets"

const cwd = "packages/repo-targets"
const sources = Smithers.glob("src/**/*.ts")
const testSupport = Smithers.Filegroup({
  srcs: [Smithers.file("//packages/smithers/build/targets/test-support/plan.ts")],
  cwd
})
const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [testSupport],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})
const test = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [sources],
  deps: [testSupport],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "scripts/**", "test-utils/**"],
  checks: [
    {
      id: "review-gate-strength",
      title: "Shared review macros cannot be weakened or silenced by the code they review",
      threat:
        "A contributor whose diff carries prompt text or a narrowed include makes every package's model review pass their change unreviewed.",
      lookFor: [
        "smithersReviewPrompt or a rubric that lets diff contents redefine the rubric, or that tells the model to skip files, instead of treating reviewed text as data.",
        "A macro whose failOn defaults to a weaker severity than its README states, or a caller option that overrides failOn or rubric silently.",
        "An anchor or include mapping in review() where the gitDiff paths and the include globs can diverge so changed files escape the reviewed set."
      ],
      paths: ["src/ReviewLint.ts", "src/ReviewTagsMigrationsAndKeys.ts", "src/ReviewDocsAgainstCode.ts", "src/ReviewJsdocAgainstCode.ts"]
    },
    {
      id: "review-context-confinement",
      title: "A review sends the model only the declaring package's files and its named prose",
      threat:
        "A review macro ships a maintainer's .env, keys, or another package's private sources to a third-party model CLI because a default or derived glob matches more than the package.",
      lookFor: [
        "ReviewDocsAgainstCode interpolating packageName, taken from cwd, into a site glob without escaping glob metacharacters such as *, ?, {, or [.",
        "A default include or context glob in any macro that can match .env*, *.pem, credentials files, or node_modules.",
        "anchor() re-rooting an exclude or pattern without Input.resolvePath, so a '..' segment survives into the emitted workspace glob."
      ],
      paths: ["src/ReviewLint.ts", "src/ReviewDocsAgainstCode.ts"]
    },
    {
      id: "build-script-exec",
      title: "Build scripts execute only the package's own toolchain and write only its dist",
      threat:
        "A build started from the wrong working directory deletes or overwrites another tree's dist on a maintainer's machine or CI runner, or ships a CommonJS bundle whose rewritten require() loads a different module.",
      lookFor: [
        "A spawnSync or exec in build-library.mjs that uses a shell or a string command instead of process.execPath with an argv array.",
        "rmSync, cpSync, or writeFileSync whose target is not confined under packageRoot/dist, or that follows a symlink out of it.",
        "The require-path rewrite regex rewriting non-relative specifiers or content outside require() calls in emitted CommonJS."
      ],
      paths: ["scripts/**"]
    },
    {
      id: "gate-cache-integrity",
      title: "Every file a gate reads is a declared cache input",
      threat:
        "A contributor changes an undeclared test fixture, config, or tool script so CI reuses a stale green result and merges a broken or malicious change.",
      lookFor: [
        "A target in BuildAndCheckTypeScriptPackage whose tool reads a file (tsconfig, vitest config, eslint config, test-utils, build script) absent from its srcs or sources.",
        "A tsconfig.test.json or vitest config that extends or imports a file (tsconfig.json, a shared base) that the check or test target does not list as an input.",
        "A default such as maxWarnings, passWithNoTests, or fix that a caller can flip to make lint or test pass vacuously."
      ],
      paths: ["src/BuildAndCheckTypeScriptPackage.ts"]
    }
  ]
})

export const Package = Smithers.Package({ targets: { check, test, ...securityReview } })
