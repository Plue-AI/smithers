/** Review is a normal file flow; no standalone runtime or deployment target. */
import { Smithers } from "@smthrs/targets"
const cwd = "flows/review"
const sources = [Smithers.file("//flows/review/flow.ts"), Smithers.glob("//flows/review/src/**/*.ts")]
const tests = Smithers.glob("//flows/review/tests/**/*.ts")
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})
const checkTests = Smithers.Typecheck({
  srcs: [...sources, tests],
  deps: [],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})
// Coverage policy: assertion-only for the retained behavioral unit gate.
// #2290 tracks measured whole-source coverage.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [...sources, tests, Smithers.file("//flows/review/tests/github/fixtures/fake-gh")],
  deps: [],
  cwd
})
// Keep the retained code's security ownership local after deleting the service.
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["flow.ts", "src/**"],
  checks: [
    {
      id: "review-output-injection",
      title: "Findings remain anchored to the reviewed source and cannot control GitHub actions",
      threat:
        "Prompt-injected findings post flags, change review events, or address files outside the reviewed change.",
      lookFor: [
        "Model findings bypassing changed-file/line anchoring or independent verification before output.",
        "buildPullRequestReview or postPullRequestReview using model text as gh flags or a review event.",
        "supersedePriorReviews changing reviews it did not author."
      ],
      paths: ["src/github/**", "src/review/anchorFinding.ts", "src/workflow/applyFindingVerdicts.ts"]
    },
    {
      id: "checkout-path-confinement",
      title: "Snapshot reads and artifact writes obey the caller's filesystem and process policy",
      threat: "A reviewed symlink or option-shaped ref reads host secrets or overwrites files outside permitted paths.",
      lookFor: [
        "Snapshot or artifact IO using native filesystem/process access instead of the host-supplied services.",
        "Artifact writes following a symlink or escaping the permitted artifact directory.",
        "Git/jj refs and paths reaching argv without validation or option terminators.",
        "Reviewed configuration controlling filters that should be pinned to trusted source."
      ],
      paths: [
        "src/git/**",
        "src/walkthrough/writeWalkthroughArtifact.ts",
        "src/walkthrough/walkthroughPath.ts",
        "src/review/buildFileFilter.ts",
        "src/io.ts",
        "src/workflow/reviewActions.ts"
      ]
    },
    {
      id: "review-agent-authority",
      title: "Review seats use the shared host's model, auth, tools, budget and cancellation policy",
      threat:
        "A review creates its own model credentials, tool authority, budget or runtime to bypass the caller's limits.",
      lookFor: [
        "reviewLayer constructing a second engine, resolver, agent host, implementation table or provider credential source.",
        "Review, verification or narration acquiring tools or choosing model endpoints from reviewed text.",
        "AgentAction calls bypassing the shared budget, timeout or cancellation scope.",
        "Model output becoming executable HTML without escaping, strict Mermaid rendering and isolated result presentation."
      ],
      paths: ["flow.ts", "src/workflow/**", "src/walkthrough/**", "src/diffs/**"]
    }
  ]
})
export const Package = Smithers.Package({ targets: { check, checkTests, unitTests, ...securityReview } })
