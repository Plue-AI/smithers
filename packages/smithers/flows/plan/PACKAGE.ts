import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets plus package-owned documentation generation.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/plan"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/plan",
  include: ["src/**"],
  checks: [
    {
      id: "step-key-collision",
      title: "Distinct node material never compiles to the same step key",
      threat:
        "A flow author whose node differs in inputs, layers, env or version reuses another node's cached result, poisoning a run's outputs.",
      lookFor: [
        "A literal shaped like a digest reference ({digest}) hashed identically to a nominally branded Digest input.",
        "Environment, caller layers, or capabilities merged into one namespace so two different declarations canonicalize to the same JSON.",
        "An InputRef variant (Literal, Ref, Pending) whose tag, from, or path is not folded into the hashed body.",
        "undefined, NaN, -0 or key order collapsing two different payloads into one canonical form."
      ],
      paths: ["src/StepKey.ts", "src/KeyMaterial.ts", "src/internal/JsonMirror.ts"]
    },
    {
      id: "function-identity-cache-hit",
      title: "A closure's identity changes whenever its behavior can change",
      threat:
        "A flow author gets a cached result computed by a different closure or different captured values, returning another step's output as this step's.",
      lookFor: [
        "functionIdentity hashing normalized source or omitting per-function entropy for closures without declared captures.",
        "Node.capture admitting a getter, Proxy, or non-plain prototype so the hashed snapshot differs from the value the callback reads."
      ],
      paths: ["src/Node.ts", "src/internal/node.ts"]
    },
    {
      id: "plan-verify-integrity",
      title: "Plan.verify rejects any stored plan whose nodes, keys or digests were altered",
      threat:
        "Someone who can write the plan store substitutes node material, effects or keys so an approved plan digest runs different work.",
      lookFor: [
        "A verify path that trusts decoded keys, effects, or ordering instead of recompiling and comparing the full node contract.",
        "isVerified or the frozenPlans fast path accepting an object not produced by the compiler.",
        "prefixDigest or generation checks that let an append rewrite an earlier generation's nodes."
      ],
      paths: ["src/Plan.ts", "src/PlanDiff.ts"]
    },
    {
      id: "declared-path-confinement",
      title: "Declared file paths and patterns stay inside the workspace and name each file one way",
      threat:
        "A flow author declares an effect path that escapes the workspace or aliases another path, reading or writing files outside the sandbox boundary.",
      lookFor: [
        "workspaceRelative accepting '..', '.', empty segments, absolute or drive-letter paths after backslash canonicalization.",
        "Unicode forms (NFC vs NFD, fullwidth separators) or C0 controls that pass validation but name a different file at runtime.",
        "TreeArtifact or Glob paths that skip the Pattern schema.",
        "A drive-relative first segment such as 'C:foo', or Windows trailing-dot/space segments, passing workspaceRelative."
      ],
      paths: ["src/FileSet.ts"]
    },
    {
      id: "write-conflict-false-negative",
      title: "Static overlap never reports disjoint for two effects that can touch the same file",
      threat:
        "Two concurrently scheduled nodes write the same file because overlap analysis said false, corrupting a user's workspace or letting one node clobber another's output.",
      lookFor: [
        "FileSet.overlaps returning false for a glob exclusion, tree prefix, or separator alias that can match the same path, or reading a plain string as a pattern when execution reads it as a literal path.",
        "EffectCandidates' trie omitting a candidate owner that the final overlap predicate would have flagged.",
        "ConflictAnnotation dropping a reader-producer edge so a reader runs before its producer.",
        "Exact-path comparison that is case-sensitive, so 'A.txt' and 'a.txt' are disjoint although a case-insensitive filesystem (default macOS APFS) maps them to one file."
      ],
      paths: [
        "src/FileSet.ts",
        "src/internal/EffectCandidates.ts",
        "src/internal/ConflictAnnotation.ts",
        "src/Effects.ts",
        "src/internal/effects.ts"
      ]
    },
    {
      id: "untrusted-graph-dos",
      title: "Payloads, globs and graphs from authors are processed in bounded time and memory",
      threat:
        "A flow author or a crafted stored plan hangs or exhausts memory in the planner process shared by other runs.",
      lookFor: [
        "Recursion over payload or AST depth without the payload_too_deep refusal.",
        "Glob matching that backtracks exponentially on repeated '*' or '**' segments.",
        "toJSON or getter evaluation during mirroring that can loop, throw arbitrary objects, or mutate input."
      ],
      paths: ["src/internal/JsonMirror.ts", "src/FileSet.ts", "src/GraphBuildError.ts", "src/internal/node.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
