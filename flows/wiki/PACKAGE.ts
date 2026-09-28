/** Exact code dependencies: no cross-package globs silently expanding to nothing. */
import { Smithers as S } from "@smthrs/targets"
import project from "../../.smithers/coding-project.json" with { type: "json" }
// The page catalog is the `pages` of the coding project; each page's document and inputs invalidate the wiki.
const sourceFiles = project.pages.flatMap((page) => [page.document, ...page.inputs])
const data = [
  ...new Set([
    ...sourceFiles,
    ".smithers/coding-project.json",
    "flows/wiki/schema.ts",
    "flows/wiki/evidence.ts",
    "flows/wiki/flow.ts",
    "flows/wiki/workflow.ts",
    "flows/wiki/operations.ts",
    "flows/wiki/main.ts",
    "flows/wiki/runtime.ts",
    "flows/wiki/reuse.ts",
    "flows/wiki/jev-citations.ts",
    "flows/repository/jev-checks.ts",
    "flows/coding/schema.ts",
    "flows/coding/wiki-output.ts",
    "flows/release-support/runtime.ts"
  ])
].map((file) => S.file(`//${file}`))
const preview = S.Shell.Build({
  bin: S.Runtime.bin,
  args: ["--experimental-strip-types", "flows/wiki/main.ts"],
  data,
  timeout: "10m",
  outDirs: [".flows/wiki"]
})
const verify = S.Shell.Run({
  bin: S.Runtime.bin,
  args: ["--experimental-strip-types", "flows/wiki/main.ts", "--verified"],
  data,
  timeout: "30m"
})
const freshness = S.Shell.Test({
  bin: S.Runtime.bin,
  args: ["--experimental-strip-types", "flows/wiki/main.ts", "--check"],
  data: [preview, ...data],
  timeout: "5m"
})
const securityReview = S.SecurityReview({
  cwd: "flows/wiki",
  include: ["*.ts"],
  checks: [
    {
      id: "wiki-source-confinement",
      title: "Page sources are repository-relative, non-private text files inside the root",
      threat:
        "A catalog entry or symlink in a contributed change copies a maintainer's secrets or files outside the repository into the published wiki snapshot and the reviewer prompt.",
      lookFor: [
        "safePath denying .env with a case-sensitive regex (no /i), so .ENV on a case-insensitive disk, .envrc, .npmrc, .dev.vars, *.pem, id_rsa, or a nested .git/.jj dir still pass.",
        "read resolving realPath of root and file but comparing with a prefix check that a sibling directory such as <root>-other can pass.",
        "check() reading pages/ or sources/ files via path.resolve(current.directory, input.path) and following a symlink before the realPath comparison runs."
      ],
      paths: ["operations.ts", "main.ts"]
    },
    {
      id: "wiki-output-confinement",
      title: "Generation writes only inside a dedicated output directory under --root",
      threat:
        "A symlinked .flows or output parent committed in a contributed change makes a wiki run write snapshots and current.json outside the repository on the runner.",
      lookFor: [
        "main.ts relative() and write() realPath checks covering only the last output segment, so a symlinked .flows parent lets output resolve outside --root.",
        "write() installing the snapshot, staging dir, or current.json pointer through a symlinked snapshots/ or output root without the realPath equality check.",
        "Capability rules in main.ts granting fs:read on the whole root or resolve(output, \"..\") or fs:write beyond output/**.",
        "flow.ts declaring capabilities fs:read:** and fs:write:** wider than its effects.writes .flows/wiki/**, so a host that trusts the declaration grants every path."
      ],
      paths: ["main.ts", "operations.ts", "flow.ts"]
    },
    {
      id: "reviewer-prompt-injection",
      title: "Repository text cannot steer the reviewer into certifying a page",
      threat:
        "A contributor who edits a catalogued page or source file makes the model reviewer mark false documentation as verified.",
      lookFor: [
        "ReviewPage prompt interpolating evidence, prior review, or correction text outside JSON.stringify so it can close the data frame.",
        "A supported verdict accepted without assess() proving each quote is on the cited line and that a current-behavior section cites a non-self file.",
        "The Jev citation classifier state carrying excerpt lines that the page excerpts hid, or a low-confidence answer counted as supported.",
        "agentLayers in runtime.ts giving the reviewer a nonempty capabilityEnvelope or registry tools, so injected page text can act instead of only answer."
      ],
      paths: ["workflow.ts", "evidence.ts", "jev-citations.ts", "operations.ts", "runtime.ts"]
    },
    {
      id: "reused-review-trust",
      title: "Reused reviews come only from intact, same-policy receipts",
      threat:
        "Whoever supplies a carried pool or a prior run id publishes a verified wiki whose reviews no model produced against the current source.",
      lookFor: [
        "load() accepting a caller pool whose policyDigest is computable from public files and whose candidates are not re-verified against a stored attempt.",
        "loadRun() reading attempts from another execution or a non-terminal run, or picking between two successful receipts for one page.",
        "select() reusing a review when inputDigest, contentDigest, sections, or reviewer changed, or when assess() fails."
      ],
      paths: ["reuse.ts"]
    },
    {
      id: "verification-status-integrity",
      title: "A snapshot says verified only when every section passed review and the source is unchanged",
      threat:
        "A stale or partly reviewed wiki is published as verified and readers trust documentation that contradicts the code.",
      lookFor: [
        "write() computing verified without requiring a non-null reviewer and every section supported, or skipping the recollect digest comparison.",
        "check() accepting a current.json whose pages, sources, or artifactDigest differ from the immutable snapshot, or --verified passing a non-verified snapshot.",
        "check() accepting a verified pointer without a valid seal (HMAC of artifactDigest under the host key beside, never inside, the output), or write() placing that key where the output writer can read it.",
        "The reviewer label in main.ts taken from SMITHERS_OPENAI_AUTH so a different provider route can reuse a prior approval."
      ],
      paths: ["operations.ts", "main.ts", "reuse.ts"]
    }
  ]
})
export const Package = S.Package({ targets: { preview, freshness, verify, ...securityReview } })
