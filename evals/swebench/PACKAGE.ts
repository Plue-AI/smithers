/**
 * Targets for the SWE-bench benchmark rig.
 *
 * The offline fixtures and TypeScript check gate CI after the workspace install.
 * The subject and evaluator checks are an explicit operator target requiring
 * a built CLI and evaluator venv. Docker and funded-model benchmarks remain
 * documented operator commands.
 *
 * `lint` and `fmt` cover the rig's code only. The rest of this directory is
 * captured evaluator output (`baseline/`, `reports/`, `fullbench/`, fixture
 * data) whose bytes are evidence of what a wave measured.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "evals/swebench"

/**
 * Checks the scorecard generator and its price table against their tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [Smithers.glob("//evals/swebench/*.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/** The rig's code, as `eslint.config.js` and `dprint.json` scope it. */
const code = [Smithers.glob("*.ts"), Smithers.glob("*.mjs"), Smithers.glob("lib/*.mjs")]

/**
 * Lints the rig's scripts.
 *
 * @since 1.0.0
 * @category lint
 */
const lint = Smithers.EsLint({
  sources: code,
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.invariants.js")],
  deps: [],
  maxWarnings: 0,
  fix: false,
  cwd
})

/**
 * Checks formatting of the rig's scripts and fixture checks.
 *
 * @since 1.0.0
 * @category lint
 */
const fmt = Smithers.Dprint({
  sources: [...code, Smithers.glob("fixtures/*.mjs")],
  config: Smithers.file("dprint.json"),
  deps: [],
  fix: false,
  cwd
})

// Declare the rig scripts, recorded fixtures and imported workspace code.
const fixtureInputs = [
  Smithers.glob("//evals/swebench/*.{ts,mjs,sh,md}"),
  Smithers.glob("//evals/swebench/lib/**"),
  Smithers.glob("//evals/swebench/fixtures/**"),
  Smithers.glob("//evals/swebench/baseline/**"),
  // lib/plue.py drives Smithers Cloud through the Harbor adapter's seam.
  Smithers.glob("//evals/harbor/*.py"),
  Smithers.ImportClosure({
    entries: [
      Smithers.glob("*.ts"),
      Smithers.glob("*.mjs"),
      Smithers.glob("lib/*.mjs"),
      Smithers.glob("fixtures/*.mjs")
    ]
  }),
  Smithers.file("//packages/smithers/agent/harness/test/fixtures/wave10Journals.json"),
  Smithers.file("package.json"),
  Smithers.file("//packages/smithers/package.json"),
  Smithers.file("//packages/smithers/bin/smithers.mjs"),
  Smithers.file("//PACKAGE.ts"),
  Smithers.file("//.github/workflows/ci.yml")
]

const offline = Smithers.Shell.Test({
  summary: "Run the token-free SWE-bench fixtures serially, without Docker or a CLI build.",
  script: Smithers.file("verify.sh"),
  args: ["--offline"],
  data: fixtureInputs,
  timeout: "20m"
})

const prerequisites = Smithers.Shell.Run({
  summary: "Check the subject and evaluator after preflight.sh and bootstrap.sh.",
  script: Smithers.file("verify.sh"),
  args: ["--prerequisites"],
  data: fixtureInputs,
  timeout: "20m"
})

