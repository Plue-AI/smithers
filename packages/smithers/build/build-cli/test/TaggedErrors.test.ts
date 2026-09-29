/**
 * Every build-cli refusal is an Effect tagged error: an Effect caller routes it
 * by `_tag` with `catchTag`, a promise caller keeps `instanceof` and the typed
 * fields, and the CLI prints its designed sentence. Anything untagged prints
 * one generic sentence unless the operator asked for `--verbose`.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { AffectedGitError } from "../src/Affected.ts"
import * as Diagnostic from "../src/Diagnostic.ts"
import { GitCommitError } from "../src/GitCommit.ts"
import { GitHooksError } from "../src/GitHooks.ts"
import { GithubRenderError } from "../src/GithubRender.ts"
import { ProcessError } from "../src/internal/ContainedProcess.ts"
import { FetchError } from "../src/internal/rules/FetchExecutor.ts"
import { KnownRedError } from "../src/KnownRed.ts"
import { MemoryBackendUnavailable, MemoryCapabilityMissing, MemoryCommandFailed } from "../src/MemoryBackend.ts"
import { NixEnvironmentError } from "../src/NixExec.ts"
import { PackageError } from "../src/PackageError.ts"
import { IgnoredCensusError, ignoredLimits, OutDirLimitError, PortalCensusError } from "../src/PackageTree.ts"
import { KeyMaterialError, UnsupportedVerbError } from "../src/Planner.ts"
import { ExecutionError } from "../src/RepoResolution.ts"
import { ClosureError, ResolverConfigError } from "../src/Resolver.ts"

/** Fails an Effect with `error` and recovers only through its tag. */
const routed = <E extends Error & { readonly _tag: string }>(error: E): Promise<string> =>
  Effect.runPromise(
    Effect.fail(error).pipe(
      Effect.catchTag(error._tag as never, (caught: E) => Effect.succeed(`${caught._tag}|${caught.message}`)),
      Effect.orElseSucceed(() => "unrouted")
    ) as Effect.Effect<string>
  )

const resolution = { externalLabel: "@child//pkg:test" } as never

const cases: ReadonlyArray<readonly [string, Error & { readonly _tag: string }, string]> = [
  ["smithers-build/GitHooksError", new GitHooksError("invalid_label", "bad label"), "invalid_label: bad label"],
  [
    "smithers-build/KeyMaterialError",
    new KeyMaterialError("", "is a Proxy"),
    "cache key material at the root is a Proxy"
  ],
  [
    "smithers-build/UnsupportedVerbError",
    new UnsupportedVerbError("//a:b", "test"),
    "target selected by //a:b does not support the test verb"
  ],
  [
    "smithers-build/PackageError",
    new PackageError("unknown_label", "no such target", { path: "a/PACKAGE.ts" }),
    "unknown_label: no such target [a/PACKAGE.ts]"
  ],
  [
    "smithers-build/KnownRedError",
    new KnownRedError("invalid", "list.json: must be an object"),
    "list.json: must be an object"
  ],
  [
    "smithers-build/ResolverConfigError",
    new ResolverConfigError("outside_workspace", "x resolves outside the workspace: /x"),
    "x resolves outside the workspace: /x"
  ],
  [
    "smithers-build/ClosureError",
    new ClosureError("too_many_files", "import closure exceeds 3 files"),
    "import closure exceeds 3 files"
  ],
  ["smithers-build/GithubRenderError", new GithubRenderError("invalid_path", "bad"), "invalid_path: bad"],
  ["smithers-build/GitCommitError", new GitCommitError("empty_message", "no message"), "empty_message: no message"],
  [
    "smithers-build/IgnoredCensusError",
    new IgnoredCensusError("unreadable", "dist/a", ignoredLimits),
    "the write-set guard cannot restore the gitignored tree: dist/a could not be read"
  ],
  [
    "smithers-build/PortalCensusError",
    new PortalCensusError("unreadable", "link"),
    "the write-set guard cannot confine link: its target could not be read"
  ],
  [
    "smithers-build/OutDirLimitError",
    new OutDirLimitError("entries", "dist", 2),
    "captured output dist crosses the entries limit of 2"
  ],
  [
    "smithers-build/ExecutionError",
    new ExecutionError(resolution, 3, ""),
    "child target @child//pkg:test failed with exit 3"
  ],
  [
    "smithers-build/AffectedGitError",
    new AffectedGitError("nonzero_exit", ["diff"], "git diff failed"),
    "git diff failed"
  ],
  [
    "smithers-build/NixEnvironmentError",
    new NixEnvironmentError("nix_tool_absent", "nix is not installed"),
    "nix is not installed"
  ],
  [
    "smithers-build/MemoryBackendUnavailable",
    new MemoryBackendUnavailable("cli_not_found", "install smithers"),
    "memory backend unavailable (cli_not_found): install smithers"
  ],
  [
    "smithers-build/MemoryCapabilityMissing",
    new MemoryCapabilityMissing("search"),
    "the smithers CLI has no `memory search` subcommand (it ships: get, list, rm, set); this capability cannot run on this host"
  ],
  [
    "smithers-build/MemoryCommandFailed",
    new MemoryCommandFailed(4, { args: ["memory", "get"], stdout: "", stderr: "" }),
    "smithers memory get exited 4: (no output)"
  ],
  ["smithers-build/ProcessError", new ProcessError("timed_out", "git timed out"), "git timed out"],
  ["smithers-build/FetchError", new FetchError("digest_mismatch", "digest differs", "a", "b"), "digest differs"]
]

