import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/platform-bun"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.entrypoint(Smithers.file("scripts/run-bun-tests.mjs")),
  srcs: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts"), Smithers.file("vitest.config.ts")],
  deps: [],
  cwd: "packages/smithers/flows/platform-bun"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/platform-bun",
  include: ["src/**", "scripts/**", "docs/**", "README.md"],
  checks: [
    {
      id: "http-redirect-manual",
      title: "Every HttpClient the bundle provides stops at a redirect",
      threat:
        "A remote server answers an authorized request with a 3xx and makes the host fetch an origin the capability kernel never authorized (SSRF to metadata or internal services).",
      lookFor: [
        "A factory in src/BunHost.ts that merges BunHttpClient.layer without the RequestInit { redirect: \"manual\" } override.",
        "A RequestInit that sets redirect to \"follow\" or omits it, or a second HttpClient layer that shadows layerHttpClient.",
        "A re-export of @effect/platform-bun/BunHttpClient, whose layer follows redirects, or docs that tell callers to provide BunHttpClient.layer directly instead of BunHost.layerHttpClient."
      ],
      paths: ["src/BunHost.ts", "docs/**", "README.md"]
    },
    {
      id: "contained-spawner-wiring",
      title: "Contained factories route every child, jj included, through the ProcessReaper spawner",
      threat:
        "An agent command or jj child spawned through the raw BunChildProcessSpawner escapes the ledger and outlives the host, keeping running with the host's credentials after cancellation.",
      lookFor: [
        "layerContained or layerContainedAt exposing a ChildProcessSpawner that is not ProcessReaper.layerSpawner, or merging BunChildProcessSpawner.layer unwrapped into the output.",
        "BunJj.layer or BunJj.layerAt (self-spawning) used in a contained factory instead of BunJj.layerSpawner / layerSpawnerAt provided by the contained spawner.",
        "ContainedOptions accepting a platform override that could record pgid null for a real process group.",
        "reaping() dropping or rewriting the caller's ownerPid or system, so the reaper signals the live host's own group or reads another host's ledger rows."
      ],
      paths: ["src/BunHost.ts"]
    },
    {
      id: "filesystem-slot-atomic",
      title: "The filesystem slot is always the atomic, no-follow AtomicFileSystem",
      threat:
        "A guarded write by an agent follows a symlink swapped in after authorization and overwrites a file outside the workspace owned by the host user.",
      lookFor: [
        "Any layer in src/BunHost.ts or src/BunFileSystem.ts providing FileSystem from @effect/platform-bun's BunFileSystem or NodeFileSystem instead of AtomicFileSystem.",
        "The spawner's platform layer resolving files through a non-atomic FileSystem.",
        "BunFileSystem.layer or BunFileSystem.layerWith aliasing anything other than AtomicFileSystem.layer or AtomicFileSystem.layerWith, which own the absolute-helper-path and no-PATH checks."
      ],
      paths: ["src/BunHost.ts", "src/BunFileSystem.ts"]
    },
    {
      id: "repository-root-refusal",
      title: "Repository roots are validated before any layer is built and refusal messages are bounded and escaped",
      threat:
        "A caller-supplied root binds jj to the process cwd, or a hostile root string injects forged lines or megabytes into host logs through the BunHostError message.",
      lookFor: [
        "layerAt or layerContainedAt passing root to BunJj without first calling absoluteRoot.",
        "preview() emitting a raw control character or newline, splitting a surrogate pair, or exceeding messageLimit for any input length."
      ],
      paths: ["src/BunHost.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