/**
 * Security review of the rig's own scripts: the diff (`security`) and a full
 * audit (`securityAudit`). Captured evaluator output is data, not reviewed code.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["*.ts", "*.mjs", "*.sh", "lib/**", "fixtures/*.mjs", "fixtures/*.sh", "fixtures/*.py"],
  checks: [
    {
      id: "host-git-over-agent-checkout",
      title: "Host-side git over an agent-edited checkout never loads repository config, hooks or drivers",
      threat:
        "A benchmark agent (or a hostile SWE-bench repository) plants .git/config, hooks or .gitattributes that run code on the operator's host when the rig captures the patch.",
      lookFor: [
        "A git command run with cwd or --git-dir inside $WORK that is not wrapped by capture_git (env -i, hooksPath=/dev/null, fsmonitor=false, attributesFile=/dev/null).",
        "A copy or symlink of $WORK/.git/config, hooks, or info/attributes into the private capture git dir.",
        "A git diff, apply, or read-tree over the checkout without --no-ext-diff and --no-textconv."
      ],
      paths: [
        "lib/capture-git.sh",
        "lib/capture-patch.sh",
        "lib/snapshot-base.sh",
        "regen-patch.sh",
        "run-instance.sh",
        "run-instance-codex.sh"
      ]
    },
    {
      id: "instance-id-reaches-shell",
      title: "Dataset-sourced ids and run indexes are validated before reaching a path, container name, or eval",
      threat:
        "A tampered swb-verified.json or a lane argument injects shell into the eval'd run-paths output or writes artifacts outside the artifact root on the operator's host.",
      lookFor: [
        "An instance id, run index, or SWB_ARTIFACT_ROOT used in a path, docker name, or image name before lib/validate-instance.mjs or lib/run-paths.sh checked it.",
        "run-paths.sh output printed without printf %q before a caller evals it.",
        "A manifest field (verdict, flowsVerdict) emitted by codex-backfill-queue.mjs --row for codex-backfill.sh to eval without its shell() escaping.",
        "A dataset field other than instance_id (repo, version, base_commit) interpolated into a shell string or file name unvalidated."
      ],
      paths: [
        "lib/run-paths.sh",
        "lib/validate-instance.mjs",
        "lib/codex-backfill-queue.mjs",
        "run-*.sh",
        "codex-backfill.sh",
        "fullbench.sh",
        "lib/fullbench-instance.sh",
        "evaluate.sh",
        "regrade.sh"
      ]
    },
    {
      id: "testbed-network-seal",
      title: "The testbed an agent can reach has no network, and the seal is observed, not assumed",
      threat:
        "A benchmark agent fetches the upstream fix or exfiltrates host data through the testbed container, and the lane still reports a sealed run.",
      lookFor: [
        "A docker run or plue workspace create whose network is not the value lib/testbed-network.sh resolved and then asserted on the live container.",
        "A network verdict in plue.py or testbed-network.sh that returns none when the probe or inspect output is missing or unparseable.",
        "A breach-scan or compare-codex-lanes rule that counts an unobserved container or an unrefused in-container fetch as sealed."
      ],
      paths: [
        "lib/testbed-network.sh",
        "lib/plue.py",
        "breach-scan.mjs",
        "compare-codex-lanes.mjs",
        "run-instance.sh",
        "run-instance-codex.sh",
        "preflight-network.sh",
        "network-dryrun.sh"
      ]
    },
    {
      id: "agent-host-shell-opt-in",
      title: "An agent gets an unconfined host shell only by explicit operator opt-in",
      threat:
        "A model-authored command runs on the operator's host with the docker socket, CODEX_HOME credentials and OPENAI_API_KEY in reach without the lane having chosen that condition.",
      lookFor: [
        "A path where run-instance.sh starts the agent while SWB_FLOWS_HOST_SHELL is neither allowed nor the plue sealed value.",
        "codex exec invoked with --dangerously-bypass-approvals-and-sandbox for a SWB_CODEX_NETWORK value other than on or sealed.",
        "A sealed lane where an inherited NO_PROXY or a proxy variable escapes shell_environment_policy.set, or web_search is left enabled."
      ],
      paths: [
        "run-instance.sh",
        "run-instance-codex.sh",
        "lib/codex-network.sh",
        "codex-backfill.sh",
        "fullbench.sh",
        "run-matrix.sh",
        "run-sample.sh",
        "run-45.sh"
      ]
    },
    {
      id: "grader-answer-leak",
      title: "Graded test identifiers and the reference patch never reach an agent prompt",
      threat:
        "A benchmark agent reads FAIL_TO_PASS, PASS_TO_PASS, test_patch or the gold patch, inflating the published score.",
      lookFor: [
        "A prompt writer that interpolates any dataset field other than repo, base_commit, problem_statement and the resolved test command.",
        "lib/test-command.py printing a spec command without the LEAKY field check.",
        "Evaluator artifacts (reports/, baseline/, eval.sh) placed under $WORK or /testbed where the agent can read them."
      ],
      paths: [
        "lib/write-flow.mjs",
        "lib/write-prompt-codex.mjs",
        "lib/test-command.py",
        "lib/prompt-bytes.sh",
        "run-instance.sh",
        "run-instance-codex.sh"
      ]
    },
    {
      id: "codex-credential-handling",
      title: "Codex and model credentials are passed by stdin or environment and never written to logs or artifacts",
      threat:
        "Anyone who reads committed fullbench logs, timings or trace bundles recovers the operator's OpenAI API key or ChatGPT session.",
      lookFor: [
        "OPENAI_API_KEY or a CODEX_HOME auth file passed on argv, echoed, or copied into LOG_ROOT, TIMINGS, journals or trace bundles.",
        "An api-key lane whose CODEX_HOME resolves to the operator's signed-in ~/.codex instead of the rig's isolated home.",
        "A trace-bundle or report writer that includes environment dumps or codex transcript headers holding tokens."
      ],
      paths: [
        "lib/codex-auth.sh",
        "run-instance-codex.sh",
        "codex-backfill.sh",
        "lib/trace-bundle.mjs",
        "fixtures/check-codex-auth.sh"
      ]
    },
    {
      id: "plue-guest-command-quoting",
      title: "Commands sent to a plue guest quote every path and cannot touch another host's workspaces",
      threat:
        "An evaluator-supplied path or workspace label runs extra commands in the grading guest, or reap deletes workspaces owned by another process or host in the shared PLUE_REPO.",
      lookFor: [
        "An f-string shell command in lib/plue.py (evaluator_copy mkdir, _with_rig, exec) that interpolates a path without shlex.quote.",
        "reap or orphaned() deleting a workspace whose name does not carry this host's tag and a dead owner pid.",
        "SMITHERS_TOKEN or PLUE_REPO echoed in a PlueError message or written into the shim directory."
      ],
      paths: ["lib/plue.py", "lib/transport.sh", "lib/grade.py"]
    },
    {
      id: "lock-and-cleanup-ownership",
      title: "Locks and rm -rf only ever remove what this run owns",
      threat:
        "A concurrent lane or a crafted lock directory makes one run delete another run's workspace, patch or lock, or an rm -rf follow a path outside the artifact root.",
      lookFor: [
        "rm -rf over a variable that is empty-able or not derived from run-paths.sh output.",
        "A lock release or steal in lib/lock.sh that does not recheck owner pid and generation under the guard.",
        "A cleanup trap that releases a lock or removes a container before this process acquired it."
      ],
      paths: [
        "lib/lock.sh",
        "lib/disk-free.sh",
        "run-instance.sh",
        "run-instance-codex.sh",
        "evaluate.sh",
        "regrade.sh",
        "fixtures/check-lock.sh"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, lint, fmt, offline, prerequisites, ...securityReview }
})