describe("build-cli tagged errors", () => {
  it.each(cases)("%s routes through catchTag and keeps its sentence", async (tag, error, sentence) => {
    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe(tag)
    await expect(routed(error)).resolves.toBe(`${tag}|${sentence}`)
    expect(Diagnostic.present(error, { verbose: false })).toBe(sentence)
  })

  it("keeps the typed fields a caller branches on", () => {
    const cause = new Error("root")
    expect(new AffectedGitError("cancelled", ["log"], "cancelled", cause)).toMatchObject({
      code: "cancelled",
      args: ["log"],
      cause
    })
    expect(new ProcessError("output_limit", "too much", cause)).toMatchObject({ code: "output_limit", cause })
    expect(new PackageError("unknown_label", "x", { cause, chain: ["a", "b"] })).toMatchObject({
      code: "unknown_label",
      chain: ["a", "b"],
      cause
    })
    expect(new FetchError("digest_mismatch", "m", "e", "a", { cause })).toMatchObject({
      expectedSha256: "e",
      actualSha256: "a",
      cause
    })
    expect(new IgnoredCensusError("entries", "p", ignoredLimits, { cause })).toMatchObject({
      reason: "entries",
      path: "p",
      cause
    })
    expect(new UnsupportedVerbError("//a", "build")).toMatchObject({ pattern: "//a", verb: "build" })
    expect(new MemoryCommandFailed(2, { args: ["memory"], stdout: "o", stderr: "e" })).toMatchObject({
      exitCode: 2,
      stdout: "o",
      stderr: "e",
      args: ["memory"]
    })
  })

  it("names the cause of a known-red, resolver, and closure refusal with a typed reason", () => {
    expect(new KnownRedError("unreadable", "x").reason).toBe("unreadable")
    expect(new ResolverConfigError("extends_too_deep", "x").reason).toBe("extends_too_deep")
    expect(new ClosureError("missing_entry", "x").reason).toBe("missing_entry")
  })
})

describe("Diagnostic.present", () => {
  it("prints a plain build-cli sentence as written", () => {
    expect(Diagnostic.present(new Error("no targets selected by //x"), { verbose: false }))
      .toBe("no targets selected by //x")
  })

  it.each([
    ["a string", "raw /secret/path"],
    ["an object", { detail: "raw" }],
    ["a runtime bug", new TypeError("Cannot read properties of undefined (reading 'x')")],
    [
      "a system error",
      Object.assign(new Error("ENOENT: no such file, open '/home/u/x'"), { syscall: "open", errno: -2 })
    ],
    ["undefined", undefined]
  ])("prints one generic sentence for %s", (_name, cause) => {
    const rendered = Diagnostic.present(cause, { verbose: false })
    expect(rendered).toBe(Diagnostic.unknownFailure)
    expect(rendered).not.toContain("raw")
    expect(rendered).not.toContain("/home/u")
    expect(rendered).not.toContain("Cannot read")
  })

  it("adds the raw detail only under --verbose, without a stack", () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')")
    const rendered = Diagnostic.present(bug, { verbose: true })
    expect(rendered).toBe(`${Diagnostic.unknownFailure}\nCannot read properties of undefined (reading 'x')`)
    expect(rendered).not.toContain("    at ")
  })
})
